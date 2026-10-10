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
