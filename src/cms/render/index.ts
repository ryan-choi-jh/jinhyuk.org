/**
 * src/cms/render/index.ts
 *
 * WS-1 RENDERER. The one place a document turns into HTML.
 *
 * The contract (docs/cms-rebuild.md 3.6, docs/cms-contracts.md 4):
 *
 *   export function renderDoc(doc: Doc): string;   // body HTML
 *   export function docStyles(): string;           // path to the stylesheet
 *
 * No React, no Astro, no DOM. Pure string in, string out, so the same function
 * runs in the static build, in SSR, in the preview and in a bare node script.
 * Both the live site and the preview call it, which is the whole point of 2.4:
 * there is nothing for them to drift from.
 *
 * Page structure:
 *
 *   <div class="doc">
 *     <div class="doc-group">          one lead band, plus any overlays on it
 *       <div class="doc-band doc-band--prose">  blocks, in normal flow
 *       <div class="doc-band doc-band--canvas doc-band--overlay">
 *     </div>
 *     <div class="doc-group"> ... </div>
 *     <svg class="doc-connectors">     filled in by the client script
 *   </div>
 *
 * `.doc` belongs in a full-width content column: the 1344px that
 * REFERENCE_WIDTH refers to is the column `.wrap` leaves at the designed
 * 1440px page width, which on the current site is where `.project-body` sits.
 * The reading measure is applied to the prose blocks themselves, not to their
 * container, exactly as `.project-body > p` does it today, so a canvas band can
 * use the whole width while the text stays at 720px.
 */

import { isCanvasBand, resolveAnchor } from '../schema.ts';
import type { Band, CanvasBand, Doc } from '../schema.ts';
import { renderCanvasBand } from './canvas.ts';
import { attr, escapeText, joinParts } from './escape.ts';
import { renderProseBand } from './prose.ts';
import { renderDocButtons } from './pages/buttons.ts';
import { renderHomeWith } from './pages/home.ts';

export { renderCanvasBand, renderCanvasItem, embedSrc } from './canvas.ts';
export { renderInline, renderProseBand, renderProseBlock } from './prose.ts';
export * from './pages/index.ts';
export {
  ensureShapeAssets,
  fallbackGenerateShape,
  getShapeGenerator,
  renderShapeSvg,
  setShapeGenerator,
  usingShapeAssets,
} from './shapes.ts';
export { escapeAttr, escapeText, safeUrl } from './escape.ts';

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The stylesheet, as a project-root-relative path. Everything `renderDoc`
 * produces is styled by this one file and nothing else.
 *
 * How to use it depends on where you are:
 *   - Astro or any Vite consumer: `import '../cms/styles/doc.css';`, which
 *     bundles and hashes it. This path is what that import resolves to.
 *   - a script or a test: read it off disk relative to the project root.
 */
export function docStyles(): string {
  return '/src/cms/styles/doc.css';
}

/**
 * The client script that draws anchored connectors, as a project-root-relative
 * path. Optional: a page without anchored items does not need it, and the
 * script does nothing below the mobile breakpoint.
 *
 *   <script>
 *     import { initDocConnectors } from '../cms/render/connectors.ts';
 *     initDocConnectors();
 *   </script>
 */
export function docScript(): string {
  return '/src/cms/render/connectors.ts';
}

/**
 * WS-B. The second stylesheet: everything the four surfaces that are not a
 * document need, plus the album page. `doc.css` styles what `renderDoc`
 * produces; this styles what the index pages and the album page produce, and
 * it expects `src/styles/global.css` to be loaded alongside it, because the
 * card grid, the masthead and the lightbox chrome are already there.
 *
 *   import '../cms/styles/sections.css';
 */
export function sectionStyles(): string {
  return '/src/cms/styles/sections.css';
}

/**
 * WS-B. The filmography poster-frame facade: swaps in the YouTube player on
 * click so four pages' worth of player stays off first paint.
 *
 *   import { initVideoFacades } from '../cms/render/video.ts';
 *   initVideoFacades();
 */
export function videoScript(): string {
  return '/src/cms/render/video.ts';
}

/**
 * WS-B. The enlarge overlay, for the homepage hero and for an album.
 *
 *   import { initLightboxes } from '../cms/render/lightbox.ts';
 *   initLightboxes();
 */
export function lightboxScript(): string {
  return '/src/cms/render/lightbox.ts';
}

/* -------------------------------------------------------------------------- */
/* Bands -> groups                                                            */
/* -------------------------------------------------------------------------- */

type Group = { lead: Band; overlays: CanvasBand[] };

/**
 * An overlay band sits over the band before it (2.2), so the two have to share
 * a positioning context. Consecutive overlays all attach to the same lead band,
 * which is what lets a paragraph carry a screenshot and a connector at once.
 *
 * The schema already rejects `overlay` on band 0; the guard here is so a
 * hand-written or half-migrated document renders as a plain band instead of
 * disappearing.
 */
export function groupBands(bands: readonly Band[]): Group[] {
  const groups: Group[] = [];
  for (const band of bands) {
    const isOverlay = isCanvasBand(band) && band.overlay === true;
    const previous = groups[groups.length - 1];
    if (isOverlay && previous !== undefined) previous.overlays.push(band as CanvasBand);
    else groups.push({ lead: band, overlays: [] });
  }
  return groups;
}

function renderBand(band: Band, doc: Doc): string {
  return band.type === 'prose' ? renderProseBand(band) : renderCanvasBand(band, doc);
}

/** True when at least one canvas item has an anchor that actually resolves. */
export function hasConnectors(doc: Doc): boolean {
  return doc.bands.some(
    (band) =>
      isCanvasBand(band) &&
      band.items.some((item) => item.anchor !== undefined && resolveAnchor(doc, item.anchor) !== null),
  );
}

/* -------------------------------------------------------------------------- */
/* renderDoc                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The modifier class on `.doc`, so the stylesheet can hold an essay to the
 * typography the live essay pages use (27px between paragraphs, a quiet
 * grey-ruled blockquote) while a project keeps the project page's (28px, a
 * 26/40 accent pull-quote). The two really do differ in `global.css`
 * (`article p` versus `.project-body > p`, `article blockquote` versus
 * `.pb-quote`), and "the only visible change on the whole site is the new
 * album page" means the renderer has to know which it is rendering.
 *
 * A document with no `meta.section` — every phase 1 project page — gets no
 * modifier and therefore the phase 1 appearance, unchanged.
 */
function sectionClass(doc: Doc): string {
  const section = doc.meta.section;
  // 'home' never reaches `.doc`: `renderHome` renders the hero and the intro
  // as the site's own `.hero` and `.intro`, and only sends any band after
  // those through `renderDocBands`, where it is an ordinary document.
  if (section === undefined || section === 'home') return '';
  return ` doc--${section}`;
}

/**
 * `doc--canvas` when the document actually places something freely.
 *
 * It exists for one decision, and only on essays. A live essay's reading
 * column is a flat 720px (`article { max-width: 720px }`); a document's is
 * `min(720px, 100cqw * 720/1344)`, which scales with the column so that an
 * item authored to sit beside the text at the reference width is still beside
 * it at 1100. For a project page that scaling is the whole point. For an essay
 * with no canvas in it there is nothing to stay beside, and the scaling is a
 * visible change for nothing: at a 1440px window the scrollbar gutter alone
 * takes the measure to 712px and the text wraps eight pixels early.
 *
 * So: an essay with no canvas keeps the live 720px, and an essay that has
 * gained one gets the scaling measure that makes the canvas work. The
 * stylesheet is where the two are spelled out.
 */
function canvasClass(doc: Doc, bands: readonly Band[]): string {
  // Only on a document that declares its section, so a phase 1 project page —
  // which has no `meta.section` — still renders the exact string it rendered
  // before phase 2 existed. WS-1's verify.ts asserts that string.
  if (doc.meta.section === undefined) return '';
  return bands.some(isCanvasBand) ? ' doc--canvas' : '';
}

/**
 * The bands of a document, as HTML, wrapped in `.doc`.
 *
 * This is what `renderDoc` was in phase 1, and it is still the whole of it for
 * a project page. `bands` defaults to the document's own; `renderHome` passes a
 * subset, because the homepage lifts its hero and its intro out into the
 * site's own `.hero` and `.intro` and sends only what is left through here.
 */
export function renderDocBands(doc: Doc, bands: readonly Band[] = doc.bands): string {
  const groups = groupBands(bands)
    .map((group) => {
      const lead = renderBand(group.lead, doc);
      const overlays = joinParts(group.overlays.map((band) => renderCanvasBand(band, doc)));
      if (lead === '' && overlays === '') return '';
      return `<div class="doc-group">${lead}${overlays}</div>`;
    })
    .filter((html) => html !== '');

  // One overlay for the whole document, because a connector runs between two
  // boxes that can sit in different bands. Only emitted when there is something
  // to draw; an empty svg would still be a box the editor has to think about.
  const connectors = hasConnectors(doc)
    ? '<svg class="doc-connectors" aria-hidden="true" focusable="false"></svg>'
    : '';

  return (
    `<div class="doc${sectionClass(doc)}${canvasClass(doc, bands)}"` +
    attr('data-doc-slug', doc.meta.slug) +
    `>${groups.join('')}${connectors}</div>`
  );
}

/**
 * The document body, as HTML. Bands, plus `meta.buttons` when there are any:
 * the title, date and summary in `doc.meta` are the page's business, and
 * `renderDocHead` below is there for a page that wants the site's masthead
 * without writing it twice.
 *
 * Dispatches on `meta.section` (docs/cms-sections.md 2), because the three
 * document surfaces are not one layout:
 *
 *   home                 the hero on its white sheet, then `.intro`. See
 *                        `./pages/home.ts` for why it cannot come out of the
 *                        band renderer.
 *   essays, projects     bands, then the end-of-post buttons.
 *   no section           bands. Every phase 1 document, rendered exactly as
 *                        phase 1 rendered it.
 *
 * Never throws. A band the renderer cannot make sense of contributes nothing
 * rather than taking the build down; validate with `validateDoc` first if you
 * want to know about it.
 */
export function renderDoc(doc: Doc): string {
  if (doc.meta.section === 'home') return renderHomeWith(doc, renderDocBands);
  return renderDocBands(doc) + renderDocButtons(doc);
}

/* -------------------------------------------------------------------------- */
/* renderDocHead — optional                                                   */
/* -------------------------------------------------------------------------- */

/** "8 October 2026" the way the existing project and essay pages write it. */
function formatDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** `habit-tracker.vercel.app/welcome`, the way the project page writes a link. */
function prettyUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return (url.hostname.replace(/^www\./, '') + url.pathname).replace(/\/$/, '');
  } catch {
    return raw;
  }
}

/**
 * The masthead for a document: title, date, the "Visit" link and the summary,
 * styled to match the existing `article h1` / `.post-meta` / `.lead`.
 *
 * NOT part of the 3.6 contract, and not part of `renderDoc`, which is bands
 * only. It is here because the preview, the published page and the migration
 * diff all need the same three lines above the body, and three copies of them
 * is three chances to disagree. A page that builds its own header ignores this.
 */
export function renderDocHead(doc: Doc): string {
  const { meta } = doc;
  const visit =
    meta.url === undefined
      ? ''
      : `<a class="doc-visit"${attr('href', meta.url)} target="_blank" rel="noopener noreferrer">` +
        `<span class="doc-visit-label">Visit</span>` +
        `<span class="doc-visit-url">${escapeText(prettyUrl(meta.url))}</span></a>`;
  const summary =
    meta.summary === undefined ? '' : `<p class="doc-summary">${escapeText(meta.summary)}</p>`;

  return (
    `<header class="doc-head${meta.section === undefined ? '' : ` doc-head--${meta.section}`}">` +
    `<h1 class="doc-title">${escapeText(meta.title)}</h1>` +
    `<p class="doc-date">${escapeText(formatDate(meta.date))}</p>` +
    visit +
    summary +
    '</header>'
  );
}

/* -------------------------------------------------------------------------- */
/* renderDocPage — optional                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Masthead plus body, which is what an essay page and a project page both are.
 * Not part of the 3.6 contract either; it exists so WS-G's two page files and
 * WS-H's preview cannot disagree about the order of the two calls.
 *
 * The homepage has no masthead — its name is the first line of `.intro` — so
 * this returns `renderDoc` alone for it.
 */
export function renderDocPage(doc: Doc): string {
  if (doc.meta.section === 'home') return renderDoc(doc);
  return renderDocHead(doc) + renderDoc(doc);
}
