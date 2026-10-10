/**
 * src/cms/assets/shapes.ts
 *
 * WS-6 ASSET LIBRARY. The drawable components.
 *
 * This file is the frozen contract from docs/cms-contracts.md section 5:
 *
 *   export function generateShape(spec: ShapeSpec): string;
 *   export const SHAPE_KINDS: readonly ShapeKind[];
 *
 * WS-1 (renderer) and WS-4 (canvas editor) import from exactly this path with
 * exactly these names. Nothing else under src/cms/assets/ is part of the
 * contract, so the picker and the catalogue can change without touching anyone.
 *
 * The output, all of it frozen by section 5.3: one self-contained root <svg>,
 * no ids, no <defs>, no <style>, no classes, no script, no <marker>; arrowheads
 * are paths. Strokes are stroke-linecap="round" and fill="none" unless `fill`
 * is set. Pure and deterministic: the same ShapeSpec returns the same bytes.
 *
 * --------------------------------------------------------------------------
 * How these are drawn
 *
 * The brief asks for drawings that read as a pen line, not as a plot of a
 * function, and the owner's reference is one continuous looping line: loose,
 * confident, one pass. So:
 *
 *  - Nothing is a sine wave. Every shape is a chain of cubic Beziers through
 *    waypoints whose spacing, amplitude and control-point tangents are all
 *    jittered, which is what a wrist does and what a formula does not.
 *  - The squiggle contains real cursive loops that cross back over the line
 *    they came in on, and ends on a flick. That crossing is the single most
 *    legible "a hand did this" signal available.
 *  - A rect is one continuous stroke that goes round the box and overshoots
 *    past where it started, not four tidy sides. An ellipse over-closes past
 *    its start angle for the same reason.
 *  - One pass, not a sketchy double stroke. Overdrawn hatching reads as
 *    uncertain; the reference is confident.
 *  - Jitter is drawn from a seeded PRNG in a fixed order, and never from
 *    `Math.random`, the clock or the DOM. The same seed at the same size is
 *    byte-identical forever, and the *number* of waypoints and loops depends
 *    only on the seed — never on the width or height — so dragging a resize
 *    handle scales the drawing instead of rearranging it.
 */

import { SHAPE_DEFAULTS, SHAPE_KINDS as SCHEMA_SHAPE_KINDS } from '../schema.ts';
import type { ShapeKind, ShapeSpec } from '../schema.ts';
import {
  add,
  arcToIn,
  between,
  clamp,
  coin,
  cursiveLoop,
  drawChain,
  fmt,
  length,
  lerp,
  makeRng,
  frameAlong,
  norm,
  onArcIn,
  path,
  perp,
  rotate,
  scale,
  segmentControls,
  sub,
  swing,
  tangentAt,
} from './wobble.ts';
import type { Bounds, Frame, Path, Pt, Rng } from './wobble.ts';

/**
 * Re-exported from the schema so there is one list, not two that can drift.
 * Contract: `SHAPE_KINDS: readonly ShapeKind[]`.
 */
export const SHAPE_KINDS: readonly ShapeKind[] = SCHEMA_SHAPE_KINDS;

/* -------------------------------------------------------------------------- */
/* Input hygiene                                                               */
/* -------------------------------------------------------------------------- */

/** Same set the schema's HexColorSchema accepts: #rgb, #rgba, #rrggbb, #rrggbbaa. */
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * The generator promises never to echo raw input into its output, because the
 * result gets inlined into static HTML and assigned with innerHTML. A colour
 * that is not a hex literal is replaced, not escaped: there is no legitimate
 * reason for `fill="#fff" onload=...` to reach a page.
 */
function safeHex(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_RE.test(value) ? value : fallback;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Padding that keeps round caps inside the box without collapsing a deliberately
 * flat shape. A 420x2 rule (fixtures: `i_dense_rule`) has to stay drawable, so
 * the vertical pad can never eat more than a third of the height.
 */
function insets(width: number, height: number, strokeWidth: number): { padX: number; padY: number } {
  const cap = strokeWidth * 0.6 + 1;
  return {
    padX: Math.min(cap, width * 0.12),
    padY: Math.min(cap, height * 0.3),
  };
}

/**
 * Where the pen is allowed to go: the viewBox, inset by half the stroke so a
 * round cap lands on the edge rather than over it. Handed to every path, which
 * clamps against it, so no seed can ever draw outside its own item.
 */
function box(width: number, height: number, strokeWidth: number): Bounds {
  const pen = Math.min(strokeWidth / 2, Math.min(width, height) / 2);
  return { minX: pen, minY: pen, maxX: width - pen, maxY: height - pen };
}

/** Per-kind seed salt, so switching kind in the picker redraws rather than reuses. */
const KIND_SALT: Readonly<Record<ShapeKind, number>> = {
  line: 1,
  rect: 2,
  ellipse: 3,
  squiggle: 4,
  arrow: 5,
};

/* -------------------------------------------------------------------------- */
/* Elements                                                                    */
/* -------------------------------------------------------------------------- */

function strokeEl(d: string, colour: string, strokeWidth: number): string {
  return (
    `<path d="${d}" fill="none" stroke="${colour}" stroke-width="${fmt(strokeWidth)}"` +
    ` stroke-linecap="round" stroke-linejoin="round"/>`
  );
}

function fillEl(d: string, colour: string): string {
  return `<path d="${d}" fill="${colour}" stroke="none"/>`;
}

/* -------------------------------------------------------------------------- */
/* line                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A pen line across the box, top-left to bottom-right.
 *
 * It always spans the full width and the full height of the padded box, so a
 * flat box (the 420x2 rule in the fixtures) is a level rule and a tall box is a
 * diagonal, with everything in between continuous. No threshold, so resizing
 * never makes it jump.
 *
 * The waver is capped against the *smaller* side of the box, because in a 2px
 * high box a "subtle" 8px wobble is a scribble.
 */
function drawLine(width: number, height: number, strokeWidth: number, rng: Rng): string {
  const { padX, padY } = insets(width, height, strokeWidth);
  const a: Pt = { x: padX, y: padY };
  const b: Pt = { x: Math.max(padX + 1, width - padX), y: Math.max(padY, height - padY) };
  const span = length(sub(b, a));
  const normal = perp(norm(sub(b, a)));
  const room = Math.max(0.2, Math.min(width, height) * 0.22);
  const maxOff = Math.min(span * 0.022, room);
  const bow = coin(rng) * between(rng, 0.45, 1) * maxOff;

  const steps = 4;
  const points: Pt[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const off = bow * Math.sin(Math.PI * t) + (i === 0 || i === steps ? 0 : swing(rng, maxOff * 0.5));
    points.push(add(lerp(a, b, t), scale(normal, off)));
  }

  const pen = path(box(width, height, strokeWidth));
  drawChain(pen, points, rng, 0.018, { cap: maxOff * 0.6 });
  return strokeEl(pen.d(), '%C', strokeWidth);
}

/* -------------------------------------------------------------------------- */
/* squiggle                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The hero. One continuous looping pen line.
 *
 * Waypoints alternate above and below the centre with jittered amplitude and
 * jittered spacing; one or two of the interior waypoints are replaced by a
 * cursive loop curling back toward the centre line, which makes the stroke
 * cross itself; and the line finishes on a flick, the way a pen leaves paper.
 *
 * Waypoint count (3-5 humps) and loop count come from the seed alone. Resizing
 * stretches this drawing; it never re-rolls it.
 */
function drawSquiggle(width: number, height: number, strokeWidth: number, rng: Rng): string {
  const { padX, padY } = insets(width, height, strokeWidth);
  const centreY = height / 2;
  // 0.92: the control-point wobble pushes the curve a little past its
  // waypoints, and inline SVG is clipped by the UA stylesheet, so leave room.
  const room = Math.max(0.5, (height / 2 - padY) * 0.92);

  // A hand does two things at once: it oscillates, and it drifts. Splitting the
  // vertical budget between a hump amplitude and a wandering centre line is what
  // stops the stroke sitting on an invisible horizontal axis, which is the
  // biggest single "this is a plotted function" tell there is.
  const humpAmp = room * 0.78;
  const driftAmp = room * 0.22;
  const tilt = swing(rng, 1);
  const bulge = swing(rng, 1);
  const phase = between(rng, 0, Math.PI);
  const drift = (t: number): number =>
    driftAmp * (tilt * (t - 0.5) * 1.2 + bulge * 0.4 * Math.sin(Math.PI * t + phase));

  const humps = 3 + Math.floor(rng() * 3);
  const flickRoom = (width - 2 * padX) * between(rng, 0.07, 0.12);
  const from = padX;
  const to = Math.max(padX + 1, width - padX - flickRoom);
  const count = humps + 2;
  const step = (to - from) / (count - 1);
  const first = coin(rng);

  const points: Pt[] = [];
  for (let i = 0; i < count; i += 1) {
    const edge = i === 0 || i === count - 1;
    const x = from + step * i + (edge ? 0 : swing(rng, step * 0.26));
    const base = centreY + drift((x - from) / Math.max(1, to - from));
    const amplitude = humpAmp * between(rng, 0.45, 1);
    points.push({
      x,
      y: edge ? base + swing(rng, humpAmp * 0.55) : base + (i % 2 === 1 ? first : -first) * amplitude,
    });
  }

  // Which interior waypoints become loops. Non-adjacent, and chosen from the
  // seed alone, so resizing the box never adds or removes one.
  const interior: number[] = [];
  for (let i = 1; i < count - 1; i += 1) interior.push(i);
  const wanted = Math.min(interior.length, 1 + (rng() < (humps >= 4 ? 0.62 : 0.4) ? 1 : 0));
  const loopAt: number[] = [];
  for (let tries = 0; tries < 24 && loopAt.length < wanted; tries += 1) {
    const candidate = interior[Math.floor(rng() * interior.length)];
    if (loopAt.some((held) => Math.abs(held - candidate) < 2)) continue;
    loopAt.push(candidate);
  }

  const pen = path(box(width, height, strokeWidth));
  pen.move(points[0]);
  let carried: Pt | null = null;
  let lastControl: Pt = points[0];

  for (let i = 0; i < count - 1; i += 1) {
    const start = pen.tip();
    const end = points[i + 1];
    // A wide tension range is what makes some peaks pointed and others lazy.
    const [c1, c2] = segmentControls(
      start,
      end,
      carried ?? tangentAt(points, i),
      tangentAt(points, i + 1),
      rng,
      0.08,
      [0.68, 1.5],
      room * 0.4,
    );
    pen.curve(c1, c2, end);
    lastControl = c2;
    carried = null;

    const index = i + 1;
    if (loopAt.includes(index) && index < count - 1) {
      // Curl back toward the centre line, so the loop stays inside the box.
      const side = (index % 2 === 1 ? -first : first) as 1 | -1;
      const radius = Math.max(
        strokeWidth * 0.9,
        Math.min(humpAmp * between(rng, 0.5, 0.78), Math.abs(step) * 0.42),
      );
      const loop = cursiveLoop(pen, end, norm(sub(end, c2)), radius, side, rng);
      const next = points[index + 1];
      carried = scale(loop.dir, length(sub(next, loop.exit)));
      lastControl = loop.exit;
    }
  }

  // The flick: forward, then hooked off to one side as the pen lifts.
  const end = pen.tip();
  const heading = norm(sub(end, lastControl));
  const hook = coin(rng);
  // Keep the whole flick, control points included, inside the box: a cubic
  // never leaves the convex hull of its four points, so clamping the points is
  // enough.
  const low = Math.min(strokeWidth * 0.5, height / 2);
  const high = Math.max(low, height - strokeWidth * 0.5);
  const hold = (point: Pt): Pt => ({
    x: clamp(point.x, strokeWidth * 0.5, Math.max(strokeWidth * 0.5, width - strokeWidth * 0.5)),
    y: clamp(point.y, low, high),
  });
  const reach = Math.min(Math.max(strokeWidth * 1.5, flickRoom), room * 1.6);
  const tip = hold({
    x: end.x + heading.x * reach * 0.5 + reach * 0.35,
    y: end.y + perp(heading).y * hook * room * between(rng, 0.35, 0.7),
  });
  pen.curve(
    hold(add(end, scale(heading, reach * 0.8))),
    hold(add(tip, scale(heading, reach * 0.45))),
    tip,
  );

  return strokeEl(pen.d(), '%C', strokeWidth);
}

/* -------------------------------------------------------------------------- */
/* arrow                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A bowed shaft left to right, plus a head drawn as one V stroke with a corner
 * at the tip and a slight overshoot past it. Two strokes, because a hand lifts
 * between the shaft and the head.
 *
 * The bow scales with the box height, so a flat box gives a nearly straight
 * arrow and a tall box gives a swoop. That makes `h` mean something on an
 * arrow instead of being dead space.
 */
function drawArrow(width: number, height: number, strokeWidth: number, rng: Rng): string {
  const { padX, padY } = insets(width, height, strokeWidth);
  const centreY = height / 2;
  const room = Math.max(0.5, height / 2 - padY);
  // The head is sized from the box before the tip is placed, because the pen
  // carries a little way past the tip and that overshoot has to fit too.
  const reachable = Math.max(1, width - padX * 2);
  const barb = clamp(
    reachable * between(rng, 0.2, 0.28),
    strokeWidth * 2.2,
    Math.max(strokeWidth * 2.2, Math.min(reachable * 0.45, room * 1.45)),
  );
  const tail: Pt = { x: padX, y: centreY + swing(rng, room * 0.12) };
  const head: Pt = {
    x: Math.max(padX + 1, width - padX - barb * 0.16),
    y: centreY + swing(rng, room * 0.12),
  };
  const normal = perp(norm(sub(head, tail)));
  const bow = coin(rng) * between(rng, 0.3, 0.95) * room * 0.85;

  const steps = 4;
  const shaft: Pt[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const off =
      bow * Math.sin(Math.PI * t) + (i === 0 || i === steps ? 0 : swing(rng, room * 0.07));
    shaft.push(add(lerp(tail, head, t), scale(normal, off)));
  }

  const pen = path(box(width, height, strokeWidth));
  const heading = drawChain(pen, shaft, rng, 0.028, { cap: room * 0.3 });

  // The two barbs share a spread and a length and then disagree slightly.
  // Drawing them independently makes a bird's foot, not an arrowhead.
  const back = scale(heading, -1);
  const spread = between(rng, 0.4, 0.52);
  const lean = swing(rng, 0.07);
  const legA = scale(rotate(back, spread + lean), barb * between(rng, 0.94, 1.06));
  const legB = scale(rotate(back, -(spread - lean)), barb * between(rng, 0.94, 1.06));
  const overshoot = add(head, scale(heading, barb * between(rng, 0.02, 0.09)));
  const a = add(head, legA);
  const b = add(head, legB);

  const nib = path(box(width, height, strokeWidth));
  nib.move(a);
  bowedLeg(nib, a, overshoot, rng, barb);
  bowedLeg(nib, overshoot, b, rng, barb);

  return strokeEl(pen.d(), '%C', strokeWidth) + strokeEl(nib.d(), '%C', strokeWidth);
}

/** One barb: mostly straight, slightly bowed, arriving along its own direction. */
function bowedLeg(pen: Path, from: Pt, to: Pt, rng: Rng, barb: number): void {
  const dir = norm(sub(to, from));
  const normal = perp(dir);
  const len = length(sub(to, from));
  const bend = swing(rng, barb * 0.06);
  pen.curve(
    add(add(from, scale(dir, len * 0.38)), scale(normal, bend)),
    add(sub(to, scale(dir, len * 0.3)), scale(normal, bend * 0.6)),
    to,
  );
}

/* -------------------------------------------------------------------------- */
/* rect                                                                        */
/* -------------------------------------------------------------------------- */

type Ring = {
  corners: Pt[];
  dirs: Pt[];
  lengths: number[];
  radius: number;
  /** How far outside the drawn ring there is still room inside the box. */
  room: number;
};

function ring(
  width: number,
  height: number,
  strokeWidth: number,
  radius: number,
  rng: Rng,
): Ring {
  const { padX, padY } = insets(width, height, strokeWidth);
  // Shrink by the jitter and the edge bow before adding them, so a corner that
  // wanders and an edge that bows still land inside the clipped box.
  const slack = Math.min(width - padX * 2, height - padY * 2) * 0.032;
  const x0 = padX + slack;
  const y0 = padY + slack;
  const x1 = Math.max(x0 + 1, width - padX - slack);
  const y1 = Math.max(y0 + 1, height - padY - slack);
  const skew = Math.min(x1 - x0, y1 - y0) * 0.016;
  const corners: Pt[] = [
    { x: x0 + swing(rng, skew), y: y0 + swing(rng, skew) },
    { x: x1 + swing(rng, skew), y: y0 + swing(rng, skew) },
    { x: x1 + swing(rng, skew), y: y1 + swing(rng, skew) },
    { x: x0 + swing(rng, skew), y: y1 + swing(rng, skew) },
  ];
  const dirs = corners.map((corner, i) => norm(sub(corners[(i + 1) % 4], corner)));
  const lengths = corners.map((corner, i) => length(sub(corners[(i + 1) % 4], corner)));
  return {
    corners,
    dirs,
    lengths,
    radius: clamp(radius, 0, Math.max(0, Math.min(x1 - x0, y1 - y0) / 2 - 0.5)),
    room: Math.max(0, Math.min(padX, padY) + slack - skew - strokeWidth / 2),
  };
}

/**
 * One continuous stroke round the box, starting partway along the top edge and
 * finishing past where it started. The crossing at the start is the hand-drawn
 * tell; four separate tidy sides are not.
 */
function drawRect(
  shape: Ring,
  width: number,
  height: number,
  strokeWidth: number,
  rng: Rng,
): string {
  const { corners, dirs, lengths, radius: r, room } = shape;
  const minSide = Math.min(width, height);
  const bow = Math.min(minSide * 0.018, room * 0.8);
  // An ear reaches ear*1.6 past the corner once its control point is counted,
  // and there is only `room` to spare before the box edge clips it.
  const earBase = Math.min(strokeWidth * 0.5 + minSide * 0.016, room / 2.3);
  // How far past each sharp corner the pen carries before it turns. Negative
  // means it stops short. Corners that meet exactly are what make a drawn box
  // look like a CSS border, so none of these four agree with each other.
  const ears = [0, 1, 2, 3].map(() => (r >= 0.5 ? 0 : earBase * between(rng, -0.5, 1.4)));
  const pen = path(box(width, height, strokeWidth));

  // Start far enough along the top edge to clear the corner we come back to.
  const clearance = Math.min((r + strokeWidth * 2 + earBase) / Math.max(lengths[0], 1), 0.5);
  const startT = clamp(between(rng, 0.22, 0.42), Math.min(clearance, 0.5), 0.5);
  const start = lerp(corners[0], corners[1], startT);
  pen.move(start);

  const edge = (target: Pt, index: number): void => {
    const begin = pen.tip();
    if (length(sub(target, begin)) < 0.01) return;
    const mid = add(
      lerp(begin, target, between(rng, 0.4, 0.6)),
      scale(perp(dirs[index]), swing(rng, bow)),
    );
    drawChain(pen, [begin, mid, target], rng, 0.014, { move: false, cap: room * 0.7 });
  };

  const turn = (index: number): void => {
    const into = dirs[(index + 3) % 4];
    const out = dirs[index];
    if (r >= 0.5) {
      const end = add(corners[index], scale(out, r));
      const k = r * 0.5523 * between(rng, 0.82, 1.16);
      pen.curve(add(pen.tip(), scale(into, k)), sub(end, scale(out, k)), end);
      return;
    }
    const ear = ears[index];
    const end = add(corners[index], scale(out, Math.max(0, ear) * 0.55));
    const hair = Math.max(Math.abs(ear), strokeWidth * 0.35);
    pen.curve(add(pen.tip(), scale(into, hair * 0.6)), sub(end, scale(out, hair * 0.5)), end);
  };

  for (let i = 1; i <= 4; i += 1) {
    const index = i % 4;
    const into = dirs[(index + 3) % 4];
    edge(add(sub(corners[index], scale(into, r)), scale(into, ears[index])), (index + 3) % 4);
    turn(index);
  }
  // Past the start, so the stroke crosses itself where it began.
  edge(lerp(corners[0], corners[1], Math.min(0.94, startT + between(rng, 0.1, 0.22))), 0);

  return strokeEl(pen.d(), '%C', strokeWidth);
}

/**
 * Closed outline for a fill. Same ring as the stroke, pulled in toward the
 * centre by half the pen: a fill drawn from its own jittered ring peeks out
 * from under the line in exactly the places the eye goes.
 */
function rectOutline(
  shape: Ring,
  width: number,
  height: number,
  strokeWidth: number,
  rng: Rng,
): string {
  const { dirs, radius: r } = shape;
  const middle: Pt = {
    x: (shape.corners[0].x + shape.corners[2].x) / 2,
    y: (shape.corners[0].y + shape.corners[2].y) / 2,
  };
  const pull = strokeWidth * 0.45 + Math.min(width, height) * 0.006;
  const corners = shape.corners.map((corner) => add(corner, scale(norm(sub(middle, corner)), pull)));
  const pen = path(box(width, height, strokeWidth));
  pen.move(add(corners[0], scale(dirs[0], r)));
  for (let i = 1; i <= 4; i += 1) {
    const index = i % 4;
    const into = dirs[(index + 3) % 4];
    const out = dirs[index];
    const stop = sub(corners[index], scale(into, r));
    const mid = add(
      lerp(pen.tip(), stop, 0.5),
      scale(perp(into), swing(rng, Math.min(width, height) * 0.008)),
    );
    drawChain(pen, [pen.tip(), mid, stop], rng, 0.01, { move: false });
    if (r >= 0.5) {
      const end = add(corners[index], scale(out, r));
      const k = r * 0.5523;
      pen.curve(add(pen.tip(), scale(into, k)), sub(end, scale(out, k)), end);
    }
  }
  pen.close();
  return pen.d();
}

/* -------------------------------------------------------------------------- */
/* ellipse                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One loop round, with the radius wavering, over-closing past the start angle
 * so the two ends cross. That overlap is how a drawn circle differs from
 * `<ellipse>`.
 */
const ELLIPSE_JITTER = 0.085;

function drawEllipse(
  geometry: EllipseGeometry,
  width: number,
  height: number,
  strokeWidth: number,
  rng: Rng,
): string {
  const JITTER = ELLIPSE_JITTER;
  const { centre, frame, rx, ry } = geometry;
  const from = between(rng, -Math.PI, Math.PI);
  // Over-close: carry on past where the stroke started, so the two ends cross.
  // That overlap is the whole difference between a drawn circle and <ellipse>.
  const sweep = coin(rng) * (Math.PI * 2 + between(rng, 0.3, 0.8));
  const pen = path(box(width, height, strokeWidth));
  pen.move(onArcIn(centre, frame, rx, ry, from));
  arcToIn(pen, centre, frame, rx, ry, from, from + sweep, rng, JITTER);
  return strokeEl(pen.d(), '%C', strokeWidth);
}

/**
 * A tilted ellipse that still fits its box. The tilt is small but it is the
 * reason the shape does not read as <ellipse rx ry>; the fit divides out both
 * the rotation's bounding box and the radius jitter arcToIn is about to add.
 */
type EllipseGeometry = { centre: Pt; frame: Frame; rx: number; ry: number };

function ellipseFrame(
  width: number,
  height: number,
  strokeWidth: number,
  rng: Rng,
  jitter: number,
  tiltAmount: number,
): EllipseGeometry {
  const { padX, padY } = insets(width, height, strokeWidth);
  const halfW = Math.max(0, Math.min(width / 2 - padX, width / 2 - strokeWidth / 2));
  const halfH = Math.max(0, Math.min(height / 2 - padY, height / 2 - strokeWidth / 2));
  const tilt = swing(rng, tiltAmount);
  const cos = Math.abs(Math.cos(tilt));
  const sin = Math.abs(Math.sin(tilt));
  const spanX = Math.max(1e-6, Math.hypot(halfW * cos, halfH * sin));
  const spanY = Math.max(1e-6, Math.hypot(halfW * sin, halfH * cos));
  const fit = Math.min(halfW / spanX, halfH / spanY) / (1 + jitter);
  return {
    centre: { x: width / 2, y: height / 2 },
    frame: frameAlong(rotate({ x: 1, y: 0 }, tilt)),
    rx: Math.max(0, halfW * fit),
    ry: Math.max(0, halfH * fit),
  };
}

/** Same frame as the stroke, pulled inside it, for the same reason as rectOutline. */
function ellipseOutline(
  geometry: EllipseGeometry,
  width: number,
  height: number,
  strokeWidth: number,
  rng: Rng,
): string {
  const JITTER = 0.045;
  const { centre, frame } = geometry;
  const rx = Math.max(0, geometry.rx * 0.97 - strokeWidth * 0.35);
  const ry = Math.max(0, geometry.ry * 0.97 - strokeWidth * 0.35);
  const from = between(rng, -Math.PI, Math.PI);
  const pen = path(box(width, height, strokeWidth));
  pen.move(onArcIn(centre, frame, rx, ry, from));
  arcToIn(pen, centre, frame, rx, ry, from, from + Math.PI * 2, rng, JITTER);
  pen.close();
  return pen.d();
}

/* -------------------------------------------------------------------------- */
/* generateShape                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The contract entry point. docs/cms-contracts.md section 5.
 *
 * Every drawing decision is derived from `spec`, so this is a pure function of
 * its argument: same spec in, same string out, byte for byte, in the editor, in
 * the preview, at build time and in a test.
 */
export function generateShape(spec: ShapeSpec): string {
  const kind: ShapeKind = SHAPE_KINDS.includes(spec?.shape) ? spec.shape : 'line';
  const width = Math.max(1, finite(spec?.width, 1));
  const height = Math.max(1, finite(spec?.height, 1));
  const colour = safeHex(spec?.color, SHAPE_DEFAULTS.color);
  const strokeWidth = clamp(
    finite(spec?.strokeWidth, SHAPE_DEFAULTS.strokeWidth),
    0.25,
    Math.max(1, Math.min(width, height)),
  );
  const seed = (finite(spec?.seed, 0) >>> 0) ^ (Math.imul(KIND_SALT[kind], 0x9e3779b1) >>> 0);
  const rng = makeRng(seed);

  const fill = typeof spec?.fill === 'string' ? safeHex(spec.fill, '') : '';
  const radius = Math.max(0, finite(spec?.radius, 0));

  let body = '';
  switch (kind) {
    case 'squiggle':
      body = drawSquiggle(width, height, strokeWidth, rng);
      break;
    case 'arrow':
      body = drawArrow(width, height, strokeWidth, rng);
      break;
    case 'rect': {
      // One ring, drawn twice: the fill first, so the stroke sits on top of it.
      const shape = ring(width, height, strokeWidth, radius, rng);
      body =
        (fill !== '' ? fillEl(rectOutline(shape, width, height, strokeWidth, rng), fill) : '') +
        drawRect(shape, width, height, strokeWidth, rng);
      break;
    }
    case 'ellipse': {
      const geometry = ellipseFrame(width, height, strokeWidth, rng, ELLIPSE_JITTER, 0.13);
      body =
        (fill !== '' ? fillEl(ellipseOutline(geometry, width, height, strokeWidth, rng), fill) : '') +
        drawEllipse(geometry, width, height, strokeWidth, rng);
      break;
    }
    default:
      body = drawLine(width, height, strokeWidth, rng);
      break;
  }

  // `%C` is a placeholder the drawing functions emit for the stroke colour, so
  // no drawing function has to carry it through every call. Replaced once here,
  // with a value that has already been checked against HEX_RE.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(width)} ${fmt(height)}"` +
    ` width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true"` +
    ` focusable="false">${body.split('%C').join(colour)}</svg>`
  );
}
