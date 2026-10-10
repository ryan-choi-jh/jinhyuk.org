/**
 * src/cms/app/state/store.ts
 *
 * WS-3. The document store: one `Doc`, undo and redo, dirty tracking, a
 * selection model, and the save/publish calls that go through `CmsApi`.
 *
 * It is a plain observable object, not a React thing. React binds to it in
 * `./use-doc-store.ts` through `useSyncExternalStore`. That split is what lets
 * `./verify-state.ts` prove undo, redo and dirty tracking under bare `node`,
 * with no DOM at all.
 *
 * Rules it keeps:
 *  - Every state object is new; nothing is mutated in place, so React's
 *    reference comparison is enough.
 *  - Editor state (selection, notices, phase) never enters the document.
 *    docs/cms-contracts.md 2.2 rule 1: a strict schema rejects stray keys.
 *  - Dirty is structural, not referential. Editing a value and putting it back
 *    reports clean, and so does undoing to the last saved state.
 */

import { formatIssues, validateDoc } from '../../schema.ts';
import type { Band, CanvasItem, Doc, DocMeta, ProseBlockKind, ValidationIssue } from '../../schema.ts';
import { apiErrorMessage } from './api.ts';
import type { AuthStatus, CmsApi } from './api.ts';
import * as ops from './doc-ops.ts';
import * as hist from './history.ts';
import type { CommitOptions, History } from './history.ts';
import {
  NO_SELECTION,
  pruneSelection,
  sameSelection,
  selectBand,
  selectBlock,
  selectItems,
} from './selection.ts';
import type { Selection } from './selection.ts';

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

export type StorePhase = 'idle' | 'loading' | 'saving' | 'publishing' | 'discarding';

export type Notice = {
  /** Increments, so a repeated message still re-renders and re-announces. */
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
  /** True when the shell should offer an Undo button next to the message. */
  undoable: boolean;
};

export type DocStoreState = {
  /** Slug the editor is editing. Comes from `doc.meta.slug` on load. */
  slug: string;
  doc: Doc;
  /** Last known published document, for reference and for discarding a draft. */
  published: Doc | null;
  /** Whether a draft exists on the server. */
  hasDraft: boolean;

  selection: Selection;

  /** Document differs structurally from the last saved or loaded state. */
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;

  phase: StorePhase;
  notice: Notice | null;
  /** Issues from the last `validate()`, which `save()` always runs first. */
  issues: ValidationIssue[];
  lastSavedAt: number | null;
  lastCommit: string | null;
  auth: AuthStatus | null;
};

type Snapshot = { doc: Doc; selection: Selection };

export type EditOptions = CommitOptions & {
  /** Where to leave the selection after the edit. */
  selection?: Selection;
  /** Status-line message. */
  notice?: string;
  /** Offer Undo beside the notice. Use for anything destructive. */
  undoable?: boolean;
};

export type DocStoreOptions = {
  api: CmsApi;
  /** Starting document. The harness passes a fixture; the real app passes what `getPage` returned. */
  doc: Doc;
  published?: Doc | null;
  hasDraft?: boolean;
  /** Injectable clock, so history coalescing is deterministic in a test. */
  now?: () => number;
};

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export type DocStore = {
  readonly api: CmsApi;

  getState(): DocStoreState;
  subscribe(listener: () => void): () => void;

  /* selection, no history */
  select(selection: Selection): void;
  selectBand(bandId: string): void;
  selectBlock(bandId: string, blockId: string): void;
  selectItems(bandId: string, itemIds: readonly string[]): void;
  clearSelection(): void;

  /* history */
  undo(): boolean;
  redo(): boolean;

  /* escape hatch: any pure Doc -> Doc edit, committed as one history step */
  update(recipe: (doc: Doc) => Doc, options?: EditOptions): boolean;

  /* bands */
  insertBand(type: Band['type'], index: number): string | null;
  deleteBand(bandId: string): void;
  moveBand(bandId: string, toIndex: number): void;
  setBandHeight(bandId: string, height: number, options?: EditOptions): void;
  setBandOverlay(bandId: string, overlay: boolean): void;

  /* canvas items */
  setCanvasItems(bandId: string, items: CanvasItem[], options?: EditOptions): void;
  addCanvasItem(bandId: string, item: CanvasItem): void;
  updateCanvasItem(bandId: string, itemId: string, patch: Partial<CanvasItem>, options?: EditOptions): void;
  deleteCanvasItem(bandId: string, itemId: string): void;

  /* prose blocks */
  setBlockContent(bandId: string, blockId: string, content: unknown[], options?: EditOptions): void;
  setBlockKind(bandId: string, blockId: string, kind: ProseBlockKind): void;
  insertProseBlock(bandId: string, index: number, kind?: ProseBlockKind): void;
  deleteProseBlock(bandId: string, blockId: string): void;
  moveProseBlock(bandId: string, blockId: string, toIndex: number): void;

  /* meta */
  updateMeta(patch: Partial<DocMeta>, options?: EditOptions): void;

  /* notices and validation */
  notify(kind: Notice['kind'], message: string, undoable?: boolean): void;
  dismissNotice(): void;
  validate(): { ok: boolean; issues: ValidationIssue[] };

  /* api */
  loadPage(slug: string): Promise<boolean>;
  save(): Promise<boolean>;
  saveIfDirty(): Promise<boolean>;
  publish(): Promise<boolean>;
  discardDraft(): Promise<boolean>;
  refreshAuth(): Promise<void>;

  /** Replace the document and reset history and the dirty baseline. */
  reset(doc: Doc, options?: { published?: Doc | null; hasDraft?: boolean }): void;
};

export function createDocStore(options: DocStoreOptions): DocStore {
  const api = options.api;
  const now = options.now ?? (() => Date.now());

  let baseline: Doc = options.doc;
  let history: History<Snapshot> = hist.emptyHistory<Snapshot>();
  let noticeId = 0;

  let state: DocStoreState = {
    slug: options.doc.meta.slug,
    doc: options.doc,
    published: options.published ?? null,
    hasDraft: options.hasDraft ?? false,
    selection: NO_SELECTION,
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
    auth: null,
  };

  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  function set(patch: Partial<DocStoreState>): void {
    state = { ...state, ...patch };
    emit();
  }

  function computeDirty(doc: Doc): boolean {
    if (doc === baseline) return false;
    return !ops.docsEqual(doc, baseline);
  }

  function historyFlags(): Pick<DocStoreState, 'canUndo' | 'canRedo' | 'undoLabel' | 'redoLabel'> {
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

  /* ---------------------------------------------------------------------- */
  /* Core edit path                                                          */
  /* ---------------------------------------------------------------------- */

  function update(recipe: (doc: Doc) => Doc, editOptions: EditOptions = {}): boolean {
    const nextDoc = recipe(state.doc);
    const wantedSelection = editOptions.selection;

    if (nextDoc === state.doc) {
      // Nothing changed in the document. Honour a requested selection move so
      // callers can use one entry point, but never touch history for it.
      if (wantedSelection !== undefined) select(wantedSelection);
      return false;
    }

    const previous: Snapshot = { doc: state.doc, selection: state.selection };
    history = hist.commit(history, previous, editOptions, now());

    const selection = pruneSelection(nextDoc, wantedSelection ?? state.selection);

    set({
      doc: nextDoc,
      selection,
      dirty: computeDirty(nextDoc),
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
      doc: snapshot.doc,
      selection: pruneSelection(snapshot.doc, snapshot.selection),
      dirty: computeDirty(snapshot.doc),
      ...historyFlags(),
      notice: null,
      issues: [],
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Selection                                                               */
  /* ---------------------------------------------------------------------- */

  function select(next: Selection): void {
    const pruned = pruneSelection(state.doc, next);
    if (sameSelection(pruned, state.selection)) return;
    set({ selection: pruned });
  }

  /* ---------------------------------------------------------------------- */
  /* API calls                                                               */
  /* ---------------------------------------------------------------------- */

  async function save(): Promise<boolean> {
    if (state.phase !== 'idle') return false;

    const check = validate();
    if (!check.ok) {
      set({
        notice: makeNotice('error', `Not saved: ${check.issues.length} validation problem(s).`, false),
      });
      return false;
    }

    const sent = state.doc;
    set({ phase: 'saving', notice: null });
    try {
      const result = await api.putDraft(state.slug, ops.cloneDoc(sent));
      baseline = sent;
      set({
        phase: 'idle',
        hasDraft: true,
        dirty: computeDirty(state.doc),
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
    // Publish copies the draft over the published file (2.3), so anything not
    // saved would simply not be published. Save first, silently.
    if (state.dirty && !(await save())) return false;
    if (state.phase !== 'idle') return false;

    const sent = state.doc;
    set({ phase: 'publishing', notice: null });
    try {
      const result = await api.publish(state.slug);
      baseline = sent;
      set({
        phase: 'idle',
        published: ops.cloneDoc(sent),
        hasDraft: false,
        dirty: computeDirty(state.doc),
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
      await api.deleteDraft(state.slug);
      const fallback = state.published;
      if (fallback !== null) {
        reset(fallback, { published: fallback, hasDraft: false });
        set({ notice: makeNotice('info', 'Draft discarded. Showing the published page.', false) });
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

  async function loadPage(slug: string): Promise<boolean> {
    set({ phase: 'loading', notice: null });
    try {
      const page = await api.getPage(slug);
      const doc = page.draft ?? page.published;
      if (doc === null) {
        set({ phase: 'idle', notice: makeNotice('error', `No page "${slug}".`, false) });
        return false;
      }
      reset(doc, { published: page.published, hasDraft: page.draft !== null });
      set({ phase: 'idle' });
      return true;
    } catch (error) {
      set({ phase: 'idle', notice: makeNotice('error', `Load failed: ${apiErrorMessage(error)}`, false) });
      return false;
    }
  }

  async function refreshAuth(): Promise<void> {
    try {
      set({ auth: await api.authStatus() });
    } catch {
      set({ auth: { signedIn: false } });
    }
  }

  function validate(): { ok: boolean; issues: ValidationIssue[] } {
    const result = validateDoc(state.doc);
    const issues = result.ok ? [] : result.issues;
    set({ issues });
    if (!result.ok && typeof console !== 'undefined') {
      console.warn(`[cms] document is invalid:\n${formatIssues(issues)}`);
    }
    return { ok: result.ok, issues };
  }

  function reset(doc: Doc, resetOptions: { published?: Doc | null; hasDraft?: boolean } = {}): void {
    baseline = doc;
    history = hist.emptyHistory<Snapshot>();
    set({
      slug: doc.meta.slug,
      doc,
      published: resetOptions.published === undefined ? state.published : resetOptions.published,
      hasDraft: resetOptions.hasDraft === undefined ? state.hasDraft : resetOptions.hasDraft,
      selection: NO_SELECTION,
      dirty: false,
      ...historyFlags(),
      notice: null,
      issues: [],
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Public surface                                                          */
  /* ---------------------------------------------------------------------- */

  const store: DocStore = {
    api,

    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    select,
    selectBand: (bandId) => select(selectBand(bandId)),
    selectBlock: (bandId, blockId) => select(selectBlock(bandId, blockId)),
    selectItems: (bandId, itemIds) => select(selectItems(bandId, itemIds)),
    clearSelection: () => select(NO_SELECTION),

    undo() {
      const step = hist.undo(history, { doc: state.doc, selection: state.selection });
      if (step === null) return false;
      history = step.history;
      applySnapshot(step.snapshot);
      return true;
    },

    redo() {
      const step = hist.redo(history, { doc: state.doc, selection: state.selection });
      if (step === null) return false;
      history = step.history;
      applySnapshot(step.snapshot);
      return true;
    },

    update,

    insertBand(type, index) {
      const band = ops.createBand(type);
      const changed = update((doc) => ops.insertBand(doc, index, band), {
        label: `insert ${type} band`,
        selection: selectBand(band.id),
      });
      return changed ? band.id : null;
    },

    deleteBand(bandId) {
      const index = ops.bandIndexOf(state.doc, bandId);
      if (index < 0) return;
      update((doc) => ops.removeBand(doc, bandId), {
        label: 'delete band',
        // Pruning clears it only if it pointed into the band that just went.
        notice: `Deleted band ${index + 1}.`,
        undoable: true,
      });
    },

    moveBand(bandId, toIndex) {
      update((doc) => ops.moveBand(doc, bandId, toIndex), {
        label: 'move band',
        selection: selectBand(bandId),
      });
    },

    setBandHeight(bandId, height, editOptions) {
      update((doc) => ops.setBandHeight(doc, bandId, height), {
        label: 'set band height',
        coalesceKey: `height:${bandId}`,
        ...editOptions,
      });
    },

    setBandOverlay(bandId, overlay) {
      update((doc) => ops.setBandOverlay(doc, bandId, overlay), {
        label: overlay ? 'set overlay' : 'clear overlay',
      });
    },

    setCanvasItems(bandId, items, editOptions) {
      update((doc) => ops.setCanvasItems(doc, bandId, items), {
        label: 'edit canvas',
        coalesceKey: `canvas:${bandId}`,
        ...editOptions,
      });
    },

    addCanvasItem(bandId, item) {
      update((doc) => ops.addCanvasItem(doc, bandId, item), {
        label: 'add canvas item',
        selection: selectItems(bandId, [item.id]),
      });
    },

    updateCanvasItem(bandId, itemId, patch, editOptions) {
      update((doc) => ops.updateCanvasItem(doc, bandId, itemId, patch), {
        label: 'edit canvas item',
        coalesceKey: `item:${itemId}`,
        ...editOptions,
      });
    },

    deleteCanvasItem(bandId, itemId) {
      update((doc) => ops.removeCanvasItem(doc, bandId, itemId), {
        label: 'delete canvas item',
        // No explicit selection: pruning keeps whatever survives, which for a
        // multi-selection means the other items stay selected.
        notice: 'Deleted item.',
        undoable: true,
      });
    },

    setBlockContent(bandId, blockId, content, editOptions) {
      update((doc) => ops.setBlockContent(doc, bandId, blockId, content), {
        label: 'edit text',
        coalesceKey: `prose:${blockId}`,
        ...editOptions,
      });
    },

    setBlockKind(bandId, blockId, kind) {
      update((doc) => ops.setBlockKind(doc, bandId, blockId, kind), {
        label: `set block to ${kind}`,
        selection: selectBlock(bandId, blockId),
      });
    },

    insertProseBlock(bandId, index, kind = 'p') {
      update((doc) => ops.insertProseBlock(doc, bandId, index, kind), {
        label: 'insert block',
      });
    },

    deleteProseBlock(bandId, blockId) {
      update((doc) => ops.removeProseBlock(doc, bandId, blockId), {
        label: 'delete block',
        // Pruning falls back to the band when the selected block is the one gone.
        notice: 'Deleted block.',
        undoable: true,
      });
    },

    moveProseBlock(bandId, blockId, toIndex) {
      update((doc) => ops.moveProseBlock(doc, bandId, blockId, toIndex), {
        label: 'move block',
        selection: selectBlock(bandId, blockId),
      });
    },

    updateMeta(patch, editOptions) {
      update((doc) => ops.updateMeta(doc, patch), {
        label: 'edit page details',
        coalesceKey: `meta:${Object.keys(patch).join(',')}`,
        ...editOptions,
      });
    },

    notify(kind, message, undoable = false) {
      set({ notice: makeNotice(kind, message, undoable) });
    },

    dismissNotice() {
      if (state.notice !== null) set({ notice: null });
    },

    validate,
    loadPage,
    save,
    saveIfDirty,
    publish,
    discardDraft,
    refreshAuth,
    reset,
  };

  return store;
}
