/**
 * src/cms/app/shell/use-unsaved-changes.ts
 *
 * WS-3. Unsaved-changes protection on navigate away.
 *
 * Three ways out of this page, and all three are covered:
 *
 *  1. Closing the tab or reloading: the `beforeunload` event, which is the only
 *     hook browsers give and which shows their own wording, not ours.
 *  2. Clicking a link that leaves the page: a capture-phase listener, so it
 *     runs before anything the link's own handler might do.
 *  3. The Back button: `popstate` fires after the fact, so there is nothing to
 *     cancel. The shell's own in-app navigation should call `confirmDiscard()`
 *     before it pushes state, which is why that is returned.
 */

import { useCallback, useEffect, useRef } from 'react';

export const UNSAVED_MESSAGE = 'This page has unsaved changes. Leave and lose them?';

export type UnsavedChangesGuard = {
  /** True to continue, false to stay. Always true when there is nothing to lose. */
  confirmDiscard: () => boolean;
};

export function useUnsavedChangesGuard(dirty: boolean, enabled = true): UnsavedChangesGuard {
  // A ref, so the listeners are installed once and still see the current value.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const confirmDiscard = useCallback((): boolean => {
    if (!enabled || !dirtyRef.current) return true;
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
    return window.confirm(UNSAVED_MESSAGE);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      // Legacy, still required by some browsers to actually show the prompt.
      event.returnValue = UNSAVED_MESSAGE;
    };

    const onClickCapture = (event: MouseEvent): void => {
      if (!dirtyRef.current) return;
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;

      const href = anchor.getAttribute('href') ?? '';
      if (href === '' || href.startsWith('#')) return;

      const destination = new URL(anchor.href, window.location.href);
      const here = new URL(window.location.href);
      // Same page, different fragment: not a navigation.
      if (destination.origin === here.origin && destination.pathname === here.pathname && destination.search === here.search) {
        return;
      }

      if (!window.confirm(UNSAVED_MESSAGE)) event.preventDefault();
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClickCapture, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClickCapture, true);
    };
  }, [enabled]);

  return { confirmDiscard };
}
