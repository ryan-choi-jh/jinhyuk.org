/**
 * src/cms/app/state/local-draft.ts
 *
 * A copy of what you are typing, in this browser, in case the tab dies.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT AUTOSAVE TO THE SERVER
 * ---------------------------------------------------------------------------
 *
 * Because every server save is a git commit. A debounced autosave would turn
 * an afternoon's writing into two hundred commits on `main`, and before the
 * Pages workflow learned to ignore `src/content/drafts/`, each one was also
 * a full site build. Saving is a deliberate act here and should stay one.
 *
 * What was missing is the thing a deliberate save cannot give you: cover for
 * a crash, a closed laptop, a tab shut by accident. The unsaved-changes
 * guard warns you on the way out, which is the last line of defence, not the
 * first, and it cannot fire at all if the process dies.
 *
 * ---------------------------------------------------------------------------
 * NEVER RESTORE SILENTLY
 * ---------------------------------------------------------------------------
 *
 * A snapshot is offered, never applied. Two reasons, and the second is the
 * one that matters: a stale snapshot quietly overwriting a newer published
 * page would be the worst bug this editor could have, and a restore the
 * author did not ask for is indistinguishable from the editor losing their
 * work. So the shell shows a line saying what it has and when, and nothing
 * happens until it is pressed.
 *
 * ---------------------------------------------------------------------------
 * localStorage, AND EVERY ACCESS IN A TRY/CATCH
 * ---------------------------------------------------------------------------
 *
 * Documents are JSON with `/media/` references in them rather than embedded
 * data, so they are tens of kilobytes and fit comfortably. localStorage can
 * be absent, full, or throw outright in a private window, and none of that
 * is worth a word to the author: the feature degrades to what the editor did
 * before it existed. It can also be per-origin shared between tabs, which is
 * why a snapshot records which tab wrote it.
 *
 * Nothing here is sent anywhere. It never leaves the browser.
 */

import { docsEqual } from './doc-ops.ts';
import type { Doc } from '../../schema.ts';

/** Bumped if the stored shape changes, so an old snapshot is ignored. */
const VERSION = 'v1';
const PREFIX = `jinhyuk-cms.local-draft.${VERSION}`;

/** Past this, assume something has gone wrong and do not store it. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * How long a snapshot is worth offering. Past a day it is far more likely to
 * be a forgotten tab than work in progress, and offering to restore
 * yesterday over today is how a snapshot does harm.
 */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type LocalDraft = {
  doc: Doc;
  /** When it was written, epoch ms. */
  at: number;
};

/** One entry per entry being edited. `home`, `essays/slug`, and so on. */
export function localDraftKey(section: string, slug: string | null): string {
  return `${PREFIX}:${section}${slug === null || slug === '' ? '' : `/${slug}`}`;
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): Storage | null {
  try {
    const value = globalThis.localStorage;
    // Touch it: in a private window the property exists and throws on use.
    value.getItem(`${PREFIX}:probe`);
    return value;
  } catch {
    return null;
  }
}

/** Write a snapshot. Returns false when it could not be stored, for any reason. */
export function writeLocalDraft(key: string, doc: Doc, at: number, store = storage()): boolean {
  if (store === null) return false;
  try {
    const text = JSON.stringify({ at, doc });
    if (text.length > MAX_BYTES) return false;
    store.setItem(key, text);
    return true;
  } catch {
    // Quota, most likely. Nothing to do and nothing worth saying: the editor
    // behaves as it did before this existed.
    return false;
  }
}

export function clearLocalDraft(key: string, store = storage()): void {
  if (store === null) return;
  try {
    store.removeItem(key);
  } catch {
    /* see above */
  }
}

/**
 * Read a snapshot back, or null.
 *
 * Anything unreadable, mis-shaped or older than MAX_AGE_MS reads as nothing.
 * A snapshot is a convenience; a corrupt one must never become a problem.
 */
export function readLocalDraft(key: string, now: number, store = storage()): LocalDraft | null {
  if (store === null) return null;
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const { at, doc } = parsed as { at?: unknown; doc?: unknown };
    if (typeof at !== 'number' || !Number.isFinite(at)) return null;
    if (doc === null || typeof doc !== 'object') return null;
    if (now - at > MAX_AGE_MS) return null;
    return { at, doc: doc as Doc };
  } catch {
    return null;
  }
}

/**
 * Is this snapshot worth offering?
 *
 * Only when it says something the editor does not already have. A snapshot
 * identical to what is on screen is the normal case — it is written from
 * that document — and offering to restore it would be a banner that never
 * goes away.
 *
 * Deliberately `docsEqual` and not a reference or a string comparison: the
 * document is rebuilt on every edit and its key order is not stable.
 */
export function worthOffering(snapshot: LocalDraft | null, current: Doc): boolean {
  if (snapshot === null) return false;
  return !docsEqual(snapshot.doc, current);
}

/** "3 minutes ago", for the line that offers it. */
export function describeAge(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'less than a minute ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}
