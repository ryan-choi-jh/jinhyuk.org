/**
 * src/cms/app/canvas/verify-geometry.ts
 *
 * WS-4's headless proof. Runs under bare `node` with no browser, no React and
 * no network:
 *
 *   node src/cms/app/canvas/verify-geometry.ts
 *
 * It drives the real gesture functions the component uses, from real pointer
 * client coordinates through a faked stage rect, at several scales, and asserts
 * the exact numbers that come out. The scale cases are the point: a pointer
 * delta has to be divided by the stage scale exactly once, so the SAME physical
 * drag in reference px must produce the SAME geometry at scale 1.0 and at 0.7.
 *
 * The browser half of the verification is ./harness (see harness/README.md),
 * which drives the component itself in Chromium.
 */

import { readFileSync } from 'node:fs';

import { REFERENCE_WIDTH, formatIssues, validateDocJson } from '../../schema.ts';
import type { CanvasBand, CanvasItem, Doc } from '../../schema.ts';
import {
  aabbOf,
  boxCorners,
  boxOf,
  clientToRef,
  resizeCursor,
  rotateBoxTo,
  safeScale,
  screenLengthToRef,
  screenToRef,
  normaliseAngle,
} from './geometry.ts';
import type { CornerId, Point } from './geometry.ts';
import { DEFAULT_SNAP_THRESHOLD, collectSnapTargets, snapRect } from './snap.ts';
import {
  beginMarquee,
  beginMove,
  beginResize,
  beginRotate,
  updateMarquee,
  updateMove,
  updateResize,
  updateRotate,
} from './interaction.ts';
import { deleteItems, nudgeItems, reorderZ, stackingOrder } from './items.ts';

/* -------------------------------------------------------------------------- */
/* Tiny test harness                                                           */
/* -------------------------------------------------------------------------- */

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(detail === undefined ? label : `${label}\n      ${detail}`);
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, `expected ${b}\n      actual   ${a}`);
}

function near(label: string, actual: number, expected: number, tolerance = 1e-9): void {
  check(
    label,
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected} +/- ${tolerance}\n      actual   ${actual}`,
  );
}

function section(name: string): void {
  process.stdout.write(`\n  ${name}\n`);
}

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

const densePath = new URL('../../fixtures/dense.json', import.meta.url);
const result = validateDocJson(readFileSync(densePath, 'utf8'));
if (!result.ok) {
  process.stderr.write(`dense.json did not validate:\n${formatIssues(result.issues)}\n`);
  process.exit(1);
}
const dense: Doc = result.doc;

function band(id: string): CanvasBand {
  const found = dense.bands.find((candidate) => candidate.id === id);
  if (found === undefined || found.type !== 'canvas') throw new Error(`no canvas band ${id}`);
  return found;
}

const shapesBand = band('b_dense_shapes');
const stackBand = band('b_dense_stack');
const overlayBand = band('b_dense_overlay');

function item(items: readonly CanvasItem[], id: string): CanvasItem {
  const found = items.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no item ${id}`);
  return found;
}

const geometryOf = (items: readonly CanvasItem[], id: string) => {
  const it = item(items, id);
  return { x: it.x, y: it.y, w: it.w, h: it.h, rotate: it.rotate ?? 0 };
};

/* -------------------------------------------------------------------------- */
/* A faked stage at a given scale                                              */
/* -------------------------------------------------------------------------- */

/**
 * The stage element is laid out at REFERENCE_WIDTH and then CSS-scaled, so the
 * rect the browser reports is already multiplied by the scale. These fixtures
 * reproduce that exactly, including a non-zero page offset, because a bug that
 * forgets rect.left looks identical to a bug that forgets the scale until the
 * page is scrolled.
 */
function stageAt(scale: number, height: number, offset = { left: 137, top: 61 }) {
  const rect = {
    left: offset.left,
    top: offset.top,
    width: REFERENCE_WIDTH * scale,
    height: height * scale,
  };
  return {
    scale,
    rect,
    stage: { width: REFERENCE_WIDTH, height },
    /** A reference-px point as the browser would report the pointer there. */
    client(point: Point) {
      return { clientX: rect.left + point.x * scale, clientY: rect.top + point.y * scale };
    },
    /** What the component does with a pointer event. */
    pointer(point: Point): Point {
      const c = this.client(point);
      return clientToRef(c.clientX, c.clientY, rect, scale);
    },
    refThreshold(screenPx = DEFAULT_SNAP_THRESHOLD) {
      return screenLengthToRef(screenPx, scale);
    },
  };
}

const SCALES = [1, 0.7];

/* -------------------------------------------------------------------------- */

section('scale conversion');

for (const scale of [1, 0.7, 0.5, 0.3333, 1.5]) {
  const s = stageAt(scale, 360);
  const probes: Point[] = [
    { x: 0, y: 0 },
    { x: 672, y: 180 },
    { x: 1344, y: 360 },
    { x: -40, y: 12.5 },
  ];
  for (const probe of probes) {
    const back = s.pointer(probe);
    near(`clientToRef round trip at scale ${scale} for (${probe.x},${probe.y}) x`, back.x, probe.x, 1e-9);
    near(`clientToRef round trip at scale ${scale} for (${probe.x},${probe.y}) y`, back.y, probe.y, 1e-9);
  }
  // A screen delta becomes a reference delta by dividing, never multiplying.
  const delta = screenToRef(100 * scale, 40 * scale, scale);
  near(`screenToRef at scale ${scale} x`, delta.x, 100, 1e-9);
  near(`screenToRef at scale ${scale} y`, delta.y, 40, 1e-9);
}

eq('safeScale rejects 0', safeScale(0), 1);
eq('safeScale rejects NaN', safeScale(Number.NaN), 1);
eq('safeScale rejects negative', safeScale(-2), 1);
eq('safeScale passes 0.7 through', safeScale(0.7), 0.7);

/* -------------------------------------------------------------------------- */

section('move: the same drag at scale 1.0 and 0.7');

{
  // The squiggle starts at x 60, y 40. Drag it 220 reference px right and 35
  // down, expressed as a physical screen drag at each scale.
  const results: Record<number, unknown> = {};
  for (const scale of SCALES) {
    const s = stageAt(scale, shapesBand.height);
    const from: Point = { x: 100, y: 80 };
    const to: Point = { x: from.x + 220, y: from.y + 35 };

    const gesture = beginMove(shapesBand.items, ['i_dense_squiggle'], s.pointer(from), s.stage);
    const update = updateMove(gesture, s.pointer(to), {
      shift: false,
      alt: true, // snapping off, so this case tests the conversion alone
      refThreshold: s.refThreshold(),
    });

    results[scale] = geometryOf(update.items, 'i_dense_squiggle');
    eq(`drag at scale ${scale} lands at x 280`, geometryOf(update.items, 'i_dense_squiggle'), {
      x: 280,
      y: 75,
      w: 380,
      h: 160,
      rotate: 4,
    });
    check(
      `drag at scale ${scale} touched only the dragged item`,
      update.items.filter((candidate, index) => candidate !== shapesBand.items[index]).length === 1,
    );
  }
  eq('scale 1.0 and 0.7 produce identical geometry', results[1], results[0.7]);
}

{
  // The bug this guards: dividing by the scale at the wrong moment. A drag of
  // 140 SCREEN px is 140 reference px at scale 1 and 200 at scale 0.7.
  for (const [scale, expectedX] of [
    [1, 60 + 140],
    [0.7, 60 + 200],
  ] as const) {
    const s = stageAt(scale, shapesBand.height);
    const startClient = s.client({ x: 100, y: 80 });
    const movedClient = { clientX: startClient.clientX + 140, clientY: startClient.clientY };
    const gesture = beginMove(
      shapesBand.items,
      ['i_dense_squiggle'],
      clientToRef(startClient.clientX, startClient.clientY, s.rect, scale),
      s.stage,
    );
    const update = updateMove(
      gesture,
      clientToRef(movedClient.clientX, movedClient.clientY, s.rect, scale),
      { shift: false, alt: true, refThreshold: 0 },
    );
    eq(
      `140 screen px at scale ${scale} is ${expectedX - 60} reference px`,
      item(update.items, 'i_dense_squiggle').x,
      expectedX,
    );
  }
}

section('move: multi-selection moves as one rigid body');

{
  for (const scale of SCALES) {
    const s = stageAt(scale, stackBand.height);
    const ids = ['i_dense_stack_1', 'i_dense_stack_3'];
    const before = ids.map((id) => geometryOf(stackBand.items, id));
    const gesture = beginMove(stackBand.items, ids, s.pointer({ x: 200, y: 200 }), s.stage);
    const update = updateMove(gesture, s.pointer({ x: 200 + 61.4, y: 200 - 23.6 }), {
      shift: false,
      alt: true,
      refThreshold: 0,
    });
    const after = ids.map((id) => geometryOf(update.items, id));
    eq(
      `relative offset preserved exactly at scale ${scale} (x)`,
      after[1].x - after[0].x,
      before[1].x - before[0].x,
    );
    eq(
      `relative offset preserved exactly at scale ${scale} (y)`,
      after[1].y - after[0].y,
      before[1].y - before[0].y,
    );
    eq(`both items moved by the same rounded delta at scale ${scale}`, after[0].x - before[0].x, 61);
    eq(`unselected items untouched at scale ${scale}`, geometryOf(update.items, 'i_dense_stack_2'), {
      ...geometryOf(stackBand.items, 'i_dense_stack_2'),
    });
  }
}

section('move: shift locks the axis, alt suspends snapping');

{
  const s = stageAt(1, shapesBand.height);
  const gesture = beginMove(shapesBand.items, ['i_dense_squiggle'], s.pointer({ x: 100, y: 80 }), s.stage);
  const locked = updateMove(gesture, s.pointer({ x: 190, y: 110 }), {
    shift: true,
    alt: true,
    refThreshold: 0,
  });
  eq('shift keeps the dominant axis only', geometryOf(locked.items, 'i_dense_squiggle'), {
    x: 150,
    y: 40,
    w: 380,
    h: 160,
    rotate: 4,
  });

  const lockedVertical = updateMove(gesture, s.pointer({ x: 110, y: 200 }), {
    shift: true,
    alt: true,
    refThreshold: 0,
  });
  eq('shift picks the vertical axis when it dominates', geometryOf(lockedVertical.items, 'i_dense_squiggle').x, 60);
}

section('snapping: edges, centres, the canvas centre, and guides');

{
  // Put a probe item 4 reference px to the left of the rect's left edge (500),
  // and drag it by 0: snapping alone should close the gap.
  const items: CanvasItem[] = [
    ...shapesBand.items,
    { id: 'i_probe', kind: 'shape', shape: 'rect', x: 496, y: 300, w: 100, h: 40, z: 9 },
  ];
  for (const scale of SCALES) {
    const s = stageAt(scale, shapesBand.height);
    const gesture = beginMove(items, ['i_probe'], s.pointer({ x: 500, y: 320 }), s.stage);
    const update = updateMove(gesture, s.pointer({ x: 500, y: 320 }), {
      shift: false,
      alt: false,
      refThreshold: s.refThreshold(),
    });
    eq(`left edge snaps to the rect's left edge at scale ${scale}`, item(update.items, 'i_probe').x, 500);
    check(
      `a vertical item-edge guide is reported at scale ${scale}`,
      update.guides.some((guide) => guide.axis === 'x' && guide.value === 500 && guide.kind === 'item-edge'),
      JSON.stringify(update.guides),
    );
  }

  // Snap radius is a SCREEN distance: 6 screen px is 8.57 reference px at 0.7.
  const gap = 8;
  const far: CanvasItem[] = [
    ...shapesBand.items,
    { id: 'i_probe', kind: 'shape', shape: 'rect', x: 500 - gap, y: 300, w: 100, h: 40, z: 9 },
  ];
  for (const [scale, expected] of [
    [1, 500 - gap],
    [0.7, 500],
  ] as const) {
    const s = stageAt(scale, shapesBand.height);
    const gesture = beginMove(far, ['i_probe'], s.pointer({ x: 500, y: 320 }), s.stage);
    const update = updateMove(gesture, s.pointer({ x: 500, y: 320 }), {
      shift: false,
      alt: false,
      refThreshold: s.refThreshold(),
    });
    eq(`an ${gap}px gap at scale ${scale} ${expected === 500 ? 'snaps' : 'does not snap'}`, item(update.items, 'i_probe').x, expected);
  }

  // Alt suspends it entirely.
  const s = stageAt(1, shapesBand.height);
  const gesture = beginMove(items, ['i_probe'], s.pointer({ x: 500, y: 320 }), s.stage);
  const update = updateMove(gesture, s.pointer({ x: 500, y: 320 }), {
    shift: false,
    alt: true,
    refThreshold: s.refThreshold(),
  });
  eq('alt suspends snapping', item(update.items, 'i_probe').x, 496);
  eq('alt reports no guides', update.guides.length, 0);
}

{
  // The canvas centre, which is REFERENCE_WIDTH / 2 = 672, and the vertical
  // centre of the band.
  const probe: CanvasItem[] = [
    { id: 'i_probe', kind: 'shape', shape: 'rect', x: 520, y: 100, w: 300, h: 60 },
  ];
  const s = stageAt(0.7, 360);
  const gesture = beginMove(probe, ['i_probe'], s.pointer({ x: 600, y: 120 }), s.stage);
  const update = updateMove(gesture, s.pointer({ x: 602, y: 171 }), {
    shift: false,
    alt: false,
    refThreshold: s.refThreshold(),
  });
  const moved = item(update.items, 'i_probe');
  eq('item centre snaps to the canvas centre x', moved.x + moved.w / 2, REFERENCE_WIDTH / 2);
  eq('item centre snaps to the canvas centre y', moved.y + moved.h / 2, 180);
  check(
    'both canvas-centre guides are reported',
    update.guides.filter((guide) => guide.kind === 'canvas-centre').length === 2,
    JSON.stringify(update.guides),
  );
}

{
  const targets = collectSnapTargets(shapesBand.items, [], { width: REFERENCE_WIDTH, height: 360 });
  check(
    'a rotated item offers its visual AABB edge, not its stored x',
    targets.some((target) => target.axis === 'x' && target.itemId === 'i_dense_arrow' && Math.abs(target.value - aabbOf(boxOf(item(shapesBand.items, 'i_dense_arrow'))).x) < 1e-9),
  );
  eq(
    'an excluded item offers no targets',
    collectSnapTargets(shapesBand.items, shapesBand.items.map((i) => i.id), { width: 1344, height: 360 }).filter(
      (target) => target.itemId !== undefined,
    ).length,
    0,
  );
  const noTargets = snapRect({ x: 0, y: 0, w: 10, h: 10 }, [], 6);
  eq('snapRect with no targets is a no-op', noTargets.delta, { x: 0, y: 0 });
}

/* -------------------------------------------------------------------------- */

section('resize: the opposite corner stays pinned');

const CORNER_IDS: CornerId[] = ['nw', 'ne', 'se', 'sw'];

{
  for (const scale of SCALES) {
    const s = stageAt(scale, shapesBand.height);
    for (const corner of CORNER_IDS) {
      const start = boxOf(item(shapesBand.items, 'i_dense_rect'));
      const anchorBefore = boxCorners(start)[
        CORNER_IDS.find((other) => other !== corner && boxCorners(start)[other].x !== boxCorners(start)[corner].x && boxCorners(start)[other].y !== boxCorners(start)[corner].y) as CornerId
      ];
      const gesture = beginResize(shapesBand.items, 'i_dense_rect', corner, s.stage);
      if (gesture === null) throw new Error('no resize gesture');
      const dragged = boxCorners(start)[corner];
      const update = updateResize(gesture, s.pointer({ x: dragged.x + 37, y: dragged.y + 23 }), {
        shift: false,
        alt: true,
        refThreshold: 0,
      });
      const after = geometryOf(update.items, 'i_dense_rect');
      const anchorAfter = boxCorners({ ...after })[
        CORNER_IDS.find((other) => other !== corner && boxCorners(start)[other].x !== boxCorners(start)[corner].x && boxCorners(start)[other].y !== boxCorners(start)[corner].y) as CornerId
      ];
      near(`resize ${corner} at scale ${scale} pins the opposite corner x`, anchorAfter.x, anchorBefore.x, 0.51);
      near(`resize ${corner} at scale ${scale} pins the opposite corner y`, anchorAfter.y, anchorBefore.y, 0.51);
      check(
        `resize ${corner} at scale ${scale} emits whole numbers`,
        Number.isInteger(after.x) && Number.isInteger(after.y) && Number.isInteger(after.w) && Number.isInteger(after.h),
        JSON.stringify(after),
      );
    }
  }
}

{
  // Exact expected numbers for one unrotated case, at both scales.
  const expected = { x: 500, y: 30, w: 340, h: 230, rotate: 0 };
  for (const scale of SCALES) {
    const s = stageAt(scale, shapesBand.height);
    const gesture = beginResize(shapesBand.items, 'i_dense_rect', 'se', s.stage);
    if (gesture === null) throw new Error('no resize gesture');
    const update = updateResize(gesture, s.pointer({ x: 840, y: 260 }), {
      shift: false,
      alt: true,
      refThreshold: 0,
    });
    eq(`se resize to (840,260) at scale ${scale}`, geometryOf(update.items, 'i_dense_rect'), expected);
  }
}

{
  // A rotated item. i_dense_rotated is at -6 degrees.
  const start = boxOf(item(overlayBand.items, 'i_dense_rotated'));
  const results: Record<number, unknown> = {};
  for (const scale of SCALES) {
    const s = stageAt(scale, overlayBand.height);
    const gesture = beginResize(overlayBand.items, 'i_dense_rotated', 'se', s.stage);
    if (gesture === null) throw new Error('no resize gesture');
    const dragged = boxCorners(start).se;
    const update = updateResize(gesture, s.pointer({ x: dragged.x + 50, y: dragged.y + 80 }), {
      shift: false,
      alt: true,
      refThreshold: 0,
    });
    const after = geometryOf(update.items, 'i_dense_rotated');
    results[scale] = after;
    eq(`rotation is untouched by a resize at scale ${scale}`, after.rotate, -6);
    const anchorBefore = boxCorners(start).nw;
    const anchorAfter = boxCorners({ ...after }).nw;
    near(`rotated resize pins nw x at scale ${scale}`, anchorAfter.x, anchorBefore.x, 0.75);
    near(`rotated resize pins nw y at scale ${scale}`, anchorAfter.y, anchorBefore.y, 0.75);
  }
  eq('rotated resize is identical at both scales', results[1], results[0.7]);
}

section('resize: shift keeps the ratio, and nothing collapses');

{
  const s = stageAt(0.7, shapesBand.height);
  const start = item(shapesBand.items, 'i_dense_rect');
  const ratio = start.w / start.h;
  const gesture = beginResize(shapesBand.items, 'i_dense_rect', 'se', s.stage);
  if (gesture === null) throw new Error('no resize gesture');
  const update = updateResize(gesture, s.pointer({ x: 900, y: 120 }), {
    shift: true,
    alt: true,
    refThreshold: 0,
  });
  const after = geometryOf(update.items, 'i_dense_rect');
  near('shift resize keeps the aspect ratio', after.w / after.h, ratio, 0.01);

  const collapse = updateResize(gesture, s.pointer({ x: 300, y: -200 }), {
    shift: false,
    alt: true,
    refThreshold: 0,
  });
  const collapsed = geometryOf(collapse.items, 'i_dense_rect');
  check('dragging a corner past its anchor clamps instead of flipping', collapsed.w >= 8 && collapsed.h >= 8, JSON.stringify(collapsed));
}

{
  // Resize snapping: unrotated only, and switched off while shift is held.
  const items: CanvasItem[] = [
    { id: 'i_a', kind: 'shape', shape: 'rect', x: 100, y: 100, w: 200, h: 100 },
    { id: 'i_b', kind: 'shape', shape: 'rect', x: 500, y: 400, w: 200, h: 100 },
  ];
  const s = stageAt(1, 600);
  const gesture = beginResize(items, 'i_a', 'se', s.stage);
  if (gesture === null) throw new Error('no resize gesture');
  const snapped = updateResize(gesture, s.pointer({ x: 497, y: 402 }), {
    shift: false,
    alt: false,
    refThreshold: s.refThreshold(),
  });
  const box = geometryOf(snapped.items, 'i_a');
  eq('resize corner snaps to another item edge', box.x + box.w, 500);
  eq('resize corner snaps vertically too', box.y + box.h, 400);
  check('resize snapping reports guides', snapped.guides.length >= 2, JSON.stringify(snapped.guides));

  const withShift = updateResize(gesture, s.pointer({ x: 497, y: 402 }), {
    shift: true,
    alt: false,
    refThreshold: s.refThreshold(),
  });
  eq('shift turns resize snapping off', withShift.guides.length, 0);

  const rotated: CanvasItem[] = [{ ...items[0], rotate: 12 }, items[1]];
  const rotatedGesture = beginResize(rotated, 'i_a', 'se', s.stage);
  if (rotatedGesture === null) throw new Error('no resize gesture');
  const rotatedUpdate = updateResize(rotatedGesture, s.pointer({ x: 497, y: 402 }), {
    shift: false,
    alt: false,
    refThreshold: s.refThreshold(),
  });
  eq('a rotated item does not edge-snap while resizing', rotatedUpdate.guides.length, 0);
}

eq('beginResize on a missing id returns null', beginResize(shapesBand.items, 'nope', 'se', { width: 1344, height: 360 }), null);

/* -------------------------------------------------------------------------- */

section('rotate: about the centre, 15 degree steps with shift');

{
  const results: Record<number, unknown> = {};
  for (const scale of SCALES) {
    const s = stageAt(scale, shapesBand.height);
    const start = boxOf(item(shapesBand.items, 'i_dense_rect'));
    const centre = { x: start.x + start.w / 2, y: start.y + start.h / 2 };
    const from = { x: centre.x, y: centre.y - 200 };          // handle straight up
    const to = { x: centre.x + 200, y: centre.y };            // a quarter turn clockwise
    const gesture = beginRotate(shapesBand.items, 'i_dense_rect', s.pointer(from));
    if (gesture === null) throw new Error('no rotate gesture');
    const update = updateRotate(gesture, s.pointer(to), { shift: false, alt: false });
    const after = geometryOf(update.items, 'i_dense_rect');
    results[scale] = after;
    eq(`a quarter turn clockwise at scale ${scale} is +90 degrees`, after.rotate, 90);
    eq(`rotating does not move or resize at scale ${scale}`, { x: after.x, y: after.y, w: after.w, h: after.h }, {
      x: start.x,
      y: start.y,
      w: start.w,
      h: start.h,
    });

    // Free rotation here would be 71.1 degrees; shift takes it to 75.
    const stepped = updateRotate(gesture, s.pointer({ x: centre.x + 190, y: centre.y - 65 }), {
      shift: true,
      alt: false,
    });
    const steppedAngle = item(stepped.items, 'i_dense_rect').rotate ?? 0;
    eq(`shift snaps to a 15 degree step at scale ${scale}`, steppedAngle % 15, 0);
    eq(`shift snaps to the nearest step at scale ${scale}`, steppedAngle, 75);
    const free = updateRotate(gesture, s.pointer({ x: centre.x + 190, y: centre.y - 65 }), {
      shift: false,
      alt: false,
    });
    eq(`without shift the same drag is 71 degrees at scale ${scale}`, item(free.items, 'i_dense_rect').rotate, 71);
  }
  eq('rotation is identical at both scales', results[1], results[0.7]);
}

{
  const start = boxOf(item(shapesBand.items, 'i_dense_arrow')); // rotate: -12
  const centre = { x: start.x + start.w / 2, y: start.y + start.h / 2 };
  const degrees = rotateBoxTo(
    start,
    { x: centre.x, y: centre.y - 100 },
    { x: centre.x - 100, y: centre.y },
    {},
  );
  eq('rotation starts from the existing angle', degrees, -102);
  eq('rotation normalises past 180', normaliseAngle(190), -170);
  eq('rotation normalises to the half-open range', normaliseAngle(-180), 180);
  eq('rotation keeps 0 as 0, not -0', Object.is(normaliseAngle(-360), 0), true);

  const far = rotateBoxTo({ x: 0, y: 0, w: 100, h: 100, rotate: 170 }, { x: 50, y: -50 }, { x: 100, y: 50 }, {});
  eq('a rotation that passes 180 wraps instead of growing', far, -100);
}

eq('beginRotate on a missing id returns null', beginRotate(shapesBand.items, 'nope', { x: 0, y: 0 }), null);

/* -------------------------------------------------------------------------- */

section('nudge, delete, z-order, marquee');

{
  const nudged = nudgeItems(shapesBand.items, ['i_dense_rect', 'i_dense_ellipse'], -1, 0);
  eq('arrow key nudges by 1', item(nudged, 'i_dense_rect').x, 499);
  eq('a nudge moves the whole selection', item(nudged, 'i_dense_ellipse').x, 699);
  eq('a nudge leaves everything else alone', item(nudged, 'i_dense_squiggle'), item(shapesBand.items, 'i_dense_squiggle'));

  // A move must never resize. An item authored smaller than the editor's
  // minimum size has to survive a nudge untouched.
  const tiny: CanvasItem[] = [{ id: 'i_tiny', kind: 'shape', shape: 'rect', x: 10, y: 10, w: 3, h: 2 }];
  const nudgedTiny = item(nudgeItems(tiny, ['i_tiny'], 5, 5), 'i_tiny');
  eq('a nudge does not resize a sub-minimum item', { w: nudgedTiny.w, h: nudgedTiny.h }, { w: 3, h: 2 });
  eq('a nudge still moves it', { x: nudgedTiny.x, y: nudgedTiny.y }, { x: 15, y: 15 });

  const big = nudgeItems(shapesBand.items, ['i_dense_rect'], 0, 10);
  eq('shift+arrow nudges by 10', item(big, 'i_dense_rect').y, 40);
  eq('a zero nudge is a no-op and returns the same array', nudgeItems(shapesBand.items, ['i_dense_rect'], 0, 0), shapesBand.items);
  eq('nudging nothing is a no-op', nudgeItems(shapesBand.items, [], 1, 1), shapesBand.items);
}

{
  const deleted = deleteItems(shapesBand.items, ['i_dense_rect', 'i_dense_arrow']);
  eq('delete removes the whole selection', deleted.length, shapesBand.items.length - 2);
  eq('delete keeps document order', deleted.map((i) => i.id), ['i_dense_squiggle', 'i_dense_ellipse']);
  eq('deleting nothing is a no-op', deleteItems(shapesBand.items, []), shapesBand.items);
}

{
  const order = stackingOrder(stackBand.items);
  eq('stacking order follows z', order, ['i_dense_stack_1', 'i_dense_stack_2', 'i_dense_stack_3', 'i_dense_stack_4']);

  const front = reorderZ(stackBand.items, ['i_dense_stack_1'], 'front');
  eq('bring to front', stackingOrder(front), ['i_dense_stack_2', 'i_dense_stack_3', 'i_dense_stack_4', 'i_dense_stack_1']);
  eq('bring to front keeps the array in document order', front.map((i) => i.id), stackBand.items.map((i) => i.id));
  eq('z stays a contiguous integer range', front.map((i) => i.z), [3, 0, 1, 2]);

  eq('send to back', stackingOrder(reorderZ(stackBand.items, ['i_dense_stack_4'], 'back')), [
    'i_dense_stack_4',
    'i_dense_stack_1',
    'i_dense_stack_2',
    'i_dense_stack_3',
  ]);
  eq('bring forward moves one step', stackingOrder(reorderZ(stackBand.items, ['i_dense_stack_2'], 'forward')), [
    'i_dense_stack_1',
    'i_dense_stack_3',
    'i_dense_stack_2',
    'i_dense_stack_4',
  ]);
  eq('send backward moves one step', stackingOrder(reorderZ(stackBand.items, ['i_dense_stack_3'], 'backward')), [
    'i_dense_stack_1',
    'i_dense_stack_3',
    'i_dense_stack_2',
    'i_dense_stack_4',
  ]);
  eq('restacking with nothing selected changes nothing', reorderZ(stackBand.items, [], 'front'), stackBand.items);
  eq('forward on the top item is a no-op', stackingOrder(reorderZ(stackBand.items, ['i_dense_stack_4'], 'forward')), [
    'i_dense_stack_1',
    'i_dense_stack_2',
    'i_dense_stack_3',
    'i_dense_stack_4',
  ]);
  eq(
    'a multi-selection keeps its internal order when sent to front',
    stackingOrder(reorderZ(stackBand.items, ['i_dense_stack_1', 'i_dense_stack_2'], 'front')),
    ['i_dense_stack_3', 'i_dense_stack_4', 'i_dense_stack_1', 'i_dense_stack_2'],
  );
}

{
  for (const scale of SCALES) {
    const s = stageAt(scale, shapesBand.height);
    const gesture = beginMarquee(shapesBand.items, s.pointer({ x: 40, y: 20 }), []);
    const update = updateMarquee(gesture, s.pointer({ x: 520, y: 240 }));
    near(`marquee rect x at scale ${scale}`, update.rect.x, 40, 1e-9);
    near(`marquee rect y at scale ${scale}`, update.rect.y, 20, 1e-9);
    near(`marquee rect w at scale ${scale}`, update.rect.w, 480, 1e-9);
    near(`marquee rect h at scale ${scale}`, update.rect.h, 220, 1e-9);
    eq(`marquee catches overlapping items at scale ${scale}`, update.ids, ['i_dense_squiggle', 'i_dense_rect']);

    const backwards = updateMarquee(gesture, s.pointer({ x: 20, y: 10 }));
    near(`a marquee dragged up and left is normalised at scale ${scale} (x)`, backwards.rect.x, 20, 1e-9);
    near(`a marquee dragged up and left is normalised at scale ${scale} (w)`, backwards.rect.w, 20, 1e-9);
    eq(`an empty marquee selects nothing at scale ${scale}`, backwards.ids, []);
  }

  const additive = updateMarquee(
    beginMarquee(shapesBand.items, { x: 1000, y: 100 }, ['i_dense_squiggle']),
    { x: 1200, y: 200 },
  );
  eq('a shift-marquee adds to the existing selection', additive.ids, ['i_dense_squiggle', 'i_dense_arrow']);

  // A rotated item is caught by the box the eye sees, not by its stored x/y.
  const rotated: CanvasItem[] = [{ id: 'i_r', kind: 'shape', shape: 'rect', x: 100, y: 100, w: 200, h: 20, rotate: 90 }];
  const caught = updateMarquee(beginMarquee(rotated, { x: 180, y: 10 }, []), { x: 220, y: 60 });
  eq('a rotated item is caught by its visual bounds', caught.ids, ['i_r']);
}

/* -------------------------------------------------------------------------- */

section('cursors');

eq('an unrotated se handle is nwse', resizeCursor('se', 0), 'nwse-resize');
eq('a 90 degree turn swaps the diagonal', resizeCursor('se', 90), 'nesw-resize');
eq('a 45 degree turn gives an axis cursor', resizeCursor('se', 45), 'ns-resize');
eq('cursors wrap past 180', resizeCursor('nw', -90), 'nesw-resize');

/* -------------------------------------------------------------------------- */

section('what comes out is still a valid document');

{
  // Run a drag, a resize, a rotate, a nudge, a delete and a restack over the
  // dense fixture, put the results back into the document, and validate. This
  // is what catches editor state leaking into stored geometry: the schema is
  // strict, so one stray key fails here.
  const s = stageAt(0.7, shapesBand.height);
  let items: CanvasItem[] = shapesBand.items as CanvasItem[];

  const move = beginMove(items, ['i_dense_squiggle', 'i_dense_rect'], s.pointer({ x: 300, y: 120 }), s.stage);
  items = updateMove(move, s.pointer({ x: 367.3, y: 151.9 }), { shift: false, alt: false, refThreshold: s.refThreshold() }).items;

  const resize = beginResize(items, 'i_dense_ellipse', 'nw', s.stage);
  if (resize === null) throw new Error('no resize gesture');
  items = updateResize(resize, s.pointer({ x: 660.4, y: 90.2 }), { shift: true, alt: false, refThreshold: s.refThreshold() }).items;

  const rotate = beginRotate(items, 'i_dense_arrow', s.pointer({ x: 1170, y: 60 }));
  if (rotate === null) throw new Error('no rotate gesture');
  items = updateRotate(rotate, s.pointer({ x: 1240, y: 130 }), { shift: true, alt: false }).items;

  items = nudgeItems(items, ['i_dense_arrow'], 10, -10);
  items = reorderZ(items, ['i_dense_squiggle'], 'front');
  items = deleteItems(items, ['i_dense_rect']);

  for (const emitted of items) {
    check(
      `${emitted.id} geometry is whole numbers`,
      Number.isInteger(emitted.x) && Number.isInteger(emitted.y) && Number.isInteger(emitted.w) && Number.isInteger(emitted.h),
      JSON.stringify(emitted),
    );
    check(
      `${emitted.id} rotation is a whole number`,
      emitted.rotate === undefined || Number.isInteger(emitted.rotate),
      JSON.stringify(emitted),
    );
    check(`${emitted.id} z is an integer`, emitted.z === undefined || Number.isInteger(emitted.z), JSON.stringify(emitted));
    check(`${emitted.id} w and h are positive`, emitted.w > 0 && emitted.h > 0, JSON.stringify(emitted));
  }

  const rebuilt: Doc = {
    ...dense,
    bands: dense.bands.map((candidate) =>
      candidate.id === 'b_dense_shapes' && candidate.type === 'canvas' ? { ...candidate, items } : candidate,
    ),
  };
  const revalidated = validateDocJson(JSON.stringify(rebuilt));
  check(
    'the edited document still validates against the WS-0 schema',
    revalidated.ok,
    revalidated.ok ? '' : formatIssues(revalidated.issues),
  );
}

/* -------------------------------------------------------------------------- */

process.stdout.write(`\n  ${passed} checks passed`);
if (failures.length > 0) {
  process.stdout.write(`, ${failures.length} FAILED\n\n`);
  for (const failure of failures) process.stdout.write(`  FAIL  ${failure}\n`);
  process.stdout.write('\n');
  process.exit(1);
}
process.stdout.write(', 0 failed\n\n');
