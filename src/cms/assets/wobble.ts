/**
 * src/cms/assets/wobble.ts
 *
 * WS-6, internal. The hand-drawn geometry toolkit behind `shapes.ts`.
 *
 * NOT part of the WS-0 contract (docs/cms-contracts.md section 5.1 freezes
 * `shapes.ts` only). Nothing outside `src/cms/assets/` should import this.
 *
 * Two jobs:
 *
 *  1. A seeded PRNG, so a shape's wobble is fixed forever by its seed. Nothing
 *     in this file reads `Math.random`, the clock, the DOM or anything else
 *     ambient. That is the whole reason a squiggle does not twitch when the
 *     page re-renders or the window resizes.
 *  2. Cubic Bezier primitives for drawing the way a pen moves: curves through
 *     jittered waypoints, arcs with a wavering radius, and cursive loops that
 *     cross back over the line they came in on.
 *
 * Coordinates are emitted rounded to two decimals, which is what makes "the
 * same spec returns the same bytes" true rather than approximately true.
 */

export type Pt = { x: number; y: number };

/** A seeded uniform generator over [0, 1). */
export type Rng = () => number;

/* -------------------------------------------------------------------------- */
/* Randomness                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * mulberry32. Small, fast, good enough for jitter, and — the only property
 * that actually matters here — exactly reproducible from its seed on every
 * engine, because it is all `Math.imul` and uint32 arithmetic.
 */
export function makeRng(seed: number): Rng {
  let state = ((Number.isFinite(seed) ? seed : 0) >>> 0) ^ 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform in [lo, hi). */
export function between(rng: Rng, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

/** Uniform in [-amount, amount). The everyday "nudge this a bit" call. */
export function swing(rng: Rng, amount: number): number {
  return (rng() * 2 - 1) * amount;
}

/** -1 or 1. Which way a bow bends, which way a loop curls. */
export function coin(rng: Rng): 1 | -1 {
  return rng() < 0.5 ? -1 : 1;
}

export function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  if (hi < lo) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

/* -------------------------------------------------------------------------- */
/* Vectors                                                                     */
/* -------------------------------------------------------------------------- */

export function add(a: Pt, b: Pt): Pt {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Pt, b: Pt): Pt {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Pt, k: number): Pt {
  return { x: a.x * k, y: a.y * k };
}

export function length(a: Pt): number {
  return Math.sqrt(a.x * a.x + a.y * a.y);
}

/** Unit vector. A zero vector stays zero instead of becoming NaN. */
export function norm(a: Pt): Pt {
  const len = length(a);
  return len > 1e-9 ? { x: a.x / len, y: a.y / len } : { x: 0, y: 0 };
}

/**
 * Left normal in SVG coordinates (y grows downward), so `perp({x:1,y:0})` is
 * `{x:0,y:1}` and points down the screen.
 */
export function perp(a: Pt): Pt {
  return { x: -a.y, y: a.x };
}

export function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/* -------------------------------------------------------------------------- */
/* Numbers and path data                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Two decimals, no exponent, no `-0`, no trailing zeros. Rounding here is what
 * makes the output byte-stable: it throws away the last bits of float noise
 * before they ever reach the string.
 */
export function fmt(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 100) / 100;
  if (rounded === 0) return '0';
  return String(rounded);
}

export type Path = {
  move(to: Pt): void;
  curve(c1: Pt, c2: Pt, to: Pt): void;
  line(to: Pt): void;
  close(): void;
  /** The current point. After an arc or a loop, where the pen actually is. */
  tip(): Pt;
  /** Number of drawing commands, i.e. the shape's topology. */
  size(): number;
  d(): string;
};

/**
 * Optional hard limit on where the pen may go.
 *
 * Every point handed to the pen, control points included, is clamped into this
 * rectangle. A cubic never leaves the convex hull of its four points, so
 * clamping the points is a proof that the ink cannot leave the box: inline SVG
 * is clipped by the UA stylesheet, and a shape whose wobble gets sliced off by
 * the edge of its own item looks broken. The per-shape jitter is tuned to fit
 * anyway; this is the backstop that makes "it fits" true for every size, every
 * stroke width and every seed rather than for the ones that were tried.
 */
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export function path(bounds?: Bounds): Path {
  const parts: string[] = [];
  let cur: Pt = { x: 0, y: 0 };
  let commands = 0;
  const hold =
    bounds === undefined
      ? (point: Pt): Pt => point
      : (point: Pt): Pt => ({
          x: clamp(point.x, bounds.minX, bounds.maxX),
          y: clamp(point.y, bounds.minY, bounds.maxY),
        });
  return {
    move(to) {
      const end = hold(to);
      parts.push(`M${fmt(end.x)} ${fmt(end.y)}`);
      cur = end;
      commands += 1;
    },
    curve(c1, c2, to) {
      const a = hold(c1);
      const b = hold(c2);
      const end = hold(to);
      parts.push(`C${fmt(a.x)} ${fmt(a.y)} ${fmt(b.x)} ${fmt(b.y)} ${fmt(end.x)} ${fmt(end.y)}`);
      cur = end;
      commands += 1;
    },
    line(to) {
      const end = hold(to);
      parts.push(`L${fmt(end.x)} ${fmt(end.y)}`);
      cur = end;
      commands += 1;
    },
    close() {
      parts.push('Z');
      commands += 1;
    },
    tip: () => cur,
    size: () => commands,
    d: () => parts.join(' '),
  };
}

/* -------------------------------------------------------------------------- */
/* Pen strokes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Catmull-Rom style tangent at waypoint `i`: half the vector between its
 * neighbours. At the ends it degrades to half the one segment it has.
 */
export function tangentAt(points: readonly Pt[], index: number): Pt {
  const prev = points[Math.max(0, index - 1)];
  const next = points[Math.min(points.length - 1, index + 1)];
  return scale(sub(next, prev), 0.5);
}

/**
 * Control points for one segment of a pen stroke.
 *
 * The smoothness comes from the Catmull-Rom tangents; the hand comes from two
 * things on top of them: the tangent lengths are jittered (so the curve
 * sometimes overshoots and leans past where a machine would turn) and each
 * control point is pushed off the segment perpendicular by a fraction of the
 * segment's own length (so a long sweep wavers more than a short one, exactly
 * like a wrist does).
 */
export function segmentControls(
  from: Pt,
  to: Pt,
  tanFrom: Pt,
  tanTo: Pt,
  rng: Rng,
  wobble: number,
  tension: [number, number] = [0.82, 1.24],
  cap = Infinity,
): [Pt, Pt] {
  const seg = sub(to, from);
  const len = length(seg);
  const normal = perp(norm(seg));
  const k0 = between(rng, tension[0], tension[1]) / 3;
  const k1 = between(rng, tension[0], tension[1]) / 3;
  // The cap matters in a flat box: wobble is a fraction of the segment's
  // length, and in a 1100x70 box a "subtle" 8% of 275px is three times the
  // vertical room there is. Inline SVG is clipped, so the caller says how far
  // off the line the pen is allowed to stray in absolute terms.
  const j0 = clamp(swing(rng, wobble * len), -cap, cap);
  const j1 = clamp(swing(rng, wobble * len), -cap, cap);
  return [
    add(add(from, scale(tanFrom, k0)), scale(normal, j0)),
    add(sub(to, scale(tanTo, k1)), scale(normal, j1)),
  ];
}

/**
 * Draw one continuous pen stroke through every waypoint. Returns the direction
 * the pen was travelling as it arrived, which is what an arrowhead needs.
 */
export function drawChain(
  pen: Path,
  points: readonly Pt[],
  rng: Rng,
  wobble: number,
  options: { move?: boolean; tension?: [number, number]; cap?: number } = {},
): Pt {
  if (points.length === 0) return { x: 1, y: 0 };
  if (options.move !== false) pen.move(points[0]);
  let lastControl = points[0];
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = i === 0 ? pen.tip() : points[i];
    const to = points[i + 1];
    const [c1, c2] = segmentControls(
      from,
      to,
      tangentAt(points, i),
      tangentAt(points, i + 1),
      rng,
      wobble,
      options.tension,
      options.cap,
    );
    pen.curve(c1, c2, to);
    lastControl = c2;
  }
  const end = points[points.length - 1];
  const dir = norm(sub(end, lastControl));
  return dir.x === 0 && dir.y === 0 ? { x: 1, y: 0 } : dir;
}

/**
 * A local frame for drawing an ellipse that is not axis aligned. `ex` and
 * `ey` are unit vectors; the identity frame is {x:1,y:0} and {x:0,y:1}.
 */
export type Frame = { ex: Pt; ey: Pt };

export const AXIS_FRAME: Frame = { ex: { x: 1, y: 0 }, ey: { x: 0, y: 1 } };

/** The frame whose x axis points along `dir`. */
export function frameAlong(dir: Pt): Frame {
  const ex = norm(dir);
  return { ex, ey: perp(ex) };
}

/** The point at `angle` on an ellipse in `frame`, for moving the pen to an arc's start. */
export function onArcIn(centre: Pt, frame: Frame, rx: number, ry: number, angle: number): Pt {
  const u = rx * Math.cos(angle);
  const v = ry * Math.sin(angle);
  return {
    x: centre.x + frame.ex.x * u + frame.ey.x * v,
    y: centre.y + frame.ex.y * u + frame.ey.y * v,
  };
}

/** Axis-aligned convenience wrapper. */
export function onArc(centre: Pt, rx: number, ry: number, angle: number): Pt {
  return onArcIn(centre, AXIS_FRAME, rx, ry, angle);
}

/**
 * Append an elliptical arc as cubics, in an arbitrary frame, with the radius
 * wavering as it goes.
 *
 * Sub-arcs are capped at 90 degrees and use the standard k = 4/3 tan(d/4)
 * circle approximation. `jitter` is a fraction of the radius applied
 * independently at every joint, which is what stops a hand-drawn circle from
 * being a circle. Coarser sub-arcs make bigger lumps, which is why the callers
 * do not subdivide more finely than they need.
 */
export function arcToIn(
  pen: Path,
  centre: Pt,
  frame: Frame,
  rx: number,
  ry: number,
  from: number,
  to: number,
  rng: Rng,
  jitter = 0,
): void {
  const sweep = to - from;
  if (!Number.isFinite(sweep) || sweep === 0) return;
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const step = sweep / steps;
  const k = (4 / 3) * Math.tan(step / 4);
  const place = (u: number, v: number): Pt => ({
    x: frame.ex.x * u + frame.ey.x * v,
    y: frame.ex.y * u + frame.ey.y * v,
  });
  let angle = from;
  let rxA = rx * (1 + swing(rng, jitter));
  let ryA = ry * (1 + swing(rng, jitter));
  for (let i = 0; i < steps; i += 1) {
    const next = angle + step;
    const rxB = rx * (1 + swing(rng, jitter));
    const ryB = ry * (1 + swing(rng, jitter));
    const start = add(centre, place(rxA * Math.cos(angle), ryA * Math.sin(angle)));
    const end = add(centre, place(rxB * Math.cos(next), ryB * Math.sin(next)));
    const tanStart = place(-rxA * Math.sin(angle), ryA * Math.cos(angle));
    const tanEnd = place(-rxB * Math.sin(next), ryB * Math.cos(next));
    pen.curve(add(start, scale(tanStart, k)), sub(end, scale(tanEnd, k)), end);
    angle = next;
    rxA = rxB;
    ryA = ryB;
  }
}

/** Axis-aligned convenience wrapper. */
export function arcTo(
  pen: Path,
  centre: Pt,
  rx: number,
  ry: number,
  from: number,
  to: number,
  rng: Rng,
  jitter = 0,
): void {
  arcToIn(pen, centre, AXIS_FRAME, rx, ry, from, to, rng, jitter);
}

/**
 * A cursive loop, the signature move of a pen line that is enjoying itself.
 *
 * The pen arrives at `at` travelling along `dir`, curls around a circle set
 * off to one side (`side`), and comes out short of a full turn — so the exit
 * sits slightly behind the entry and the next stroke crosses the line it came
 * in on. That crossing is the difference between a loop and a bump, and it is
 * the thing that reads as handwriting rather than as a plotted function.
 *
 * Returns where the pen ended up and which way it is now pointing.
 */
export function cursiveLoop(
  pen: Path,
  at: Pt,
  dir: Pt,
  radius: number,
  side: 1 | -1,
  rng: Rng,
): { exit: Pt; dir: Pt } {
  const frame = frameAlong(dir);
  // Longer along the direction of travel than across it: a cursive loop is an
  // ellipse lying down in the direction the hand is already moving, not a
  // compass circle stuck onto a wave.
  const rx = radius * between(rng, 1.12, 1.5);
  const ry = radius * between(rng, 0.58, 0.84);
  const centre = add(
    add(at, scale(frame.ey, side * ry)),
    scale(frame.ex, rx * between(rng, 0.06, 0.34)),
  );
  const local = sub(at, centre);
  const from = Math.atan2(
    (local.x * frame.ey.x + local.y * frame.ey.y) / ry,
    (local.x * frame.ex.x + local.y * frame.ex.y) / rx,
  );
  const sweep = side * between(rng, 0.72, 0.93) * Math.PI * 2;
  const to = from + sweep;
  arcToIn(pen, centre, frame, rx, ry, from, to, rng, 0.08);
  const sign = Math.sign(sweep) || 1;
  const tangent = add(
    scale(frame.ex, -rx * Math.sin(to) * sign),
    scale(frame.ey, ry * Math.cos(to) * sign),
  );
  return { exit: pen.tip(), dir: norm(tangent) };
}

/** Rotate a vector by `angle` radians, clockwise on screen (y grows down). */
export function rotate(v: Pt, angle: number): Pt {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
}
