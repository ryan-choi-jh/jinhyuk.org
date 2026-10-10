/**
 * src/cms/app/guide/storage.ts
 *
 * One flag in localStorage: has this browser been shown the guide.
 *
 * Every access is wrapped, including reaching for `window.localStorage`
 * itself, because that property getter is what throws when a browser blocks
 * site data. The three ways this fails in practice:
 *
 *  - a private window, where the getter throws a SecurityError;
 *  - site data cleared, where the read simply returns null;
 *  - storage full or a quota of zero, where the write throws.
 *
 * None of them may break the guide. A browser that cannot remember is a
 * browser that sees the guide every time, which is annoying and harmless, and
 * is strictly better than an editor that fails to boot.
 */

/** Namespaced, versioned, and obvious in a devtools storage pane. */
export const GUIDE_SEEN_KEY = 'jinhyuk-cms.guide-seen.v1';

const SEEN_VALUE = '1';

export type FlagState =
  /** The flag is present: this browser has been shown the guide. */
  | 'set'
  /** Storage works and the flag is not there: a first visit. */
  | 'unset'
  /** Storage could not be read at all. Treat as a first visit, remember nothing. */
  | 'unavailable';

/**
 * The store, or null if touching it throws. Not cached: a value cached at
 * module load would be wrong after the user changes their site-data setting,
 * and this runs a handful of times per session.
 */
function store(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const local = window.localStorage;
    // A stub can exist and still be unusable; the read below is the real test.
    return local ?? null;
  } catch {
    return null;
  }
}

export function readFlag(key: string = GUIDE_SEEN_KEY): FlagState {
  try {
    const local = store();
    if (local === null) return 'unavailable';
    return local.getItem(key) === SEEN_VALUE ? 'set' : 'unset';
  } catch {
    return 'unavailable';
  }
}

/** Returns whether it actually persisted. */
export function writeFlag(key: string = GUIDE_SEEN_KEY): boolean {
  try {
    const local = store();
    if (local === null) return false;
    local.setItem(key, SEEN_VALUE);
    return true;
  } catch {
    return false;
  }
}

/** Returns whether it actually cleared. Used by `forget()`. */
export function clearFlag(key: string = GUIDE_SEEN_KEY): boolean {
  try {
    const local = store();
    if (local === null) return false;
    local.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
