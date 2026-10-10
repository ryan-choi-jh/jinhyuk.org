/**
 * src/cms/app/state/use-site-store.ts
 *
 * WS-D. React bindings for `./site-store.ts` and `./record-store.ts`, built
 * the same way `./use-doc-store.ts` binds the document store: plain stores,
 * `useSyncExternalStore`, and a context so a slot mounted by WS-G can reach
 * the store without the shell drilling props through it.
 *
 * The two record hooks are here rather than in `./record-store.ts` for the
 * same reason the document ones are not in `./store.ts`: those files have to
 * stay runnable under bare node, with no React, which is what lets
 * `./verify-site-state.ts` prove navigation, undo and dirty tracking with no
 * DOM at all.
 */

import { createContext, useContext, useDebugValue, useRef, useSyncExternalStore } from 'react';

import type { RecordStore, RecordStoreState } from './record-store.ts';
import type { SiteStore, SiteStoreState } from './site-store.ts';

/* -------------------------------------------------------------------------- */
/* Generic                                                                     */
/* -------------------------------------------------------------------------- */

type Observable<S> = {
  getState(): S;
  subscribe(listener: () => void): () => void;
};

function useWholeState<S>(store: Observable<S>): S {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/**
 * One slice. Pass `isEqual` when the selector builds a new object or array, or
 * React will re-render forever comparing fresh references.
 */
function useSlice<S, T>(
  store: Observable<S>,
  selector: (state: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const cache = useRef<{ state: S; value: T } | null>(null);

  const getSnapshot = (): T => {
    const state = store.getState();
    const previous = cache.current;
    if (previous !== null && previous.state === state) return previous.value;
    const value = selector(state);
    if (previous !== null && isEqual(previous.value, value)) {
      cache.current = { state, value: previous.value };
      return previous.value;
    }
    cache.current = { state, value };
    return value;
  };

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/* -------------------------------------------------------------------------- */
/* Site store                                                                  */
/* -------------------------------------------------------------------------- */

/** Whole state. Re-renders on any change, which is fine for a tool this size. */
export function useSiteStoreState(store: SiteStore): SiteStoreState {
  const state = useWholeState(store);
  useDebugValue(state.resolved.route);
  return state;
}

export function useSiteStoreSelector<T>(
  store: SiteStore,
  selector: (state: SiteStoreState) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  return useSlice(store, selector, isEqual);
}

const SiteStoreContext = createContext<SiteStore | null>(null);

export const SiteStoreProvider = SiteStoreContext.Provider;

/** The site store, from anywhere the site shell renders. Throws outside it. */
export function useSiteStore(): SiteStore {
  const store = useContext(SiteStoreContext);
  if (store === null) {
    throw new Error('useSiteStore() must be called inside <SiteShell>, which provides SiteStoreProvider');
  }
  return store;
}

/** Same, but null outside the site shell. For components that work either way. */
export function useOptionalSiteStore(): SiteStore | null {
  return useContext(SiteStoreContext);
}

/* -------------------------------------------------------------------------- */
/* Record store                                                                */
/* -------------------------------------------------------------------------- */

export function useRecordStore(store: RecordStore): RecordStoreState {
  const state = useWholeState(store);
  useDebugValue(state.openId);
  return state;
}

export function useRecordStoreSelector<T>(
  store: RecordStore,
  selector: (state: RecordStoreState) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  return useSlice(store, selector, isEqual);
}

const RecordStoreContext = createContext<RecordStore | null>(null);

export const RecordStoreProvider = RecordStoreContext.Provider;

/**
 * The record store, from inside WS-E's record editor. The shell provides it
 * around the `renderRecordEditor` slot, so the editor can use either this or
 * the `store` prop it is handed; they are the same object.
 */
export function useOpenRecordStore(): RecordStore {
  const store = useContext(RecordStoreContext);
  if (store === null) {
    throw new Error(
      'useOpenRecordStore() must be called inside the shell\'s record editor slot, ' +
        'which provides RecordStoreProvider',
    );
  }
  return store;
}

export function useOptionalRecordStore(): RecordStore | null {
  return useContext(RecordStoreContext);
}
