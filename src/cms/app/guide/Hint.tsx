/**
 * src/cms/app/guide/Hint.tsx
 *
 * A one-line tooltip for a single control. Optional: the panel is the
 * deliverable, and this exists only because "what does this button do" is a
 * question better answered next to the button.
 *
 * Deliberately dumb. No portal, no placement engine, no delay. It shows on
 * hover and on keyboard focus, it is `aria-hidden` because the wrapped
 * control should carry its own accessible name, and it positions itself below
 * unless told otherwise. If a hint ever needs more than that, it wants to be
 * a line in the guide instead.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';

import { useGuideStyles } from './styles.ts';

export type HintProps = {
  /** The sentence. Short: this is a label, not documentation. */
  text: string;
  children: ReactNode;
  /** Put the bubble above the control. For anything near the bottom edge. */
  above?: boolean;
};

export function Hint({ text, children, above = false }: HintProps) {
  useGuideStyles();
  const [shown, setShown] = useState(false);

  return (
    <span
      className="cms-hint-wrap"
      onMouseEnter={() => setShown(true)}
      onMouseLeave={() => setShown(false)}
      onFocus={() => setShown(true)}
      onBlur={() => setShown(false)}
    >
      {children}
      {shown && (
        <span
          className={above ? 'cms-hint-bubble cms-hint-bubble--above' : 'cms-hint-bubble'}
          aria-hidden="true"
          data-testid="hint-bubble"
        >
          {text}
        </span>
      )}
    </span>
  );
}
