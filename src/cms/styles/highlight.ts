/**
 * src/cms/styles/highlight.ts
 *
 * The highlighter's brush stroke, as CSS, in one place.
 *
 * ---------------------------------------------------------------------------
 * WHY THE INK IS BEHIND THE WORDS AND NOT OVER THEM
 * ---------------------------------------------------------------------------
 *
 * A highlighter laid OVER text has to let the text through, and in a browser
 * there are only two ways to do that, both of which were measured here and
 * both of which fail:
 *
 *  - `mix-blend-mode: multiply`, the usual answer, blends with the backdrop of
 *    the nearest ancestor that forms an isolated group. Every stacking context
 *    is one. A canvas item is `position: absolute` with a `z-index`, and an
 *    overlay band is too (doc.css), so a multiplied stroke reaches nothing but
 *    the transparent band it sits in and paints flat over the words.
 *  - flat opacity lightens the glyphs along with the paper. At an alpha pale
 *    enough to read through, the colour is barely there; at an alpha you can
 *    see, #111 text goes olive.
 *
 * Painted BEHIND the words it is neither: the ink can be fully saturated and
 * the text keeps every bit of its contrast, which is how a real highlighter
 * works and why this is a background on the text rather than a layer above it.
 * A `background-image` is exactly that, and it needs no stacking tricks at
 * all, because a background always paints behind its own element's content.
 *
 * ---------------------------------------------------------------------------
 * WHY A BACKGROUND IMAGE AND NOT A BACKGROUND COLOUR
 * ---------------------------------------------------------------------------
 *
 * The stroke has hand-drawn long edges, which a colour cannot do. The colour
 * therefore has to be baked into the SVG, which is why HIGHLIGHT_INKS is a
 * closed set and each pen is a rule here rather than an inline style.
 *
 * `box-decoration-break: clone` is what makes a highlight that wraps get a
 * stroke on each line instead of one stretched across both.
 *
 * The padding and the equal negative margin do two jobs: they let the ink
 * overhang the glyphs slightly, and they make abutting marks overlap. A
 * highlight that crosses a bold word is two `<mark>` elements, and without the
 * overlap you would see the seam between their strokes.
 */

import { HIGHLIGHT_INKS } from '../schema.ts';
import type { HighlightInk } from '../schema.ts';

/**
 * The stroke, drawn once in a 100x26 box and stretched to whatever the
 * highlight turns out to be. Two sine frequencies on each long edge, so the
 * edge is irregular rather than a clean wave, and the whole band sits far
 * enough inside the box that no part of the wave is clipped by the viewBox.
 *
 * The ends are flat on purpose. See the overlap note above: a slanted end
 * would leave a notch where two marks meet.
 *
 * Baked rather than generated at runtime, so the editor and the published page
 * cannot differ by a rounding decision, and so the stroke does not change
 * under anyone's feet. Two sine waves sampled into eight cubics per edge; to
 * redraw it, change the waves and re-sample, rather than nudging numbers here.
 */
export const BRUSH_PATH =
  'M0 5.00C4.4 7.05,8.1 7.00,12.5 6.45C16.9 5.62,20.6 5.79,25.0 6.00C29.4 6.82,33.1 6.62,37.5 6.27' +
  'C41.9 3.46,45.6 4.83,50.0 2.07C54.4 1.83,58.1 1.59,62.5 2.45C66.9 2.57,70.6 2.78,75.0 1.88' +
  'C79.4 1.42,83.1 1.32,87.5 2.44C91.9 5.38,95.6 4.12,100.0 6.37L100 21.20C95.6 23.60,91.9 23.05,87.5 24.38' +
  'C83.1 24.27,79.4 24.66,75.0 23.10C70.6 20.88,66.9 21.70,62.5 20.49C58.1 20.94,54.4 20.70,50.0 20.89' +
  'C45.6 19.55,41.9 20.26,37.5 18.87C33.1 19.63,29.4 18.96,25.0 20.96C20.6 22.69,16.9 22.17,12.5 22.73' +
  'C8.1 22.39,4.4 22.45,0.0 22.84Z';

/**
 * The four pens. Saturated, because they sit behind the glyphs: the same
 * yellow over the text at any usable opacity would turn it olive.
 */
export const HIGHLIGHT_INK_HEX: Readonly<Record<HighlightInk, string>> = {
  yellow: '#ffe14d',
  blue: '#9fdcff',
  green: '#b6f0a8',
  pink: '#ffbcd4',
};

/** One ink's stroke, as a `url(...)` ready for `background-image`. */
export function brushUrl(ink: HighlightInk): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 26' preserveAspectRatio='none'>` +
    `<path d='${BRUSH_PATH}' fill='${HIGHLIGHT_INK_HEX[ink]}'/></svg>`;
  // Only these three need escaping in a url() inside a stylesheet: # starts a
  // fragment, and < > are not valid unencoded. The quotes in the SVG are
  // single, and the url() is double-quoted, so neither needs touching.
  const encoded = svg.replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E');
  return `url("data:image/svg+xml,${encoded}")`;
}

/**
 * The rules, shared verbatim by the published page and the editor.
 *
 * src/cms/styles/doc.css carries a copy between its HIGHLIGHT markers, because
 * a plain stylesheet cannot import this. prose/verify.ts asserts the copy is
 * byte-identical, so the two cannot drift.
 */
export const HIGHLIGHT_CSS = [
  '.doc-hl {',
  "  /* A <mark> comes with the browser's own flat yellow. The brush stroke has",
  '     wavy edges, so that yellow would show through along the top and bottom',
  '     of every pen and fringe the blue, green and pink ones. */',
  '  background-color: transparent;',
  '  background-repeat: no-repeat;',
  '  background-size: 100% 100%;',
  '  -webkit-box-decoration-break: clone;',
  '  box-decoration-break: clone;',
  '  padding: 0.06em 0.18em;',
  '  margin: 0 -0.1em;',
  '  /* The ink is the same in both themes, so the text on it has to be too:',
  '     in dark mode --ink is near-white and would all but vanish. */',
  '  color: #16160f;',
  '  border-radius: 1px;',
  '}',
  '',
  ...(HIGHLIGHT_INKS as readonly HighlightInk[]).flatMap((ink) => [
    `.doc-hl--${ink} {`,
    `  background-image: ${brushUrl(ink)};`,
    '}',
    '',
  ]),
  '@media print {',
  '  /* Background images are dropped by default when printing, which would',
  '     leave the highlight invisible. */',
  '  .doc-hl {',
  '    -webkit-print-color-adjust: exact;',
  '    print-color-adjust: exact;',
  '  }',
  '}',
].join('\n');

export const HIGHLIGHT_STYLE_ID = 'cms-highlight';

/**
 * Put the rules in the document, once.
 *
 * Any host that mounts a ProseEditor needs these, because the editor emits
 * `<mark>` and an unstyled one is the browser's own flat yellow with black
 * text. The published page gets them from doc.css; everything else gets them
 * from here, which is why this is a plain function and not a hook: it is
 * called from the editor's own insertion effect, beside the prose chrome.
 *
 * Deliberately NOT folded into PROSE_EDITOR_CSS. That stylesheet is asserted
 * to touch nothing but `.pe-*` chrome and ProseMirror's machinery, and the
 * assertion is worth keeping: these are the published page's rules, shared,
 * not the editor's own.
 */
export function injectHighlightStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(HIGHLIGHT_STYLE_ID) !== null) return;
  const element = document.createElement('style');
  element.id = HIGHLIGHT_STYLE_ID;
  element.textContent = HIGHLIGHT_CSS;
  document.head.appendChild(element);
}
