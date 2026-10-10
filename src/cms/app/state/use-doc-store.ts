/**
 * src/cms/app/state/use-doc-store.ts
 *
 * WS-3. The only React-aware file in `state/`. Binds the plain store in
 * `./store.ts` to React through `useSyncExternalStore`, and provides a context
 * so slot components mounted by WS-8 can reach the store without the shell
 * drilling props through them.
 */

import { createContext, useContext, useDebugValue, useRef, useSyncExternalStore } from 'react';

import type { DocStore, DocStoreState } from './store.ts';

/** Whole state. Re-renders on any change, which is fine for a tool this size. */
export function useDocStore(store: DocStore): DocStoreState {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  useDebugValue(state.slug);
  return state;
}

/**
 * One slice. Pass `isEqual` when the selector builds a new object or array, or
 * React will re-render forever comparing fresh references.
 */
export function useDocStoreSelector<T>(
  store: DocStore,
  selector: (state: DocStoreState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const cache = useRef<{ state: DocStoreState; value: T } | null>(null);

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
/* Context                                                                     */
/* -------------------------------------------------------------------------- */

const DocStoreContext = createContext<DocStore | null>(null);

export const DocStoreProvider = DocStoreContext.Provider;

/**
 * The store, from inside anything the shell renders, including WS-4's and
 * WS-5's components in the shell's slots. Throws rather than returning null,
 * because a slot rendered outside the shell is a wiring bug.
 */
export function useStore(): DocStore {
  const store = useContext(DocStoreContext);
  if (store === null) {
    throw new Error('useStore() must be called inside <EditorShell>, which provides DocStoreProvider');
  }
  return store;
}

/** Same, but returns null outside the shell. For components that work either way. */
export function useOptionalStore(): DocStore | null {
  return useContext(DocStoreContext);
}
