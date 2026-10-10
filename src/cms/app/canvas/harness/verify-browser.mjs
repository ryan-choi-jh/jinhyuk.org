/**
 * src/cms/app/canvas/harness/verify-browser.mjs
 *
 * WS-4's browser proof. Builds the harness, serves it on 127.0.0.1, drives the
 * real <CanvasEditor> in Chromium with real pointer input, and asserts the
 * geometry it emits. Run it:
 *
 *   node src/cms/app/canvas/harness/verify-browser.mjs
 *
 * Every gesture is exercised at scale 1.00 and at 0.70, because the one bug
 * that would make this component useless is forgetting to divide a pointer
 * delta by the stage scale. Two kinds of assertion catch it:
 *
 *   - the same drag expressed in REFERENCE px must give the same numbers at
 *     both scales;
 *   - the same drag expressed in SCREEN px must give numbers that differ by
 *     exactly 1 / scale.
 *
 * Playwright comes from the gstack install, which is already on this machine;
 * nothing is installed into this repo.
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, OUT_DIR } from './build.mjs';
import { startServer } from './server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(OUT_DIR, 'screens');

const PLAYWRIGHT_HOSTS = [
  '/Users/ryanchoi/.claude/skills/gstack/package.json',
  join(here, '..', '..', '..', '..', '..', 'package.json'),
];

function loadPlaywright() {
  for (const host of PLAYWRIGHT_HOSTS) {
    try {
      return createRequire(host)('playwright');
    } catch {
      /* try the next host */
    }
  }
  throw new Error('playwright not found; this check needs a browser');
}

/* -------------------------------------------------------------------------- */

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(detail === undefined ? label : `${label}\n      ${detail}`);
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, `expected ${b}\n      actual   ${a}`);
}

function near(label, actual, expected, tolerance) {
  check(label, Math.abs(actual - expected) <= tolerance, `expected ${expected} +/- ${tolerance}\n      actual   ${actual}`);
}

function section(name) {
  process.stdout.write(`\n  ${name}\n`);
}

/* -------------------------------------------------------------------------- */

const { chromium } = loadPlaywright();

await build();
mkdirSync(SHOTS, { recursive: true });
const server = await startServer({ port: 0 });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2240, height: 1180 } });

const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

await page.goto(server.url);
await page.waitForSelector('[data-cv-stage]');

/* -------------------------------------------------------------------------- */
/* Driving helpers                                                             */
/* -------------------------------------------------------------------------- */

const harness = () => page.evaluate(() => window.__harness);

async function setup({ scale, bandIndex, snapEnabled, parentScaled = false }) {
  await page.evaluate(() => window.__harnessReset());
  await page.evaluate(
    (patch) => window.__harnessSet(patch),
    { scale, bandIndex, snapEnabled, parentScaled, selection: [] },
  );
  await page.waitForFunction(
    (expected) => window.__harness.scale === expected.scale && window.__harness.bandId === expected.bandId,
    { scale, bandId: ['b_dense_overlay', 'b_dense_shapes', 'b_dense_stack'][bandIndex] },
  );
  await page.mouse.move(4, 4);
}

async function stageBox() {
  const box = await page.locator('[data-cv-stage]').boundingBox();
  if (box === null) throw new Error('no stage');
  return box;
}

/** A reference-px point in the stage -> a client point Chromium can aim at. */
function toClient(stage, scale, point) {
  return { x: stage.x + point.x * scale, y: stage.y + point.y * scale };
}

async function itemOf(id) {
  const items = (await harness()).items;
  const found = items.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no item ${id}`);
  return found;
}

async function centreOfItem(id) {
  const box = await page.locator(`[data-cv-item="${id}"]`).boundingBox();
  if (box === null) throw new Error(`no element for ${id}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * A real press, move, release. The intermediate moves matter: a single jump
 * would only ever produce one pointermove and would hide an accumulation bug.
 */
async function drag(from, to, { steps = 12, keys = [], midway } = {}) {
  for (const key of keys) await page.keyboard.down(key);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
  }
  if (midway !== undefined) await midway();
  await page.mouse.up();
  for (const key of [...keys].reverse()) await page.keyboard.up(key);
}

async function click(point, { keys = [] } = {}) {
  for (const key of keys) await page.keyboard.down(key);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.up();
  for (const key of [...keys].reverse()) await page.keyboard.up(key);
}

const SCALES = [1, 0.7];

/* -------------------------------------------------------------------------- */

section('the same drag in reference px gives the same numbers at every scale');

{
  const results = {};
  for (const scale of SCALES) {
    await setup({ scale, bandIndex: 1, snapEnabled: false });
    const stage = await stageBox();
    const from = await centreOfItem('i_dense_rect');
    // +137 / -22 REFERENCE px, expressed as a physical screen distance.
    const to = { x: from.x + 137 * scale, y: from.y - 22 * scale };
    await drag(from, to);
    const item = await itemOf('i_dense_rect');
    results[scale] = { x: item.x, y: item.y, w: item.w, h: item.h };
    eq(`move at scale ${scale.toFixed(2)}`, results[scale], { x: 637, y: 8, w: 300, h: 200 });
  }
  eq('scale 1.00 and 0.70 agree', results[1], results[0.7]);
}

section('the same drag in screen px scales by 1 / scale');

{
  for (const [scale, expected] of [
    [1, 500 + 140],
    [0.7, 500 + 200],
  ]) {
    await setup({ scale, bandIndex: 1, snapEnabled: false });
    const from = await centreOfItem('i_dense_rect');
    await drag(from, { x: from.x + 140, y: from.y });
    const item = await itemOf('i_dense_rect');
    eq(`140 screen px at scale ${scale.toFixed(2)} is ${expected - 500} reference px`, item.x, expected);
  }
}

section('resize from a corner');

{
  const results = {};
  for (const scale of SCALES) {
    await setup({ scale, bandIndex: 1, snapEnabled: false });
    await click(await centreOfItem('i_dense_rect'));
    const handle = await page.locator('[data-cv-handle="se"]').boundingBox();
    const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
    await drag(from, { x: from.x + 100 * scale, y: from.y + 50 * scale });
    const item = await itemOf('i_dense_rect');
    results[scale] = { x: item.x, y: item.y, w: item.w, h: item.h };
    eq(`se resize at scale ${scale.toFixed(2)} grows by 100 x 50`, results[scale], {
      x: 500,
      y: 30,
      w: 400,
      h: 250,
    });
  }
  eq('resize agrees at both scales', results[1], results[0.7]);

  // nw drags the other way and must pin the se corner.
  await setup({ scale: 0.7, bandIndex: 1, snapEnabled: false });
  await click(await centreOfItem('i_dense_rect'));
  const nw = await page.locator('[data-cv-handle="nw"]').boundingBox();
  const from = { x: nw.x + nw.width / 2, y: nw.y + nw.height / 2 };
  await drag(from, { x: from.x + 40 * 0.7, y: from.y + 20 * 0.7 });
  const item = await itemOf('i_dense_rect');
  eq('nw resize pins the se corner', { right: item.x + item.w, bottom: item.y + item.h }, { right: 800, bottom: 230 });
  eq('nw resize moves the origin', { x: item.x, y: item.y, w: item.w, h: item.h }, { x: 540, y: 50, w: 260, h: 180 });
}

section('shift keeps the aspect ratio while resizing');

{
  await setup({ scale: 0.7, bandIndex: 1, snapEnabled: false });
  await click(await centreOfItem('i_dense_rect'));
  const handle = await page.locator('[data-cv-handle="se"]').boundingBox();
  const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  await drag(from, { x: from.x + 150 * 0.7, y: from.y + 10 * 0.7 }, { keys: ['Shift'] });
  const item = await itemOf('i_dense_rect');
  near('ratio held to within rounding', item.w / item.h, 300 / 200, 0.01);
  check('shift resize actually grew the item', item.w > 300, JSON.stringify(item));
}

section('rotate, and 15 degree steps with shift');

{
  for (const scale of SCALES) {
    await setup({ scale, bandIndex: 1, snapEnabled: false });
    await click(await centreOfItem('i_dense_rect'));
    const handle = await page.locator('.cv-rotate').boundingBox();
    const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
    const centre = await centreOfItem('i_dense_rect');
    const radius = centre.y - from.y;
    // A quarter turn clockwise: the handle ends up to the right of the centre.
    await drag(from, { x: centre.x + radius, y: centre.y });
    const item = await itemOf('i_dense_rect');
    eq(`a quarter turn at scale ${scale.toFixed(2)} is 90 degrees`, item.rotate, 90);
    eq(`rotating leaves the box alone at scale ${scale.toFixed(2)}`, { x: item.x, y: item.y, w: item.w, h: item.h }, { x: 500, y: 30, w: 300, h: 200 });
  }

  await setup({ scale: 0.7, bandIndex: 1, snapEnabled: false });
  await click(await centreOfItem('i_dense_rect'));
  const handle = await page.locator('.cv-rotate').boundingBox();
  const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  const centre = await centreOfItem('i_dense_rect');
  const radius = centre.y - from.y;
  const angle = (-90 + 71) * (Math.PI / 180);
  await drag(from, { x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius }, { keys: ['Shift'] });
  const item = await itemOf('i_dense_rect');
  eq('shift snaps 71 degrees to 75', item.rotate, 75);
}

section('snapping, with the guides that go with it');

{
  for (const scale of SCALES) {
    await setup({ scale, bandIndex: 1, snapEnabled: true });
    const stage = await stageBox();
    const from = await centreOfItem('i_dense_rect');
    // The rect's centre is at x 650. Nudge it to 670, two px short of the
    // canvas centre at 672, and let the snap close the gap.
    let guidesMidDrag = 0;
    let guideKeys = [];
    await drag(from, { x: from.x + 20 * scale, y: from.y }, {
      midway: async () => {
        guideKeys = await page.$$eval('[data-cv-guide]', (nodes) => nodes.map((node) => node.dataset.cvGuide));
        guidesMidDrag = guideKeys.length;
      },
    });
    const item = await itemOf('i_dense_rect');
    eq(`centre snaps to the canvas centre at scale ${scale.toFixed(2)}`, item.x + item.w / 2, 672);
    check(
      `a guide is drawn while dragging at scale ${scale.toFixed(2)}`,
      guidesMidDrag > 0,
      JSON.stringify(guideKeys),
    );
    check(
      `the guide names the canvas centre at scale ${scale.toFixed(2)}`,
      guideKeys.some((key) => key === 'x:672:canvas-centre'),
      JSON.stringify(guideKeys),
    );
    const after = await page.$$eval('[data-cv-guide]', (nodes) => nodes.length);
    eq(`guides are cleared on release at scale ${scale.toFixed(2)}`, after, 0);
  }

  // Snapping off means no help and no guides.
  await setup({ scale: 1, bandIndex: 1, snapEnabled: false });
  const from = await centreOfItem('i_dense_rect');
  await drag(from, { x: from.x + 20, y: from.y });
  const item = await itemOf('i_dense_rect');
  eq('with snapping off the item lands exactly where it was dragged', item.x, 520);
}

section('multi-select: marquee, shift-click, move together, delete together');

{
  for (const scale of SCALES) {
    await setup({ scale, bandIndex: 1, snapEnabled: false });
    const stage = await stageBox();
    await drag(toClient(stage, scale, { x: 40, y: 20 }), toClient(stage, scale, { x: 520, y: 240 }));
    const state = await harness();
    eq(`marquee catches two items at scale ${scale.toFixed(2)}`, state.selection, ['i_dense_squiggle', 'i_dense_rect']);
    eq(`a marquee changes nothing at scale ${scale.toFixed(2)}`, state.changes, 0);

    await click(await centreOfItem('i_dense_ellipse'), { keys: ['Shift'] });
    eq(`shift-click adds a third at scale ${scale.toFixed(2)}`, (await harness()).selection.length, 3);

    const before = await Promise.all(
      ['i_dense_squiggle', 'i_dense_rect', 'i_dense_ellipse'].map((id) => itemOf(id)),
    );
    const grab = await centreOfItem('i_dense_squiggle');
    await drag(grab, { x: grab.x + 30 * scale, y: grab.y + 15 * scale });
    const after = await Promise.all(
      ['i_dense_squiggle', 'i_dense_rect', 'i_dense_ellipse'].map((id) => itemOf(id)),
    );
    for (let i = 0; i < before.length; i += 1) {
      eq(`${before[i].id} moved with the selection at scale ${scale.toFixed(2)}`, { dx: after[i].x - before[i].x, dy: after[i].y - before[i].y }, { dx: 30, dy: 15 });
    }
    eq(`the arrow was left alone at scale ${scale.toFixed(2)}`, (await itemOf('i_dense_arrow')).x, 1060);

    await page.keyboard.press('Delete');
    const deleted = await harness();
    eq(`delete removes the whole selection at scale ${scale.toFixed(2)}`, deleted.items.map((it) => it.id), ['i_dense_arrow']);
    eq(`the selection is empty after a delete at scale ${scale.toFixed(2)}`, deleted.selection, []);
  }

  // Shift-click toggles back off, and must not move anything.
  await setup({ scale: 1, bandIndex: 1, snapEnabled: false });
  await click(await centreOfItem('i_dense_rect'));
  await click(await centreOfItem('i_dense_rect'), { keys: ['Shift'] });
  eq('shift-click on a selected item removes it', (await harness()).selection, []);
  eq('building a selection never changes the document', (await harness()).changes, 0);
}

section('arrow keys');

{
  for (const scale of SCALES) {
    await setup({ scale, bandIndex: 1, snapEnabled: true });
    await click(await centreOfItem('i_dense_rect'));
    await page.keyboard.press('ArrowRight');
    eq(`arrow nudges 1px at scale ${scale.toFixed(2)}`, (await itemOf('i_dense_rect')).x, 501);
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.up('Shift');
    eq(`shift+arrow nudges 10px at scale ${scale.toFixed(2)}`, (await itemOf('i_dense_rect')).x, 511);
    await page.keyboard.press('ArrowUp');
    eq(`arrow up nudges negative at scale ${scale.toFixed(2)}`, (await itemOf('i_dense_rect')).y, 29);
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.up('Shift');
    eq(`shift+arrow down at scale ${scale.toFixed(2)}`, (await itemOf('i_dense_rect')).y, 39);
  }
}

section('z-order');

{
  await setup({ scale: 0.7, bandIndex: 2, snapEnabled: false });
  const order = async () => (await harness()).items.map((item) => [item.id, item.z]);
  eq('the stack starts in fixture order', await order(), [
    ['i_dense_stack_1', 1],
    ['i_dense_stack_2', 2],
    ['i_dense_stack_3', 3],
    ['i_dense_stack_4', 4],
  ]);

  await click(await centreOfItem('i_dense_stack_1'));
  await page.keyboard.press(']');
  eq('] brings it forward one step', await order(), [
    ['i_dense_stack_1', 1],
    ['i_dense_stack_2', 0],
    ['i_dense_stack_3', 2],
    ['i_dense_stack_4', 3],
  ]);

  await page.keyboard.down('Meta');
  await page.keyboard.press(']');
  await page.keyboard.up('Meta');
  eq('cmd+] brings it to the front', await order(), [
    ['i_dense_stack_1', 3],
    ['i_dense_stack_2', 0],
    ['i_dense_stack_3', 1],
    ['i_dense_stack_4', 2],
  ]);

  await page.locator('.cv-toolbar button[title^="Send to back"]').click();
  eq('the toolbar sends it to the back', await order(), [
    ['i_dense_stack_1', 0],
    ['i_dense_stack_2', 1],
    ['i_dense_stack_3', 2],
    ['i_dense_stack_4', 3],
  ]);
  eq('the document array order never changed', (await harness()).items.map((item) => item.id), [
    'i_dense_stack_1',
    'i_dense_stack_2',
    'i_dense_stack_3',
    'i_dense_stack_4',
  ]);
}

section('a rotated item, dragged');

{
  const results = {};
  for (const scale of SCALES) {
    await setup({ scale, bandIndex: 0, snapEnabled: false });
    const from = await centreOfItem('i_dense_rotated');
    await drag(from, { x: from.x - 60 * scale, y: from.y + 24 * scale });
    const item = await itemOf('i_dense_rotated');
    results[scale] = { x: item.x, y: item.y, rotate: item.rotate };
    eq(`a rotated item translates without changing angle at scale ${scale.toFixed(2)}`, results[scale], {
      x: 1010,
      y: 38,
      rotate: -6,
    });
  }
  eq('the rotated drag agrees at both scales', results[1], results[0.7]);
}

section('escape abandons a drag');

{
  await setup({ scale: 0.7, bandIndex: 1, snapEnabled: false });
  const before = await itemOf('i_dense_rect');
  const from = await centreOfItem('i_dense_rect');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i += 1) await page.mouse.move(from.x + (100 * i) / 6, from.y + (40 * i) / 6);
  const midway = await itemOf('i_dense_rect');
  check('the item really did move before escape', midway.x !== before.x, JSON.stringify(midway));
  await page.keyboard.press('Escape');
  await page.mouse.up();
  const after = await itemOf('i_dense_rect');
  eq('escape puts the item back exactly', { x: after.x, y: after.y, w: after.w, h: after.h }, {
    x: before.x,
    y: before.y,
    w: before.w,
    h: before.h,
  });
  eq('nothing is left selected-and-dragging', await page.$$eval('[data-cv-guide]', (n) => n.length), 0);
}

section('the other integration mode: the parent applies the scale');

{
  // applyTransform={false}: an ancestor owns the CSS transform, the component
  // is told the scale only so its pointer maths is right. Same drag, same
  // numbers, or the two modes have drifted.
  const results = {};
  for (const parentScaled of [false, true]) {
    await setup({ scale: 0.7, bandIndex: 1, snapEnabled: false, parentScaled });
    const from = await centreOfItem('i_dense_rect');
    await drag(from, { x: from.x + 137 * 0.7, y: from.y - 22 * 0.7 });
    const item = await itemOf('i_dense_rect');
    results[String(parentScaled)] = { x: item.x, y: item.y, w: item.w, h: item.h };
    eq(`move with parentScaled=${parentScaled}`, results[String(parentScaled)], { x: 637, y: 8, w: 300, h: 200 });
  }
  eq('both integration modes agree', results.false, results.true);
}

section('the document stays valid, and the page stays quiet');

{
  const state = await harness();
  check('the harness reports the band as schema-valid', state.valid === true);
  eq('no console errors', consoleErrors, []);
}

/* -------------------------------------------------------------------------- */
/* Evidence                                                                    */
/* -------------------------------------------------------------------------- */

for (const [name, scale, bandIndex] of [
  ['scale-100-shapes', 1, 1],
  ['scale-070-shapes', 0.7, 1],
  ['scale-070-stack', 0.7, 2],
]) {
  await setup({ scale, bandIndex, snapEnabled: true });
  await click(await centreOfItem(bandIndex === 1 ? 'i_dense_rect' : 'i_dense_stack_2'));
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

// One mid-drag frame, so the guides are in the picture.
await setup({ scale: 0.7, bandIndex: 1, snapEnabled: true });
{
  const from = await centreOfItem('i_dense_rect');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(from.x + (20 * 0.7 * i) / 8, from.y);
  await page.screenshot({ path: join(SHOTS, 'snapping-guides.png') });
  await page.mouse.up();
}

await browser.close();
await server.close();

process.stdout.write(`\n  screenshots in ${SHOTS}\n`);
process.stdout.write(`\n  ${passed} checks passed`);
if (failures.length > 0) {
  process.stdout.write(`, ${failures.length} FAILED\n\n`);
  for (const failure of failures) process.stdout.write(`  FAIL  ${failure}\n`);
  process.stdout.write('\n');
  process.exit(1);
}
process.stdout.write(', 0 failed\n\n');
