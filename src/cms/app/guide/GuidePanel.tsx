/**
 * src/cms/app/guide/GuidePanel.tsx
 *
 * The panel's contents, with no backdrop and no behaviour.
 *
 * Split out of `GuideOverlay` so the editor can show a live copy of the real
 * thing beside the form. There is exactly one renderer for the guide, which
 * means the preview cannot drift from what the owner will actually see.
 *
 * It sizes itself from its container, not from the window, so the same
 * component is right at 1240px in the modal and at 700px in a preview
 * column. That is a container query in `styles.ts`, not a prop.
 */

import { useId } from 'react';
import type { ReactNode } from 'react';

import { rowIsKeyCap } from './schema.ts';
import type { GuideCard, GuideContent } from './schema.ts';
import { useGuideStyles } from './styles.ts';

export type GuidePanelProps = {
  content: GuideContent;
  /**
   * Omit for a copy that cannot be dismissed: no ×, no Close, no footer
   * hint. That is the preview.
   */
  onClose?: () => void;
  /** Extra footer content, left of Close. */
  footer?: ReactNode;
  /** Skip the open animation. The preview is not opening, it is just there. */
  still?: boolean;
  className?: string;
};

export function GuidePanel({ content, onClose, footer, still = false, className }: GuidePanelProps) {
  useGuideStyles();
  // Two panels can be on screen at once (the modal and the editor preview),
  // so the heading id has to be unique per instance.
  const headingId = useId();

  const classes = ['cms-guide'];
  if (still) classes.push('cms-guide--still');
  if (className !== undefined) classes.push(className);

  return (
    <div
      className={classes.join(' ')}
      role={onClose === undefined ? 'group' : 'dialog'}
      aria-modal={onClose === undefined ? undefined : 'true'}
      aria-labelledby={headingId}
      data-testid={onClose === undefined ? 'guide-preview' : 'guide'}
      tabIndex={-1}
    >
      <div className="cms-guide__head">
        <div className="cms-guide__heading">
          <h2 className="cms-guide__title" id={headingId} data-testid="guide-title">
            {content.title}
          </h2>
          {content.lead !== '' && <p className="cms-guide__lead">{content.lead}</p>}
        </div>
        {onClose !== undefined && (
          <button
            type="button"
            className="cms-guide-btn cms-guide-btn--icon cms-guide-btn--close"
            aria-label="Close the guide"
            title="Close (Esc)"
            data-testid="guide-close"
            onClick={onClose}
          >
            ×
          </button>
        )}
      </div>

      <div className="cms-guide__body" data-testid="guide-body">
        {content.cards.map((card) => (
          <Card card={card} key={card.id} />
        ))}
      </div>

      {onClose !== undefined && (
        <div className="cms-guide__foot">
          <span data-testid="guide-foot-hint">
            Escape, or a click outside, closes this. The ? in the top bar opens it again.
          </span>
          <span className="cms-guide__foot-spacer" />
          {footer}
          <button type="button" className="cms-guide-btn" data-testid="guide-done" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}

function Card({ card }: { card: GuideCard }) {
  return (
    <section className="cms-guide-card" data-testid={`guide-card-${card.id}`}>
      <h3 className="cms-guide-card__title">{card.title}</h3>
      {card.lead !== undefined && <p className="cms-guide-card__lead">{card.lead}</p>}
      <dl className="cms-guide-rows">
        {card.rows.map((row, index) => (
          <Row
            key={row.id ?? `${card.id}:${index}`}
            term={row.term}
            text={row.text}
            keyCap={rowIsKeyCap(card, row)}
          />
        ))}
      </dl>
      {card.note !== undefined && <p className="cms-guide-card__note">{card.note}</p>}
    </section>
  );
}

/**
 * A dt and its dd, as grid children of the dl. They are siblings rather than
 * a wrapped pair on purpose: the dl is the grid, so every term column lines
 * up across the rows of a card.
 */
function Row({ term, text, keyCap }: { term: string; text: string; keyCap: boolean }) {
  return (
    <>
      <dt className={keyCap ? 'cms-guide-rows__term cms-guide-rows__term--key' : 'cms-guide-rows__term'}>
        {term}
      </dt>
      <dd className="cms-guide-rows__text">{text}</dd>
    </>
  );
}
