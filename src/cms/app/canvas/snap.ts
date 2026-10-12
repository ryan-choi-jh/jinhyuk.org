/**
 * src/cms/app/canvas/snap.ts
 *
 * WS-4. Snapping, pure. Everything in reference px.
 *
 * What an item can snap to:
 *   - every other item's left / horizontal centre / right
 *   - every other item's top / vertical centre / bottom
 *   - the canvas's left / centre / right and top / centre / bottom
 *
 * "Every other item" means its axis-aligned bounding box, so a rotated item
 * offers the edges the eye actually sees rather than its unrotated stored box.
 *
 * A snap returns both the correction to apply and the guide lines that became
 * true, so the editor can draw exactly the alignments it just honoured, and
 * nothing it did not.
 */

import { aabbOf, boxOf } from './geometry.ts';
import type { Point, Rect } from './geometry.ts';
import type { CanvasItem } from '../../schema.ts';

export type SnapAxis = 'x' | 'y';

export type SnapKind = 'item-edge' | 'item-centre' | 'canvas-edge' | 'canvas-centre';

/** A line something can snap to. `min`/`max` are its extent on the other axis. */
export type SnapTarget = {
  axis: SnapAxis;
  value: number;
  kind: SnapKind;
  min: number;
  max: number;
  itemId?: string;
};

/** A line the editor should draw, because the snap made it true. */
export type SnapGuide = {
  axis: SnapAxis;
  value: number;
  kind: SnapKind;
  /** Extent along the other axis, already widened to cover the moving box. */
  min: number;
  max: number;
};

export type SnapResult = {
  /** Correction to add to the thing being snapped, in reference px. */
  delta: Point;
  guides: SnapGuide[];
};

export const NO_SNAP: SnapResult = { delta: { x: 0, y: 0 }, guides: [] };

/** Default snap radius in SCREEN px. Divided by the stage scale before use. */
export const DEFAULT_SNAP_THRESHOLD = 6;

/** Float slop when deciding whether a line coincides with a snapped edge. */
const EPSILON = 0.01;

export type StageSize = { width: number; height: number };

/**
 * Build the snap target list once per gesture.
 *
 * `excludeIds` is the moving selection: an item must not snap to itself, and in
 * a multi-select drag it must not snap to anything it is dragging along with.
 */
export function collectSnapTargets(
  items: readonly CanvasItem[],
  excludeIds: readonly string[],
  stage: StageSize,
): SnapTarget[] {
  const excluded = new Set(excludeIds);
  const targets: SnapTarget[] = [];

  for (const item of items) {
    if (excluded.has(item.id)) continue;
    const box = aabbOf(boxOf(item));
    const vMin = box.y;
    const vMax = box.y + box.h;
    const hMin = box.x;
    const hMax = box.x + box.w;
    targets.push(
      { axis: 'x', value: box.x, kind: 'item-edge', min: vMin, max: vMax, itemId: item.id },
      { axis: 'x', value: box.x + box.w / 2, kind: 'item-centre', min: vMin, max: vMax, itemId: item.id },
      { axis: 'x', value: box.x + box.w, kind: 'item-edge', min: vMin, max: vMax, itemId: item.id },
      { axis: 'y', value: box.y, kind: 'item-edge', min: hMin, max: hMax, itemId: item.id },
      { axis: 'y', value: box.y + box.h / 2, kind: 'item-centre', min: hMin, max: hMax, itemId: item.id },
      { axis: 'y', value: box.y + box.h, kind: 'item-edge', min: hMin, max: hMax, itemId: item.id },
    );
  }

  targets.push(
    { axis: 'x', value: 0, kind: 'canvas-edge', min: 0, max: stage.height },
    { axis: 'x', value: stage.width / 2, kind: 'canvas-centre', min: 0, max: stage.height },
    { axis: 'x', value: stage.width, kind: 'canvas-edge', min: 0, max: stage.height },
    { axis: 'y', value: 0, kind: 'canvas-edge', min: 0, max: stage.width },
    { axis: 'y', value: stage.height / 2, kind: 'canvas-centre', min: 0, max: stage.width },
    { axis: 'y', value: stage.height, kind: 'canvas-edge', min: 0, max: stage.width },
  );

  return targets;
}

/** Rank for tie-breaking: a centre alignment is more interesting than an edge. */
function kindRank(kind: SnapKind): number {
  switch (kind) {
    case 'canvas-centre':
      return 0;
    case 'item-centre':
      return 1;
    case 'canvas-edge':
      return 2;
    default:
      return 3;
  }
}

function bestOffset(
  candidates: readonly number[],
  targets: readonly SnapTarget[],
  axis: SnapAxis,
  threshold: number,
): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  let bestRank = Infinity;

  for (const target of targets) {
    if (target.axis !== axis) continue;
    for (const candidate of candidates) {
      const offset = target.value - candidate;
      const distance = Math.abs(offset);
      if (distance > threshold) continue;
      const rank = kindRank(target.kind);
      if (distance < bestDistance - EPSILON || (distance < bestDistance + EPSILON && rank < bestRank)) {
        best = offset;
        bestDistance = distance;
        bestRank = rank;
      }
    }
  }

  return best;
}

/**
 * Every target line that is exactly true once `offset` is applied, so the
 * editor can draw two guides when an edge and a centre happen to coincide.
 */
function guidesFor(
  candidates: readonly number[],
  targets: readonly SnapTarget[],
  axis: SnapAxis,
  offset: number,
  movingMin: number,
  movingMax: number,
): SnapGuide[] {
  const guides: SnapGuide[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    if (target.axis !== axis) continue;
    const hit = candidates.some((candidate) => Math.abs(candidate + offset - target.value) < EPSILON);
    if (!hit) continue;
    const key = `${axis}:${target.value.toFixed(2)}:${target.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    guides.push({
      axis,
      value: target.value,
      kind: target.kind,
      min: Math.min(target.min, movingMin),
      max: Math.max(target.max, movingMax),
    });
  }

  return guides;
}

/**
 * Snap a moving box. Candidates are its left/centre/right and top/centre/bottom.
 * `threshold` is in reference px, so the caller divides the screen-px radius by
 * the stage scale first and snapping stays a constant distance on screen.
 */
export function snapRect(rect: Rect, targets: readonly SnapTarget[], threshold: number): SnapResult {
  if (threshold <= 0 || targets.length === 0) return NO_SNAP;

  const xCandidates = [rect.x, rect.x + rect.w / 2, rect.x + rect.w];
  const yCandidates = [rect.y, rect.y + rect.h / 2, rect.y + rect.h];

  const dx = bestOffset(xCandidates, targets, 'x', threshold);
  const dy = bestOffset(yCandidates, targets, 'y', threshold);

  const guides: SnapGuide[] = [];
  if (dx !== null) {
    guides.push(...guidesFor(xCandidates, targets, 'x', dx, rect.y + (dy ?? 0), rect.y + rect.h + (dy ?? 0)));
  }
  if (dy !== null) {
    guides.push(...guidesFor(yCandidates, targets, 'y', dy, rect.x + (dx ?? 0), rect.x + rect.w + (dx ?? 0)));
  }

  return { delta: { x: dx ?? 0, y: dy ?? 0 }, guides };
}

/** Snap a single point. Used for the corner being dragged during a resize. */
export function snapPoint(point: Point, targets: readonly SnapTarget[], threshold: number): SnapResult {
  if (threshold <= 0 || targets.length === 0) return NO_SNAP;

  const dx = bestOffset([point.x], targets, 'x', threshold);
  const dy = bestOffset([point.y], targets, 'y', threshold);

  const guides: SnapGuide[] = [];
  if (dx !== null) guides.push(...guidesFor([point.x], targets, 'x', dx, point.y, point.y));
  if (dy !== null) guides.push(...guidesFor([point.y], targets, 'y', dy, point.x, point.x));

  return { delta: { x: dx ?? 0, y: dy ?? 0 }, guides };
}

/* -------------------------------------------------------------------------- */
/* Matching SIZE, not position                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Everything above aligns POSITIONS: edges and centres. Two pictures can sit
 * on a perfect shared baseline and still be four pixels different in width,
 * and nothing here would have said so — which is the one thing you cannot see
 * by eye and the thing that makes a row of screenshots look wrong without
 * showing you why.
 *
 * So, separately: while an item is being resized, its width and height snap
 * to the width and height of the others, and the editor marks which ones it
 * now matches. Independently, because matching a neighbour's width while
 * keeping your own height is a perfectly ordinary thing to want.
 */

/** Another item's measurements, and the box to mark if one is matched. */
export type SizeTarget = { w: number; h: number; rect: Rect };

/**
 * A measurement the resized item now shares with others. `boxes` holds every
 * box that has it, the resized one first, so the editor can mark them all.
 */
export type SizeGuide = {
  kind: 'width' | 'height';
  value: number;
  boxes: Rect[];
};

export type SizeSnapResult = {
  /** The corrected size, in reference px. */
  w: number;
  h: number;
  guides: SizeGuide[];
};

export function collectSizeTargets(
  items: readonly CanvasItem[],
  excludeIds: ReadonlySet<string>,
): SizeTarget[] {
  const out: SizeTarget[] = [];
  for (const item of items) {
    if (excludeIds.has(item.id)) continue;
    const rect = aabbOf(boxOf(item));
    if (rect.w <= 0 || rect.h <= 0) continue;
    out.push({ w: rect.w, h: rect.h, rect });
  }
  return out;
}

/** The nearest target measurement within `threshold`, or null. */
function nearestMeasure(
  value: number,
  targets: readonly SizeTarget[],
  pick: (target: SizeTarget) => number,
  threshold: number,
): number | null {
  let best: number | null = null;
  let bestGap = threshold;
  for (const target of targets) {
    const measure = pick(target);
    const gap = Math.abs(measure - value);
    // `<=` so an exact match still registers when the threshold is 0.
    if (gap <= bestGap) {
      // Already the same size: nothing to correct, but it IS a match, so
      // return it anyway and let the caller mark it.
      bestGap = gap;
      best = measure;
    }
  }
  return best;
}

export function snapSize(
  rect: Rect,
  targets: readonly SizeTarget[],
  threshold: number,
): SizeSnapResult {
  if (targets.length === 0) return { w: rect.w, h: rect.h, guides: [] };

  const w = nearestMeasure(rect.w, targets, (t) => t.w, Math.max(0, threshold)) ?? rect.w;
  const h = nearestMeasure(rect.h, targets, (t) => t.h, Math.max(0, threshold)) ?? rect.h;

  const guides: SizeGuide[] = [];
  const snapped: Rect = { ...rect, w, h };

  const sharing = (pick: (target: SizeTarget) => number, value: number): Rect[] =>
    targets.filter((target) => Math.abs(pick(target) - value) < EPSILON).map((target) => target.rect);

  const sameW = sharing((t) => t.w, w);
  if (sameW.length > 0) guides.push({ kind: 'width', value: w, boxes: [snapped, ...sameW] });

  const sameH = sharing((t) => t.h, h);
  if (sameH.length > 0) guides.push({ kind: 'height', value: h, boxes: [snapped, ...sameH] });

  return { w, h, guides };
}
