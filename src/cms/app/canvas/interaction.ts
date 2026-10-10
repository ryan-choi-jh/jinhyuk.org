/**
 * src/cms/app/canvas/interaction.ts
 *
 * WS-4. The gesture state machine, pure. No React, no DOM, no fetch.
 *
 * A gesture is begun from a snapshot of the items and then updated with a
 * pointer position. Two properties follow from that and both matter:
 *
 *  - **Every frame is computed from the gesture's start state plus the current
 *    pointer**, never from the previous frame. A long drag cannot accumulate
 *    rounding error, and releasing shift halfway through undoes the constraint
 *    instead of baking it in.
 *  - **Everything here is in reference px.** The caller converts the pointer
 *    once, with geometry.clientToRef, using the live scale. So a window resize
 *    mid-drag cannot desynchronise a gesture, and these functions never need to
 *    know the scale at all. The one exception is the snap radius, which is a
 *    screen-px distance and so arrives per update as `refThreshold`.
 *
 * Because of that, ./verify-geometry.ts can drive a whole drag, resize and
 * rotate under bare `node` and assert the exact numbers that come out.
 */

import {
  aabbOf,
  boxCorners,
  boxOf,
  lockAxis,
  moveBox,
  normaliseAngle,
  rectFromPoints,
  rectsIntersect,
  resizeBox,
  rotateBoxTo,
  roundResizedBox,
  unionRect,
} from './geometry.ts';
import type { Box, CornerId, Point, Rect } from './geometry.ts';
import { collectSnapTargets, snapPoint, snapRect } from './snap.ts';
import type { SnapGuide, SnapTarget, StageSize } from './snap.ts';
import { patchItems, withGeometry, withRotation } from './items.ts';
import type { CanvasItem } from '../../schema.ts';

export type { StageSize };

/** Keys read live off the pointer event, so they can change mid-gesture. */
export type Modifiers = {
  /** Constrain: axis-lock a move, keep the ratio on a resize, 15 degree steps on a rotate. */
  shift: boolean;
  /** Suspend snapping for this frame. */
  alt: boolean;
};

export const NO_MODIFIERS: Modifiers = { shift: false, alt: false };

/** Per-update inputs that are not the pointer position. */
export type UpdateOptions = Modifiers & {
  /** Snap radius in REFERENCE px: the screen-px radius divided by the scale. 0 disables. */
  refThreshold: number;
};

export type GestureUpdate = {
  items: CanvasItem[];
  guides: SnapGuide[];
  /** False when the gesture has not yet produced a different document. */
  changed: boolean;
};

/**
 * Slop for deciding which guides to draw. Guides are recomputed from the final
 * rounded geometry rather than from the pre-rounding snap, so a drawn guide is
 * always one that is actually true to within half a stored pixel.
 */
const GUIDE_SLOP = 0.51;

/* -------------------------------------------------------------------------- */
/* Move                                                                        */
/* -------------------------------------------------------------------------- */

export type MoveGesture = {
  kind: 'move';
  ids: string[];
  pointerStart: Point;
  startItems: readonly CanvasItem[];
  startRects: ReadonlyMap<string, Rect>;
  unionStart: Rect;
  targets: readonly SnapTarget[];
};

export function beginMove(
  items: readonly CanvasItem[],
  ids: readonly string[],
  pointer: Point,
  stage: StageSize,
): MoveGesture {
  const selected = new Set(ids);
  const startRects = new Map<string, Rect>();
  const aabbs: Rect[] = [];
  for (const item of items) {
    if (!selected.has(item.id)) continue;
    startRects.set(item.id, { x: item.x, y: item.y, w: item.w, h: item.h });
    aabbs.push(aabbOf(boxOf(item)));
  }
  return {
    kind: 'move',
    ids: [...startRects.keys()],
    pointerStart: pointer,
    startItems: items,
    startRects,
    unionStart: unionRect(aabbs) ?? { x: 0, y: 0, w: 0, h: 0 },
    targets: collectSnapTargets(items, [...startRects.keys()], stage),
  };
}

export function updateMove(
  gesture: MoveGesture,
  pointer: Point,
  options: UpdateOptions,
): GestureUpdate {
  const raw = { x: pointer.x - gesture.pointerStart.x, y: pointer.y - gesture.pointerStart.y };
  const constrained = options.shift ? lockAxis(raw) : raw;

  let delta = constrained;
  if (!options.alt && options.refThreshold > 0 && gesture.ids.length > 0) {
    const snap = snapRect(moveBox(gesture.unionStart, constrained), gesture.targets, options.refThreshold);
    delta = { x: constrained.x + snap.delta.x, y: constrained.y + snap.delta.y };
  }

  // Round the DELTA, not each item. A multi-selection then moves as one rigid
  // body: relative offsets inside it survive the gesture exactly.
  delta = { x: Math.round(delta.x), y: Math.round(delta.y) };

  const patches = new Map<string, CanvasItem>();
  for (const item of gesture.startItems) {
    const start = gesture.startRects.get(item.id);
    if (start === undefined) continue;
    patches.set(item.id, withGeometry(item, moveBox(start, delta)));
  }
  const items = patchItems(gesture.startItems, patches);

  const guides =
    options.alt || options.refThreshold <= 0
      ? []
      : snapRect(moveBox(gesture.unionStart, delta), gesture.targets, GUIDE_SLOP).guides;

  return { items, guides, changed: items !== gesture.startItems };
}

/* -------------------------------------------------------------------------- */
/* Resize                                                                      */
/* -------------------------------------------------------------------------- */

export type ResizeGesture = {
  kind: 'resize';
  id: string;
  corner: CornerId;
  startItems: readonly CanvasItem[];
  startBox: Box;
  targets: readonly SnapTarget[];
};

export function beginResize(
  items: readonly CanvasItem[],
  id: string,
  corner: CornerId,
  stage: StageSize,
): ResizeGesture | null {
  const item = items.find((candidate) => candidate.id === id);
  if (item === undefined) return null;
  return {
    kind: 'resize',
    id,
    corner,
    startItems: items,
    startBox: boxOf(item),
    targets: collectSnapTargets(items, [id], stage),
  };
}

export function updateResize(
  gesture: ResizeGesture,
  pointer: Point,
  options: UpdateOptions,
): GestureUpdate {
  // Snapping a corner only means anything while the item is square to the page.
  // On a rotated item the dragged corner does not travel along either axis, so
  // an edge snap would fight the pointer; and with shift held the ratio is the
  // constraint, so a corner snap would break it.
  const canSnap =
    !options.alt &&
    !options.shift &&
    options.refThreshold > 0 &&
    normaliseAngle(gesture.startBox.rotate) === 0;

  const snapped = canSnap
    ? snapPoint(pointer, gesture.targets, options.refThreshold)
    : { delta: { x: 0, y: 0 }, guides: [] };

  const target = { x: pointer.x + snapped.delta.x, y: pointer.y + snapped.delta.y };
  const resized = resizeBox(gesture.startBox, gesture.corner, target, {
    constrainRatio: options.shift,
  });
  const rect = roundResizedBox(gesture.startBox, gesture.corner, resized);

  const patches = new Map<string, CanvasItem>();
  for (const item of gesture.startItems) {
    if (item.id !== gesture.id) continue;
    patches.set(item.id, withGeometry(item, rect));
  }
  const items = patchItems(gesture.startItems, patches);

  let guides: SnapGuide[] = [];
  if (canSnap) {
    const movedCorner = boxCorners({ ...rect, rotate: gesture.startBox.rotate })[gesture.corner];
    guides = snapPoint(movedCorner, gesture.targets, GUIDE_SLOP).guides;
  }

  return { items, guides, changed: items !== gesture.startItems };
}

/* -------------------------------------------------------------------------- */
/* Rotate                                                                      */
/* -------------------------------------------------------------------------- */

export type RotateGesture = {
  kind: 'rotate';
  id: string;
  pointerStart: Point;
  startItems: readonly CanvasItem[];
  startBox: Box;
};

export function beginRotate(
  items: readonly CanvasItem[],
  id: string,
  pointer: Point,
): RotateGesture | null {
  const item = items.find((candidate) => candidate.id === id);
  if (item === undefined) return null;
  return { kind: 'rotate', id, pointerStart: pointer, startItems: items, startBox: boxOf(item) };
}

export function updateRotate(
  gesture: RotateGesture,
  pointer: Point,
  options: Modifiers,
): GestureUpdate {
  const degrees = rotateBoxTo(gesture.startBox, gesture.pointerStart, pointer, {
    snapToSteps: options.shift,
  });

  const patches = new Map<string, CanvasItem>();
  for (const item of gesture.startItems) {
    if (item.id !== gesture.id) continue;
    patches.set(item.id, withRotation(item, degrees));
  }
  const items = patchItems(gesture.startItems, patches);

  return { items, guides: [], changed: items !== gesture.startItems };
}

/* -------------------------------------------------------------------------- */
/* Marquee                                                                     */
/* -------------------------------------------------------------------------- */

export type MarqueeGesture = {
  kind: 'marquee';
  anchor: Point;
  /** Selection to add to, for a shift-marquee. */
  baseIds: readonly string[];
  items: readonly CanvasItem[];
};

export type MarqueeUpdate = {
  rect: Rect;
  ids: string[];
};

export function beginMarquee(
  items: readonly CanvasItem[],
  anchor: Point,
  baseIds: readonly string[],
): MarqueeGesture {
  return { kind: 'marquee', anchor, baseIds, items };
}

/**
 * Items the marquee has caught. Overlap, not containment: a brush across a
 * corner picks the item up, which is how every other canvas tool behaves.
 * Order follows document order so the resulting selection is stable.
 */
export function updateMarquee(gesture: MarqueeGesture, pointer: Point): MarqueeUpdate {
  const rect = rectFromPoints(gesture.anchor, pointer);
  const base = new Set(gesture.baseIds);
  const ids: string[] = [];
  for (const item of gesture.items) {
    if (base.has(item.id) || rectsIntersect(rect, aabbOf(boxOf(item)))) ids.push(item.id);
  }
  return { rect, ids };
}

export type Gesture = MoveGesture | ResizeGesture | RotateGesture | MarqueeGesture;
