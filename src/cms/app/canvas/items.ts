/**
 * src/cms/app/canvas/items.ts
 *
 * WS-4. Pure operations on a CanvasItem array. No React, no DOM.
 *
 * Three rules every function here keeps:
 *
 *  1. **Array order is never changed.** Document order is what the renderer
 *     stacks from below 900px (docs/cms-rebuild.md 3.4), so reordering the
 *     array would silently rewrite the mobile layout. Stacking is `z` only.
 *  2. **Whole numbers out.** x, y, w, h and rotate are emitted as integers.
 *  3. **Untouched items keep their identity.** The same object comes back, so
 *     React and the shell's dirty tracking both stay cheap. If nothing changed
 *     at all, the input array itself comes back.
 */

import { normaliseAngle } from './geometry.ts';
import type { Rect } from './geometry.ts';
import type { CanvasItem } from '../../schema.ts';

/**
 * Geometry, rounded to the whole numbers the document stores.
 *
 * This rounds; it does not impose the editor's minimum size. A move must never
 * resize anything, not even an item that was authored smaller than
 * MIN_ITEM_SIZE. The minimum belongs to the resize path, which clamps in
 * geometry.resizeBox and geometry.roundResizedBox. The only floor here is 1,
 * because the schema requires w and h to be greater than zero and a 0.4px item
 * would otherwise round to an unsaveable 0.
 */
export function roundRect(rect: Rect): Rect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.max(Math.round(rect.w), 1),
    h: Math.max(Math.round(rect.h), 1),
  };
}

/** Copy of `item` at `rect`. Returns the same object when nothing moved. */
export function withGeometry(item: CanvasItem, rect: Rect): CanvasItem {
  const next = roundRect(rect);
  if (item.x === next.x && item.y === next.y && item.w === next.w && item.h === next.h) return item;
  return { ...item, ...next };
}

/**
 * Copy of `item` rotated to `degrees`.
 *
 * `rotate` is optional in the schema. An item that never had the key does not
 * get a `"rotate": 0` added to it, and an item that did keeps it, so round
 * tripping a document through the editor does not churn the JSON.
 */
export function withRotation(item: CanvasItem, degrees: number): CanvasItem {
  const next = normaliseAngle(Math.round(degrees));
  const current = item.rotate;
  if (current === next) return item;
  if (next === 0 && current === undefined) return item;
  if (next === 0 && current !== undefined) return { ...item, rotate: 0 };
  return { ...item, rotate: next };
}

/**
 * Apply a map of replacements by id. Order preserved, identity preserved for
 * everything not in the map, and the input array returned when it is a no-op.
 */
export function patchItems(
  items: readonly CanvasItem[],
  patches: ReadonlyMap<string, CanvasItem>,
): CanvasItem[] {
  if (patches.size === 0) return items as CanvasItem[];
  let changed = false;
  const next = items.map((item) => {
    const patch = patches.get(item.id);
    if (patch === undefined || patch === item) return item;
    changed = true;
    return patch;
  });
  return changed ? next : (items as CanvasItem[]);
}

/** Arrow-key nudge. 1px, or 10px with shift; the caller decides which. */
export function nudgeItems(
  items: readonly CanvasItem[],
  ids: readonly string[],
  dx: number,
  dy: number,
): CanvasItem[] {
  if (ids.length === 0 || (dx === 0 && dy === 0)) return items as CanvasItem[];
  const selected = new Set(ids);
  const patches = new Map<string, CanvasItem>();
  for (const item of items) {
    if (!selected.has(item.id)) continue;
    // Position only. A nudge touches neither size nor rotation.
    const x = Math.round(item.x + dx);
    const y = Math.round(item.y + dy);
    if (x === item.x && y === item.y) continue;
    patches.set(item.id, { ...item, x, y });
  }
  return patchItems(items, patches);
}

export function deleteItems(items: readonly CanvasItem[], ids: readonly string[]): CanvasItem[] {
  if (ids.length === 0) return items as CanvasItem[];
  const doomed = new Set(ids);
  const next = items.filter((item) => !doomed.has(item.id));
  return next.length === items.length ? (items as CanvasItem[]) : next;
}

/* -------------------------------------------------------------------------- */
/* z-order                                                                     */
/* -------------------------------------------------------------------------- */

export type ZOrderOp = 'front' | 'back' | 'forward' | 'backward';

/**
 * Ids from bottom of the stack to top. `z` wins; items that share a `z` (or
 * have none) keep document order, which is what the renderer's painting order
 * does too.
 */
export function stackingOrder(items: readonly CanvasItem[]): string[] {
  return items
    .map((item, index) => ({ id: item.id, z: item.z ?? 0, index }))
    .sort((a, b) => (a.z === b.z ? a.index - b.index : a.z - b.z))
    .map((entry) => entry.id);
}

/**
 * Re-stack. The order is rewritten to contiguous integers 0..n-1, which keeps
 * `z` bounded however many times someone presses "bring to front" and makes
 * the resulting JSON diff readable. The array itself is not reordered.
 */
export function reorderZ(
  items: readonly CanvasItem[],
  ids: readonly string[],
  op: ZOrderOp,
): CanvasItem[] {
  // Nothing selected means nothing to restack. Normalising `z` anyway would
  // emit a change nobody asked for.
  if (items.length === 0 || ids.length === 0) return items as CanvasItem[];
  const selected = new Set(ids);
  let order = stackingOrder(items);

  if (op === 'front') {
    order = [...order.filter((id) => !selected.has(id)), ...order.filter((id) => selected.has(id))];
  } else if (op === 'back') {
    order = [...order.filter((id) => selected.has(id)), ...order.filter((id) => !selected.has(id))];
  } else if (op === 'forward') {
    for (let i = order.length - 2; i >= 0; i -= 1) {
      if (selected.has(order[i]) && !selected.has(order[i + 1])) {
        [order[i], order[i + 1]] = [order[i + 1], order[i]];
      }
    }
  } else {
    for (let i = 1; i < order.length; i += 1) {
      if (selected.has(order[i]) && !selected.has(order[i - 1])) {
        [order[i], order[i - 1]] = [order[i - 1], order[i]];
      }
    }
  }

  const zById = new Map(order.map((id, index) => [id, index]));
  const patches = new Map<string, CanvasItem>();
  for (const item of items) {
    const z = zById.get(item.id);
    if (z === undefined || item.z === z) continue;
    patches.set(item.id, { ...item, z });
  }
  return patchItems(items, patches);
}

/** Highest-to-lowest, for "which item is on top at this point". */
export function topMostFirst(items: readonly CanvasItem[]): CanvasItem[] {
  const order = stackingOrder(items);
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...items].sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0));
}
