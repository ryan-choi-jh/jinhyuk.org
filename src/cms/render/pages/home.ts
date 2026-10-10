/**
 * src/cms/render/pages/home.ts
 *
 * WS-B. The homepage, from `src/content/pages/home.json`.
 *
 * The homepage is a document now (docs/cms-sections.md 3.2), but it is not a
 * document that should render like a project page. Live it is three things:
 *
 *   .hero        the 원고지 illustration, full bleed, on its own white sheet
 *   .hero-hint   "TAP THE GRID TO ENLARGE", touch devices only
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

import { isCanvasBand, isProseBand } from '../../schema.ts';
import type { Band, CanvasItem, Doc, ProseBand } from '../../schema.ts';
import { attr, escapeText, joinParts, safeUrl } from '../escape.ts';
import { renderInline, renderProseBlock } from '../prose.ts';

/* -------------------------------------------------------------------------- */
/* Picking the hero and the intro out of the bands                            */
/* -------------------------------------------------------------------------- */

export type HomeParts = {
  /** The illustration, or null when the document has no leading image. */
  hero: CanvasItem | null;
  /** The band the hero came out of, so it is not rendered twice. */
  heroBand: Band | null;
  /** The paragraphs under it, or null. */
  intro: ProseBand | null;
  /** Everything else, in document order. Rendered as an ordinary document. */
  rest: Band[];
};

/**
 * The hero is the first image in the document's first canvas band. First
 * canvas band and not "the band called hero": a band id is the author's, and
 * a renderer that keys off one breaks the moment somebody renames it.
 */
function heroItemOf(band: Band): CanvasItem | null {
  if (!isCanvasBand(band)) return null;
  for (const item of band.items) {
    if (item.kind === 'image' && safeUrl(item.src) !== null) return item;
  }
  return null;
}

export function splitHome(doc: Doc): HomeParts {
  const bands = [...doc.bands];
  let hero: CanvasItem | null = null;
  let heroBand: Band | null = null;

  const first = bands[0];
  if (first !== undefined) {
    const candidate = heroItemOf(first);
    // Only when the band holds nothing but the hero. A canvas band with a
    // squiggle in it as well is a canvas, and belongs in the document body
    // where the renderer can place both.
    if (candidate !== null && isCanvasBand(first) && first.items.length === 1) {
      hero = candidate;
      heroBand = first;
      bands.shift();
    }
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
 * `width` and `height` are the authored box, which is the illustration's own
 * aspect ratio in reference pixels. `.hero img` is `width:100%; height:auto`,
 * so these only reserve the right shape before the file arrives — exactly what
 * the live page's 2688x1648 does, at half the numbers and the same ratio.
 */
function heroImage(item: CanvasItem, lazy: boolean): string {
  const src = safeUrl(item.src);
  if (src === null) return '';
  return (
    `<img${attr('src', src)}${attr('alt', lazy ? '' : (item.alt ?? ''))}` +
    attr('width', Math.round(item.w)) +
    attr('height', Math.round(item.h)) +
    (lazy ? ' loading="lazy" decoding="async"' : ' fetchpriority="high" decoding="async"') +
    ' />'
  );
}

/** The close mark, from src/pages/index.astro. */
const CLOSE_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path d="M3 3l10 10M13 3L3 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />' +
  '</svg>';

export function renderHero(item: CanvasItem): string {
  return (
    '<div class="hero" tabindex="-1">' +
    '<button class="hero-open" type="button" aria-label="Enlarge the illustration">' +
    heroImage(item, false) +
    '</button>' +
    '</div>' +
    `<span class="hero-hint">${HERO_HINT}</span>`
  );
}

/**
 * The enlarge overlay. `position: fixed`, so it must not end up inside an
 * element with layout containment — `.doc` has `container-type: inline-size`,
 * which would make the overlay resolve against the document box instead of the
 * viewport. That is why `renderHome` returns it as a sibling of everything
 * else rather than wrapping the page in one container.
 */
export function renderHeroLightbox(item: CanvasItem): string {
  return (
    `<div class="lightbox" id="${HERO_LIGHTBOX_ID}" tabindex="-1" role="dialog" aria-modal="true"` +
    ' aria-label="Illustration, enlarged">' +
    `<div class="lightbox-stage">${heroImage(item, true)}</div>` +
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
