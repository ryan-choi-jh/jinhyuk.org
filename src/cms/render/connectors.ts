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
 * An S-curve from the text out to the item, with a little slack in it. It
 * leaves the paragraph going sideways and arrives at the item going sideways,
 * so the line bows instead of cutting a straight diagonal, and every control
 * point is nudged by the seed so it does not look drafted.
 *
 * `direction` is +1 when the item is to the right of the text, -1 when it is to
 * the left, so the bow always leans away from the text rather than through it.
 */
function handPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  seed: number,
  direction: number,
): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const reach = Math.max(60, Math.abs(dx) * 0.55) * direction;

  // A short tick out of the text before the curve proper: it is what makes the
  // line look drawn from the paragraph rather than passing near it.
  const tick = 6 * direction + wobble(seed, 5) * 2;
  const sx = x1 + tick;
  const sy = y1 + wobble(seed, 6) * 2;

  // Where the knot sits, and which way the line is travelling through it.
  // Roughly halfway, nudged by the seed so two connectors on one page do not
  // knot at the same point.
  const mx = sx + (x2 - sx) * (0.52 + wobble(seed, 7) * 0.07);
  const my = sy + (y2 - sy) * (0.5 + wobble(seed, 8) * 0.09);
  const len = Math.hypot(x2 - sx, y2 - sy) || 1;
  const ux = (x2 - sx) / len;
  const uy = (y2 - sy) / len;
  // The loop hangs off one side of the line. Which side alternates with the
  // seed, so a page of connectors does not look stamped.
  const side = wobble(seed, 9) >= 0 ? 1 : -1;
  const nx = -uy * side;
  const ny = ux * side;

  // Small enough to read as a flourish in the line rather than a circle with
  // a line through it. Scaled down on a short run so it cannot swallow the
  // whole connector.
  const r = clamp(9 + wobble(seed, 10) * 2, 6, Math.max(6, len / 7));
  // The exit sits a little past the entry along the travel direction, so the
  // loop closes into a knot rather than a clean circle that happens to touch.
  // Squashed and tilted, so it is a knot in a line and not a stamped circle.
  const ry = r * (0.76 + Math.abs(wobble(seed, 13)) * 0.16);
  const tilt = wobble(seed, 14) * 34;
  const advance = r * 0.55;
  const ex = mx + ux * advance;
  const ey = my + uy * advance;
  // The far side of the loop, diametrically opposite the entry.
  const fx = mx + nx * r * 2;
  const fy = my + ny * r * 2;

  // The two runs either side of the knot bow in OPPOSITE directions, which is
  // what makes the line read as drawn rather than as a curve with a circle
  // stuck on it: each one is a shallow S instead of an arc.
  const bowIn = (7 + Math.abs(wobble(seed, 11)) * 5) * side;
  const bowOut = -(7 + Math.abs(wobble(seed, 12)) * 5) * side;

  // Into the knot: leaves the paragraph sideways, arrives along the travel
  // direction so the loop starts tangentially.
  const i1x = sx + reach * 0.5 + wobble(seed, 2) * 10 + nx * bowIn;
  const i1y = sy + dy * 0.06 + wobble(seed, 1) * 12 + ny * bowIn;
  const i2x = mx - ux * 34 - nx * bowIn * 0.6;
  const i2y = my - uy * 34 - ny * bowIn * 0.6;

  // Out of the knot: leaves along the travel direction, arrives at the item
  // sideways so the line meets its edge square on.
  const o1x = ex + ux * 34 + nx * bowOut * 0.6;
  const o1y = ey + uy * 34 + ny * bowOut * 0.6;
  const o2x = x2 - reach * 0.5 + wobble(seed, 3) * 10 + nx * bowOut;
  const o2y = y2 - dy * 0.1 + wobble(seed, 4) * 12 + ny * bowOut;

  const n = (value: number): string => value.toFixed(1);

  return (
    `M ${n(x1)} ${n(y1)}` +
    ` L ${n(sx)} ${n(sy)}` +
    ` C ${n(i1x)} ${n(i1y)}, ${n(i2x)} ${n(i2y)}, ${n(mx)} ${n(my)}` +
    // Two half turns make the full loop. Same sweep both times, so it goes
    // round once rather than doubling back into an S.
    ` A ${n(r)} ${n(ry)} ${n(tilt)} 1 1 ${n(fx)} ${n(fy)}` +
    ` A ${n(r)} ${n(ry)} ${n(tilt)} 1 1 ${n(ex)} ${n(ey)}` +
    ` C ${n(o1x)} ${n(o1y)}, ${n(o2x)} ${n(o2y)}, ${n(x2)} ${n(y2)}`
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
