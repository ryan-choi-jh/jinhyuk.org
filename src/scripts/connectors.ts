// Draws the hand-drawn lines joining a paragraph to its margin image.
//
// The path can only be worked out in the browser: it depends on where the two
// boxes actually land, which depends on the viewport, the font and how the
// text happened to wrap. So this measures them and emits an SVG path, then
// does it again whenever anything moves.
//
// A margin item opts in with data-connect="curve" | "loop" and, optionally,
// data-connect-color. Its anchor is the element immediately before it in the
// document, which is the paragraph you had just written when you dropped it in.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Stable pseudo-random in [-1, 1], so a given line wobbles the same way every
 *  render instead of twitching on resize. */
function wobble(seed: number, salt: number): number {
  const x = Math.sin(seed * 374.761 + salt * 91.337) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

function anchorFor(item: Element): Element | null {
  let el = item.previousElementSibling;
  while (el) {
    // Skip other margin items and the overlay itself.
    if (!el.classList.contains('margin-item') && !el.classList.contains('connectors')) {
      return el;
    }
    el = el.previousElementSibling;
  }
  return null;
}

/** An S-curve from the text out to the margin, with a little slack in it. */
function curvePath(
  x1: number, y1: number, x2: number, y2: number, seed: number
): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  // Leave the text going sideways and arrive at the image going sideways, so
  // the line bows into an S instead of cutting a straight diagonal.
  const reach = Math.max(70, Math.abs(dx) * 0.62);
  const c1x = x1 + reach + wobble(seed, 2) * 12;
  const c1y = y1 + dy * 0.06 + wobble(seed, 1) * 14;
  const c2x = x2 - reach + wobble(seed, 3) * 12;
  const c2y = y2 - dy * 0.1 + wobble(seed, 4) * 14;
  return `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`;
}

/** The same journey, but it curls back on itself once on the way. */
function loopPath(
  x1: number, y1: number, x2: number, y2: number, seed: number
): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const mx = x1 + dx * 0.45;
  const my = y1 + dy * 0.45;
  const r = Math.min(34, Math.abs(dx) * 0.14) + wobble(seed, 4) * 5;

  const lead = `M ${x1} ${y1} C ${x1 + dx * 0.18} ${y1 + r * 0.8}, ${mx - r * 1.6} ${my - r}, ${mx - r} ${my}`;
  // A full turn: out, over the top, back under, and on its way again.
  const curl =
    ` C ${mx - r * 1.5} ${my + r * 1.1}, ${mx + r * 0.6} ${my + r * 1.4}, ${mx + r * 0.5} ${my}` +
    ` C ${mx + r * 0.45} ${my - r * 1.2}, ${mx - r * 0.8} ${my - r * 1.1}, ${mx} ${my - r * 0.1}`;
  const tail = ` C ${mx + r * 2} ${my + r * 0.8}, ${x2 - dx * 0.16} ${y2 - r}, ${x2} ${y2}`;
  return lead + curl + tail;
}

export function drawConnectors(root: HTMLElement): void {
  // Below the breakpoint the margin column collapses into the text, so there
  // is nothing to join. The CSS hides the overlay; skip the work too.
  if (window.matchMedia('(max-width: 900px)').matches) return;

  let svg = root.querySelector<SVGSVGElement>('svg.connectors');
  if (!svg) {
    svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    svg.setAttribute('class', 'connectors');
    svg.setAttribute('aria-hidden', 'true');
    root.prepend(svg);
  }
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const box = root.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);

  const items = root.querySelectorAll<HTMLElement>('.margin-item[data-connect]');
  items.forEach((item, i) => {
    const anchor = anchorFor(item);
    if (!anchor) return;

    const a = anchor.getBoundingClientRect();
    // Aim at the picture, not at its box. A tall image is capped by height and
    // sits right-aligned inside the slot, so the slot's left edge can be a
    // long way from anything you can see.
    const media = item.querySelector('img, video, iframe') ?? item;
    const m = media.getBoundingClientRect();

    // Leave the text just past its last line, arrive at the picture's edge.
    const x1 = Math.min(a.right, box.left + 720) - box.left + 8;
    const y1 = a.bottom - box.top - 10;
    const x2 = m.left - box.left - 10;
    const y2 = m.top - box.top + Math.min(48, m.height * 0.25);

    // If the image sits above or level with the text, the line would double
    // back on itself and look like a mistake. Skip it.
    if (x2 - x1 < 40) return;

    // Two margin items in quick succession get stacked well apart, because the
    // second clears the first. Past a certain drop the line stops reading as a
    // connection and starts reading as a scribble across the page, so leave it
    // off rather than draw it.
    if (y2 - y1 > 520) return;

    const shape = item.dataset.connect === 'loop' ? loopPath : curvePath;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', shape(x1, y1, x2, y2, i + 1));
    // A presentation attribute loses to the stylesheet's `.connectors path`
    // rule, so the chosen colour has to go on the element's own style.
    const color = item.dataset.connectColor;
    if (color) path.style.stroke = color;
    svg.appendChild(path);
  });
}

export function initConnectors(): void {
  const root = document.querySelector<HTMLElement>('.project-body');
  if (!root) return;

  const redraw = () => drawConnectors(root);

  redraw();
  // Images change the layout as they load, so draw again as they arrive.
  root.querySelectorAll('img').forEach((img) => {
    if (!img.complete) img.addEventListener('load', redraw, { once: true });
  });
  if (document.fonts?.ready) document.fonts.ready.then(redraw);

  let frame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(redraw);
  });
}
