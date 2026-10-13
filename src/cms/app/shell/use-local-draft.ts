/**
 * src/cms/app/shell/use-local-draft.ts
 *
 * Keep a crash copy of the open document, and offer it back once.
 *
 * The store stays pure: it has no idea this exists, which is what lets
 * `verify-state.ts` drive it under bare node with no DOM. This hook
 * subscribes from outside, writes on a debounce, and clears the moment a
 * real save lands, so a snapshot only ever exists for work the server has
 * not got.
 *
 * `src/cms/app/state/local-draft.ts` has the reasoning: why this is not a
 * server autosave (every server save is a git commit), and why a snapshot is
 * offered and never applied.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  clearLocalDraft,
  describeAge,
  localDraftKey,
  readLocalDraft,
  worthOffering,
  writeLocalDraft,
} from '../state/local-draft.ts';
import type { LocalDraft } from '../state/local-draft.ts';
import type { DocStore } from '../state/store.ts';

/**
 * Long enough that typing a sentence is one write, short enough that a crash
 * costs a sentence rather than a paragraph.
 */
export const SNAPSHOT_DEBOUNCE_MS = 1200;

export type LocalDraftOffer = {
  /** Null when there is nothing worth offering. */
  found: LocalDraft | null;
  /** "11 minutes ago". */
  age: string;
  /** Put it in the editor. One undoable step, like any other edit. */
  restore: () => void;
  /** Throw it away and stop asking. */
  dismiss: () => void;
};

export function useLocalDraft(store: DocStore, enabled = true): LocalDraftOffer {
  const [found, setFound] = useState<LocalDraft | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** The key this hook is currently looking after, so a change of entry re-checks. */
  const state = store.getState();
  const key = localDraftKey(state.doc.meta.section ?? 'page', state.slug);
  const checked = useRef<string | null>(null);

  /* ---- offer, once per entry, on arrival -------------------------------- */
  useEffect(() => {
    if (!enabled) return;
    if (checked.current === key) return;
    checked.current = key;
    const at = Date.now();
    const snapshot = readLocalDraft(key, at);
    setNow(at);
    setFound(worthOffering(snapshot, store.getState().doc) ? snapshot : null);
    // A snapshot that matches what is already open has done its job and is
    // only clutter.
    if (snapshot !== null && !worthOffering(snapshot, store.getState().doc)) clearLocalDraft(key);
  }, [enabled, key, store]);

  /* ---- write, debounced, while there is something unsaved --------------- */
  useEffect(() => {
    if (!enabled) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = store.subscribe(() => {
      const current = store.getState();
      // Clean means the server has it. Nothing to protect, and leaving a
      // stale snapshot behind would offer yesterday over today tomorrow.
      if (!current.dirty) {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        clearLocalDraft(key);
        return;
      }
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        writeLocalDraft(key, store.getState().doc, Date.now());
      }, SNAPSHOT_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [enabled, key, store]);

  const restore = useCallback(() => {
    if (found === null) return;
    const doc = found.doc;
    // Through `update`, so it is one undo step and the author can change
    // their mind, rather than a reset that throws the history away.
    store.update(() => doc, {
      label: 'restore the copy from this browser',
      notice: 'Restored what this browser had. Undo puts it back.',
      undoable: true,
    });
    setFound(null);
  }, [found, store]);

  const dismiss = useCallback(() => {
    clearLocalDraft(key);
    setFound(null);
  }, [key]);

  return { found, age: found === null ? '' : describeAge(found.at, now), restore, dismiss };
}
