/**
 * src/cms/app/prose/LinkControl.tsx
 *
 * WS-5. The link field in the floating toolbar. Opens from the toolbar's Link
 * button or from Mod-K.
 *
 * Stores TipTap's link attrs, exactly the three docs/cms-contracts.md 2.3 says
 * to read: `href`, `target`, `rel`. New links get target="_blank" and
 * rel="noopener noreferrer", which is what the fixtures already carry.
 *
 * `example.com` is accepted and stored as `https://example.com`. Anything that
 * is not http(s), mailto, tel, a site-absolute path or a fragment is refused
 * at the field, so it can never reach a document: see isSafeHref in block.ts.
 */

import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { Editor } from '@tiptap/core';

import { isSafeHref } from './block.ts';

export type LinkControlProps = {
  editor: Editor;
  /** The href on the current selection, or null when there is no link. */
  current: string | null;
  /** Close the panel. */
  onClose: () => void;
};

/** What a person types -> what can be stored, or null. */
export function normalizeHrefInput(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;
  if (isSafeHref(value)) return value;
  // A bare host or host/path. Everything else is refused rather than guessed.
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(value)) {
    const guessed = `https://${value}`;
    return isSafeHref(guessed) ? guessed : null;
  }
  return null;
}

export function LinkControl({ editor, current, onClose }: LinkControlProps): JSX.Element {
  const [draft, setDraft] = useState(current ?? '');
  const [bad, setBad] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft(current ?? '');
    setBad(false);
  }, [current]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const apply = (): void => {
    const href = normalizeHrefInput(draft);
    if (href === null) {
      setBad(true);
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange('link')
      .setLink({ href, target: '_blank', rel: 'noopener noreferrer' })
      .run();
    onClose();
  };

  const remove = (): void => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    onClose();
  };

  return (
    <div className="pe-popover">
      <span className="pe-label">Link</span>
      <div className="pe-field">
        <input
          ref={inputRef}
          type="text"
          className="pe-input pe-input--href"
          value={draft}
          placeholder="https://…"
          spellCheck={false}
          autoComplete="off"
          aria-label="Link address"
          aria-invalid={bad}
          onChange={(event) => {
            setDraft(event.target.value);
            setBad(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              apply();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <button
          type="button"
          className="pe-btn"
          onMouseDown={(event) => event.preventDefault()}
          onClick={apply}
        >
          Apply
        </button>
        {current === null ? null : (
          <button
            type="button"
            className="pe-btn"
            onMouseDown={(event) => event.preventDefault()}
            onClick={remove}
          >
            Remove
          </button>
        )}
      </div>
      <span className={bad ? 'pe-hint pe-hint--bad' : 'pe-hint'}>
        {bad
          ? 'Needs http(s), mailto, tel, a path starting with /, or #anchor.'
          : 'Enter to apply, Escape to close.'}
      </span>
    </div>
  );
}
