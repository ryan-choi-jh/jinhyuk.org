/**
 * src/cms/app/guide/GuideEditor.tsx
 *
 * The form that edits the guide, with a live copy of the real panel beside
 * it. Pure editing: it fetches nothing, saves nothing and owns no state
 * beyond which confirmation button is armed. Content comes in as a prop and
 * every change goes out through `onChange`, so whoever mounts it decides
 * what saving means.
 *
 * Two decisions worth stating:
 *
 *  - The preview is the real `GuidePanel`, not a mock of it. The whole point
 *    of editing a guide is seeing how it reads, and a preview that can drift
 *    from the thing it previews is worse than none.
 *  - Reordering is up and down buttons, not drag and drop. A guide has a
 *    handful of cards, the buttons work from the keyboard, and there is
 *    already one drag implementation in this app to maintain.
 *
 * Every mutation is a pure function in `edits.ts`. This file is layout.
 */

import { useMemo, useState } from 'react';

import { defaultGuideContent } from './loader.ts';
import { GuidePanel } from './GuidePanel.tsx';
import {
  addCard,
  addRow,
  moveCard,
  moveRow,
  patchCard,
  patchRow,
  removeCard,
  removeRow,
  setLead,
  setTitle,
  toggleRowKey,
} from './edits.ts';
import { formatGuideIssues, rowIsKeyCap, validateGuideContent } from './schema.ts';
import type { GuideCard, GuideContent } from './schema.ts';
import { useGuideStyles } from './styles.ts';

export type GuideEditorProps = {
  content: GuideContent;
  onChange: (next: GuideContent) => void;
  /** Show the live panel beside the form. Default true. */
  preview?: boolean;
  /** Replace the built-in "reset to the shipped guide". */
  onReset?: () => void;
  className?: string;
};

export function GuideEditor({ content, onChange, preview = true, onReset, className }: GuideEditorProps) {
  useGuideStyles();
  /** The reset button arms on the first press and fires on the second. */
  const [armed, setArmed] = useState(false);

  // Validation is advisory here: the form lets you type an empty term and
  // tells you about it, rather than refusing the keystroke.
  const issues = useMemo(() => {
    const result = validateGuideContent(content);
    return result.ok ? [] : result.issues;
  }, [content]);

  const classes = ['cms-ge'];
  if (!preview) classes.push('cms-ge--no-preview');
  if (className !== undefined) classes.push(className);

  const reset = (): void => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    if (onReset !== undefined) onReset();
    else onChange(defaultGuideContent());
  };

  return (
    <div className={classes.join(' ')} data-testid="guide-editor">
      <div className="cms-ge__form" data-testid="ge-form">
        <div className="cms-ge-block">
          <div className="cms-ge-block__head">
            <span className="cms-ge-label">The panel</span>
            <span className="cms-ge-block__spacer" />
            <button
              type="button"
              className={armed ? 'cms-guide-btn cms-guide-btn--on' : 'cms-guide-btn'}
              data-testid="ge-reset"
              title="Put the shipped guide back, losing every edit"
              onClick={reset}
              onBlur={() => setArmed(false)}
            >
              {armed ? 'Sure? This drops every edit' : 'Reset to the shipped guide'}
            </button>
          </div>

          <label className="cms-ge-field">
            <span>Title</span>
            <input
              className="cms-ge-input"
              value={content.title}
              data-testid="ge-title"
              onChange={(event) => onChange(setTitle(content, event.target.value))}
            />
          </label>
          <label className="cms-ge-field">
            <span>Lead</span>
            <textarea
              className="cms-ge-input cms-ge-area"
              rows={2}
              value={content.lead}
              placeholder="One sentence under the title. Leave empty for none."
              data-testid="ge-lead"
              onChange={(event) => onChange(setLead(content, event.target.value))}
            />
          </label>
        </div>

        {issues.length > 0 && (
          <div className="cms-ge-issues" data-testid="ge-issues">
            {formatGuideIssues(issues)
              .split('\n')
              .map((line) => (
                <div key={line}>{line}</div>
              ))}
          </div>
        )}

        {content.cards.map((card, cardIndex) => (
          <CardForm
            key={card.id}
            card={card}
            index={cardIndex}
            count={content.cards.length}
            content={content}
            onChange={onChange}
          />
        ))}

        <button
          type="button"
          className="cms-guide-btn cms-ge-add"
          data-testid="ge-add-card"
          onClick={() => onChange(addCard(content))}
        >
          + card
        </button>
      </div>

      {preview && (
        <div className="cms-ge__preview" data-testid="ge-preview">
          <div className="cms-ge__preview-head">
            <span className="cms-ge-label">Preview</span>
          </div>
          <div className="cms-ge__preview-stage">
            <GuidePanel content={content} still />
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

type CardFormProps = {
  card: GuideCard;
  index: number;
  count: number;
  content: GuideContent;
  onChange: (next: GuideContent) => void;
};

function CardForm({ card, index, count, content, onChange }: CardFormProps) {
  return (
    <div className="cms-ge-block" data-testid={`ge-card-${index}`}>
      <div className="cms-ge-block__head">
        <span className="cms-ge-block__index">{index + 1}</span>
        <input
          className="cms-ge-input cms-ge-input--heading"
          value={card.title}
          aria-label={`Heading of card ${index + 1}`}
          data-testid={`ge-card-title-${index}`}
          onChange={(event) => onChange(patchCard(content, index, { title: event.target.value }))}
        />
        <button
          type="button"
          className="cms-guide-btn cms-guide-btn--icon"
          aria-label={`Move card ${index + 1} up`}
          disabled={index === 0}
          data-testid={`ge-card-up-${index}`}
          onClick={() => onChange(moveCard(content, index, index - 1))}
        >
          ↑
        </button>
        <button
          type="button"
          className="cms-guide-btn cms-guide-btn--icon"
          aria-label={`Move card ${index + 1} down`}
          disabled={index === count - 1}
          data-testid={`ge-card-down-${index}`}
          onClick={() => onChange(moveCard(content, index, index + 1))}
        >
          ↓
        </button>
        <button
          type="button"
          className="cms-guide-btn cms-guide-btn--icon cms-guide-btn--danger"
          aria-label={`Delete card ${index + 1}`}
          title={count <= 1 ? 'The last card cannot be deleted' : 'Delete this card'}
          disabled={count <= 1}
          data-testid={`ge-card-remove-${index}`}
          onClick={() => onChange(removeCard(content, index))}
        >
          ✕
        </button>
      </div>

      <label className="cms-ge-field">
        <span>Blurb</span>
        <textarea
          className="cms-ge-input cms-ge-area"
          rows={2}
          value={card.lead ?? ''}
          placeholder="Optional. A sentence above the rows."
          data-testid={`ge-card-lead-${index}`}
          onChange={(event) => onChange(patchCard(content, index, { lead: event.target.value }))}
        />
      </label>

      <div className="cms-ge-rows">
        {card.rows.map((row, rowIndex) => (
          <div className="cms-ge-row" key={row.id ?? `${card.id}:${rowIndex}`}>
            <button
              type="button"
              className={
                rowIsKeyCap(card, row)
                  ? 'cms-guide-btn cms-guide-btn--tiny cms-ge-row__key cms-guide-btn--on'
                  : 'cms-guide-btn cms-guide-btn--tiny cms-ge-row__key'
              }
              aria-label={`Draw the term of row ${rowIndex + 1} as a key cap`}
              aria-pressed={rowIsKeyCap(card, row)}
              title="Key cap: draw the term monospace, in a box"
              data-testid={`ge-row-key-${index}-${rowIndex}`}
              onClick={() => onChange(toggleRowKey(content, index, rowIndex))}
            >
              key
            </button>
            <input
              className="cms-ge-input"
              value={row.term}
              aria-label={`Term of row ${rowIndex + 1}`}
              data-testid={`ge-row-term-${index}-${rowIndex}`}
              onChange={(event) => onChange(patchRow(content, index, rowIndex, { term: event.target.value }))}
            />
            <textarea
              className="cms-ge-input cms-ge-area"
              rows={2}
              value={row.text}
              aria-label={`Description of row ${rowIndex + 1}`}
              data-testid={`ge-row-text-${index}-${rowIndex}`}
              onChange={(event) => onChange(patchRow(content, index, rowIndex, { text: event.target.value }))}
            />
            <div className="cms-ge-row__actions">
              <button
                type="button"
                className="cms-guide-btn cms-guide-btn--icon"
                aria-label={`Move row ${rowIndex + 1} up`}
                disabled={rowIndex === 0}
                data-testid={`ge-row-up-${index}-${rowIndex}`}
                onClick={() => onChange(moveRow(content, index, rowIndex, rowIndex - 1))}
              >
                ↑
              </button>
              <button
                type="button"
                className="cms-guide-btn cms-guide-btn--icon"
                aria-label={`Move row ${rowIndex + 1} down`}
                disabled={rowIndex === card.rows.length - 1}
                data-testid={`ge-row-down-${index}-${rowIndex}`}
                onClick={() => onChange(moveRow(content, index, rowIndex, rowIndex + 1))}
              >
                ↓
              </button>
              <button
                type="button"
                className="cms-guide-btn cms-guide-btn--icon cms-guide-btn--danger"
                aria-label={`Delete row ${rowIndex + 1}`}
                data-testid={`ge-row-remove-${index}-${rowIndex}`}
                onClick={() => onChange(removeRow(content, index, rowIndex))}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="cms-ge-block__foot">
        <button
          type="button"
          className="cms-guide-btn cms-guide-btn--tiny"
          data-testid={`ge-add-row-${index}`}
          onClick={() => onChange(addRow(content, index))}
        >
          + row
        </button>
      </div>

      <label className="cms-ge-field">
        <span>Footnote</span>
        <textarea
          className="cms-ge-input cms-ge-area"
          rows={2}
          value={card.note ?? ''}
          placeholder="Optional. A sentence below the rows."
          data-testid={`ge-card-note-${index}`}
          onChange={(event) => onChange(patchCard(content, index, { note: event.target.value }))}
        />
      </label>
    </div>
  );
}
