/**
 * src/cms/app/library/harness/run.mjs
 *
 * The library's proof. Builds the harness, serves it on 127.0.0.1, drives the
 * real <LibraryBrowser> in the real Google Chrome on this machine, and asserts
 * what it does.
 *
 *   node src/cms/app/library/harness/run.mjs
 *
 * What is actually checked, as opposed to looked at:
 *
 *   - the catalogue loads with no problems, and holds both kinds of thing;
 *   - search filters by name AND by tag, and several terms AND together;
 *   - the category chips and the kind segmented control filter;
 *   - every thumbnail in the grid resolves, and an oversized asset loads its
 *     THUMBNAIL rather than its 1.8MB original;
 *   - a shape's colour, stroke width and seed controls each redraw the
 *     preview, and the seed's back arrow returns to the drawing it came from;
 *   - insertion emits a CanvasItem that WS-0's own CanvasItemSchema accepts,
 *     at a size that is a sane fraction of the 1344px reference width with the
 *     asset's aspect ratio preserved;
 *   - the item a shape insert emits carries the id whose drawing was on
 *     screen, which is the whole point of the seed control;
 *   - inserting the same shape twice never emits the same id twice.
 *
 * Playwright comes from the gstack install, which is already on this machine.
 * Nothing is installed into this repo, and Chrome is the real browser at
 * /Applications/Google Chrome.app, not a bundled Chromium.
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OUT_DIR, build } from './build.mjs';
import { startServer } from './server.mjs';
import { generatorsAgree } from '../schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(OUT_DIR, 'shots');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORT = { width: 1600, height: 1000 };

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
  check(
    label,
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected} +/- ${tolerance}\n      actual   ${actual}`,
  );
}

function section(name) {
  process.stdout.write(`\n  ${name}\n`);
}

/* -------------------------------------------------------------------------- */

const { chromium } = loadPlaywright();

await build();
mkdirSync(SHOTS, { recursive: true });
const server = await startServer({ port: 0 });

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });

/*
 * Console errors and HTTP failures are tracked separately. Chrome asks for
 * /favicon.ico on every page and logs a generic "Failed to load resource" when
 * it is not there, so the console filter drops resource failures and the
 * response filter is what actually asserts that nothing 404ed.
 */
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  if (/Failed to load resource/.test(message.text())) return;
  consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

const badResponses = [];
page.on('response', (response) => {
  if (response.status() < 400) return;
  const url = new URL(response.url()).pathname;
  if (url === '/favicon.ico') return;
  badResponses.push(`${response.status()} ${url}`);
});

await page.goto(server.url, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-lib-root]');
await page.waitForSelector('[data-lib-grid] [data-lib-card]');
await waitForImages();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const lib = () => page.evaluate(() => window.__lib);
const cardIds = () =>
  page.$$eval('[data-lib-grid] [data-lib-card]', (nodes) =>
    nodes.map((node) => node.getAttribute('data-lib-card')),
  );
const stageSvg = () => page.locator('[data-lib-stage] [data-lib-shape]').innerHTML();

/**
 * Every <img> on the grid has finished, one way or the other. `loading="lazy"`
 * means a tile below the fold may never start, so the grid is scrolled to the
 * bottom and back first.
 */
async function waitForImages() {
  await page.evaluate(async () => {
    const grid = document.querySelector('[data-lib-grid]');
    if (grid !== null) {
      grid.scrollTop = grid.scrollHeight;
      await new Promise((done) => setTimeout(done, 120));
      grid.scrollTop = 0;
    }
    await Promise.all(
      [...document.querySelectorAll('[data-lib-grid] img')].map(
        (image) =>
          image.complete ||
          new Promise((done) => {
            image.addEventListener('load', done, { once: true });
            image.addEventListener('error', done, { once: true });
          }),
      ),
    );
  });
  await page.waitForTimeout(80);
}
const stageSeedId = () =>
  page.locator('[data-lib-stage] [data-lib-shape]').getAttribute('data-lib-seed-id');

async function search(text) {
  await page.fill('[data-lib-search]', text);
  await page.waitForTimeout(60);
}

async function pick(id) {
  await page.click(`[data-lib-card="${id}"]`);
  await page.waitForSelector(`[data-lib-detail="${id}"]`);
}

/* -------------------------------------------------------------------------- */

section('the catalogue');

check('the generator list has not drifted from WS-6', generatorsAgree());

const loaded = await lib();
eq('catalogue reports no problems', loaded.problems, []);

// Counts are derived, not hardcoded. The library grows every time an asset is
// imported, and a test that has to be edited for each one stops being run.
const TOTAL = loaded.entries;
const shapeCount = (await page.$$('[data-lib-card][data-lib-kind="shape"]')).length;
const assetCount = (await page.$$('[data-lib-card][data-lib-kind="asset"]')).length;

check('the catalogue is not empty', TOTAL > 0, `${TOTAL} entries`);

const all = await cardIds();
eq('all entries are on the grid', all.length, TOTAL);
check(
  'both kinds are present',
  shapeCount > 0 && assetCount > 0 && shapeCount + assetCount === TOTAL,
  `shapes ${shapeCount}, assets ${assetCount}, total ${TOTAL}`,
);
eq(
  'the footer counts what is shown',
  await page.locator('[data-lib-count]').getAttribute('data-lib-count'),
  String(TOTAL),
);

/* -------------------------------------------------------------------------- */

section('thumbnails');

const images = await page.$$eval('[data-lib-grid] img', (nodes) =>
  nodes.map((node) => ({
    src: node.getAttribute('src'),
    natural: node.naturalWidth,
    complete: node.complete,
  })),
);
eq('every asset tile has an image', images.length, assetCount);
check(
  'every thumbnail resolved',
  images.every((one) => one.complete && one.natural > 0),
  JSON.stringify(images.filter((one) => !one.complete || one.natural === 0)),
);
const screenshotTile = images.find((one) => one.src.includes('img-2065'));
check(
  'a 1206x2622 screenshot loads its thumbnail, not its original',
  screenshotTile !== undefined && screenshotTile.natural === 276,
  JSON.stringify(screenshotTile),
);

/* -------------------------------------------------------------------------- */

section('search');

await search('squiggle');
eq('search by name and tag', await cardIds(), ['shape_squiggle', 'shape_squiggle_accent']);

await search('getaway');
eq('search matches a tag the name does not contain', await cardIds(), [
  'a_filmography-i98vcdfruqe-jpg',
]);

await search('track heatmap');
const twoTerms = await cardIds();
eq('two terms AND together', twoTerms.length, 2);
check(
  'both results really are the heatmap screens',
  twoTerms.every((id) => id.includes('blocks-6') || id.includes('blocks-8')),
  JSON.stringify(twoTerms),
);

await search('img_2065');
eq('a file name is searchable', (await cardIds()).length, 1);

await search('zzzz');
eq('no match shows nothing', (await cardIds()).length, 0);
check('and says so', (await page.$('[data-lib-grid] .cms-lib__empty')) !== null);

await page.click('[data-lib-search-clear]');
await page.waitForTimeout(60);
eq('clearing the search restores everything', (await cardIds()).length, TOTAL);

/* -------------------------------------------------------------------------- */

section('filters');

await page.click('[data-lib-chip="film-still"]');
await page.waitForTimeout(60);
const films = await cardIds();
eq('the category chip filters', films.length, 4);
check(
  'to that category only',
  (await page.$$eval('[data-lib-grid] [data-lib-card]', (nodes) =>
    nodes.every((node) => node.getAttribute('data-lib-category') === 'film-still'),
  )),
);

await page.click('[data-lib-chip="film-still"]');
await page.waitForTimeout(60);
eq('clicking the same chip clears it', (await cardIds()).length, TOTAL);

await page.click('[data-lib-kind-filter="shape"]');
await page.waitForTimeout(60);
eq('the kind control filters to shapes', (await cardIds()).length, shapeCount);

await page.click('[data-lib-chip="frame"]');
await page.waitForTimeout(60);
eq('category and kind compose', (await cardIds()).length, 3);

await page.click('[data-lib-chip="all"]');
await page.click('[data-lib-kind-filter="all"]');
await page.waitForTimeout(60);
eq('and reset', (await cardIds()).length, TOTAL);

/* -------------------------------------------------------------------------- */

section('shape controls redraw the preview');

await pick('shape_squiggle');
const first = { svg: await stageSvg(), seed: await stageSeedId() };
check('the squiggle drew something', first.svg.includes('<path'), first.svg.slice(0, 80));
check('in the default ink', first.svg.includes('#111111'));

await page.click('[data-lib-swatch="color:accent"]');
await page.waitForTimeout(40);
const coloured = await stageSvg();
check('the colour control redraws it', coloured !== first.svg);
check('in the colour picked', coloured.includes('#ff5722'), coloured.slice(0, 140));
check('and nothing else moved', (await stageSeedId()) === first.seed);

await page.fill('[data-lib-hex="color"]', '#5cb98a');
await page.waitForTimeout(40);
check('the hex field redraws it too', (await stageSvg()).includes('#5cb98a'));
await page.click('[data-lib-swatch="color:accent"]');
await page.waitForTimeout(40);

await page.locator('[data-lib-stroke]').fill('6');
await page.waitForTimeout(40);
const thick = await stageSvg();
check('the stroke control redraws it', thick.includes('stroke-width="6"'), thick.slice(0, 180));

await page.click('[data-lib-seed-next]');
await page.waitForTimeout(40);
const stepped = { svg: await stageSvg(), seed: await stageSeedId() };
check('the seed control changes the item id', stepped.seed !== first.seed, `${first.seed} -> ${stepped.seed}`);
check('and redraws a different squiggle', stepped.svg !== thick);
check('keeping the colour and stroke', stepped.svg.includes('#ff5722') && stepped.svg.includes('stroke-width="6"'));

await page.click('[data-lib-seed-prev]');
await page.waitForTimeout(40);
eq('the back arrow returns to the drawing it came from', await stageSvg(), thick);
eq('and to the same id', await stageSeedId(), first.seed);

await page.click('[data-lib-seed-next]');
await page.waitForTimeout(40);
const chosen = { svg: await stageSvg(), seed: await stageSeedId() };

/* -------------------------------------------------------------------------- */

section('insertion');

await page.click('[data-lib-insert="shape_squiggle"]');
await page.waitForTimeout(60);
let state = await lib();
eq('one item was emitted', state.inserted.length, 1);
const shapeItem = state.inserted[0];
eq('it validates against CanvasItemSchema', state.errors[0], []);
eq('kind', shapeItem.kind, 'shape');
eq('generator', shapeItem.shape, 'squiggle');
eq('the colour that was picked', shapeItem.color, '#ff5722');
eq('the stroke that was set', shapeItem.strokeWidth, 6);
eq('the id whose drawing was on screen', shapeItem.id, chosen.seed);
eq('the preset box', { w: shapeItem.w, h: shapeItem.h }, { w: 340, h: 72 });
eq('centred across the reference width', shapeItem.x, Math.round((1344 - 340) / 2));
check('no media keys on a shape', shapeItem.src === undefined && shapeItem.alt === undefined);

await page.click('[data-lib-insert="shape_squiggle"]');
await page.waitForTimeout(60);
state = await lib();
eq('a second item was emitted', state.inserted.length, 2);
check(
  'two inserts never share an id',
  state.inserted[0].id !== state.inserted[1].id,
  `${state.inserted[0].id} vs ${state.inserted[1].id}`,
);
eq('and the preview followed what went in', await stageSeedId(), state.inserted[1].id);

/* a tall asset */
await page.click('[data-lib-kind-filter="asset"]');
await page.waitForTimeout(60);
await pick('a_projects-track-daily-habit-tracker-img-2065-png');
await page.click('[data-lib-insert="a_projects-track-daily-habit-tracker-img-2065-png"]');
await page.waitForTimeout(60);
state = await lib();
const tall = state.inserted[2];
eq('a tall asset validates', state.errors[2], []);
eq('kind', tall.kind, 'image');
eq('src', tall.src, '/projects/track-daily-habit-tracker/IMG_2065.png');
eq('alt comes from the curated name', tall.alt, 'Track, welcome screen alt');
check(
  'never at its native pixel size',
  tall.w < 1206 && tall.h < 2622,
  `${tall.w}x${tall.h} from 1206x2622`,
);
eq('at the computed insert size', { w: tall.w, h: tall.h }, { w: 285, h: 620 });
near('aspect ratio preserved', tall.w / tall.h, 1206 / 2622, 0.004);
check('a sane fraction of the reference width', tall.w / 1344 < 0.3 && tall.w > 100);
eq('centred', tall.x, Math.round((1344 - 285) / 2));

/* a wide asset */
await pick('a_home-hero-webp');
await page.click('[data-lib-insert="a_home-hero-webp"]');
await page.waitForTimeout(60);
state = await lib();
const wide = state.inserted[3];
eq('a wide asset validates', state.errors[3], []);
eq('at the computed insert size', { w: wide.w, h: wide.h }, { w: 618, h: 379 });
near('aspect ratio preserved', wide.w / wide.h, 2688 / 1648, 0.004);
check(
  'never at its native pixel size',
  wide.w < 2688,
  `${wide.w}x${wide.h} from 2688x1648`,
);
near('a sane fraction of the reference width', wide.w / 1344, 0.46, 0.01);

/* double-click a tile */
await page.click('[data-lib-kind-filter="all"]');
await page.waitForTimeout(60);
await page.dblclick('[data-lib-card="shape_rect_tint"]');
await page.waitForTimeout(80);
state = await lib();
eq('double-clicking a tile inserts it', state.inserted.length, 5);
const tinted = state.inserted[4];
eq('a preset from the catalogue JSON validates', state.errors[4], []);
eq('with its fill', tinted.fill, '#f5a62322');
eq('and its generator', tinted.shape, 'rect');

/* -------------------------------------------------------------------------- */

section('screenshots');

await page.evaluate(() => window.__libReset());
await page.click('[data-lib-card="shape_squiggle_accent"]');
await page.waitForTimeout(120);
await page.screenshot({ path: join(SHOTS, 'library-shape.png') });

await page.click('[data-lib-card="a_home-hero-webp"]');
await page.waitForTimeout(120);
await page.screenshot({ path: join(SHOTS, 'library-asset.png') });

await search('track');
await page.waitForTimeout(120);
await page.screenshot({ path: join(SHOTS, 'library-search.png') });
process.stdout.write(`    wrote 3 shots to ${SHOTS}\n`);

/* -------------------------------------------------------------------------- */

section('the console');
eq('nothing was logged as an error', consoleErrors, []);
eq('nothing 404ed', badResponses, []);

/* -------------------------------------------------------------------------- */

await browser.close();
await server.close();

process.stdout.write(`\n  ${passed} checks passed, ${failures.length} failed\n`);
for (const failure of failures) process.stdout.write(`\n  FAIL  ${failure}\n`);
process.exit(failures.length === 0 ? 0 : 1);
