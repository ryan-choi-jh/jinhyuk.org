/**
 * src/cms/render/shapes.ts
 *
 * WS-1. Where the renderer gets its shape SVG from.
 *
 * The real generator is WS-6's, at `src/cms/assets/shapes.ts`, frozen by WS-0
 * in docs/cms-contracts.md 5. That file does not exist yet, and the renderer is
 * required to be verifiable on its own, so this module holds:
 *
 *   1. a registry, `setShapeGenerator`, that WS-6's `generateShape` is dropped
 *      into with one line once it lands, and
 *   2. `fallbackGenerateShape`, which satisfies the frozen output contract in
 *      5.3 exactly, so a page renders correctly either way and only the drawing
 *      style changes when the real one arrives.
 *
 * `ensureShapeAssets()` does step 1 automatically for a caller that can await
 * once at start-up. It is deliberately the only async thing in the renderer:
 * renderDoc() stays synchronous, because the contract says so.
 *
 * Pure strings. No DOM.
 */

import { SHAPE_KINDS, shapeSpecFromItem } from '../schema.ts';
import type { CanvasItem, ShapeGenerator, ShapeSpec } from '../schema.ts';

/* -------------------------------------------------------------------------- */
/* Deterministic wobble                                                       */
/* -------------------------------------------------------------------------- */

/**
 * mulberry32. The whole point of ShapeSpec.seed is that a squiggle looks the
 * same in the editor, in the preview and on the published page forever
 * (contracts 5.2), so the randomness has to come from the seed and nowhere
 * else. Never Math.random(), never an array index.
 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A number for an SVG attribute. Two decimals: deterministic, and short. */
function n(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Math.round(value * 100) / 100);
}

/* -------------------------------------------------------------------------- */
/* The fallback generator                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Root attributes, in the order contracts 5.3 lists them. No `id`, no `<defs>`,
 * no `<style>`, no classes: many of these end up inlined in one page.
 */
function svgOpen(width: number, height: number): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg"' +
    ` viewBox="0 0 ${n(width)} ${n(height)}"` +
    ' width="100%" height="100%" preserveAspectRatio="none"' +
    ' aria-hidden="true" focusable="false">'
  );
}

/** Stroke presentation, as attributes. `fill` is "none" unless a fill is set. */
function strokeAttrs(spec: ShapeSpec, filled: boolean): string {
  return (
    ` fill="${filled && spec.fill !== undefined ? spec.fill : 'none'}"` +
    ` stroke="${spec.color}" stroke-width="${n(spec.strokeWidth)}"` +
    ' stroke-linecap="round" stroke-linejoin="round"'
  );
}

/** A gently wandering line from left to right through the middle. */
function linePath(spec: ShapeSpec): string {
  const random = rng(spec.seed);
  const inset = spec.strokeWidth / 2;
  const x1 = inset;
  const x2 = Math.max(inset, spec.width - inset);
  const mid = spec.height / 2;
  // A long rule should not bow more than it is tall, or a 2px-high line turns
  // into a wave.
  const sway = Math.min(spec.height / 2 - inset, spec.width * 0.02, 6);
  const c1 = mid + (random() * 2 - 1) * sway;
  const c2 = mid + (random() * 2 - 1) * sway;
  return `M ${n(x1)} ${n(mid)} C ${n(x1 + (x2 - x1) / 3)} ${n(c1)}, ${n(x1 + ((x2 - x1) * 2) / 3)} ${n(c2)}, ${n(x2)} ${n(mid)}`;
}

/** Three and a bit waves across the box, each crest nudged by the seed. */
function squigglePath(spec: ShapeSpec): string {
  const random = rng(spec.seed);
  const inset = spec.strokeWidth / 2;
  const left = inset;
  const right = Math.max(inset, spec.width - inset);
  const mid = spec.height / 2;
  const amplitude = Math.max(0, spec.height / 2 - inset);
  const waves = 3;
  const step = (right - left) / waves;

  let d = `M ${n(left)} ${n(mid)}`;
  for (let i = 0; i < waves; i += 1) {
    const x0 = left + step * i;
    const peak = mid + (i % 2 === 0 ? -amplitude : amplitude) * (0.72 + random() * 0.28);
    const trough = mid + (i % 2 === 0 ? amplitude : -amplitude) * (0.72 + random() * 0.28);
    d +=
      ` C ${n(x0 + step * 0.25)} ${n(peak)},` +
      ` ${n(x0 + step * 0.75)} ${n(trough)},` +
      ` ${n(x0 + step)} ${n(mid)}`;
  }
  return d;
}

/** A shaft that leans into its own direction, with two strokes for the head. */
function arrowPaths(spec: ShapeSpec): string {
  const random = rng(spec.seed);
  const inset = spec.strokeWidth / 2;
  const x1 = inset;
  const y1 = Math.max(inset, spec.height - inset);
  const x2 = Math.max(inset, spec.width - inset);
  const y2 = inset;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const bow = 0.18 + random() * 0.1;

  const shaft =
    `M ${n(x1)} ${n(y1)} Q ${n(x1 + dx * 0.5 - dy * bow)} ${n(y1 + dy * 0.5 - dx * bow)},` +
    ` ${n(x2)} ${n(y2)}`;

  // The head, drawn as two plain strokes. Contracts 5.3: no <marker>, because
  // markers need ids and ids collide once a page holds a dozen of these.
  const length = Math.hypot(dx, dy) || 1;
  const head = Math.max(spec.strokeWidth * 3, Math.min(length * 0.26, 26));
  // Approach angle at the tip, which the bow has turned away from the chord.
  const angle = Math.atan2(y2 - (y1 + dy * 0.5 - dx * bow), x2 - (x1 + dx * 0.5 - dy * bow));
  const spread = 0.42;
  const barb = (sign: number) =>
    `M ${n(x2)} ${n(y2)} L ${n(x2 - head * Math.cos(angle + sign * spread))} ${n(y2 - head * Math.sin(angle + sign * spread))}`;

  const attrs = strokeAttrs(spec, false);
  return `<path d="${shaft}"${attrs} /><path d="${barb(1)}"${attrs} /><path d="${barb(-1)}"${attrs} />`;
}

/**
 * A stand-in for WS-6's generator, compliant with the frozen contract so the
 * renderer and its screenshots are honest before WS-6 lands. Pure and
 * deterministic: the same ShapeSpec always returns the same string.
 */
export const fallbackGenerateShape: ShapeGenerator = (spec) => {
  const inset = spec.strokeWidth / 2;
  let body: string;

  switch (spec.shape) {
    case 'rect': {
      const w = Math.max(0, spec.width - spec.strokeWidth);
      const h = Math.max(0, spec.height - spec.strokeWidth);
      const r = spec.radius === undefined ? 0 : Math.min(spec.radius, w / 2, h / 2);
      body =
        `<rect x="${n(inset)}" y="${n(inset)}" width="${n(w)}" height="${n(h)}"` +
        (r > 0 ? ` rx="${n(r)}" ry="${n(r)}"` : '') +
        `${strokeAttrs(spec, true)} />`;
      break;
    }

    case 'ellipse':
      body =
        `<ellipse cx="${n(spec.width / 2)}" cy="${n(spec.height / 2)}"` +
        ` rx="${n(Math.max(0, spec.width / 2 - inset))}" ry="${n(Math.max(0, spec.height / 2 - inset))}"` +
        `${strokeAttrs(spec, true)} />`;
      break;

    case 'squiggle':
      body = `<path d="${squigglePath(spec)}"${strokeAttrs(spec, false)} />`;
      break;

    case 'arrow':
      body = arrowPaths(spec);
      break;

    case 'line':
    default:
      body = `<path d="${linePath(spec)}"${strokeAttrs(spec, false)} />`;
      break;
  }

  return `${svgOpen(spec.width, spec.height)}${body}</svg>`;
};

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

let active: ShapeGenerator = fallbackGenerateShape;

/**
 * Point the renderer at WS-6's generator. One line, at start-up, before the
 * first renderDoc():
 *
 *   import { generateShape } from '../assets/shapes.ts';
 *   import { setShapeGenerator } from '../render/index.ts';
 *   setShapeGenerator(generateShape);
 *
 * Passing null goes back to the built-in fallback.
 */
export function setShapeGenerator(generator: ShapeGenerator | null): void {
  active = generator ?? fallbackGenerateShape;
}

/** Whichever generator is in force. */
export function getShapeGenerator(): ShapeGenerator {
  return active;
}

/** True once WS-6's generator has been installed. */
export function usingShapeAssets(): boolean {
  return active !== fallbackGenerateShape;
}

/**
 * Install WS-6's generator if it exists, and say whether it did. For a caller
 * that can await once at start-up (the site build, the preview route, a script)
 * this removes the one line above.
 *
 * The specifier is assembled at run time and marked `@vite-ignore` on purpose:
 * a static specifier for a file that is not written yet is a hard build error
 * in both Vite and tsc, and this module has to compile today.
 */
export async function ensureShapeAssets(): Promise<boolean> {
  if (usingShapeAssets()) return true;
  try {
    const specifier = `../assets/${'shapes'}.ts`;
    const module = (await import(/* @vite-ignore */ specifier)) as { generateShape?: unknown };
    if (typeof module.generateShape !== 'function') return false;
    setShapeGenerator(module.generateShape as ShapeGenerator);
    return true;
  } catch {
    // Not there yet. The fallback stays in force.
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Item -> svg                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The svg for one shape item, or '' when the item is not a shape or names a
 * shape kind this build does not know. Uses the schema's own
 * `shapeSpecFromItem`, so SHAPE_DEFAULTS are applied in exactly one place and
 * the editor and the page cannot disagree.
 */
export function renderShapeSvg(item: CanvasItem): string {
  const spec = shapeSpecFromItem(item);
  if (spec === null) return '';
  if (!(SHAPE_KINDS as readonly string[]).includes(spec.shape)) return '';
  return active(spec);
}
