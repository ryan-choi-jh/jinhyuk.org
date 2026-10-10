/**
 * src/cms/app/state/record-store.ts
 *
 * WS-D. The store for one record collection: `filmography.json` or
 * `photography.json`, whole.
 *
 * It is the same shape of thing as `./store.ts` — a plain observable object,
 * no React, undo and redo over snapshots, structural dirty tracking, and the
 * save/publish calls behind one interface — but the unit is the collection
 * file rather than a document, because that is what the API writes:
 *
 *   "Records have no per-entry endpoints. One file is one commit, so the whole
 *    collection is read and written at once. Adding, deleting, editing and
 *    reordering a film are all PUT /api/cms/records/filmography with a
 *    different array."  (docs/cms-contracts.md 11)
 *
 * So create, duplicate, delete and reorder are local, undoable edits to one
 * array, and Save sends the file. That also means the entry list for a record
 * section is live: it is `records.summarise(file)` of this store's current
 * file, so a title typed in the editor appears in the list immediately and
 * both go back together on undo.
 *
 * Every per-section behaviour comes from `section.records` (WS-A's
 * `RecordsDef`): which key the array is under, how to summarise it, how to
 * validate it, what prefix a new id gets. The only narrowing is through the
 * schema's own `isAlbum`, for the one cross-field rule a generic store has to
 * keep (see `normalizeEntry`).
 */

import { formatIssues, isAlbum, newId } from '../../schema.ts';
import type {
  Album,
  Film,
  Photo,
  RecordEntry,
  RecordFile,
  RecordSectionId,
  ValidationIssue,
} from '../../schema.ts';
import type { RecordSectionDef, RecordSummary, RecordsDef } from '../../sections.ts';
import { apiErrorMessage } from './api.ts';
import type { MediaUploadResult } from './api.ts';
import { deepEqual } from './doc-ops.ts';
import { copyTitle, uniqueSlug } from './entries.ts';
import * as hist from './history.ts';
import type { CommitOptions, History } from './history.ts';
import { mediaSlugFor } from './site-api.ts';
import type { SiteApi } from './site-api.ts';
import type { Notice, StorePhase } from './store.ts';

/* -------------------------------------------------------------------------- */
/* Patches                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Fields to merge into the open record.
 *
 * `Partial<Film> & Partial<Album>` rather than `Partial<RecordEntry>`, which
 * would be a union of two partials and so unassignable from an object
 * literal mentioning `title` alone. Every key is optional, the key set is the
 * union of both records', and a key that does not belong on the record that
 * receives it fails `validateEntry` — which is the right failure: loud, at the
 * edit, with the field name in the message.
 */
export type RecordPatch = Partial<Film> & Partial<Album>;

/* -------------------------------------------------------------------------- */
/* Keys                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What identifies this entry in a URL and in the API: a film's record id, an
 * album's slug. `RecordsDef.slugField` says which, so this is one rule.
 */
export function recordEntryKey(records: RecordsDef, entry: RecordEntry): string {
  if (records.slugField === null) return entry.id;
  const value = (entry as unknown as Record<string, unknown>)[records.slugField];
  return typeof value === 'string' && value !== '' ? value : entry.id;
}

/** Entry ids, in file order. */
function idsOf(records: RecordsDef, file: RecordFile): string[] {
  return records.entries(file).map((entry) => entry.id);
}

/** Every key except the one belonging to `exceptId`. What a new slug must avoid. */
function takenKeys(records: RecordsDef, file: RecordFile, exceptId?: string): string[] {
  return records
    .entries(file)
    .filter((entry) => entry.id !== exceptId)
    .map((entry) => recordEntryKey(records, entry));
}

/* -------------------------------------------------------------------------- */
/* Normalising                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The one cross-field rule a generic store has to keep for the editor, from
 * docs/cms-contracts.md 10.2:
 *
 *   "`cover` must be the id of a photo in the same album. [...] Deleting the
 *    cover photo has to clear `cover` in the same edit."
 *
 * Doing it here means WS-E's album editor can delete a photo without
 * remembering, and cannot produce a file that fails validation on save for a
 * reason the author did not cause.
 */
export function normalizeEntry(entry: RecordEntry): RecordEntry {
  if (!isAlbum(entry)) return entry;
  if (entry.cover === undefined) return entry;
  if (entry.photos.some((photo: Photo) => photo.id === entry.cover)) return entry;
  const { cover: _dropped, ...rest } = entry;
  return rest as Album;
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

export type RecordStoreState = {
  section: RecordSectionId;
  /** The collection, as it stands in the editor. */
  file: RecordFile;
  /** Last known published collection, for discarding a draft. */
  published: RecordFile | null;
  hasDraft: boolean;

  /** `file`'s entries, in order. Derived; never edit in place. */
  entries: RecordEntry[];
  /** List rows for `file`. Derived through the section's own `summarise`. */
  summaries: RecordSummary[];

  /** Record id of the entry the editor has open, or null. */
  openId: string | null;

  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;

  phase: StorePhase;
  notice: Notice | null;
  issues: ValidationIssue[];
  lastSavedAt: number | null;
  lastCommit: string | null;
};

type Snapshot = { file: RecordFile; openId: string | null };

export type RecordEditOptions = CommitOptions & {
  /** Which entry to leave open after the edit. */
  openId?: string | null;
  notice?: string;
  undoable?: boolean;
};

export type RecordStoreOptions = {
  api: SiteApi;
  section: RecordSectionDef;
  /** Starting collection. The harness passes a fixture. */
  file?: RecordFile;
  published?: RecordFile | null;
  hasDraft?: boolean;
  openId?: string | null;
  now?: () => number;
};

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export type RecordStore = {
  readonly api: SiteApi;
  readonly section: RecordSectionDef;
  /** `section.records`, so a slot does not have to narrow to reach it. */
  readonly records: RecordsDef;

  getState(): RecordStoreState;
  subscribe(listener: () => void): () => void;

  /** The open entry, or null. */
  openEntry(): RecordEntry | null;
  /** The URL key of the open entry, or null. */
  openKey(): string | null;
  entryById(id: string): RecordEntry | null;
  /** Look an entry up by what the URL carries: a film's id, an album's slug. */
  entryByKey(key: string): RecordEntry | null;

  /** Open an entry. Not an edit: no history entry. */
  select(id: string | null): void;
  selectByKey(key: string): boolean;

  undo(): boolean;
  redo(): boolean;

  /** Escape hatch: any pure RecordFile -> RecordFile edit, as one history step. */
  update(recipe: (file: RecordFile) => RecordFile, options?: RecordEditOptions): boolean;

  /** Merge fields into one entry. Consecutive calls on one field coalesce. */
  patchEntry(id: string, patch: RecordPatch, options?: RecordEditOptions): boolean;
  /** Replace one entry wholesale. For a slot that keeps its own draft object. */
  replaceEntry(id: string, entry: RecordEntry, options?: RecordEditOptions): boolean;

  /** Append a fresh entry and open it. Returns its id. */
  createEntry(options?: { openIt?: boolean }): string | null;
  /** Copy an entry, under a new id and a free slug, and open it. */
  duplicateEntry(id: string, options?: { openIt?: boolean }): string | null;
  deleteEntry(id: string): boolean;
  /** Move an entry to `toIndex` in the file's array. That array *is* the site order. */
  moveEntry(id: string, toIndex: number): boolean;

  notify(kind: Notice['kind'], message: string, undoable?: boolean): void;
  dismissNotice(): void;
  validate(): { ok: boolean; issues: ValidationIssue[] };

  /** GET the collection. Draft wins over published, as for a document. */
  load(): Promise<boolean>;
  save(): Promise<boolean>;
  saveIfDirty(): Promise<boolean>;
  publish(): Promise<boolean>;
  discardDraft(): Promise<boolean>;
  /** POST to this section's media directory, under the open entry's own slug. */
  uploadMedia(file: File, entryKey?: string): Promise<MediaUploadResult>;

  reset(file: RecordFile, options?: { published?: RecordFile | null; hasDraft?: boolean; openId?: string | null }): void;
};

export function createRecordStore(options: RecordStoreOptions): RecordStore {
  const api = options.api;
  const section = options.section;
  const records = section.records;
  const now = options.now ?? (() => Date.now());

  const initialFile = options.file ?? records.empty();
  let baseline: RecordFile = initialFile;
  let history: History<Snapshot> = hist.emptyHistory<Snapshot>();
  let noticeId = 0;

  let state: RecordStoreState = {
    section: section.id,
    file: initialFile,
    published: options.published ?? null,
    hasDraft: options.hasDraft ?? false,
    entries: records.entries(initialFile),
    summaries: records.summarise(initialFile),
    openId: options.openId ?? null,
    dirty: false,
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
    phase: 'idle',
    notice: null,
    issues: [],
    lastSavedAt: null,
    lastCommit: null,
  };

  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  function set(patch: Partial<RecordStoreState>): void {
    state = { ...state, ...patch };
    emit();
  }

  function derive(file: RecordFile): Pick<RecordStoreState, 'entries' | 'summaries'> {
    return { entries: records.entries(file), summaries: records.summarise(file) };
  }

  function computeDirty(file: RecordFile): boolean {
    if (file === baseline) return false;
    return !deepEqual(file, baseline);
  }

  function historyFlags(): Pick<RecordStoreState, 'canUndo' | 'canRedo' | 'undoLabel' | 'redoLabel'> {
    return {
      canUndo: hist.canUndo(history),
      canRedo: hist.canRedo(history),
      undoLabel: hist.undoLabel(history),
      redoLabel: hist.redoLabel(history),
    };
  }

  function makeNotice(kind: Notice['kind'], message: string, undoable: boolean): Notice {
    noticeId += 1;
    return { id: noticeId, kind, message, undoable };
  }

  /** Keep the open entry only while it still exists. */
  function pruneOpen(file: RecordFile, wanted: string | null): string | null {
    if (wanted === null) return null;
    return idsOf(records, file).includes(wanted) ? wanted : null;
  }

  /* ---------------------------------------------------------------------- */
  /* Core edit path                                                          */
  /* ---------------------------------------------------------------------- */

  function update(recipe: (file: RecordFile) => RecordFile, editOptions: RecordEditOptions = {}): boolean {
    const next = recipe(state.file);
    if (next === state.file || deepEqual(next, state.file)) {
      if (editOptions.openId !== undefined) select(editOptions.openId);
      return false;
    }

    const previous: Snapshot = { file: state.file, openId: state.openId };
    history = hist.commit(history, previous, editOptions, now());

    const openId = pruneOpen(next, editOptions.openId === undefined ? state.openId : editOptions.openId);

    set({
      file: next,
      ...derive(next),
      openId,
      dirty: computeDirty(next),
      ...historyFlags(),
      notice:
        editOptions.notice === undefined
          ? null
          : makeNotice('info', editOptions.notice, editOptions.undoable === true),
      issues: [],
    });
    return true;
  }

  function applySnapshot(snapshot: Snapshot): void {
    set({
      file: snapshot.file,
      ...derive(snapshot.file),
      openId: pruneOpen(snapshot.file, snapshot.openId),
      dirty: computeDirty(snapshot.file),
      ...historyFlags(),
      notice: null,
      issues: [],
    });
  }

  function select(id: string | null): void {
    const next = pruneOpen(state.file, id);
    if (next === state.openId) return;
    set({ openId: next });
  }

  /** Write a new array back through the section's own `withEntries`. */
  function withEntries(file: RecordFile, entries: RecordEntry[]): RecordFile {
    return records.withEntries(file, entries);
  }

  function mapEntry(
    file: RecordFile,
    id: string,
    change: (entry: RecordEntry) => RecordEntry,
  ): RecordFile {
    const entries = records.entries(file);
    const index = entries.findIndex((entry) => entry.id === id);
    if (index < 0) return file;
    const next = [...entries];
    next[index] = normalizeEntry(change(entries[index] as RecordEntry));
    return withEntries(file, next);
  }

  /* ---------------------------------------------------------------------- */
  /* API calls                                                               */
  /* ---------------------------------------------------------------------- */

  function validate(): { ok: boolean; issues: ValidationIssue[] } {
    const result = records.validateFile(state.file);
    const issues = result.ok ? [] : result.issues;
    set({ issues });
    if (!result.ok && typeof console !== 'undefined') {
      console.warn(`[cms] ${section.id} does not validate:\n${formatIssues(issues)}`);
    }
    return { ok: result.ok, issues };
  }

  async function save(): Promise<boolean> {
    if (state.phase !== 'idle') return false;

    const check = validate();
    if (!check.ok) {
      set({
        notice: makeNotice('error', `Not saved: ${check.issues.length} validation problem(s).`, false),
      });
      return false;
    }

    const sent = state.file;
    set({ phase: 'saving', notice: null });
    try {
      const result = await api.putRecords(section.id, clone(sent));
      baseline = sent;
      set({
        phase: 'idle',
        hasDraft: true,
        dirty: computeDirty(state.file),
        lastSavedAt: now(),
        lastCommit: result.commit,
        notice: makeNotice('success', 'Draft saved.', false),
      });
      return true;
    } catch (error) {
      set({ phase: 'idle', notice: makeNotice('error', `Save failed: ${apiErrorMessage(error)}`, false) });
      return false;
    }
  }

  async function saveIfDirty(): Promise<boolean> {
    if (!state.dirty) return true;
    return save();
  }

  async function publish(): Promise<boolean> {
    if (state.phase !== 'idle') return false;
    // Publish copies the draft over the published file, so anything unsaved
    // would simply not be published (docs/cms-rebuild.md 2.3).
    if (state.dirty && !(await save())) return false;
    if (state.phase !== 'idle') return false;

    const sent = state.file;
    set({ phase: 'publishing', notice: null });
    try {
      const result = await api.publish(section.id, null);
      baseline = sent;
      set({
        phase: 'idle',
        published: clone(sent),
        hasDraft: false,
        dirty: computeDirty(state.file),
        lastCommit: result.commit,
        notice: makeNotice('success', 'Published.', false),
      });
      return true;
    } catch (error) {
      set({ phase: 'idle', notice: makeNotice('error', `Publish failed: ${apiErrorMessage(error)}`, false) });
      return false;
    }
  }

  async function discardDraft(): Promise<boolean> {
    if (state.phase !== 'idle') return false;
    set({ phase: 'discarding', notice: null });
    try {
      await api.deleteDraft(section.id, null);
      const fallback = state.published;
      if (fallback !== null) {
        reset(fallback, { published: fallback, hasDraft: false, openId: state.openId });
        set({ notice: makeNotice('info', 'Draft discarded. Showing the published collection.', false) });
      } else {
        set({ hasDraft: false, notice: makeNotice('info', 'Draft discarded.', false) });
      }
      set({ phase: 'idle' });
      return true;
    } catch (error) {
      set({ phase: 'idle', notice: makeNotice('error', `Discard failed: ${apiErrorMessage(error)}`, false) });
      return false;
    }
  }

  async function load(): Promise<boolean> {
    set({ phase: 'loading', notice: null });
    try {
      const got = await api.getRecords(section.id);
      const file = got.draft ?? got.published ?? records.empty();
      reset(file, {
        published: got.published,
        hasDraft: got.draft !== null,
        openId: state.openId,
      });
      set({ phase: 'idle' });
      return true;
    } catch (error) {
      set({ phase: 'idle', notice: makeNotice('error', `Load failed: ${apiErrorMessage(error)}`, false) });
      return false;
    }
  }

  async function uploadMedia(file: File, entryKey?: string): Promise<MediaUploadResult> {
    const key = entryKey ?? openKey();
    if (key === null) {
      throw new Error(`cannot upload to ${section.id}: no ${records.noun} is open`);
    }
    return api.uploadMedia(section.id, mediaSlugFor(section, key), file);
  }

  function reset(
    file: RecordFile,
    resetOptions: { published?: RecordFile | null; hasDraft?: boolean; openId?: string | null } = {},
  ): void {
    baseline = file;
    history = hist.emptyHistory<Snapshot>();
    set({
      file,
      ...derive(file),
      published: resetOptions.published === undefined ? state.published : resetOptions.published,
      hasDraft: resetOptions.hasDraft === undefined ? state.hasDraft : resetOptions.hasDraft,
      openId: pruneOpen(file, resetOptions.openId === undefined ? state.openId : resetOptions.openId),
      dirty: false,
      ...historyFlags(),
      notice: null,
      issues: [],
    });
  }

  function openEntry(): RecordEntry | null {
    if (state.openId === null) return null;
    return state.entries.find((entry) => entry.id === state.openId) ?? null;
  }

  function openKey(): string | null {
    const entry = openEntry();
    return entry === null ? null : recordEntryKey(records, entry);
  }

  /* ---------------------------------------------------------------------- */
  /* Public surface                                                          */
  /* ---------------------------------------------------------------------- */

  const store: RecordStore = {
    api,
    section,
    records,

    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    openEntry,
    openKey,

    entryById(id) {
      return state.entries.find((entry) => entry.id === id) ?? null;
    },

    entryByKey(key) {
      return state.entries.find((entry) => recordEntryKey(records, entry) === key) ?? null;
    },

    select,

    selectByKey(key) {
      const entry = store.entryByKey(key);
      if (entry === null) return false;
      select(entry.id);
      return true;
    },

    undo() {
      const step = hist.undo(history, { file: state.file, openId: state.openId });
      if (step === null) return false;
      history = step.history;
      applySnapshot(step.snapshot);
      return true;
    },

    redo() {
      const step = hist.redo(history, { file: state.file, openId: state.openId });
      if (step === null) return false;
      history = step.history;
      applySnapshot(step.snapshot);
      return true;
    },

    update,

    patchEntry(id, patch, editOptions) {
      const keys = Object.keys(patch).join(',');
      return update((file) => mapEntry(file, id, (entry) => ({ ...entry, ...patch } as RecordEntry)), {
        label: `edit ${records.noun}`,
        coalesceKey: `record:${id}:${keys}`,
        ...editOptions,
      });
    },

    replaceEntry(id, entry, editOptions) {
      if (entry.id !== id) {
        throw new TypeError(`replaceEntry("${id}", ...) was given an entry with id "${entry.id}"`);
      }
      return update((file) => mapEntry(file, id, () => entry), {
        label: `edit ${records.noun}`,
        coalesceKey: `record:${id}`,
        ...editOptions,
      });
    },

    createEntry(createOptions) {
      const fresh = freshEntry(records, state.file);
      const changed = update(
        (file) => withEntries(file, [...records.entries(file), fresh]),
        {
          label: `add ${records.noun}`,
          ...(createOptions?.openIt === false ? {} : { openId: fresh.id }),
        },
      );
      return changed ? fresh.id : null;
    },

    duplicateEntry(id, duplicateOptions) {
      const source = store.entryById(id);
      if (source === null) return null;
      const copy = copyEntry(records, state.file, source);
      const index = records.entries(state.file).findIndex((entry) => entry.id === id);
      const changed = update(
        (file) => {
          const entries = [...records.entries(file)];
          entries.splice(index + 1, 0, copy);
          return withEntries(file, entries);
        },
        {
          label: `duplicate ${records.noun}`,
          ...(duplicateOptions?.openIt === false ? {} : { openId: copy.id }),
        },
      );
      return changed ? copy.id : null;
    },

    deleteEntry(id) {
      const entry = store.entryById(id);
      if (entry === null) return false;
      return update((file) => withEntries(file, records.entries(file).filter((candidate) => candidate.id !== id)), {
        label: `delete ${records.noun}`,
        // Pruning clears `openId` only if it pointed at the entry that went.
        notice: `Deleted “${entry.title}”.`,
        undoable: true,
      });
    },

    moveEntry(id, toIndex) {
      return update(
        (file) => {
          const entries = records.entries(file);
          const from = entries.findIndex((entry) => entry.id === id);
          if (from < 0) return file;
          const to = Math.max(0, Math.min(entries.length - 1, toIndex));
          if (to === from) return file;
          const next = [...entries];
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved as RecordEntry);
          return withEntries(file, next);
        },
        { label: `move ${records.noun}`, openId: id },
      );
    },

    notify(kind, message, undoable = false) {
      set({ notice: makeNotice(kind, message, undoable) });
    },

    dismissNotice() {
      if (state.notice !== null) set({ notice: null });
    },

    validate,
    load,
    save,
    saveIfDirty,
    publish,
    discardDraft,
    uploadMedia,
    reset,
  };

  return store;
}

/* -------------------------------------------------------------------------- */
/* Fresh and copied entries                                                    */
/* -------------------------------------------------------------------------- */

/** Structured clone, or JSON when there is none (older runtimes). */
function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * `records.create()`, with its slug made unique.
 *
 * `newAlbum()` derives its slug from its title, so two new albums in a row
 * would both be `untitled-album` and `PhotographySchema` refuses duplicate
 * slugs. A film has no slug field and is returned untouched.
 */
export function freshEntry(records: RecordsDef, file: RecordFile): RecordEntry {
  const entry = records.create();
  if (records.slugField === null) return entry;
  const field = records.slugField;
  const current = (entry as unknown as Record<string, unknown>)[field];
  const wanted = typeof current === 'string' && current !== '' ? current : entry.id;
  const free = uniqueSlug(wanted, takenKeys(records, file), entry.id.replace(/_/g, '-'));
  return { ...entry, [field]: free } as RecordEntry;
}

/** A copy of `source` with a new record id, a copied title and a free slug. */
export function copyEntry(records: RecordsDef, file: RecordFile, source: RecordEntry): RecordEntry {
  const copy = clone(source) as RecordEntry;
  const titled = {
    ...copy,
    id: newId(records.idPrefix),
    [records.titleField]: copyTitle(
      String((copy as unknown as Record<string, unknown>)[records.titleField] ?? ''),
    ),
  } as RecordEntry;

  if (records.slugField === null) return titled;
  const field = records.slugField;
  const wanted = String((titled as unknown as Record<string, unknown>)[field] ?? titled.id);
  const free = uniqueSlug(wanted, takenKeys(records, file), titled.id.replace(/_/g, '-'));
  return { ...titled, [field]: free } as RecordEntry;
}
