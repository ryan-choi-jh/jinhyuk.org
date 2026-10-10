/**
 * src/cms/app/guide/GuideOverlay.tsx
 *
 * The guide as a panel over the editor: the backdrop, the dismiss routes and
 * the focus handling. `GuidePanel` draws what is inside it.
 *
 * It is not a wizard. There are no steps, nothing is gated behind it, and
 * every route out of it works at any moment: the button, Escape, the
 * backdrop, and the Close in the footer. Someone who already knows the tool
 * should be able to dismiss it without reading a word.
 *
 * It imports nothing from the rest of the editor. Everything it needs is in
 * this directory, so it cannot be broken by work going on elsewhere.
 */

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { DEFAULT_GUIDE_CONTENT } from './content.ts';
import { GuidePanel } from './GuidePanel.tsx';
import type { GuideContent } from './schema.ts';
import { useGuideStyles } from './styles.ts';

export type GuideOverlayProps = {
  open: boolean;
  onClose: () => void;
  /**
   * The guide to show. Defaults to the built-in copy, so the overlay is
   * useful before any content file exists. Pass
   * `loadGuideContent(stored).content` once there is one.
   */
  content?: GuideContent;
  /** Anything extra for the footer, left of the Close button. */
  footer?: ReactNode;
};

export function GuideOverlay({ open, onClose, content = DEFAULT_GUIDE_CONTENT, footer }: GuideOverlayProps) {
  useGuideStyles();

  const backdrop = useRef<HTMLDivElement | null>(null);
  /** Where focus was before we stole it, so it can be handed back. */
  const returnFocus = useRef<Element | null>(null);

  /*
   * Escape, on the window and in the capture phase. Capture matters: a
   * TipTap editor or a canvas drag may well be listening for Escape on a
   * deeper node, and while the panel is up it is the panel that Escape means.
   */
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  /*
   * Move focus into the panel on open so Escape and the Tab order both start
   * here, and put it back on close so the editor is where it was left.
   */
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    returnFocus.current = document.activeElement;
    const host = backdrop.current;
    const target = host?.querySelector<HTMLElement>('[data-testid="guide-close"]') ?? host;
    target?.focus();

    return () => {
      const previous = returnFocus.current;
      returnFocus.current = null;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="cms-guide-backdrop"
      data-testid="guide-backdrop"
      ref={backdrop}
      // A click on the backdrop closes; a click that started inside the panel
      // and ended on the backdrop (a text selection dragged out) does not,
      // which is why this tests the target rather than using a bubbling click.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <GuidePanel content={content} onClose={onClose} footer={footer} />
    </div>
  );
}
