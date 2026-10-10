/**
 * src/cms/app/canvas/shape-fallback.ts
 *
 * WS-4. A STAND-IN for WS-6's shape generator, so the canvas editor and its
 * harness can be built and verified before `src/cms/assets/shapes.ts` exists.
 *
 * It is not the contract and it is not meant to ship. The real generator is
 * WS-6's `generateShape(spec)` (docs/cms-contracts.md section 5, frozen by
 * WS-0). `<CanvasEditor>` takes a `renderShape` prop for exactly this reason:
 *
 *   renderShape={(item) => {
 *     const spec = shapeSpecFromItem(item);        // WS-6
 *     return spec === null ? null : generateShape(spec);
 *   }}
 *
 * Pass that and nothing in this file runs. WS-4 deliberately does not import
 * WS-6's module itself, so that neither workstream can break the other's
 * standalone verification.
 *
 * The output here still obeys the frozen section 5.3 output rules (one root
 * <svg>, viewBox, 100% width and height, preserveAspectRatio="none",
 * aria-hidden, no ids, no <defs>, no <style>, round linecaps), so swapping in
 * the real generator cannot change how the editor embeds it.
 */

import { SHAPE_DEFAULTS, seedFromId } from '../../schema.ts';
import type { CanvasItem, ShapeSpec } from '../../schema.ts';

/**
 * CanvasItem -> ShapeSpec, filling in the two documented defaults. The real
 * mapping is WS-6's `shapeSpecFromItem`; this exists only to feed the stand-in
 * below and is exported so a reader can see it is the same mapping.
 */
export function shapeSpecFor(item: CanvasItem): ShapeSpec | null {
  if (item.kind !== 'shape' || item.shape === undefined) return null;
  const spec: ShapeSpec = {
    shape: item.shape,
    width: item.w,
    height: item.h,
    color: item.color ?? SHAPE_DEFAULTS.color,
    strokeWidth: item.strokeWidth ?? SHAPE_DEFAULTS.strokeWidth,
    seed: seedFromId(item.id),
  };
  if (item.fill !== undefined) spec.fill = item.fill;
  if (item.radius !== undefined) spec.radius = item.radius;
  return spec;
}

/** Trim float noise out of the emitted path data. */
function n(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

/** Deterministic 0..1 sequence from the spec's seed. Never Math.random(). */
function wobbler(seed: number): () => number {
  let state = (seed || 1) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function squigglePath(spec: ShapeSpec): string {
  const next = wobbler(spec.seed);
  const inset = spec.strokeWidth / 2;
  const midY = spec.height / 2;
  const amplitude = Math.max(0, spec.height / 2 - inset);
  const phase = next() * Math.PI * 2;
  const waves = 2 + Math.floor(next() * 2);
  const steps = 48;
  const points: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = inset + t * Math.max(0, spec.width - spec.strokeWidth);
    const y = midY + Math.sin(phase + t * waves * Math.PI * 2) * amplitude * 0.9;
    points.push(`${i === 0 ? 'M' : 'L'} ${n(x)} ${n(y)}`);
  }
  return points.join(' ');
}

function body(spec: ShapeSpec): string {
  const stroke = `stroke="${spec.color}" stroke-width="${n(spec.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"`;
  const fill = spec.fill === undefined ? 'fill="none"' : `fill="${spec.fill}"`;
  const inset = spec.strokeWidth / 2;
  const w = Math.max(spec.strokeWidth, spec.width);
  const h = Math.max(spec.strokeWidth, spec.height);

  switch (spec.shape) {
    case 'line':
      return `<path d="M ${n(inset)} ${n(h / 2)} L ${n(w - inset)} ${n(h / 2)}" fill="none" ${stroke}/>`;
    case 'rect': {
      const radius = spec.radius === undefined ? '' : ` rx="${n(spec.radius)}"`;
      return `<rect x="${n(inset)}" y="${n(inset)}" width="${n(w - spec.strokeWidth)}" height="${n(h - spec.strokeWidth)}"${radius} ${fill} ${stroke}/>`;
    }
    case 'ellipse':
      return `<ellipse cx="${n(w / 2)}" cy="${n(h / 2)}" rx="${n((w - spec.strokeWidth) / 2)}" ry="${n((h - spec.strokeWidth) / 2)}" ${fill} ${stroke}/>`;
    case 'squiggle':
      return `<path d="${squigglePath(spec)}" fill="none" ${stroke}/>`;
    default: {
      // Arrow: shaft from bottom-left to top-right, head drawn as two strokes
      // (section 5.3 forbids <marker> and <defs>).
      const x0 = inset;
      const y0 = h - inset;
      const x1 = w - inset;
      const y1 = inset;
      const angle = Math.atan2(y1 - y0, x1 - x0);
      const head = Math.max(spec.strokeWidth * 3, Math.min(w, h) * 0.28);
      const spread = 0.42;
      const hx1 = x1 - Math.cos(angle - spread) * head;
      const hy1 = y1 - Math.sin(angle - spread) * head;
      const hx2 = x1 - Math.cos(angle + spread) * head;
      const hy2 = y1 - Math.sin(angle + spread) * head;
      return (
        `<path d="M ${n(x0)} ${n(y0)} L ${n(x1)} ${n(y1)}" fill="none" ${stroke}/>` +
        `<path d="M ${n(hx1)} ${n(hy1)} L ${n(x1)} ${n(y1)} L ${n(hx2)} ${n(hy2)}" fill="none" ${stroke}/>`
      );
    }
  }
}

/** One self-contained <svg> string, same embedding contract as WS-6's. */
export function fallbackShapeSvg(item: CanvasItem): string | null {
  const spec = shapeSpecFor(item);
  if (spec === null) return null;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(spec.width)} ${n(spec.height)}"` +
    ` width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true" focusable="false">` +
    body(spec) +
    `</svg>`
  );
}
