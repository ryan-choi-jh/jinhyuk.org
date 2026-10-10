/**
 * src/cms/assets/verify.ts
 *
 * WS-6's standalone proof. Runs under bare node, no build, no browser, no
 * other workstream:
 *
 *   node src/cms/assets/verify.ts
 *
 * Checks, in order:
 *
 *   1. The frozen output contract from docs/cms-contracts.md section 5.3:
 *      one root <svg>, the exact root attributes, no id, no <defs>, no
 *      <style>, no class, no script, no <marker>, round caps, fill="none"
 *      unless a fill was asked for.
 *   2. Determinism. The same spec twice in this process, and the same spec in
 *      a second node process, byte for byte.
 *   3. Containment. Inline SVG is clipped by the UA stylesheet, so the ink
 *      (path bounds grown by half the stroke, which is what a round cap does)
 *      has to stay inside the viewBox. Measured by flattening every cubic.
 *   4. Stability under resize. The same seed at four sizes has to produce the
 *      same number of drawing commands: a shape may scale, it may never
 *      rearrange itself while someone drags a handle.
 *   5. Sensitivity to the seed. Different seeds have to actually differ.
 *   6. Input hygiene. A colour that is not a hex literal never reaches the
 *      output; NaN, Infinity, a negative stroke and an unknown kind all
 *      produce a valid SVG instead of throwing or emitting NaN.
 *   7. The fixtures: every shape item in WS-0's three fixtures converts and
 *      draws.
 *
 * Exit code 0 means every one of those held.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isCanvasBand, seedFromId, shapeSpecFromItem, validateDocJson } from '../schema.ts';
import type { ShapeKind, ShapeSpec } from '../schema.ts';
import { SHAPE_KINDS, generateShape } from './shapes.ts';
import { SEEDS, fingerprint, verificationMatrix } from './matrix.ts';

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (!ok) failures += 1;
  if (!ok) console.log(`    FAIL  ${label}${detail ? ` (${detail})` : ''}`);
}

function heading(title: string): void {
  console.log(`\n${title}`);
}

function done(label: string, detail = ''): void {
  console.log(`    ok    ${label}${detail ? ` (${detail})` : ''}`);
}

/* -------------------------------------------------------------------------- */
/* Path bounds                                                                 */
/* -------------------------------------------------------------------------- */

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Flatten every path in an SVG string and return the ink bounds. */
function pathBounds(svg: string): Bounds & { numbers: number } {
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let numbers = 0;
  const grow = (x: number, y: number): void => {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  };

  for (const match of svg.matchAll(/ d="([^"]+)"/g)) {
    const tokens = match[1].match(/[MLCZ]|-?\d+(?:\.\d+)?/g) ?? [];
    let cursor = 0;
    let x = 0;
    let y = 0;
    const take = (): number => {
      const value = Number(tokens[cursor]);
      cursor += 1;
      numbers += 1;
      return value;
    };
    while (cursor < tokens.length) {
      const command = tokens[cursor];
      cursor += 1;
      if (command === 'M' || command === 'L') {
        x = take();
        y = take();
        grow(x, y);
      } else if (command === 'C') {
        const x1 = take();
        const y1 = take();
        const x2 = take();
        const y2 = take();
        const x3 = take();
        const y3 = take();
        for (let step = 0; step <= 24; step += 1) {
          const t = step / 24;
          grow(cubicAt(x, x1, x2, x3, t), cubicAt(y, y1, y2, y3, t));
        }
        x = x3;
        y = y3;
      } else if (command === 'Z') {
        /* nothing to measure */
      } else {
        cursor -= 1;
        take();
      }
    }
  }
  return { ...bounds, numbers };
}

function commandCount(svg: string): number {
  return (svg.match(/[MLCZ]/g) ?? []).length;
}

const specs = verificationMatrix();

/** Same rounding the generator uses, so the expected viewBox is the real one. */
function fmt(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? '0' : String(rounded);
}

/* -------------------------------------------------------------------------- */
/* 1. Output contract                                                          */
/* -------------------------------------------------------------------------- */

heading(`1. output contract (${specs.length} specs)`);
{
  let bad = 0;
  const complain = (spec: ShapeSpec, why: string): void => {
    if (bad < 5) console.log(`          ${spec.shape} ${spec.width}x${spec.height} sw${spec.strokeWidth}: ${why}`);
    bad += 1;
  };
  for (const spec of specs) {
    const svg = generateShape(spec);
    const head =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(spec.width)} ${fmt(spec.height)}"` +
      ` width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true" focusable="false">`;
    if (!svg.startsWith(head)) complain(spec, 'root attributes are not the frozen set');
    if (!svg.endsWith('</svg>')) complain(spec, 'does not end with </svg>');
    if (svg.trim() !== svg) complain(spec, 'surrounding whitespace');
    if ((svg.match(/<svg/g) ?? []).length !== 1) complain(spec, 'more than one <svg>');
    if (/\sid="/.test(svg)) complain(spec, 'has an id attribute');
    if (/<defs|<style|<script|<marker|class=|xlink:|url\(/.test(svg)) complain(spec, 'forbidden construct');
    if (/<\?xml|<!DOCTYPE/i.test(svg)) complain(spec, 'xml declaration or doctype');
    if (/NaN|Infinity|undefined|null|e-\d|e\+\d/.test(svg)) complain(spec, 'non-finite or exponent number');
    const strokePaths = svg.match(/<path [^>]*stroke="#[^"]*"[^>]*>/g) ?? [];
    if (strokePaths.length === 0) complain(spec, 'no stroked path');
    for (const element of strokePaths) {
      if (!element.includes('stroke-linecap="round"')) complain(spec, 'stroke without round caps');
      if (!element.includes('fill="none"')) complain(spec, 'stroked path without fill="none"');
    }
    const filled = (svg.match(/fill="#[0-9a-fA-F]{3,8}"/g) ?? []).length;
    if (spec.fill === undefined && filled > 0) complain(spec, 'filled without being asked to');
    if (spec.fill !== undefined && filled !== 1) complain(spec, `expected one filled path, got ${filled}`);
  }
  check('every spec satisfies section 5.3', bad === 0, `${bad} violations`);
  if (bad === 0) done('every spec satisfies section 5.3');
}

/* -------------------------------------------------------------------------- */
/* 2. Determinism                                                              */
/* -------------------------------------------------------------------------- */

heading('2. determinism');
{
  let same = 0;
  for (const spec of specs) if (generateShape(spec) === generateShape(spec)) same += 1;
  check('same spec twice in one process', same === specs.length, `${same}/${specs.length}`);
  if (same === specs.length) done('same spec twice in one process', `${same} specs`);

  const here = fingerprint(specs.map((spec) => generateShape(spec)));
  const child = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('./fingerprint.ts', import.meta.url))],
    { encoding: 'utf8' },
  ).trim();
  check('same specs in a second node process', here === child, `${here} vs ${child}`);
  if (here === child) done('same specs in a second node process', `fingerprint ${here}`);
}

/* -------------------------------------------------------------------------- */
/* 3. Containment                                                              */
/* -------------------------------------------------------------------------- */

heading('3. ink stays inside the viewBox');
{
  let worst = 0;
  let worstLabel = '';
  let bad = 0;
  for (const spec of specs) {
    const svg = generateShape(spec);
    const bounds = pathBounds(svg);
    const pen = Math.min(spec.strokeWidth, Math.max(1, Math.min(spec.width, spec.height))) / 2;
    const over = Math.max(
      -(bounds.minX - pen),
      -(bounds.minY - pen),
      bounds.maxX + pen - spec.width,
      bounds.maxY + pen - spec.height,
    );
    if (over > worst) {
      worst = over;
      worstLabel = `${spec.shape} ${spec.width}x${spec.height} sw${spec.strokeWidth}`;
    }
    if (over > 0.75) bad += 1;
  }
  check('no shape overflows its box by more than 0.75px', bad === 0, `${bad} specs, worst ${worst.toFixed(2)}px on ${worstLabel}`);
  if (bad === 0) done('no shape overflows its box', `worst ${worst.toFixed(2)}px on ${worstLabel}`);
}

/* -------------------------------------------------------------------------- */
/* 4. Topology is stable under resize                                          */
/* -------------------------------------------------------------------------- */

heading('4. resizing scales a shape, it never rearranges it');
{
  let bad = 0;
  for (const shape of SHAPE_KINDS) {
    for (const seed of SEEDS) {
      const counts = [
        [200, 120],
        [400, 240],
        [800, 480],
        [1200, 720],
      ].map(([width, height]) =>
        commandCount(generateShape({ shape, width, height, color: '#111111', strokeWidth: 2, seed })),
      );
      if (new Set(counts).size !== 1) {
        bad += 1;
        console.log(`          ${shape} seed ${seed}: command counts ${counts.join(', ')}`);
      }
    }
  }
  check('same command count at four sizes', bad === 0, `${bad} unstable`);
  if (bad === 0) done('same command count at four sizes', `${SHAPE_KINDS.length * SEEDS.length} seeds`);
}

/* -------------------------------------------------------------------------- */
/* 5. The seed actually does something                                         */
/* -------------------------------------------------------------------------- */

heading('5. different seeds draw different shapes');
{
  let bad = 0;
  for (const shape of SHAPE_KINDS) {
    const drawings = new Set(
      SEEDS.map((seed) =>
        generateShape({ shape, width: 300, height: 160, color: '#111111', strokeWidth: 2, seed }),
      ),
    );
    if (drawings.size !== SEEDS.length) bad += 1;
  }
  check('five seeds give five drawings for every kind', bad === 0, `${bad} kinds collided`);
  if (bad === 0) done('five seeds give five drawings for every kind');
}

/* -------------------------------------------------------------------------- */
/* 6. Input hygiene                                                            */
/* -------------------------------------------------------------------------- */

heading('6. hostile and broken input');
{
  const base: ShapeSpec = {
    shape: 'squiggle',
    width: 200,
    height: 100,
    color: '#111111',
    strokeWidth: 2,
    seed: 7,
  };
  const hostile = generateShape({
    ...base,
    color: '#fff" onload="alert(1)' as string,
    fill: 'javascript:alert(1)' as string,
    shape: 'rect',
  });
  check('a colour that is not hex never reaches the output', !hostile.includes('onload') && !hostile.includes('javascript'));
  check('the fallback colour is used instead', hostile.includes('stroke="#111111"'));

  const nonsense: [string, ShapeSpec][] = [
    ['NaN width', { ...base, width: Number.NaN }],
    ['Infinite height', { ...base, height: Number.POSITIVE_INFINITY }],
    ['zero width', { ...base, width: 0 }],
    ['negative size', { ...base, width: -300, height: -40 }],
    ['negative stroke', { ...base, strokeWidth: -4 }],
    ['huge stroke', { ...base, strokeWidth: 400 }],
    ['NaN seed', { ...base, seed: Number.NaN }],
    ['unknown kind', { ...base, shape: 'spiral' as ShapeKind }],
    ['negative radius', { ...base, shape: 'rect', radius: -20 }],
    ['absurd radius', { ...base, shape: 'rect', radius: 9999 }],
    ['missing fields', {} as ShapeSpec],
  ];
  let bad = 0;
  for (const [label, spec] of nonsense) {
    let svg = '';
    try {
      svg = generateShape(spec);
    } catch (error) {
      bad += 1;
      console.log(`          ${label}: threw ${(error as Error).message}`);
      continue;
    }
    if (!svg.startsWith('<svg ') || !svg.endsWith('</svg>') || /NaN|Infinity|undefined/.test(svg)) {
      bad += 1;
      console.log(`          ${label}: ${svg.slice(0, 120)}`);
    }
  }
  check('broken input still produces a valid svg', bad === 0, `${bad} of ${nonsense.length} broken`);
  if (bad === 0) done('broken input still produces a valid svg', `${nonsense.length} cases`);
}

/* -------------------------------------------------------------------------- */
/* 7. Fixtures                                                                 */
/* -------------------------------------------------------------------------- */

heading('7. WS-0 fixtures');
{
  let shapes = 0;
  let bad = 0;
  for (const name of ['simple.json', 'canvas.json', 'dense.json']) {
    const result = validateDocJson(
      readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8'),
    );
    if (!result.ok) {
      bad += 1;
      continue;
    }
    for (const band of result.doc.bands.filter(isCanvasBand)) {
      for (const item of band.items) {
        const spec = shapeSpecFromItem(item);
        if (spec === null) continue;
        shapes += 1;
        const svg = generateShape(spec);
        if (!svg.startsWith('<svg ') || svg.length < 120) {
          bad += 1;
          console.log(`          ${item.id} drew nothing useful`);
        }
        if (spec.seed !== seedFromId(item.id)) {
          bad += 1;
          console.log(`          ${item.id} seed is not seedFromId(id)`);
        }
      }
    }
  }
  check('every fixture shape converts and draws', bad === 0 && shapes > 0, `${shapes} shapes, ${bad} bad`);
  if (bad === 0 && shapes > 0) done('every fixture shape converts and draws', `${shapes} shapes`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
