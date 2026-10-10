/**
 * src/cms/app/canvas/geometry.ts
 *
 * WS-4. Pure geometry for the canvas editor. No React, no DOM, no fetch.
 * Every function here is a plain maths function so the whole interaction model
 * can be driven and asserted from bare `node` (see ./verify-geometry.ts).
 *
 * Coordinate systems, because mixing them up is the one bug that matters:
 *
 *   REFERENCE px  the stored geometry. x/y/w/h on a CanvasItem, authored
 *                 against REFERENCE_WIDTH (1344). docs/cms-rebuild.md 3.3.
 *   SCREEN px     what the pointer reports. The stage is laid out at
 *                 REFERENCE_WIDTH and then visually scaled by `scale`, so
 *                 1 reference px is `scale` screen px.
 *
 * The rule: a pointer number crosses into reference space exactly once, through
 * `clientToRef` or `screenToRef`, and never by any other route. Everything
 * downstream of that is reference px.
 *
 * Rotation matches CSS `rotate(Ndeg)`: clockwise on screen, about the item's
 * centre (the browser default transform-origin), in a y-down coordinate space.
 */

import { REFERENCE_WIDTH } from '../../schema.ts';
import type { CanvasItem } from '../../schema.ts';

export { REFERENCE_WIDTH };

/** Smallest item the editor will produce, in reference px. */
export const MIN_ITEM_SIZE = 8;

/** Rotation snaps to this step while shift is held. docs/cms-rebuild.md 4, WS-4. */
export const ROTATE_SNAP_DEGREES = 15;

/* -------------------------------------------------------------------------- */
/* Small types                                                                 */
/* -------------------------------------------------------------------------- */

export type Point = { x: number; y: number };

/** Axis-aligned box in reference px. */
export type Rect = { x: number; y: number; w: number; h: number };

/** Geometry of one item, without the rest of the CanvasItem payload. */
export type Box = Rect & { rotate: number };

/** The four resize corners. `sx`/`sy` are -1 at the min edge, +1 at the max. */
export type CornerId = 'nw' | 'ne' | 'se' | 'sw';

export const CORNERS: readonly { id: CornerId; sx: -1 | 1; sy: -1 | 1 }[] = [
  { id: 'nw', sx: -1, sy: -1 },
  { id: 'ne', sx: 1, sy: -1 },
  { id: 'se', sx: 1, sy: 1 },
  { id: 'sw', sx: -1, sy: 1 },
];

const CORNER_SIGNS: Readonly<Record<CornerId, { sx: -1 | 1; sy: -1 | 1 }>> = {
  nw: { sx: -1, sy: -1 },
  ne: { sx: 1, sy: -1 },
  se: { sx: 1, sy: 1 },
  sw: { sx: -1, sy: 1 },
};

export function cornerSigns(corner: CornerId): { sx: -1 | 1; sy: -1 | 1 } {
  return CORNER_SIGNS[corner];
}

/** The subset of a DOMRect this module needs, so it can be faked in a test. */
export type StageRect = { left: number; top: number; width: number; height: number };

/* -------------------------------------------------------------------------- */
/* Scale: the one place pointer numbers become reference numbers               */
/* -------------------------------------------------------------------------- */

/**
 * Guard a scale prop. A zero, negative or non-finite scale would turn every
 * division below into Infinity or NaN and quietly destroy a document.
 */
export function safeScale(scale: number | undefined): number {
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return 1;
  return scale;
}

/**
 * A pointer's client position -> stage reference px.
 *
 * `rect` is the stage element's bounding rect, which the browser reports
 * ALREADY SCALED (its width is REFERENCE_WIDTH * scale). So the offset from
 * its top-left is in screen px and is divided by the scale exactly once. It is
 * never multiplied: that is the drift bug the brief warns about.
 */
export function clientToRef(
  clientX: number,
  clientY: number,
  rect: StageRect,
  scale: number,
): Point {
  const s = safeScale(scale);
  return { x: (clientX - rect.left) / s, y: (clientY - rect.top) / s };
}

/** A pointer delta in screen px -> a delta in reference px. */
export function screenToRef(dx: number, dy: number, scale: number): Point {
  const s = safeScale(scale);
  return { x: dx / s, y: dy / s };
}

/** A length in screen px -> reference px. Used for snap thresholds and handle sizes. */
export function screenLengthToRef(length: number, scale: number): number {
  return length / safeScale(scale);
}

/* -------------------------------------------------------------------------- */
/* Rotation                                                                    */
/* -------------------------------------------------------------------------- */

const DEG = Math.PI / 180;

/** Rotate a vector clockwise on screen by `degrees`, matching CSS rotate(). */
export function rotateVector(v: Point, degrees: number): Point {
  const r = degrees * DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Normalise to (-180, 180]. Keeps stored angles small and diff-friendly. */
export function normaliseAngle(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  let a = degrees % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  // -0 is a real number in JSON and reads badly in a diff.
  return a === 0 ? 0 : a;
}

/** Signed angle, in degrees, of `to` as seen from `from`. Clockwise positive. */
export function angleBetween(from: Point, to: Point): number {
  return Math.atan2(to.y - from.y, to.x - from.x) / DEG;
}

/* -------------------------------------------------------------------------- */
/* Boxes                                                                       */
/* -------------------------------------------------------------------------- */

export function boxOf(item: CanvasItem): Box {
  return { x: item.x, y: item.y, w: item.w, h: item.h, rotate: item.rotate ?? 0 };
}

export function centreOf(box: Rect): Point {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/** The four corners of a box in stage reference px, rotation applied. */
export function boxCorners(box: Box): Record<CornerId, Point> {
  const c = centreOf(box);
  const out = {} as Record<CornerId, Point>;
  for (const { id, sx, sy } of CORNERS) {
    const local = { x: (sx * box.w) / 2, y: (sy * box.h) / 2 };
    const world = rotateVector(local, box.rotate);
    out[id] = { x: c.x + world.x, y: c.y + world.y };
  }
  return out;
}

/** Midpoint of the box's top edge, rotation applied. Where the rotate handle hangs from. */
export function topEdgeMidpoint(box: Box): Point {
  const c = centreOf(box);
  const world = rotateVector({ x: 0, y: -box.h / 2 }, box.rotate);
  return { x: c.x + world.x, y: c.y + world.y };
}

/**
 * Axis-aligned bounding box of a possibly rotated box. For rotate === 0 this is
 * the box itself, so unrotated items snap to their own stored edges exactly.
 */
export function aabbOf(box: Box): Rect {
  if (normaliseAngle(box.rotate) === 0) return { x: box.x, y: box.y, w: box.w, h: box.h };
  const corners = boxCorners(box);
  const xs = CORNERS.map((c) => corners[c.id].x);
  const ys = CORNERS.map((c) => corners[c.id].y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

export function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Marquee selection test: overlap, not containment. Touching edges do not count. */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Normalise a drag-defined rectangle so w and h are non-negative. */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/* -------------------------------------------------------------------------- */
/* Move                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Where a box lands when moved by a reference-px delta. Rotation is irrelevant
 * to a translation, so this is deliberately trivial: x/y are the box's
 * unrotated top-left, exactly as stored.
 */
export function moveBox(start: Rect, delta: Point): Rect {
  return { x: start.x + delta.x, y: start.y + delta.y, w: start.w, h: start.h };
}

/** Collapse a delta onto its dominant axis. Shift while moving. */
export function lockAxis(delta: Point): Point {
  return Math.abs(delta.x) >= Math.abs(delta.y) ? { x: delta.x, y: 0 } : { x: 0, y: delta.y };
}

/* -------------------------------------------------------------------------- */
/* Resize                                                                      */
/* -------------------------------------------------------------------------- */

export type ResizeOptions = {
  /** Keep the start box's aspect ratio. Shift while resizing. */
  constrainRatio?: boolean;
  /** Minimum width and height in reference px. */
  minSize?: number;
};

/**
 * Resize by dragging one corner to `pointer`, in stage reference px.
 *
 * The opposite corner is pinned in stage space, which is the only behaviour
 * that does not feel broken on a rotated item. The maths:
 *
 *   anchor  A = the fixed corner, computed from the GESTURE-START box
 *   v       = R(-rotate) . (pointer - A)      the drag in the item's own frame
 *   w       = v.x / sx,  h = v.y / sy         signs cancel per corner
 *   centre  = A + R(rotate) . (sx*w/2, sy*h/2)
 *
 * Always computed from the start box plus the current pointer, never
 * incrementally from the previous frame, so a gesture cannot accumulate error.
 */
export function resizeBox(
  start: Box,
  corner: CornerId,
  pointer: Point,
  options: ResizeOptions = {},
): Box {
  const minSize = options.minSize ?? MIN_ITEM_SIZE;
  const { sx, sy } = cornerSigns(corner);

  const startCentre = centreOf(start);
  const anchorLocal = { x: (-sx * start.w) / 2, y: (-sy * start.h) / 2 };
  const anchorWorld = rotateVector(anchorLocal, start.rotate);
  const anchor = { x: startCentre.x + anchorWorld.x, y: startCentre.y + anchorWorld.y };

  const local = rotateVector({ x: pointer.x - anchor.x, y: pointer.y - anchor.y }, -start.rotate);

  let w = local.x / sx;
  let h = local.y / sy;

  if (options.constrainRatio === true) {
    // Least-squares projection of (w, h) onto the start box's diagonal. Smoother
    // than picking the dominant axis, and it never jumps between axes mid-drag.
    const denom = start.w * start.w + start.h * start.h;
    const factor = denom === 0 ? 1 : (w * start.w + h * start.h) / denom;
    const clamped = Math.max(factor, minSize / start.w, minSize / start.h);
    w = start.w * clamped;
    h = start.h * clamped;
  }

  w = Math.max(w, minSize);
  h = Math.max(h, minSize);

  const centreWorld = rotateVector({ x: (sx * w) / 2, y: (sy * h) / 2 }, start.rotate);
  const centre = { x: anchor.x + centreWorld.x, y: anchor.y + centreWorld.y };

  return { x: centre.x - w / 2, y: centre.y - h / 2, w, h, rotate: start.rotate };
}

/**
 * The stage position of the corner opposite `corner` on the start box. Exposed
 * so a caller (and a test) can assert that resizing really does pin it.
 */
export function anchorCorner(start: Box, corner: CornerId): Point {
  const { sx, sy } = cornerSigns(corner);
  const opposite = CORNERS.find((c) => c.sx === -sx && c.sy === -sy);
  /* c8 ignore next */
  if (opposite === undefined) throw new Error(`no corner opposite ${corner}`);
  return boxCorners(start)[opposite.id];
}

/**
 * Rounded geometry with the anchor corner preserved.
 *
 * Rounding w/h and x/y independently would let the pinned corner creep by up to
 * half a pixel per gesture. So: round the size first, then rebuild the position
 * from the start box's anchor corner using that rounded size, then round the
 * position. The emitted numbers are whole, per the brief.
 */
export function roundResizedBox(start: Box, corner: CornerId, resized: Box): Rect {
  const { sx, sy } = cornerSigns(corner);
  const w = Math.max(Math.round(resized.w), MIN_ITEM_SIZE);
  const h = Math.max(Math.round(resized.h), MIN_ITEM_SIZE);
  const anchor = anchorCorner(start, corner);
  const centreWorld = rotateVector({ x: (sx * w) / 2, y: (sy * h) / 2 }, start.rotate);
  const centre = { x: anchor.x + centreWorld.x, y: anchor.y + centreWorld.y };
  return { x: Math.round(centre.x - w / 2), y: Math.round(centre.y - h / 2), w, h };
}

/* -------------------------------------------------------------------------- */
/* Rotate                                                                      */
/* -------------------------------------------------------------------------- */

export type RotateOptions = {
  /** Snap to ROTATE_SNAP_DEGREES steps. Shift while rotating. */
  snapToSteps?: boolean;
  step?: number;
};

/**
 * New rotation for a box whose rotate handle has been dragged from
 * `pointerStart` to `pointer`, both in stage reference px. The box's centre is
 * the pivot, matching CSS's default transform-origin.
 */
export function rotateBoxTo(
  start: Box,
  pointerStart: Point,
  pointer: Point,
  options: RotateOptions = {},
): number {
  const pivot = centreOf(start);
  const delta = angleBetween(pivot, pointer) - angleBetween(pivot, pointerStart);
  let next = start.rotate + delta;
  if (options.snapToSteps === true) {
    const step = options.step ?? ROTATE_SNAP_DEGREES;
    next = Math.round(next / step) * step;
  }
  return normaliseAngle(Math.round(next));
}

/* -------------------------------------------------------------------------- */
/* Cursors                                                                     */
/* -------------------------------------------------------------------------- */

const RESIZE_CURSORS = [
  'nwse-resize',
  'ns-resize',
  'nesw-resize',
  'ew-resize',
  'nwse-resize',
  'ns-resize',
  'nesw-resize',
  'ew-resize',
] as const;

/**
 * A resize cursor that points the way the corner actually faces once the item
 * is rotated. Small thing; it is the difference between feeling solid and
 * feeling like a prototype.
 */
export function resizeCursor(corner: CornerId, rotate: number): string {
  const base: Record<CornerId, number> = { nw: 0, ne: 2, se: 4, sw: 6 };
  const turns = Math.round(normaliseAngle(rotate) / 45);
  const index = (((base[corner] + turns) % 8) + 8) % 8;
  return RESIZE_CURSORS[index];
}
