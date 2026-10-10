/**
 * src/cms/app/prose/ColorControl.tsx
 *
 * WS-5. Text colour: the site palette as swatches, plus a real colour picker.
 *
 * "A real colour picker plus the site palette as swatches" means all four of
 * these, not a choice between them:
 *
 *   - eight palette swatches, each showing the colour it will actually render
 *     in the theme the editor is currently in;
 *   - the platform colour picker, `<input type="color">`, which is the real
 *     one: wheel, eyedropper, recent colours, whatever the OS provides;
 *   - a hex field, because typing `#2e7d52` is faster than hunting for it;
 *   - Default, which removes the mark instead of storing the ink colour, so a
 *     run with no opinion about colour keeps no opinion.
 *
 * The line at the bottom shows the value that is actually being stored. It is
 * there on purpose: a palette colour stores a token reference, not a hex, and
 * that is the one thing about this editor that is worth being able to see.
 *
 * See palette.ts for the stored representation.
 */

import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { Editor } from '@tiptap/core';

import {
  PROSE_PALETTE,
  canonicalColorValue,
  normalizeHex,
  resolveColorToHex,
  toSixDigitHex,
} from './palette.ts';
import type { ColorTheme } from './palette.ts';

/* -------------------------------------------------------------------------- */
/* Theme                                                                       */
/* -------------------------------------------------------------------------- */

function readTheme(): ColorTheme {
  if (typeof document === 'undefined') return 'light';
  const explicit = document.documentElement.getAttribute('data-theme');
  if (explicit === 'dark') return 'dark';
  if (explicit === 'light') return 'light';
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Which theme the swatch chips should preview. Follows the same two signals as
 * src/styles/global.css: an explicit `data-theme` on <html> first, then the OS
 * preference.
 */
export function useColorTheme(): ColorTheme {
  const [theme, setTheme] = useState<ColorTheme>(readTheme);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const update = (): void => setTheme(readTheme());
    const media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    media?.addEventListener('change', update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    update();
    return () => {
      media?.removeEventListener('change', update);
      observer.disconnect();
    };
  }, []);

  return theme;
}

/* -------------------------------------------------------------------------- */
/* The control                                                                 */
/* -------------------------------------------------------------------------- */

export type ColorControlProps = {
  editor: Editor;
  /** The colour on the current selection, or null when it has none. */
  current: string | null;
};

const HOLD_FOCUS = (event: { preventDefault: () => void }): void => event.preventDefault();

export function ColorControl({ editor, current }: ColorControlProps): JSX.Element {
  const theme = useColorTheme();
  const [hexDraft, setHexDraft] = useState<string>(() =>
    current === null ? '' : resolveColorToHex(current, 'light'),
  );
  const [badHex, setBadHex] = useState(false);

  // Follow the selection: moving the caret to a differently coloured run
  // refills the field rather than leaving a stale value in it.
  useEffect(() => {
    setHexDraft(current === null ? '' : resolveColorToHex(current, 'light'));
    setBadHex(false);
  }, [current]);

  const apply = (value: string): void => {
    const stored = canonicalColorValue(value);
    if (stored === null) return;
    editor.chain().focus().setColor(stored).run();
  };

  const clear = (): void => {
    editor.chain().focus().unsetColor().run();
  };

  const commitHex = (): void => {
    const trimmed = hexDraft.trim();
    if (trimmed === '') {
      clear();
      setBadHex(false);
      return;
    }
    const hex = normalizeHex(trimmed);
    if (hex === null) {
      setBadHex(true);
      return;
    }
    setBadHex(false);
    setHexDraft(hex);
    // The field mirrors whatever colour the selection already has. If it still
    // shows exactly what that colour resolves to, the author did not change it,
    // and committing would quietly replace a palette token with its flattened
    // hex (losing dark mode) or drop an alpha channel the field cannot show.
    if (current !== null && hex === resolveColorToHex(current, 'light')) return;
    apply(hex);
  };

  // Pressed only when the stored value IS this swatch's value. Matching a
  // frozen #ff5722 to the Accent swatch would claim the run follows the theme
  // when it does not.
  const activeSwatch =
    current === null ? undefined : PROSE_PALETTE.find((swatch) => swatch.value === current.trim());
  const pickerValue = toSixDigitHex(
    current === null ? '#111111' : resolveColorToHex(current, theme),
  );

  return (
    <div className="pe-popover">
      <span className="pe-label">Text colour</span>

      <div className="pe-swatches" role="group" aria-label="Site palette">
        {PROSE_PALETTE.map((swatch) => (
          <button
            key={swatch.id}
            type="button"
            className="pe-swatch"
            style={{ background: theme === 'dark' ? swatch.darkHex : swatch.hex }}
            aria-pressed={activeSwatch?.id === swatch.id}
            title={`${swatch.label} · ${swatch.value}`}
            aria-label={swatch.label}
            onMouseDown={HOLD_FOCUS}
            onClick={() => apply(swatch.value)}
          />
        ))}
      </div>

      <div className="pe-field">
        <input
          type="color"
          className="pe-input pe-input--color"
          value={pickerValue}
          aria-label="Pick any colour"
          title="Pick any colour"
          onChange={(event) => {
            const hex = normalizeHex(event.target.value);
            if (hex === null) return;
            setHexDraft(hex);
            setBadHex(false);
            apply(hex);
          }}
        />
        <input
          type="text"
          className="pe-input pe-input--hex"
          value={hexDraft}
          placeholder="#rrggbb"
          spellCheck={false}
          autoComplete="off"
          aria-label="Hex colour"
          aria-invalid={badHex}
          onChange={(event) => {
            setHexDraft(event.target.value);
            setBadHex(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitHex();
            }
          }}
          onBlur={commitHex}
        />
        <button
          type="button"
          className="pe-btn"
          onMouseDown={HOLD_FOCUS}
          onClick={() => {
            setHexDraft('');
            setBadHex(false);
            clear();
          }}
          title="Remove the colour mark"
        >
          Default
        </button>
      </div>

      <span className={badHex ? 'pe-hint pe-hint--bad' : 'pe-hint'}>
        {badHex
          ? 'Not a hex colour. Try #2e7d52.'
          : current === null
            ? 'No colour mark on this run.'
            : `stored as ${current}`}
      </span>
    </div>
  );
}
