/**
 * src/cms/app/state/history.ts
 *
 * WS-3. Undo and redo, as a pure data structure over snapshots. Generic so it
 * can be tested without a document, and so the store decides what a snapshot
 * contains (it uses `{ doc, selection }`, because undoing a delete should also
 * put the selection back).
 *
 * Three commit modes, which is all a one-person tool needs:
 *
 *  - plain commit: push the previous snapshot, clear the redo stack.
 *  - coalescing commit: a drag or a run of typing produces dozens of states a
 *    second. Passing the same `coalesceKey` within `COALESCE_MS` folds them
 *    into the one history step that started the gesture.
 *  - transient change (not here, see the store): no history entry at all, for
 *    selection and other editor-only state.
 *
 * `now` is a parameter rather than a call to `Date.now()` so coalescing is
 * deterministic in a test.
 */

/** How many undo steps are kept. Older ones fall off the bottom. */
export const HISTORY_LIMIT = 200;

/** Commits sharing a `coalesceKey` inside this window fold into one step. */
export const COALESCE_MS = 600;

export type HistoryFrame<S> = {
  /** State to return to. */
  snapshot: S;
  /** What the edit that moved us off this snapshot was called, e.g. "delete band". */
  label: string;
};

export type History<S> = {
  past: HistoryFrame<S>[];
  future: HistoryFrame<S>[];
  /** Bookkeeping for coalescing. Null means the next commit cannot fold. */
  open: { key: string; at: number } | null;
};

export function emptyHistory<S>(): History<S> {
  return { past: [], future: [], open: null };
}

export function canUndo<S>(history: History<S>): boolean {
  return history.past.length > 0;
}

export function canRedo<S>(history: History<S>): boolean {
  return history.future.length > 0;
}

/** Label of the step `undo()` would take, for the button's tooltip. */
export function undoLabel<S>(history: History<S>): string | null {
  return history.past.length > 0 ? (history.past[history.past.length - 1] as HistoryFrame<S>).label : null;
}

export function redoLabel<S>(history: History<S>): string | null {
  return history.future.length > 0 ? (history.future[history.future.length - 1] as HistoryFrame<S>).label : null;
}

export type CommitOptions = {
  /** Shown in the undo tooltip. Keep it lower case and imperative: "move band". */
  label?: string;
  /**
   * Fold consecutive commits that share this key, inside `COALESCE_MS`. Use
   * one key per gesture, e.g. `drag:i_dense_rotated`. Omit for a discrete edit.
   */
  coalesceKey?: string;
};

/**
 * Record `previous` as somewhere to come back to. Call it with the snapshot
 * taken BEFORE the edit; the new state lives in the store, not in here.
 */
export function commit<S>(
  history: History<S>,
  previous: S,
  options: CommitOptions,
  now: number,
): History<S> {
  const label = options.label ?? 'edit';
  const key = options.coalesceKey;

  const foldable =
    key !== undefined &&
    history.open !== null &&
    history.open.key === key &&
    now - history.open.at <= COALESCE_MS &&
    history.past.length > 0;

  if (foldable) {
    // The step that started the gesture is already on the stack. Keep it, and
    // keep the window open so the rest of the gesture folds in too.
    return { past: history.past, future: [], open: { key: key as string, at: now } };
  }

  const past = [...history.past, { snapshot: previous, label }];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, future: [], open: key === undefined ? null : { key, at: now } };
}

export type Step<S> = { history: History<S>; snapshot: S };

/** Step back. `current` goes onto the redo stack. Null when there is nothing to undo. */
export function undo<S>(history: History<S>, current: S): Step<S> | null {
  if (history.past.length === 0) return null;
  const past = [...history.past];
  const frame = past.pop() as HistoryFrame<S>;
  return {
    history: {
      past,
      future: [...history.future, { snapshot: current, label: frame.label }],
      open: null,
    },
    snapshot: frame.snapshot,
  };
}

/** Step forward. Null when there is nothing to redo. */
export function redo<S>(history: History<S>, current: S): Step<S> | null {
  if (history.future.length === 0) return null;
  const future = [...history.future];
  const frame = future.pop() as HistoryFrame<S>;
  return {
    history: {
      past: [...history.past, { snapshot: current, label: frame.label }],
      future,
      open: null,
    },
    snapshot: frame.snapshot,
  };
}
