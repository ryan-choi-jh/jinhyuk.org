/**
 * src/cms/app/state/site-store.ts
 *
 * WS-D. The layer above the document store: where we are in the site, what is
 * in each section, and which editor is open.
 *
 * Phase 1's `./store.ts` edits one document and knows nothing else. This does
 * not replace it — it owns one of them per document section and calls
 * `reset`/`loadPage` on it when the open entry changes, with the section-aware
 * API adapted back down to `CmsApi` by `documentApiFor`. The undo stack, the
 * dirty tracking, the selection model and the save/publish path are all
 * phase 1's, unedited.
 *
 * Three things are worth knowing before reading it.
 *
 * 1. A RECORD SECTION'S ENTRY LIST IS LIVE. A record collection is one file
 *    and one commit, so adding, renaming, deleting and reordering are local
 *    edits to `./record-store.ts`'s array, not API calls. The list the sidebar
 *    shows for those sections is therefore `records.summarise(file)` of that
 *    store's current file, kept in sync by a subscription, and it goes back
 *    with undo. Document sections' lists come from `listEntries`, because
 *    there each entry is its own file.
 *
 * 2. NAVIGATION IS GUARDED, ONCE. `navigate` refuses to move while the open
 *    editor is dirty unless `confirmDiscard()` says yes. The shell injects
 *    WS-3's existing guard (`useUnsavedChangesGuard`) into it, so there is one
 *    prompt and one wording for closing the tab, clicking a link, and moving
 *    between sections.
 *
 * 3. NOTHING HERE NAMES A SECTION. Every branch is on `section.shape` or
 *    `section.storage` from WS-A's registry, and every path, URL and field
 *    comes from the `SectionDef`. Adding a sixth section is a registry edit.
 */

import type { Doc, RecordFile, SectionId } from '../../schema.ts';
import {
  SECTIONS,
  isRecordSection,
  requireSection,
} from '../../sections.ts';
import type { DocumentSectionDef, RecordSectionDef, SectionDef } from '../../sections.ts';
import { apiErrorMessage } from './api.ts';
import type { AuthStatus } from './api.ts';
import { createDocFor, duplicateDoc } from './entries.ts';
import { createRecordStore, recordEntryKey } from './record-store.ts';
import type { RecordStore } from './record-store.ts';
import { OVERVIEW, entryRoute, resolveRoute, sameRoute } from './route.ts';
import type { CmsRoute, Navigator, ResolvedRoute } from './route.ts';
import { canDeleteEntry, documentApiFor } from './site-api.ts';
import type { EntrySummary, SectionSummary, SiteApi } from './site-api.ts';
import { createDocStore } from './store.ts';
import type { DocStore, Notice } from './store.ts';

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Which editor is mounted, and the store it is bound to. One discriminated
 * union, so the shell's dispatch is a `switch` the compiler checks rather than
 * a chain of section comparisons.
 */
export type EditorBinding =
  | {
      kind: 'document';
      section: DocumentSectionDef;
      /** Null for the singleton, whose API calls carry no slug. */
      entryKey: string | null;
      store: DocStore;
    }
  | {
      kind: 'records';
      section: RecordSectionDef;
      /** A film's record id, an album's slug. */
      entryKey: string;
      store: RecordStore;
    };

export type SiteStorePhase = 'idle' | 'loading' | 'working';

export type SiteStoreState = {
  /** Where we are, already looked up in the registry. */
  resolved: ResolvedRoute;
  /** Always every section, in sidebar order, even before the API answers. */
  sections: SectionSummary[];
  /** Entry lists, by section. Undefined means "not fetched yet". */
  entries: Partial<Record<SectionId, EntrySummary[]>>;
  /** Sections whose list is being fetched. */
  loading: Partial<Record<SectionId, boolean>>;
  /** The open editor, or null on the overview and on a section list. */
  editor: EditorBinding | null;
  phase: SiteStorePhase;
  notice: Notice | null;
  auth: AuthStatus | null;
};

export type SiteStoreOptions = {
  api: SiteApi;
  /** Where routes come from and go to. Default: the browser's history. */
  navigator: Navigator;
  /**
   * Asked before leaving a dirty editor. True to continue, false to stay.
   * The shell replaces it with WS-3's `useUnsavedChangesGuard().confirmDiscard`
   * so there is one prompt for every way out of a page. Default: allow.
   */
  confirmDiscard?: () => boolean;
  now?: () => number;
};

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export type SiteStore = {
  readonly api: SiteApi;

  getState(): SiteStoreState;
  subscribe(listener: () => void): () => void;

  /** Read the route, fetch what it needs, and listen for Back. Returns a teardown. */
  start(): () => void;
  /** Replace the guard asked before leaving a dirty editor. */
  setConfirmDiscard(confirm: () => boolean): void;

  /* navigation */
  navigate(route: CmsRoute, options?: { replace?: boolean; force?: boolean }): boolean;
  openOverview(): boolean;
  openSection(id: SectionId): boolean;
  openEntry(id: SectionId, key: string): boolean;
  /** True when the open editor has unsaved changes. */
  isDirty(): boolean;

  /* lists */
  refreshSections(): Promise<void>;
  refreshEntries(id: SectionId): Promise<void>;
  refreshAuth(): Promise<void>;
  /** The list for a section, or [] when it has not been fetched. */
  entriesOf(id: SectionId): EntrySummary[];

  /* entry operations */
  createEntry(id: SectionId): Promise<string | null>;
  duplicateEntry(id: SectionId, key: string): Promise<string | null>;
  deleteEntry(id: SectionId, key: string): Promise<boolean>;
  /** Move an entry by `delta` places. Ordered (record) sections only. */
  moveEntry(id: SectionId, key: string, delta: number): boolean;
  /** Whether this section supports each operation, so a button can be disabled with a reason. */
  can(id: SectionId): EntryCapabilities;

  notify(kind: Notice['kind'], message: string): void;
  dismissNotice(): void;

  /* stores, for the shell's editor region */
  docStore(id: SectionId): DocStore | null;
  recordStore(id: SectionId): RecordStore | null;
};

export type EntryCapabilities = {
  create: boolean;
  duplicate: boolean;
  delete: boolean;
  /** Only a section whose file order is the site order can be reordered. */
  reorder: boolean;
  /** Why `delete` is false, for a title attribute. Empty when it is true. */
  deleteReason: string;
};

/** The five rows the sidebar can draw before any API call has answered. */
export function registrySectionSummaries(): SectionSummary[] {
  return SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
    shape: section.shape,
    storage: section.storage,
    count: section.shape === 'singleton' ? 1 : 0,
    hasDraft: false,
  }));
}

export function createSiteStore(options: SiteStoreOptions): SiteStore {
  const api = options.api;
  const nav = options.navigator;
  const now = options.now ?? (() => Date.now());
  let confirmDiscard = options.confirmDiscard ?? ((): boolean => true);

  let noticeId = 0;
  const docStores = new Map<SectionId, DocStore>();
  const docApis = new Map<SectionId, ReturnType<typeof documentApiFor>>();
  const recordStores = new Map<SectionId, RecordStore>();
  /** One in-flight load per record section, so two callers share it. */
  const recordLoads = new Map<SectionId, Promise<RecordStore>>();
  /**
   * One per record section, kept so a subscription is never installed twice.
   * They are deliberately not torn down by `start`'s teardown: see there.
   */
  const recordUnsubscribes = new Map<SectionId, () => void>();
  /** Bumped on every applyRoute, so a slow fetch for an old route is dropped. */
  let generation = 0;

  let state: SiteStoreState = {
    resolved: resolveRoute(nav.current()),
    sections: registrySectionSummaries(),
    entries: {},
    loading: {},
    editor: null,
    phase: 'idle',
    notice: null,
    auth: null,
  };

  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  function set(patch: Partial<SiteStoreState>): void {
    state = { ...state, ...patch };
    emit();
  }

  function makeNotice(kind: Notice['kind'], message: string): Notice {
    noticeId += 1;
    return { id: noticeId, kind, message, undoable: false };
  }

  function fail(error: unknown, what: string): void {
    set({ phase: 'idle', notice: makeNotice('error', `${what}: ${apiErrorMessage(error)}`) });
  }

  function section_(id: SectionId): SectionDef {
    return requireSection(id);
  }

  /* ---------------------------------------------------------------------- */
  /* Lists                                                                   */
  /* ---------------------------------------------------------------------- */

  function setEntries(id: SectionId, rows: EntrySummary[]): void {
    const sections = state.sections.map((summary) =>
      summary.id === id
        ? {
            ...summary,
            count: summary.shape === 'singleton' ? 1 : rows.length,
            hasDraft: rows.some((row) => row.hasDraft),
          }
        : summary,
    );
    set({ entries: { ...state.entries, [id]: rows }, sections });
  }

  /** A record store's current file, as list rows. The list for those sections. */
  function rowsFromRecordStore(store: RecordStore): EntrySummary[] {
    const current = store.getState();
    return current.summaries.map((summary) => ({
      key: summary.key,
      title: summary.title,
      subtitle: summary.subtitle,
      thumb: summary.thumb,
      hasDraft: current.hasDraft || current.dirty,
      hasPublished: current.published !== null,
    }));
  }

  async function refreshEntries(id: SectionId): Promise<void> {
    const section = section_(id);
    if (isRecordSection(section)) {
      // The file is the list. Make sure it is loaded; the subscription below
      // writes the rows.
      await ensureRecordStore(section);
      return;
    }
    set({ loading: { ...state.loading, [id]: true } });
    try {
      setEntries(id, await api.listEntries(id));
    } catch (error) {
      fail(error, `Could not list ${section.label.toLowerCase()}`);
    } finally {
      set({ loading: { ...state.loading, [id]: false } });
    }
  }

  async function refreshSections(): Promise<void> {
    try {
      const rows = await api.listSections();
      const byId = new Map(rows.map((row) => [row.id, row]));
      set({
        sections: state.sections.map((summary) => {
          const fresh = byId.get(summary.id);
          if (fresh === undefined) return summary;
          // A record section's count and draft flag are owned by its store
          // once that store exists, because it may hold unsaved additions.
          const store = recordStores.get(summary.id);
          if (store !== undefined) {
            const current = store.getState();
            return {
              ...fresh,
              count: current.summaries.length,
              hasDraft: current.hasDraft || current.dirty,
            };
          }
          return fresh;
        }),
      });
    } catch (error) {
      fail(error, 'Could not list the sections');
    }
  }

  async function refreshAuth(): Promise<void> {
    try {
      set({ auth: await api.authStatus() });
    } catch {
      set({ auth: { signedIn: false } });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Stores                                                                  */
  /* ---------------------------------------------------------------------- */

  function docApiFor(section: DocumentSectionDef): ReturnType<typeof documentApiFor> {
    const existing = docApis.get(section.id);
    if (existing !== undefined) return existing;
    const made = documentApiFor(api, section);
    docApis.set(section.id, made);
    return made;
  }

  /**
   * The collection's store, loaded.
   *
   * It memoises the PROMISE, not the store, which matters: opening
   * `/cms/photography/first-build` asks for the list and for the editor in the
   * same tick, and a second caller handed a store whose `load()` had not
   * finished would look for an album in an empty file and conclude there is
   * no such album.
   */
  function ensureRecordStore(section: RecordSectionDef): Promise<RecordStore> {
    const inFlight = recordLoads.get(section.id);
    if (inFlight !== undefined) return inFlight;

    const store = createRecordStore({ api, section, now });
    recordStores.set(section.id, store);

    // One subscription per section, for as long as the site store lives: the
    // entry list, the sidebar count and the URL of an open album all follow
    // this file.
    const unsubscribe = store.subscribe(() => {
      setEntries(section.id, rowsFromRecordStore(store));
      syncRecordRoute(section, store);
    });
    recordUnsubscribes.set(section.id, unsubscribe);

    const loading = (async () => {
      await store.load();
      setEntries(section.id, rowsFromRecordStore(store));
      return store;
    })();
    recordLoads.set(section.id, loading);
    return loading;
  }

  /**
   * An album's URL key is its slug, and the slug is editable. When the open
   * album is renamed, move the address bar with it rather than leaving a URL
   * that no longer resolves. `replace`, not `push`: typing in a field should
   * not fill the Back button.
   */
  function syncRecordRoute(section: RecordSectionDef, store: RecordStore): void {
    if (state.resolved.section?.id !== section.id) return;
    if (state.resolved.view !== 'entry') return;
    const key = store.openKey();
    if (key === null || key === state.resolved.entryKey) return;
    const resolved = resolveRoute(entryRoute(section, key));
    nav.replace(resolved.route);
    set({
      resolved,
      editor:
        state.editor !== null && state.editor.kind === 'records'
          ? { ...state.editor, entryKey: key }
          : state.editor,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Routing                                                                 */
  /* ---------------------------------------------------------------------- */

  function isDirty(): boolean {
    const editor = state.editor;
    if (editor === null) return false;
    return editor.store.getState().dirty;
  }

  function navigate(route: CmsRoute, navOptions: { replace?: boolean; force?: boolean } = {}): boolean {
    const resolved = resolveRoute(route);
    // Already there, and there is nothing outstanding to bind.
    if (
      sameRoute(resolved.route, state.resolved.route) &&
      (state.resolved.view !== 'entry' || state.editor !== null)
    ) {
      return true;
    }

    if (navOptions.force !== true && isDirty() && !confirmDiscard()) return false;

    if (navOptions.replace === true) nav.replace(resolved.route);
    else nav.push(resolved.route);
    applyRoute(resolved);
    return true;
  }

  /** Set the route, then fetch whatever it needs. Never throws. */
  function applyRoute(resolved: ResolvedRoute): void {
    generation += 1;
    const mine = generation;
    set({ resolved, notice: null });

    void (async () => {
      const section = resolved.section;
      if (section === null) {
        set({ editor: null });
        await refreshSections();
        return;
      }

      // The list is beside the editor, so an entry route needs it too.
      if (section.shape === 'collection') void refreshEntries(section.id);

      if (resolved.view !== 'entry') {
        set({ editor: null });
        return;
      }

      set({ phase: 'loading' });
      try {
        const editor = isRecordSection(section)
          ? await bindRecords(section, resolved.entryKey)
          : await bindDocument(section, resolved.entryKey);
        if (mine !== generation) return;
        set({ phase: 'idle', editor });
      } catch (error) {
        if (mine !== generation) return;
        set({ editor: null });
        fail(error, 'Could not open it');
      }
    })();
  }

  async function bindDocument(
    section: DocumentSectionDef,
    entryKey: string | null,
  ): Promise<EditorBinding> {
    const store = docStores.get(section.id);
    const wanted = section.shape === 'singleton' ? null : entryKey;

    if (store === undefined) {
      const page = await api.getEntry(section.id, wanted);
      const doc = page.draft ?? page.published;
      if (doc === null) {
        throw new Error(`there is no ${section.noun} at "${entryKey ?? section.id}" yet`);
      }
      const made = createDocStore({
        api: docApiFor(section),
        doc,
        published: page.published,
        hasDraft: page.draft !== null,
        now,
      });
      docStores.set(section.id, made);
      return { kind: 'document', section, entryKey: wanted, store: made };
    }

    // One store per section, re-pointed at the entry being opened. `loadPage`
    // resets history and the dirty baseline, which is correct: the navigation
    // guard has already asked about anything unsaved.
    const slug = wanted ?? store.getState().slug;
    if (store.getState().slug !== slug) {
      const ok = await store.loadPage(slug);
      if (!ok) throw new Error(store.getState().notice?.message ?? `could not load "${slug}"`);
    }
    return { kind: 'document', section, entryKey: wanted, store };
  }

  async function bindRecords(
    section: RecordSectionDef,
    entryKey: string | null,
  ): Promise<EditorBinding> {
    const store = await ensureRecordStore(section);
    if (entryKey === null) throw new Error(`which ${section.records.noun}?`);
    if (!store.selectByKey(entryKey)) {
      throw new Error(`there is no ${section.records.noun} "${entryKey}" in ${section.label}`);
    }
    return { kind: 'records', section, entryKey, store };
  }

  /* ---------------------------------------------------------------------- */
  /* Entry operations                                                        */
  /* ---------------------------------------------------------------------- */

  function can(id: SectionId): EntryCapabilities {
    const section = section_(id);
    if (section.shape === 'singleton') {
      return {
        create: false,
        duplicate: false,
        delete: false,
        reorder: false,
        deleteReason: `${section.label} is the one ${section.noun} of its kind; it cannot be deleted.`,
      };
    }
    if (isRecordSection(section)) {
      return { create: true, duplicate: true, delete: true, reorder: true, deleteReason: '' };
    }
    const deletable = canDeleteEntry(api);
    return {
      create: true,
      duplicate: true,
      delete: deletable,
      // A document collection's order on the site comes from the date, not
      // from a list the author permutes.
      reorder: false,
      deleteReason: deletable
        ? ''
        : 'This build of the API has no endpoint for deleting a published page. ' +
          'Discard the draft instead, or delete the file in the repository.',
    };
  }

  function takenKeys(id: SectionId): string[] {
    return (state.entries[id] ?? []).map((row) => row.key);
  }

  async function createEntry(id: SectionId): Promise<string | null> {
    const section = section_(id);
    if (!can(id).create) return null;

    if (isRecordSection(section)) {
      const store = await ensureRecordStore(section);
      const newId = store.createEntry();
      if (newId === null) return null;
      const entry = store.entryById(newId);
      const key = entry === null ? null : recordEntryKey(section.records, entry);
      if (key !== null) navigate(entryRoute(section, key), { force: true });
      set({
        notice: makeNotice(
          'info',
          `New ${section.records.noun} added. It is not saved yet: Save writes the whole collection.`,
        ),
      });
      return key;
    }

    set({ phase: 'working' });
    try {
      // Re-read the list first. The new entry's slug is chosen to be free, and
      // "free" is decided against this list — a stale one would pick a slug
      // that exists and the PUT would land on somebody else's draft.
      await refreshEntries(id);
      const doc = createDocFor(section as DocumentSectionDef, { taken: takenKeys(id) });
      await api.putDraft(id, doc.meta.slug, doc);
      set({ phase: 'idle' });
      await refreshEntries(id);
      navigate(entryRoute(section, doc.meta.slug), { force: true });
      set({ notice: makeNotice('success', `Created “${doc.meta.title}” as a draft.`) });
      return doc.meta.slug;
    } catch (error) {
      fail(error, `Could not create a ${section.noun}`);
      return null;
    }
  }

  async function duplicateEntry(id: SectionId, key: string): Promise<string | null> {
    const section = section_(id);
    if (!can(id).duplicate) return null;

    if (isRecordSection(section)) {
      const store = await ensureRecordStore(section);
      const source = store.entryByKey(key);
      if (source === null) return null;
      const copyId = store.duplicateEntry(source.id);
      if (copyId === null) return null;
      const copy = store.entryById(copyId);
      const copyKey = copy === null ? null : recordEntryKey(section.records, copy);
      if (copyKey !== null) navigate(entryRoute(section, copyKey), { force: true });
      set({ notice: makeNotice('info', `Copied. Not saved yet.`) });
      return copyKey;
    }

    set({ phase: 'working' });
    try {
      const page = await api.getEntry(id, key);
      const source: Doc | null = page.draft ?? page.published;
      if (source === null) throw new Error(`there is nothing at "${key}" to copy`);
      // As in createEntry: the copy's slug is free only against a fresh list.
      await refreshEntries(id);
      const copy = duplicateDoc(source, { taken: takenKeys(id) });
      await api.putDraft(id, copy.meta.slug, copy);
      set({ phase: 'idle' });
      await refreshEntries(id);
      navigate(entryRoute(section, copy.meta.slug), { force: true });
      set({ notice: makeNotice('success', `Copied to “${copy.meta.title}” as a draft.`) });
      return copy.meta.slug;
    } catch (error) {
      fail(error, `Could not duplicate that ${section.noun}`);
      return null;
    }
  }

  async function deleteEntry(id: SectionId, key: string): Promise<boolean> {
    const section = section_(id);
    if (!can(id).delete) return false;

    if (isRecordSection(section)) {
      const store = await ensureRecordStore(section);
      const entry = store.entryByKey(key);
      if (entry === null) return false;
      const wasOpen = store.getState().openId === entry.id;
      const removed = store.deleteEntry(entry.id);
      if (removed && wasOpen) navigate({ kind: 'section', section: id }, { force: true });
      return removed;
    }

    const remove = api.deleteEntry;
    if (remove === undefined) return false;
    set({ phase: 'working' });
    try {
      await remove.call(api, id, key);
      set({ phase: 'idle' });
      // Drop the store if it was pointing at what just went, so reopening the
      // section does not try to re-save a document that has no file.
      if (state.resolved.entryKey === key && state.resolved.section?.id === id) {
        docStores.delete(id);
        navigate({ kind: 'section', section: id }, { force: true });
      }
      await refreshEntries(id);
      set({ notice: makeNotice('success', `Deleted “${key}”.`) });
      return true;
    } catch (error) {
      fail(error, `Could not delete that ${section.noun}`);
      return false;
    }
  }

  function moveEntry(id: SectionId, key: string, delta: number): boolean {
    const section = section_(id);
    if (!can(id).reorder || !isRecordSection(section)) return false;
    const store = recordStores.get(id);
    if (store === undefined) return false;
    const entry = store.entryByKey(key);
    if (entry === null) return false;
    const index = store.getState().entries.findIndex((candidate) => candidate.id === entry.id);
    if (index < 0) return false;
    return store.moveEntry(entry.id, index + delta);
  }

  /* ---------------------------------------------------------------------- */
  /* Public surface                                                          */
  /* ---------------------------------------------------------------------- */

  const store: SiteStore = {
    api,

    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start() {
      applyRoute(resolveRoute(nav.current()));
      void refreshSections();
      void refreshAuth();
      const stopListening = nav.listen((route) => {
        // Back and Forward have already happened, so there is nothing to
        // cancel: `force`, and let the editor's own beforeunload guard be the
        // thing that warned.
        applyRoute(resolveRoute(route));
      });
      // Only the navigator listener is torn down. The record subscriptions
      // belong to this store for as long as it lives, and dropping them here
      // would break a StrictMode remount: `start` runs twice, and the second
      // run reuses the memoised load without re-subscribing.
      return stopListening;
    },

    setConfirmDiscard(confirm) {
      confirmDiscard = confirm;
    },

    navigate,
    openOverview: () => navigate(OVERVIEW),
    openSection: (id) => navigate({ kind: 'section', section: id }),
    openEntry: (id, key) => navigate(entryRoute(section_(id), key)),
    isDirty,

    refreshSections,
    refreshEntries,
    refreshAuth,
    entriesOf: (id) => state.entries[id] ?? [],

    createEntry,
    duplicateEntry,
    deleteEntry,
    moveEntry,
    can,

    notify(kind, message) {
      set({ notice: makeNotice(kind, message) });
    },

    dismissNotice() {
      if (state.notice !== null) set({ notice: null });
    },

    docStore: (id) => docStores.get(id) ?? null,
    recordStore: (id) => recordStores.get(id) ?? null,
  };

  return store;
}

/* -------------------------------------------------------------------------- */
/* Small helpers the shell needs                                               */
/* -------------------------------------------------------------------------- */

/** The record file a section's store currently holds, for a preview or a diff. */
export function currentRecordFile(store: RecordStore): RecordFile {
  return store.getState().file;
}
