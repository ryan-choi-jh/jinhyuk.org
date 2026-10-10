/**
 * src/cms/assets/draft.ts
 *
 * WS-6. The shape a picker hands back, and the two conversions around it.
 * Pure TypeScript: no React, so WS-8 can use these without mounting anything.
 *
 * Why a draft carries an `id`
 * ---------------------------
 * docs/cms-contracts.md section 5.2 is explicit that a shape's seed comes from
 * `seedFromId(item.id)` and from nowhere else. If the picker handed back only
 * a kind and a colour, the id would be minted at insert time and the drawing
 * the author just chose would be replaced by a different one the moment they
 * clicked Insert. So the picker mints the candidate id up front and "reshuffle"
 * mints a new one: what you previewed is what lands on the canvas.
 */

import { SHAPE_DEFAULTS, newId, seedFromId } from '../schema.ts';
import type { CanvasItem, ShapeKind, ShapeSpec } from '../schema.ts';

export type ShapeDraft = {
  /** The id the inserted item will carry. The wobble seed is derived from it. */
  id: string;
  shape: ShapeKind;
  /** Reference px, against REFERENCE_WIDTH. */
  w: number;
  h: number;
  color: string;
  strokeWidth: number;
  /** rect and ellipse only. */
  fill?: string;
  /** rect only. */
  radius?: number;
};

/** Where an inserted draft goes on the canvas. WS-4 and WS-8 decide this, not WS-6. */
export type Placement = { x: number; y: number; z?: number; rotate?: number };

/**
 * A sensible box per kind, in reference px. A line wants to be flat, a
 * squiggle wants to be wide, an ellipse wants to be roundish. Nobody should
 * have to type numbers to get something that looks right.
 */
export const DEFAULT_SIZE: Readonly<Record<ShapeKind, { w: number; h: number }>> = {
  line: { w: 320, h: 4 },
  rect: { w: 320, h: 200 },
  ellipse: { w: 280, h: 200 },
  squiggle: { w: 360, h: 150 },
  arrow: { w: 240, h: 110 },
};

/** `fill` is only legal on a rect or an ellipse, `radius` only on a rect (schema 3.3). */
export function fillAllowed(shape: ShapeKind): boolean {
  return shape === 'rect' || shape === 'ellipse';
}

export function radiusAllowed(shape: ShapeKind): boolean {
  return shape === 'rect';
}

/**
 * Drop whatever the current kind cannot carry. Switching from rect to line
 * with a fill still set would produce a CanvasItem the validator rejects, and
 * the editor would fail to save with a message about a key nobody typed.
 */
export function normaliseDraft(draft: ShapeDraft): ShapeDraft {
  const next: ShapeDraft = {
    id: draft.id,
    shape: draft.shape,
    w: Math.max(1, draft.w),
    h: Math.max(1, draft.h),
    color: draft.color,
    strokeWidth: Math.max(0.25, draft.strokeWidth),
  };
  if (draft.fill !== undefined && fillAllowed(draft.shape)) next.fill = draft.fill;
  if (draft.radius !== undefined && radiusAllowed(draft.shape)) {
    next.radius = Math.max(0, draft.radius);
  }
  return next;
}

export function newDraft(shape: ShapeKind = 'squiggle', overrides: Partial<ShapeDraft> = {}): ShapeDraft {
  return normaliseDraft({
    id: newId('i'),
    shape,
    w: DEFAULT_SIZE[shape].w,
    h: DEFAULT_SIZE[shape].h,
    color: SHAPE_DEFAULTS.color,
    strokeWidth: SHAPE_DEFAULTS.strokeWidth,
    ...overrides,
  });
}

/** A new candidate id, which is a new wobble: the picker's "draw me another one". */
export function reseed(draft: ShapeDraft): ShapeDraft {
  return { ...draft, id: newId('i') };
}

/** Keeps the box but swaps the kind, taking the new kind's default aspect if the box is untouched. */
export function withShape(draft: ShapeDraft, shape: ShapeKind, keepSize = true): ShapeDraft {
  const size = keepSize ? { w: draft.w, h: draft.h } : DEFAULT_SIZE[shape];
  return normaliseDraft({ ...draft, ...size, shape });
}

export function draftToSpec(draft: ShapeDraft): ShapeSpec {
  const clean = normaliseDraft(draft);
  const spec: ShapeSpec = {
    shape: clean.shape,
    width: clean.w,
    height: clean.h,
    color: clean.color,
    strokeWidth: clean.strokeWidth,
    seed: seedFromId(clean.id),
  };
  if (clean.fill !== undefined) spec.fill = clean.fill;
  if (clean.radius !== undefined) spec.radius = clean.radius;
  return spec;
}

/**
 * Draft plus a position becomes a CanvasItem that passes `validateDoc`. The
 * only thing the caller has to get right is that the id is still unique in the
 * document; `newId` makes that overwhelmingly likely, and the shell can check.
 */
export function draftToItem(draft: ShapeDraft, placement: Placement): CanvasItem {
  const clean = normaliseDraft(draft);
  const item: CanvasItem = {
    id: clean.id,
    kind: 'shape',
    x: placement.x,
    y: placement.y,
    w: clean.w,
    h: clean.h,
    shape: clean.shape,
    color: clean.color,
    strokeWidth: clean.strokeWidth,
  };
  if (placement.rotate !== undefined) item.rotate = placement.rotate;
  if (placement.z !== undefined) item.z = placement.z;
  if (clean.fill !== undefined) item.fill = clean.fill;
  if (clean.radius !== undefined) item.radius = clean.radius;
  return item;
}

/** The inverse, for opening the picker on an item that is already on a canvas. */
export function draftFromItem(item: CanvasItem): ShapeDraft | null {
  if (item.kind !== 'shape' || item.shape === undefined) return null;
  return normaliseDraft({
    id: item.id,
    shape: item.shape,
    w: item.w,
    h: item.h,
    color: item.color ?? SHAPE_DEFAULTS.color,
    strokeWidth: item.strokeWidth ?? SHAPE_DEFAULTS.strokeWidth,
    ...(item.fill !== undefined ? { fill: item.fill } : {}),
    ...(item.radius !== undefined ? { radius: item.radius } : {}),
  });
}
