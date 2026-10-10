/**
 * src/cms/app/guide/use-guide.ts
 *
 * The open state of the guide, and the first-visit rule.
 *
 * The rule: if this browser has never been shown the guide, it opens itself
 * once, on mount. It is marked as shown when it is closed, not when it is
 * opened, so a tab that is abandoned with the panel still up gets the guide
 * again rather than silently losing it.
 *
 * The check runs in an effect, never during render, because there is no
 * localStorage during server rendering and the first client render has to
 * match the server's markup.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { GUIDE_SEEN_KEY, clearFlag, readFlag, writeFlag } from './storage.ts';

export type UseGuideOptions = {
  /** Override the localStorage key. The harness uses this to stay out of the way. */
  storageKey?: string;
  /**
   * Open on a first visit. Default true. Pass false to get a guide that only
   * ever opens from the button.
   */
  autoOpenOnFirstVisit?: boolean;
};

export type Guide = {
  open: boolean;
  /** Open it. Safe to call when it is already open. */
  show(): void;
  /** Close it, and record that this browser has seen it. */
  hide(): void;
  /** For the top-bar button. */
  toggle(): void;
  /**
   * False when localStorage could not be read or written, i.e. the guide will
   * open again on the next visit. Nothing has to act on this; it is here so a
   * caller can say so if it wants to.
   */
  remembered: boolean;
  /** Forget the flag, so the next mount auto-opens again. */
  forget(): void;
};

export function useGuide(options: UseGuideOptions = {}): Guide {
  const { storageKey = GUIDE_SEEN_KEY, autoOpenOnFirstVisit = true } = options;

  const [open, setOpen] = useState(false);
  const [remembered, setRemembered] = useState(true);
  /** Write the flag at most once per mount, on the first close. */
  const recorded = useRef(false);

  useEffect(() => {
    if (!autoOpenOnFirstVisit) return;
    const state = readFlag(storageKey);
    if (state === 'unavailable') {
      // Cannot know and cannot remember. Show it: a guide that appears once
      // too often beats one that never appears.
      setRemembered(false);
      setOpen(true);
      return;
    }
    if (state === 'unset') setOpen(true);
  }, [storageKey, autoOpenOnFirstVisit]);

  const record = useCallback(() => {
    if (recorded.current) return;
    recorded.current = true;
    if (!writeFlag(storageKey)) setRemembered(false);
  }, [storageKey]);

  const show = useCallback(() => setOpen(true), []);

  const hide = useCallback(() => {
    setOpen(false);
    record();
  }, [record]);

  // Deliberately not a setState updater: closing has a side effect (the
  // write), and an updater can be called twice under StrictMode.
  const toggle = useCallback(() => {
    if (open) hide();
    else show();
  }, [open, hide, show]);

  const forget = useCallback(() => {
    recorded.current = false;
    if (clearFlag(storageKey)) setRemembered(true);
  }, [storageKey]);

  return { open, show, hide, toggle, remembered, forget };
}
