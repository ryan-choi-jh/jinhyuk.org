/**
 * src/cms/preview/client/frame.ts
 *
 * WS-7. The only script the previewed page carries beyond the ones the live
 * page carries. It adds nothing to the rendering: it measures the page the
 * browser has just laid out and tells the chrome about it.
 *
 * Two jobs:
 *
 *  1. HEIGHT. The frame is an iframe, and an iframe does not size itself. The
 *     chrome gives it the full content height so the whole document is one
 *     continuous page that the chrome scrolls, rather than a short window with
 *     its own scrollbar inside another scrollbar. That also means a full-page
 *     screenshot is possible, which is what WS-7's verification needs.
 *
 *  2. THE READOUT. Whether the 3.4 fallback is in force, how many items are
 *     still positioned, how many connectors are drawn, where each band starts.
 *     Measured from the real computed styles in a real browser, because the
 *     whole point of a preview is that nobody has to take the renderer's word
 *     for it.
 *
 * Imports nothing but the message shape, which is itself import-free, so this
 * does not pull the schema or zod into the previewed page.
 */

import { FRAME_MESSAGE } from '../state.ts';
import type { FrameBandBox, FrameReport } from '../state.ts';

/**
 * `.doc` declares MOBILE_BREAKPOINT as a custom property; read it rather than
 * retyping it.
 *
 * Four of the six surfaces have no `.doc` at all, so the fallback is not a
 * nicety: it is the normal path for a film list or an album page. 900 is the
 * same number, stated once more here and asserted against the schema in
 * `selftest.ts` through `MOBILE_BREAKPOINT_PX`.
 */
function breakpointFrom(doc: HTMLElement | null): number {
  const raw =
    doc === null ? '' : getComputedStyle(doc).getPropertyValue('--doc-mobile-breakpoint').trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 900;
}

/**
 * The boxes of this surface's "entries": the Nth film, album tile, photograph
 * or ledger row, in page order.
 *
 * The selector comes from the frame route, on `<html data-pv-entries>`, for
 * two reasons. One, this script has no idea what it is rendering and guessing
 * from what happens to be in the page would make the change list's row
 * numbering depend on a CSS class collision. Two, it keeps the registry — and
 * therefore zod — out of the previewed page, which is the whole reason
 * `state.ts` is import-free.
 *
 * The id is the index as a string, because a film has no id in its markup and
 * WS-B's renderers are not mine to add one to. The chrome matches on the
 * index it already has from the diff.
 */
function entryBoxes(): FrameBandBox[] {
  const selector = document.documentElement.dataset.pvEntries ?? '';
  if (selector === '') return [];
  let found: NodeListOf<HTMLElement>;
  try {
    found = document.querySelectorAll<HTMLElement>(selector);
  } catch {
    // A malformed selector is a bug in the route, not a reason to stop
    // reporting the height the chrome is waiting for.
    return [];
  }
  return Array.from(found).map((element, index) => boxOf(element, String(index)));
}

/** Opt any image that is still lazy out of it. See `loadEagerly` in frame.astro. */
function eagerLoad(): number {
  const lazy = document.querySelectorAll<HTMLImageElement>('img[loading="lazy"]');
  for (const image of lazy) image.loading = 'eager';
  return lazy.length;
}

/** One element's box, in the frame's own document coordinates. */
function boxOf(element: HTMLElement, id: string): FrameBandBox {
  const box = element.getBoundingClientRect();
  return {
    id,
    top: Math.round(box.top + window.scrollY),
    left: Math.round(box.left + window.scrollX),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

function measure(): FrameReport {
  const doc = document.querySelector<HTMLElement>('.doc');
  const items = Array.from(document.querySelectorAll<HTMLElement>('.doc-item'));
  const overlays = Array.from(document.querySelectorAll<HTMLElement>('.doc-band--overlay'));
  const svg = document.querySelector<SVGSVGElement>('svg.doc-connectors');

  const positioned = items.filter((el) => getComputedStyle(el).position !== 'static');
  const overlayPositioned = overlays.filter((el) => getComputedStyle(el).position !== 'static');

  const connectorNodes = svg === null ? 0 : svg.querySelectorAll('path, line, polyline').length;
  const connectorsHidden = svg === null ? true : getComputedStyle(svg).display === 'none';

  // offsetTop, not getBoundingClientRect: a rotated item's client rect is its
  // rotated bounding box, which starts above the box it was laid out in and
  // would make an order check on a tilted screenshot meaningless. offsetTop is
  // measured against `.doc`, which is positioned, so it is comparable across
  // bands.
  let inOrder = true;
  let previous = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const top = item.offsetTop;
    if (top < previous - 0.5) inOrder = false;
    previous = top;
  }

  /**
   * The images the page is actually waiting for.
   *
   * An overlay's stage starts as `<img src="" alt="" />` and is filled in when
   * something is clicked (WS-B's lightbox.ts), so an empty `src` never loads
   * and `complete && naturalWidth > 0` is false for it forever. Counting it
   * meant the homepage and every album page reported "6 of 7 images" and never
   * became ready, which made the chrome retry three times and a screenshot
   * harness give up waiting. An image with nothing to load is not an image
   * that has failed to load.
   */
  const images = Array.from(document.images).filter((img) => {
    const src = img.getAttribute('src');
    return src !== null && src !== '';
  });

  const bands: FrameBandBox[] = Array.from(
    document.querySelectorAll<HTMLElement>('.doc-band[data-band-id]'),
  ).map((band) => boxOf(band, band.dataset.bandId ?? ''));

  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('.lightbox'));

  const body = document.body;
  const root = document.documentElement;
  const height = Math.max(
    body.scrollHeight,
    body.offsetHeight,
    root.scrollHeight,
    root.offsetHeight,
  );

  return {
    type: FRAME_MESSAGE,
    surface: document.documentElement.dataset.pvSurface ?? 'document',
    height: Math.ceil(height),
    width: window.innerWidth,
    mobile: window.innerWidth <= breakpointFrom(doc),
    items: { total: items.length, positioned: positioned.length, stacked: items.length - positioned.length },
    overlays: { total: overlays.length, positioned: overlayPositioned.length },
    connectors: connectorsHidden ? 0 : connectorNodes,
    connectorNodes,
    inDocumentOrder: inOrder,
    images: {
      total: images.length,
      loaded: images.filter((img) => img.complete && img.naturalWidth > 0).length,
    },
    fontsReady: document.fonts === undefined ? true : document.fonts.status === 'loaded',
    clientWidth: root.clientWidth,
    scrollWidth: root.scrollWidth,
    dialogs: {
      total: dialogs.length,
      open: dialogs.filter((el) => el.classList.contains('is-open')).length,
      fixed: dialogs.filter((el) => getComputedStyle(el).position === 'fixed').length,
    },
    bands,
    entries: entryBoxes(),
  };
}

/**
 * Start reporting. Returns a dispose function, the same shape as WS-1's
 * connector script, so the editor can mount and unmount a preview without
 * leaking listeners.
 *
 * Nothing happens when the page is not in a frame: the frame route is also a
 * perfectly good URL to open on its own, and opening it should not involve
 * posting messages to itself.
 */
export function initPreviewFrame(): () => void {
  // A backstop, not the mechanism. The frame route has already stripped
  // `loading="lazy"` from the markup — see `loadEagerly` in frame.astro for
  // why a preview opts out of it, and why doing it in the markup rather than
  // here is the difference between working and not. This catches an image
  // that arrives afterwards, from a client script or a hand-written document.
  eagerLoad();

  if (window.parent === window) return () => {};

  let queued = 0;
  let last = '';

  const send = (): void => {
    queued = 0;
    // Again on every pass: an image can be added after first paint — the
    // lightbox fills its stage on a click.
    eagerLoad();
    const report = measure();
    const serialised = JSON.stringify(report);
    // The ResizeObserver fires for every image that decodes. Only send when
    // something the chrome cares about actually changed.
    if (serialised === last) return;
    last = serialised;
    // Same-origin by construction: the chrome and the frame are two routes of
    // the same app. '*' would also work and be one fewer thing to get wrong,
    // but naming the origin means a mis-framed preview cannot leak the page's
    // shape to whoever framed it.
    window.parent.postMessage(report, window.location.origin);
  };

  const schedule = (): void => {
    if (queued !== 0) return;
    queued = window.requestAnimationFrame(send);
  };

  const observer = new ResizeObserver(schedule);
  observer.observe(document.documentElement);
  observer.observe(document.body);
  // `.doc` only exists on the three document surfaces; the album grid and the
  // film list reflow as their pictures arrive, and `documentElement` catches
  // that for them.
  const doc = document.querySelector<HTMLElement>('.doc');
  if (doc !== null) observer.observe(doc);

  window.addEventListener('resize', schedule);
  window.addEventListener('load', schedule);
  // Images arrive late and change the height; capture catches them all with
  // one listener, because `load` on an <img> does not bubble.
  window.addEventListener('load', schedule, true);
  if (document.fonts !== undefined) void document.fonts.ready.then(schedule);

  // Once immediately, so the chrome is never left with a provisional height,
  // and again after a tick in case the connector script has not run yet.
  schedule();
  const settle = window.setTimeout(schedule, 300);
  const settleAgain = window.setTimeout(schedule, 1200);

  return () => {
    observer.disconnect();
    window.removeEventListener('resize', schedule);
    window.removeEventListener('load', schedule);
    window.removeEventListener('load', schedule, true);
    window.clearTimeout(settle);
    window.clearTimeout(settleAgain);
    if (queued !== 0) window.cancelAnimationFrame(queued);
  };
}
