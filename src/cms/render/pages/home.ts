/**
 * src/cms/render/pages/home.ts
 *
 * WS-B. The homepage, from `src/content/pages/home.json`.
 *
 * The homepage is a document now (docs/cms-sections.md 3.2), but it is not a
 * document that should render like a project page. Live it is three things:
 *
 *   .hero        the 원고지 illustration, full bleed, on its own white sheet,
 *                with the 원고지 note over it (./home-note.ts)
 *   .hero-hint   "TAP THE GRID TO ENLARGE" on touch, and the note's replay
 *   .intro       the name in bold, then the paragraphs, at a 1184px measure
 *   .lightbox    the enlarge overlay, pannable
 *
 * None of that comes out of the generic band renderer: `.doc-item` would put a
 * hairline border around the illustration, `.doc-p` would set the paragraphs at
 * 720px with 28px gaps instead of 1184px with 24px, and `.name` would not exist
 * at all. So the first canvas band's image becomes the hero and the first prose
 * band becomes the intro, and the markup below is what
 * `src/pages/index.astro` emits today, line for line.
 *
 * Any band after those two goes through the ordinary document pipeline, so
 * "the homepage can eventually hold a canvas like anything else" (3.2) is true
 * today rather than a promise.
 *
 * The name is `meta.title`, not a prose block — see the home fixture.
 *
 * No DOM, no React, no Astro.
 */

import { REFERENCE_WIDTH, isCanvasBand, isProseBand, refPxToPercent } from '../../schema.ts';
import type { Band, CanvasBand, CanvasItem, Doc, ProseBand } from '../../schema.ts';
import { attr, css, escapeAttr, escapeText, joinParts, safeUrl } from '../escape.ts';
import { renderInline, renderProseBlock } from '../prose.ts';
import {
  noteRoleOf,
  renderNoteCaption,
  renderNoteLayer,
  renderNoteReplay,
  renderNoteRule,
} from './home-note.ts';

/* -------------------------------------------------------------------------- */
/* Picking the hero and the intro out of the bands                            */
/* -------------------------------------------------------------------------- */

export type HomeParts = {
  /**
   * The illustration, as the canvas band it is: a 원고지 grid with the scenes
   * placed on it, one item each. It was a single flattened image and a single
   * `CanvasItem` until the owner asked to edit the scenes individually, which
   * a flattened export cannot support at any price.
   */
  hero: CanvasBand | null;
  /** The band the hero came out of, so it is not rendered twice. */
  heroBand: Band | null;
  /** The paragraphs under it, or null. */
  intro: ProseBand | null;
  /** Everything else, in document order. Rendered as an ordinary document. */
  rest: Band[];
};

/**
 * The hero is the document's FIRST BAND, when that band is a canvas holding at
 * least one drawable image.
 *
 * It used to additionally require the band to hold exactly one item, so that
 * "a canvas band with a squiggle in it as well" stayed in the document body.
 * That rule cannot survive the hero being a composition: the illustration is
 * now 23 items, and the test would reject the very thing it is meant to find.
 *
 * Position is what makes it the hero, not its contents and not its id — a band
 * id is the author's, and a renderer that keys off one breaks the moment
 * somebody renames it. A second canvas band still goes through the ordinary
 * document pipeline, so only the leading one gets the sheet and the lightbox.
 */
function isHeroBand(band: Band): band is CanvasBand {
  if (!isCanvasBand(band)) return false;
  return band.items.some((item) => item.kind === 'image' && safeUrl(item.src) !== null);
}

export function splitHome(doc: Doc): HomeParts {
  const bands = [...doc.bands];
  let hero: CanvasBand | null = null;
  let heroBand: Band | null = null;

  const first = bands[0];
  if (first !== undefined && isHeroBand(first)) {
    hero = first;
    heroBand = first;
    bands.shift();
  }

  let intro: ProseBand | null = null;
  const next = bands[0];
  if (next !== undefined && isProseBand(next)) {
    intro = next;
    bands.shift();
  }

  return { hero, heroBand, intro, rest: bands };
}

/* -------------------------------------------------------------------------- */
/* The hero                                                                   */
/* -------------------------------------------------------------------------- */

const HERO_LIGHTBOX_ID = 'hero-lightbox';

/** The hint under the sheet. Hidden by global.css except on touch and <=1024px. */
const HERO_HINT = 'TAP THE GRID TO ENLARGE';

/**
 * One piece of the illustration, positioned the way every other canvas item on
 * the site is positioned — `src/cms/render/canvas.ts` explains the geometry and
 * `refPxToPercent` is the single formula both go through:
 *
 *   x -> left, as a % of the stage      w -> width, as a % of the stage
 *   y -> top, in cqw against the stage  h -> aspect-ratio on the piece
 *
 * The box carries the aspect ratio and the image fills it at 100%/100%, rather
 * than the image being left to its own intrinsic shape. That is deliberate:
 * Paper drew each of these as a frame with `background-size: 100% 100%`, so
 * the authored box is what decides the shape, and a PNG whose own ratio is a
 * fraction off would otherwise shift the scene on the grid. It also means the
 * page does not reflow as 23 files arrive, because every box has its final
 * size before any of them do.
 *
 * `data-item` and `data-note` are for the 원고지 note (./home-note.ts): while
 * it is up, the grid, the four subjects and everything else each do something
 * different, and the stylesheet tells them apart by these rather than by
 * position in the list. `--note-x` is how far across the stage the piece
 * starts, as a fraction, which is what staggers the drawings coming back in
 * left to right when the note closes.
 *
 * `hidden` is for the hero on the page, where the stage is ONE image with one
 * name (see `renderHero`): the pieces are hidden from assistive technology so
 * that name is announced once, not followed by 23 more. Chrome does not prune
 * the children of `role="img"` on its own; measured, it read the grid's alt
 * twice and then every scene. The alt text stays on each `<img>` all the same,
 * because the editor lists it and the lightbox, which has no wrapping name,
 * still uses it.
 */
function heroPiece(item: CanvasItem, lazy: boolean, isGround: boolean, hidden: boolean): string {
  const src = safeUrl(item.src);
  if (src === null) return '';

  const style = [
    `left:${css(refPxToPercent(item.x))}%`,
    `top:${css(item.y)}px`,
    `top:${css(refPxToPercent(item.y))}cqw`,
    `width:${css(refPxToPercent(item.w))}%`,
    `aspect-ratio:${css(item.w)} / ${css(item.h)}`,
  ];
  if (item.z !== undefined) style.push(`z-index:${Math.trunc(item.z)}`);
  if (item.rotate !== undefined && item.rotate !== 0) {
    style.push(`transform:rotate(${css(item.rotate)}deg)`);
  }
  // The skier starts at x:-50, so this is clamped: a negative delay would
  // bring him back before the note has finished leaving.
  style.push(`--note-x:${css(Math.min(1, Math.max(0, item.x / REFERENCE_WIDTH)))}`);

  // The grid is the ground and is the one piece worth fetching eagerly; the
  // scenes on it can arrive as they arrive. In the lightbox nothing is
  // eager, because the overlay is closed until it is opened.
  const priority =
    lazy || item.z !== 0 ? ' loading="lazy" decoding="async"' : ' fetchpriority="high" decoding="async"';

  return (
    `<div class="hero-piece"${attr('data-item', item.id)}${attr('data-note', noteRoleOf(item.id, isGround))}` +
    `${hidden ? ' aria-hidden="true"' : ''} style="${escapeAttr(style.join(';'))}">` +
    `<img${attr('src', src)}${attr('alt', item.alt ?? '')}${priority} />` +
    '</div>'
  );
}

/**
 * The stage: a fixed-shape box the pieces are placed inside.
 *
 * `container-type: inline-size` is on the stage rather than inherited from
 * `.doc`, because the hero is not inside `.doc` — it is a sibling of it — so
 * without this the `cqw` tops would resolve against the wrong box, or against
 * the viewport, and the whole arrangement would shear as the window changed.
 *
 * `label` makes the stage the illustration's one accessible image, which is
 * what the page wants and the lightbox does not (the overlay is a dialog with
 * its own name, and the pieces inside it are the thing being looked at).
 */
function heroStage(band: CanvasBand, options: { lazy: boolean; label?: string }): string {
  const sorted = [...band.items].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  const ground = sorted[0];
  const labelled = options.label !== undefined;
  const pieces = sorted
    .map((item) => heroPiece(item, options.lazy, item === ground, labelled))
    .join('');
  const role = labelled ? ` role="img"${attr('aria-label', options.label)}` : '';
  return (
    `<div class="hero-stage"${role} style="aspect-ratio:${css(REFERENCE_WIDTH)} / ${css(band.height)}">` +
    pieces +
    '</div>'
  );
}

/**
 * The sentence that names the whole illustration, which is the alt of the
 * piece at the back — the grid every other piece sits on. A composition needs
 * ONE accessible name, not 23, and this keeps that name in the document where
 * it can be edited rather than in this file where it cannot.
 */
function heroLabel(band: CanvasBand): string {
  const ground = [...band.items].sort((a, b) => (a.z ?? 0) - (b.z ?? 0))[0];
  return ground?.alt ?? 'Illustration';
}

/** The close mark, from src/pages/index.astro. */
const CLOSE_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path d="M3 3l10 10M13 3L3 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />' +
  '</svg>';

/**
 * The hero, the 원고지 note that explains it, and the row under the sheet.
 *
 *   .hero                  the white sheet; plain container, focus returns here
 *     .hero-open           the enlarge button (inert on a desktop)
 *       .hero-stage        role="img", the illustration's one name
 *     .note-layer          the note, over the grid (hidden until played)
 *   .note-caption          the note's place on a phone (hidden, empty)
 *   .hero-hint             TAP THE GRID TO ENLARGE | replay button
 *
 * `role="img"` used to be on `.hero` itself. It moved to the stage because a
 * note inside it would be text inside an image, which is not text anyone can
 * reach, and the note is a sibling of the button, not a descendant of the
 * stage, for that reason and because the lightbox reuses the stage.
 *
 * The replay button is in the hint row because on a phone it shares that row
 * with the hint, one line under the sheet. On a desktop the row is a
 * zero-height strip holding only the button, so it overlays the gap above the
 * intro rather than pushing the intro down: in Paper the intro is at the same
 * height with and without it.
 */
export function renderHero(band: CanvasBand): string {
  return (
    '<div class="hero" tabindex="-1">' +
    '<button class="hero-open" type="button" aria-label="Enlarge the illustration">' +
    heroStage(band, { lazy: false, label: heroLabel(band) }) +
    '</button>' +
    renderNoteLayer() +
    '</div>' +
    renderNoteCaption() +
    '<div class="hero-hint">' +
    `<span class="hero-hint-tap">${HERO_HINT}</span>` +
    renderNoteRule() +
    renderNoteReplay() +
    '</div>'
  );
}

/**
 * The enlarge overlay. `position: fixed`, so it must not end up inside an
 * element with layout containment — `.doc` has `container-type: inline-size`,
 * which would make the overlay resolve against the document box instead of the
 * viewport. That is why `renderHome` returns it as a sibling of everything
 * else rather than wrapping the page in one container.
 */
export function renderHeroLightbox(band: CanvasBand): string {
  // The same pieces, not a flattened copy of them. The overlay is therefore
  // whatever the homepage currently is, with nothing to regenerate when a
  // scene moves, and it enlarges from sources drawn at 1.5x rather than from
  // a 1x raster — which is the point of an enlarge on a phone.
  return (
    `<div class="lightbox" id="${HERO_LIGHTBOX_ID}" tabindex="-1" role="dialog" aria-modal="true"` +
    ' aria-label="Illustration, enlarged">' +
    `<div class="lightbox-stage">${heroStage(band, { lazy: true })}</div>` +
    '<button class="lightbox-close" type="button" aria-label="Close">' +
    CLOSE_SVG +
    '</button>' +
    '<span class="lightbox-hint">DRAG &amp; PINCH</span>' +
    '</div>'
  );
}

/* -------------------------------------------------------------------------- */
/* The intro                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The paragraphs, at `.intro`'s own measure and rhythm.
 *
 * A `p` block renders as a bare `<p>`, because that is what `.intro p` styles;
 * anything else (a heading, a list, a quote somebody puts on the homepage) goes
 * through the ordinary block renderer so it is styled rather than lost.
 */
export function renderIntro(title: string, band: ProseBand | null): string {
  const name = `<p class="name">${escapeText(title)}</p>`;
  const blocks =
    band === null
      ? ''
      : joinParts(
          band.blocks.map((block) => {
            if (block.kind !== 'p') return renderProseBlock(block);
            const inner = renderInline(block.content);
            return `<p${attr('data-block-id', block.id)}>${inner}</p>`;
          }),
        );
  return `<div class="intro"${attr('data-band-id', band?.id)}>${name}${blocks}</div>`;
}

/* -------------------------------------------------------------------------- */
/* renderHome                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The homepage body.
 *
 * Returns several top-level elements, not one wrapper. Two reasons, both
 * load-bearing:
 *
 *  - `.hero` paints its white sheet out to the window with
 *    `box-shadow: 0 0 0 100vmax`, and `.hero-hint` sits on the page background
 *    below it. A wrapper with its own padding or containment moves both.
 *  - `.lightbox` is `position: fixed` and has to resolve against the viewport.
 *
 * `renderDocBands` is passed in rather than imported so this module does not
 * import its own parent; `renderDoc` in ../index.ts supplies it.
 */
export function renderHomeWith(
  doc: Doc,
  renderRest: (doc: Doc, bands: readonly Band[]) => string,
): string {
  const { hero, intro, rest } = splitHome(doc);
  return joinParts([
    hero === null ? '' : renderHero(hero),
    renderIntro(doc.meta.title, intro),
    rest.length === 0 ? '' : renderRest(doc, rest),
    hero === null ? '' : renderHeroLightbox(hero),
  ]);
}
