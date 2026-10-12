/**
 * src/cms/render/connectors.ts
 *
 * WS-1. The client half of the renderer: the hand-drawn curves that join a
 * paragraph to the canvas item anchored to it (CanvasItem.anchor).
 *
 * This is the one thing renderDoc() cannot do. The path depends on where the
 * two boxes actually land, which depends on the viewport, on the font, and on
 * where the text happened to wrap. So it is measured in the browser and drawn
 * again whenever anything moves.
 *
 * It runs in the browser and nowhere else, and renderDoc() does not import it.
 * It also imports nothing: the breakpoint is read from the stylesheet's
 * --doc-mobile-breakpoint and the wobble seed is read from the markup
 * (data-connector-seed, which the renderer filled in from seedFromId), so
 * loading this does not drag zod into the page for two numbers.
 *
 * Below the breakpoint, nothing is drawn. Brief 3.4: connectors are not drawn
 * in the mobile fallback. The stylesheet hides the overlay as well, so this is
 * belt and braces, and it skips the measuring work too.
 *
 * Usage, from an Astro page or the editor:
 *
 *   import { initDocConnectors } from '../cms/render/connectors.ts';
 *   const stop = initDocConnectors();        // every .doc in the page
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Horizontal clearance needed before a line reads as a connection. */
const MIN_REACH = 36;
/** Past this vertical drop a line stops reading as a connection and starts
 *  reading as a scribble across the page. Leave it off instead. */
const MAX_DROP = 620;

/* -------------------------------------------------------------------------- */
/* Seeded wobble                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Stable pseudo-random in [-1, 1] from the item's seed, so a given line wobbles
 * the same way on every render instead of twitching on resize, and looks the
 * same in the editor as on the published page.
 */
function wobble(seed: number, salt: number): number {
  const x = Math.sin((seed % 100000) * 0.0137 + salt * 91.337) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

function clamp(value: number, low: number, high: number): number {
  return high < low ? low : Math.min(Math.max(value, low), high);
}

/* -------------------------------------------------------------------------- */
/* The path                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One continuous stroke from the text out to the item, with a cursive loop
 * where it crosses itself in the middle.
 *
 * THE LOOP IS MADE BY THE LINE, not stuck on it. The first attempt drew a
 * circle at the midpoint and ran the line into it, which reads as a bubble
 * sitting on a wire: there is a kink going in, a kink coming out, and the
 * circle is obviously a separate object. Here the stroke simply rises, curls
 * over, comes back down across its own path and carries on, the way a loop
 * happens in handwriting. Nothing is drawn twice and there are no corners.
 *
 * The loop always opens UPWARD on screen, whichever way the line is
 * travelling, because a loop hanging below the line reads as a mistake rather
 * than a flourish.
 *
 * Every number is nudged by the item's seed, so a given connector draws the
 * same way on every render and looks identical in the editor and on the page.
 *
 * `direction` is +1 when the item is to the right of the text, -1 when it is
 * to the left, so the stroke leaves the paragraph on the correct side.
 */
function handPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  seed: number,
  direction: number,
): string {
  // A short tick out of the text before the stroke proper: it is what makes
  // the line look drawn from the paragraph rather than passing near it.
  const tick = 6 * direction + wobble(seed, 5) * 2;
  const sx = x1 + tick;
  const sy = y1 + wobble(seed, 6) * 2;

  const dx = x2 - sx;
  const dy = y2 - sy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;

  // The upward normal. Flipped if it points down the screen, so the loop
  // opens the same way no matter which way the line runs.
  let nx = -uy;
  let ny = ux;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }

  // Where the stroke crosses itself.
  const t = 0.5 + wobble(seed, 7) * 0.05;
  const cx = sx + dx * t;
  const cy = sy + dy * t;

  // Tall and narrow, like the loop in a written letter. Capped against the
  // run so a short connector cannot be all loop.
  const h = clamp(30 + wobble(seed, 10) * 5, 15, len / 4.2);
  const w = h * (0.52 + Math.abs(wobble(seed, 13)) * 0.12);

  // The long shallow sag either side. It is what stops the two halves
  // looking like two straight lines meeting at a flourish.
  const sag = 9 + Math.abs(wobble(seed, 11)) * 6;

  /** A point in the stroke's own frame: along the run, and up from it. */
  const at = (along: number, up: number): [number, number] => [
    cx + ux * along + nx * up,
    cy + uy * along + ny * up,
  ];

  // THE LOOP LEANS INTO THE TRAVEL and its tail comes down on the FAR SIDE of
  // where it went up, so the two strands genuinely cross. An earlier version
  // brought them back to the same point: that is a cusp, not a crossing, and
  // it reads as a teardrop balanced on the line rather than as handwriting.
  const [apx, apy] = at(w * 0.55, h); // apex, up and ahead
  const [tailx, taily] = at(-w * 0.38, h * 0.12); // tail, behind and just above

  // Into the crossing: level out of the paragraph, sag, then rise into the
  // loop so the curl starts tangentially.
  const [a1x, a1y] = [sx + dx * 0.26 - nx * sag, sy + dy * 0.26 - ny * sag];
  const [a2x, a2y] = at(-len * 0.1, -sag * 0.2);

  // Up the near side and over: it arrives at the apex travelling backwards,
  // which is what turns it over instead of hooking it.
  const [u1x, u1y] = at(w * 0.5, h * 0.42);
  const [u2x, u2y] = at(w * 1.02, h * 0.88);

  // Down the far side to the tail, then away.
  const [d1x, d1y] = at(w * 0.1, h * 1.12);
  const [d2x, d2y] = at(-w * 0.62, h * 0.74);

  // Out of the tail: back down across the rising strand and on to the item.
  const [b1x, b1y] = at(w * 0.55, -h * 0.1);
  const [b2x, b2y] = [sx + dx * 0.76 - nx * sag, sy + dy * 0.76 - ny * sag];

  const n = (value: number): string => value.toFixed(1);

  return (
    `M ${n(x1)} ${n(y1)}` +
    ` L ${n(sx)} ${n(sy)}` +
    ` C ${n(a1x)} ${n(a1y)}, ${n(a2x)} ${n(a2y)}, ${n(cx)} ${n(cy)}` +
    ` C ${n(u1x)} ${n(u1y)}, ${n(u2x)} ${n(u2y)}, ${n(apx)} ${n(apy)}` +
    ` C ${n(d1x)} ${n(d1y)}, ${n(d2x)} ${n(d2y)}, ${n(tailx)} ${n(taily)}` +
    ` C ${n(b1x)} ${n(b1y)}, ${n(b2x)} ${n(b2y)}, ${n(x2)} ${n(y2)}`
  );
}

/* -------------------------------------------------------------------------- */
/* Measuring                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The breakpoint, from the stylesheet. --doc-mobile-breakpoint is declared on
 * .doc and carries MOBILE_BREAKPOINT, so the CSS and this script cannot
 * disagree about where the fallback starts.
 *
 * Returns null when the property is missing, which means doc.css is not loaded.
 * Nothing is positioned in that case, so there is nothing to connect, and
 * drawing would be worse than not drawing.
 */
function breakpointOf(root: Element): number | null {
  const raw = getComputedStyle(root).getPropertyValue('--doc-mobile-breakpoint').trim();
  if (raw === '') return null;
  const px = Number.parseFloat(raw);
  return Number.isFinite(px) ? px : null;
}

/** The visible box of an item: the media frame, not the wrapper, which also
 *  holds the caption. */
function itemBox(item: Element): DOMRect {
  const frame = item.querySelector('.doc-frame');
  return (frame ?? item).getBoundingClientRect();
}

/**
 * Draw, or redraw, every connector in one document. Clears first, so this is
 * safe to call as often as you like.
 */
export function drawDocConnectors(root: HTMLElement): void {
  const svg = root.querySelector<SVGSVGElement>('svg.doc-connectors');
  if (svg === null) return;

  while (svg.firstChild !== null) svg.removeChild(svg.firstChild);

  const breakpoint = breakpointOf(root);
  if (breakpoint === null) return;
  if (window.matchMedia(`(max-width: ${breakpoint}px)`).matches) return;

  const box = root.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return;
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);

  const items = root.querySelectorAll<HTMLElement>('.doc-item[data-anchor-block]');
  items.forEach((item) => {
    const blockId = item.getAttribute('data-anchor-block');
    if (blockId === null || blockId === '') return;

    // Ids are [A-Za-z0-9_-] by schema, so this is safe to put in a selector.
    const target = root.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
    if (target === null) return;

    const anchor = target.getBoundingClientRect();
    const media = itemBox(item);
    if (media.width === 0 || media.height === 0) return;

    // Which side of the text column the item is on. When it overlaps the text
    // horizontally there is no sideways journey to draw, so skip it: a line
    // doubling back over the paragraph it points at looks like a mistake.
    let direction = 0;
    if (media.left - anchor.right >= MIN_REACH) direction = 1;
    else if (anchor.left - media.right >= MIN_REACH) direction = -1;
    if (direction === 0) return;

    // Arrive at the middle of the facing edge, and leave from the point on the
    // paragraph's edge nearest to it, so the line stays short and level
    // instead of always starting at the last line of text.
    const y2 = media.top + media.height / 2 - box.top;
    const x2 = (direction === 1 ? media.left - 10 : media.right + 10) - box.left;
    const x1 = (direction === 1 ? anchor.right + 8 : anchor.left - 8) - box.left;
    const y1 = clamp(y2, anchor.top + 12 - box.top, anchor.bottom - 12 - box.top);

    if (Math.abs(y2 - y1) > MAX_DROP) return;

    const seed = Number.parseInt(item.getAttribute('data-connector-seed') ?? '', 10);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', handPath(x1, y1, x2, y2, Number.isFinite(seed) ? seed : 1, direction));
    // A presentation attribute loses to the stylesheet's `.doc-connectors path`
    // rule, so a chosen colour has to go on the element's own style.
    const color = item.getAttribute('data-connector-color');
    if (color !== null && color !== '') path.style.stroke = color;
    svg.appendChild(path);
  });
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Keep one document's connectors drawn. Returns a function that stops
 * listening, for the editor, which mounts and unmounts previews.
 *
 * Redrawn on: first call, each image as it arrives (they change the layout),
 * once the webfonts are ready (they change where the text wraps), on resize,
 * and whenever the document's own box changes size, which is what catches the
 * editor's panes being dragged.
 */
export function watchDocConnectors(root: HTMLElement): () => void {
  let frame = 0;
  const redraw = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => drawDocConnectors(root));
  };

  drawDocConnectors(root);

  root.querySelectorAll('img').forEach((img) => {
    if (!img.complete) img.addEventListener('load', redraw, { once: true });
  });
  if (document.fonts !== undefined) void document.fonts.ready.then(redraw);

  window.addEventListener('resize', redraw);

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(redraw);
    observer.observe(root);
  }

  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', redraw);
    if (observer !== null) observer.disconnect();
  };
}

/**
 * Start on every rendered document in the page, or on one you pass. Safe to
 * call when there are none, and safe to call twice.
 */
export function initDocConnectors(root?: HTMLElement | null): () => void {
  const roots =
    root !== undefined && root !== null
      ? [root]
      : Array.from(document.querySelectorAll<HTMLElement>('.doc'));
  const stops = roots.map((element) => watchDocConnectors(element));
  return () => stops.forEach((stop) => stop());
}
