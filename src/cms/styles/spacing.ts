/**
 * src/cms/styles/spacing.ts
 *
 * Asking for space above a block.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: AN EMPTY ROW IS NOT A SPACER
 * ---------------------------------------------------------------------------
 *
 * The only way to ask for air used to be pressing Enter on a blank line, and
 * that does not do what anyone thinks. Measured, for every pair of block
 * kinds in an essay, with zero to three empty rows between them:
 *
 *   - an empty row is 35px tall in the CMS and 0px on the published page;
 *   - it changes the page in 6 of 36 pairings, all of them directly after a
 *     heading, and never by more than 23px;
 *   - three empty rows do exactly what one does, because adjoining sibling
 *     margins collapse into a single gap.
 *
 * So the mental model everyone brings from a word processor, "press Enter
 * twice for more air", was not available, and the editor showed a blank line
 * the reader would never see.
 *
 * ---------------------------------------------------------------------------
 * "AT LEAST", NOT "PLUS"
 * ---------------------------------------------------------------------------
 *
 * This is a `margin-top`, and a margin-top adjoins the previous block's
 * margin-bottom, so the two collapse and the gap is the LARGER of them. That
 * is the honest way to describe the control: it sets a floor.
 *
 *   paragraph (27px below) then a block asking for small (48)  ->  48
 *   heading   (8px below)  then a block asking for small (48)  ->  48
 *   paragraph (27px below) then a block asking for nothing     ->  27
 *
 * The alternative, forcing exactly N, means fighting the collapse with
 * padding or a pseudo-element, and produces a document where removing the
 * paragraph above a block changes the space below it. A floor is both what
 * CSS does naturally and what an author means.
 *
 * ---------------------------------------------------------------------------
 * A CLOSED SET
 * ---------------------------------------------------------------------------
 *
 * Three sizes, not a number field. A number invites 23px here and 24px two
 * paragraphs later, and nobody can see the difference but the page is
 * quietly uneven forever. The values are on the site's own rhythm: 48 is the
 * gap a heading already opens, so `small` reads as "a section's worth" even
 * though no heading is involved.
 *
 * They step down below the breakpoint, like everything else does: global.css
 * puts the body at 14/24 there, and 120px of air on a phone is a scroll
 * through nothing.
 *
 * ---------------------------------------------------------------------------
 * ONE COPY
 * ---------------------------------------------------------------------------
 *
 * doc.css carries a copy between its SPACING markers, written by
 * `node src/cms/styles/sync-doc-css.mjs` and asserted byte-identical by
 * cms:verify. The editor injects this string directly. The editor selector is
 * in here too, so the space an author sets is the space they see.
 */

import { BLOCK_SPACES, MOBILE_BREAKPOINT } from '../schema.ts';
import type { BlockSpace } from '../schema.ts';

/** Desktop and below-the-breakpoint values, in px. */
export const SPACE_SCALE: Readonly<Record<BlockSpace, { wide: number; narrow: number }>> = {
  // The gap an h2 already opens. Familiar, and plainly more than a paragraph.
  small: { wide: 48, narrow: 32 },
  medium: { wide: 80, narrow: 52 },
  // A deliberate break in the page. Past this it is a new page.
  large: { wide: 120, narrow: 76 },
};

/**
 * ONE selector per size, not one for the page and one for the editor.
 *
 * The renderer puts `doc-space--<size>` on the block, and the editing
 * surface puts the same class on the div it wraps that block in, so the rule
 * applies in both places and there is nothing to keep in step. A second
 * selector written against the editor's own DOM is how the callout's link
 * ended up underlined in the wrong grey.
 */
/**
 * The class is written TWICE on purpose.
 *
 * `.doc-space--small` is one class, and the rules it has to beat are two:
 * `.doc--essays .doc-p` sets `margin-block: 0 27px`, whose shorthand puts
 * `margin-top: 0` back. Measured before this was doubled, the control worked
 * on a heading and a callout (one-class rules) and did nothing at all to a
 * paragraph, a quote or a list.
 *
 * Repeating the class raises it to two without naming an ancestor, which
 * matters because the same rule has to work on the published page, where the
 * class is on the block itself, and in the editor, where it is on the div the
 * surface wraps that block in. An ancestor selector would only match one of
 * them, which is how the callout's link ended up the wrong grey.
 *
 * The block is emitted LAST in doc.css so that at equal specificity it also
 * wins on source order, including inside the mobile media query.
 */
function rules(which: 'wide' | 'narrow', indent: string): string {
  return (BLOCK_SPACES as readonly BlockSpace[])
    .map(
      (space) =>
        `${indent}.doc-space--${space}.doc-space--${space} { margin-top: ${SPACE_SCALE[space][which]}px; }`,
    )
    .join('\n');
}

export const SPACING_CSS = [
  '/* Space above a block, as a floor rather than an addition: this margin',
  "   adjoins the previous block's and the two collapse, so the gap is the",
  '   larger of the two. See src/cms/styles/spacing.ts.',
  '',
  '   A first block is not given the class at all, by the renderer and by the',
  "   surface alike, because doc.css already zeroes a first block's top margin",
  '   and space there would only push the whole document down. */',
  rules('wide', ''),
  '',
  `@media (max-width: ${MOBILE_BREAKPOINT}px) {`,
  rules('narrow', '  '),
  '}',
].join('\n');

export const SPACING_STYLE_ID = 'cms-spacing';

/**
 * Put the rules in the document, once. The published page gets them from
 * doc.css; the editor, which does not load doc.css, gets them from here.
 */
export function injectSpacingStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(SPACING_STYLE_ID) !== null) return;
  const element = document.createElement('style');
  element.id = SPACING_STYLE_ID;
  element.textContent = SPACING_CSS;
  document.head.appendChild(element);
}
