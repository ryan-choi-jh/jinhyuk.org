/**
 * src/cms/app/guide/harness/run.mjs
 *
 * Builds the guide harness, serves it on 127.0.0.1, drives it in headless
 * Google Chrome at 1600x1000, asserts the behaviour, and leaves screenshots
 * in harness/.out/shots/.
 *
 *   node src/cms/app/guide/harness/run.mjs
 *
 * Exits non-zero on any failed assertion, so it is a check and not only a
 * picture. What it proves:
 *
 *   - a first visit opens the panel by itself;
 *   - Escape, the backdrop and the Close button all close it;
 *   - the button reopens it;
 *   - a second visit in the same browser does NOT open it;
 *   - with localStorage throwing on every access, the panel still opens,
 *     still closes, and reports that it cannot remember;
 *   - editing the guide in <GuideEditor> lands in the preview AND in the
 *     live overlay, reordering works, and a reset puts the defaults back;
 *   - the content survives JSON and the schema unchanged;
 *   - every malformed stored document falls back without throwing;
 *   - default-guide.json still matches content.ts;
 *   - the panel fits the window and the console stays clean.
 *
 * Playwright comes from the gstack install, like WS-4's browser check does,
 * and it is pointed at the Chrome already on this machine. Nothing is
 * installed into this repo.
 */

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, OUT_DIR } from './build.mjs';
import { renderDefaultJson } from '../write-default-json.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(OUT_DIR, 'shots');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORT = { width: 1600, height: 1000 };
const DEFAULT_JSON_PATH = join(here, '..', 'default-guide.json');

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
  throw new Error('playwright not found; this check needs a browser driver');
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                  */
/* -------------------------------------------------------------------------- */

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    process.stdout.write(`    ok   ${label}\n`);
    return;
  }
  failures.push(detail === undefined ? label : `${label}\n      ${detail}`);
  process.stdout.write(`    FAIL ${label}${detail === undefined ? '' : `  (${detail})`}\n`);
}

function eq(label, actual, expected) {
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(name) {
  process.stdout.write(`\n  ${name}\n`);
}

/* -------------------------------------------------------------------------- */
/* Serve                                                                       */
/* -------------------------------------------------------------------------- */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

async function serve(dir) {
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    // Chrome asks for this unprompted; a 404 would show up as a console error
    // and this check treats console errors as failures.
    if (path === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    const file = join(dir, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
    if (!file.startsWith(dir) || !existsSync(file)) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    response.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

/* -------------------------------------------------------------------------- */

if (!existsSync(CHROME)) {
  process.stderr.write(`no Chrome at ${CHROME}\n`);
  process.exit(2);
}

process.stdout.write('\nCMS guide, headless Chrome, 1600x1000\n');

section('the default content file');
{
  const rendered = await renderDefaultJson();
  const onDisk = existsSync(DEFAULT_JSON_PATH) ? readFileSync(DEFAULT_JSON_PATH, 'utf8') : '';
  check('default-guide.json matches content.ts', onDisk === rendered,
    'run: node src/cms/app/guide/write-default-json.mjs');
}
const DEFAULTS_JSON = JSON.stringify(JSON.parse(readFileSync(DEFAULT_JSON_PATH, 'utf8')));
/** The cards the editor starts from, so counts below follow the content. */
const SHIPPED_CARDS = JSON.parse(DEFAULTS_JSON).cards;

const { chromium } = loadPlaywright();
await build();
mkdirSync(SHOTS, { recursive: true });
const { server, url } = await serve(OUT_DIR);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

/** A fresh profile per case: a first visit has to actually be a first visit. */
async function openContext({ breakStorage = false, viewport = VIEWPORT } = {}) {
  const context = await browser.newContext({ viewport });
  if (breakStorage) {
    // What a private window with site data blocked does: the getter itself
    // throws, before any read or write is attempted.
    await context.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('denied by the harness', 'SecurityError');
        },
      });
    });
  }
  const page = await context.newPage();
  const noise = [];
  page.on('console', (message) => {
    if (message.type() === 'error') noise.push(message.text());
  });
  page.on('pageerror', (error) => noise.push(String(error)));
  return { context, page, noise };
}

const state = (page) => page.evaluate(() => window.__guide);
const visible = (page) => page.locator('[data-testid="guide"]').isVisible();

/**
 * Wait out the open animation before a screenshot. Without this the shot
 * catches the panel part way through its fade and everything behind it shows
 * through, which looks like a bug in the panel and is not one.
 */
async function settled(page) {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
}

/** The card headings the preview is currently drawing, in order. */
const previewTitles = (page) =>
  page.$$eval('[data-testid="guide-preview"] .cms-guide-card__title', (nodes) =>
    nodes.map((node) => node.textContent),
  );

const overlayTitles = (page) =>
  page.$$eval('[data-testid="guide"] .cms-guide-card__title', (nodes) =>
    nodes.map((node) => node.textContent),
  );

/* -------------------------------------------------------------------------- */

section('first visit');
{
  const { context, page, noise } = await openContext();
  await page.goto(url);
  await page.waitForSelector('[data-testid="guide"]', { timeout: 10_000 });

  check('the panel opens by itself', await visible(page));
  eq('it is not yet marked seen', (await state(page)).flag, 'unset');
  await settled(page);
  await page.screenshot({ path: join(SHOTS, '01-first-visit.png') });

  /* Every card made it in, and the words that matter are on screen. */
  const text = await page.locator('[data-testid="guide"]').innerText();
  // The section list and the document-vs-record explainer were removed from
  // the guide: the left-hand nav already shows the five sections, and which
  // editor an entry opens in is apparent the moment you open one. So the
  // words those two cards owned ('Filmography', 'record' and the rest) are
  // deliberately not asserted here any more.
  for (const phrase of [
    'document', 'Prose band', 'Canvas band', 'Overlay',
    '15 degrees', 'ratio', 'Nudge', 'guides', 'draft', 'Publish', 'Preview', '390',
  ]) {
    check(`the copy covers "${phrase}"`, text.includes(phrase));
  }

  /* It must fit: no card clipped off the bottom of the window. */
  const box = await page.locator('[data-testid="guide"]').boundingBox();
  check('the panel is inside the window', box.y >= 0 && box.y + box.height <= VIEWPORT.height + 1,
    `y=${Math.round(box.y)} h=${Math.round(box.height)}`);
  check('the panel is wide enough to read', box.width >= 900, `w=${Math.round(box.width)}`);
  const overflow = await page.evaluate(() => {
    const body = document.querySelector('[data-testid="guide"] [data-testid="guide-body"]');
    return { scroll: body.scrollHeight, client: body.clientHeight };
  });
  check('every card fits without scrolling at this size',
    overflow.scroll <= overflow.client + 1, `${overflow.scroll} > ${overflow.client}`);

  /* Escape. */
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="guide"]', { state: 'detached' });
  check('Escape closes it', !(await page.locator('[data-testid="guide"]').count()));
  eq('closing marks it seen', (await state(page)).flag, 'set');
  eq('and it says it remembered', (await state(page)).remembered, true);

  /* The button reopens. */
  await page.locator('[data-testid="guide-button"]').click();
  await page.waitForSelector('[data-testid="guide"]');
  check('the top-bar button reopens it', await visible(page));
  await settled(page);
  await page.screenshot({ path: join(SHOTS, '02-reopened-from-button.png') });

  /* The backdrop. */
  await page.mouse.click(20, 20);
  await page.waitForSelector('[data-testid="guide"]', { state: 'detached' });
  check('a click on the backdrop closes it', !(await page.locator('[data-testid="guide"]').count()));
  await page.screenshot({ path: join(SHOTS, '03-closed.png') });

  /* The footer button. */
  await page.locator('[data-testid="guide-button"]').click();
  await page.locator('[data-testid="guide-done"]').click();
  await page.waitForSelector('[data-testid="guide"]', { state: 'detached' });
  check('the Close button closes it', !(await page.locator('[data-testid="guide"]').count()));

  /* The × in the header. */
  await page.locator('[data-testid="guide-button"]').click();
  await page.locator('[data-testid="guide-close"]').click();
  await page.waitForSelector('[data-testid="guide"]', { state: 'detached' });
  check('the header × closes it', !(await page.locator('[data-testid="guide"]').count()));

  /* A click inside must NOT close it. */
  await page.locator('[data-testid="guide-button"]').click();
  await page.locator('[data-testid="guide"] [data-testid="guide-card-bands"]').click();
  check('a click inside the panel leaves it open', await visible(page));
  await page.keyboard.press('Escape');

  /* The hint. */
  await page.locator('[data-testid="guide-button"]').hover();
  await page.waitForSelector('[data-testid="hint-bubble"]');
  check('the Hint wrapper shows on hover', await page.locator('[data-testid="hint-bubble"]').isVisible());
  await page.screenshot({ path: join(SHOTS, '04-hint.png') });

  check('no console errors', noise.length === 0, noise.join(' | '));
  await context.close();
}

section('a narrower window');
{
  const { context, page } = await openContext({ viewport: { width: 900, height: 800 } });
  await page.goto(url);
  await page.waitForSelector('[data-testid="guide"]');
  await settled(page);
  const box = await page.locator('[data-testid="guide"]').boundingBox();
  check('the panel still fits a 900x800 window', box.y >= 0 && box.y + box.height <= 801,
    `y=${Math.round(box.y)} h=${Math.round(box.height)}`);
  const columns = await page.evaluate(() =>
    getComputedStyle(document.querySelector('[data-testid="guide"] [data-testid="guide-body"]')).columnCount);
  eq('the container query drops it to two columns', columns, '2');
  await page.screenshot({ path: join(SHOTS, '06-narrow.png') });
  await context.close();
}

section('second visit, same browser');
{
  const { context, page } = await openContext();
  await page.goto(url);
  await page.waitForSelector('[data-testid="guide"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="guide"]', { state: 'detached' });
  await page.reload();
  await page.waitForFunction(() => window.__guide !== undefined);
  await page.waitForTimeout(200);
  check('it stays shut on the next visit', !(await page.locator('[data-testid="guide"]').count()));
  eq('the flag survived the reload', (await state(page)).flag, 'set');
  check('the button still opens it', await page.locator('[data-testid="guide-button"]').isVisible());
  await context.close();
}

section('localStorage throws on every access');
{
  const { context, page, noise } = await openContext({ breakStorage: true });
  await page.goto(url);
  await page.waitForSelector('[data-testid="guide"]', { timeout: 10_000 });

  check('the panel still opens', await visible(page));
  const now = await state(page);
  eq('storage reports unavailable', now.flag, 'unavailable');
  eq('and the guide knows it cannot remember', now.remembered, false);
  await settled(page);
  await page.screenshot({ path: join(SHOTS, '05-no-storage.png') });

  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="guide"]', { state: 'detached' });
  check('Escape still closes it', !(await page.locator('[data-testid="guide"]').count()));
  await page.locator('[data-testid="guide-button"]').click();
  await page.waitForSelector('[data-testid="guide"]');
  check('the button still works', await visible(page));
  check('no console errors', noise.length === 0, noise.join(' | '));
  await context.close();
}

section('site data cleared between visits');
{
  const { context, page } = await openContext();
  await page.goto(url);
  await page.waitForSelector('[data-testid="guide"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="guide"]', { state: 'detached' });
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await page.waitForSelector('[data-testid="guide"]', { timeout: 10_000 });
  check('a cleared browser is treated as a first visit', await visible(page));
  await context.close();
}

/* -------------------------------------------------------------------------- */
/* The editor                                                                  */
/* -------------------------------------------------------------------------- */

section('editing the guide');
{
  const { context, page, noise } = await openContext();
  await page.goto(url);
  await page.waitForSelector('[data-testid="guide-editor"]');
  await page.keyboard.press('Escape'); // get the first-visit panel out of the way
  await page.waitForSelector('[data-testid="guide"]', { state: 'detached' });

  check('the editor mounts', await page.locator('[data-testid="ge-form"]').isVisible());
  check('and shows a live preview', await page.locator('[data-testid="guide-preview"]').isVisible());
  // Counted from the shipped content, not written in: cards get added and
  // removed as the guide is edited, and a hardcoded 6 turns every such edit
  // into a red harness for no reason.
  const shipped = SHIPPED_CARDS.length;
  const before = await previewTitles(page);
  eq('the preview draws every card', before.length, shipped);
  eq('starting with the shipped first card', before[0], SHIPPED_CARDS[0].title);

  /* A card heading. */
  await page.fill('[data-testid="ge-card-title-0"]', 'Where everything lives');
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="guide-preview"] .cms-guide-card__title').textContent ===
    'Where everything lives');
  check('editing a card heading updates the preview', true);

  /* The same edit must be in the real overlay, not only the preview. */
  await page.locator('[data-testid="guide-button"]').click();
  await page.waitForSelector('[data-testid="guide"]');
  eq('and the live overlay shows it too', (await overlayTitles(page))[0], 'Where everything lives');
  await settled(page);
  await page.screenshot({ path: join(SHOTS, '09-editor-with-overlay.png') });
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="guide"]', { state: 'detached' });

  /* The panel title and lead. */
  await page.fill('[data-testid="ge-title"]', 'Using this CMS');
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="guide-preview"] [data-testid="guide-title"]').textContent ===
    'Using this CMS');
  check('editing the title updates the preview', true);

  /* Reordering cards. */
  await page.locator('[data-testid="ge-card-down-0"]').click();
  const afterMove = await previewTitles(page);
  // The card that was second in the shipped content, whatever it is called.
  eq('moving a card down reorders the preview', afterMove[0], SHIPPED_CARDS[1].title);
  eq('and the moved card lands second', afterMove[1], 'Where everything lives');
  await page.locator('[data-testid="ge-card-up-1"]').click();
  eq('moving it back restores the order', (await previewTitles(page))[0], 'Where everything lives');

  /* Reordering rows. */
  const rowTerms = () =>
    page.$$eval('[data-testid="guide-preview"] .cms-guide-card:first-child .cms-guide-rows__term', (nodes) =>
      nodes.map((node) => node.textContent));
  const firstRows = await rowTerms();
  await page.locator('[data-testid="ge-row-down-0-0"]').click();
  const movedRows = await rowTerms();
  eq('moving a row down swaps it with the next', movedRows[0], firstRows[1]);
  eq('and the first row lands second', movedRows[1], firstRows[0]);
  await page.locator('[data-testid="ge-row-up-0-1"]').click();
  eq('moving it back restores the rows', (await rowTerms())[0], firstRows[0]);

  /* Key caps, per row. */
  const isKeyCap = () =>
    page.$eval('[data-testid="guide-preview"] .cms-guide-card:first-child .cms-guide-rows__term', (node) =>
      node.classList.contains('cms-guide-rows__term--key'));
  check('a row starts as plain text', !(await isKeyCap()));
  await page.locator('[data-testid="ge-row-key-0-0"]').click();
  check('the key-cap toggle makes it a key cap', await isKeyCap());
  await page.locator('[data-testid="ge-row-key-0-0"]').click();
  check('and toggles back', !(await isKeyCap()));

  /* Rows: add and remove. */
  const rowCount = async () => (await rowTerms()).length;
  const rowsBefore = await rowCount();
  await page.locator('[data-testid="ge-add-row-0"]').click();
  eq('+ row adds one', await rowCount(), rowsBefore + 1);
  await page.locator(`[data-testid="ge-row-remove-0-${rowsBefore}"]`).click();
  eq('and deleting it takes it away again', await rowCount(), rowsBefore);

  /* Cards: add and remove. */
  await page.locator('[data-testid="ge-add-card"]').click();
  eq('+ card adds one', (await previewTitles(page)).length, shipped + 1);
  eq('with a placeholder heading', (await previewTitles(page))[shipped], 'New card');
  await page.locator(`[data-testid="ge-card-remove-${shipped}"]`).click();
  eq('and deleting it takes it away again', (await previewTitles(page)).length, shipped);

  /* Blurb and footnote. */
  await page.fill('[data-testid="ge-card-lead-0"]', 'A blurb under the heading.');
  await page.fill('[data-testid="ge-card-note-0"]', 'A footnote under the rows.');
  const cardText = await page.locator('[data-testid="guide-preview"] .cms-guide-card').first().innerText();
  check('the blurb reaches the preview', cardText.includes('A blurb under the heading.'));
  check('the footnote reaches the preview', cardText.includes('A footnote under the rows.'));

  /* Emptying an optional field drops it rather than storing "". */
  await page.fill('[data-testid="ge-card-note-0"]', '');
  const hasNote = await page.evaluate(() => 'note' in window.__guide.content.cards[0]);
  check('clearing the footnote removes the key', !hasNote);

  /* The round trip. */
  const trip = await page.evaluate(() => window.__guideApi.roundTrip());
  check('the edited content is still valid', trip.ok, trip.issues.join(' | '));
  check('and survives JSON unchanged', trip.same, trip.diff);

  /* Validation is advisory, not a wall. */
  await page.fill('[data-testid="ge-row-term-0-0"]', '');
  await page.waitForSelector('[data-testid="ge-issues"]');
  check('an empty term is reported, not refused',
    (await page.locator('[data-testid="ge-issues"]').innerText()).includes('term'));
  await page.fill('[data-testid="ge-row-term-0-0"]', 'Home');
  await page.waitForSelector('[data-testid="ge-issues"]', { state: 'detached' });
  check('and the warning clears when it is fixed', true);

  /* Reset. */
  await page.locator('[data-testid="ge-reset"]').click();
  check('reset arms on the first press',
    (await page.locator('[data-testid="ge-reset"]').innerText()).includes('Sure'));
  await page.locator('[data-testid="ge-reset"]').click();
  const json = await page.evaluate(() => window.__guide.json);
  check('and the second press puts the shipped guide back', json === DEFAULTS_JSON,
    `${json.slice(0, 80)}…`);

  await settled(page);
  await page.screenshot({ path: join(SHOTS, '07-editor.png') });
  check('no console errors', noise.length === 0, noise.join(' | '));
  await context.close();
}

section('a malformed stored guide');
{
  const { context, page, noise } = await openContext();
  await page.goto(url);
  await page.waitForFunction(() => window.__guideApi !== undefined);
  await page.keyboard.press('Escape');

  const probe = (raw) => page.evaluate((value) => window.__guideApi.probe(value), raw);

  const bad = [
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['truncated JSON', '{"version":1,'],
    ['a number', 42],
    ['an array', [{ id: 'a' }]],
    ['the wrong version', { version: 2, title: 'T', lead: '', cards: [] }],
    ['no cards', { version: 1, title: 'T', lead: '', cards: [] }],
    ['an empty title', { version: 1, title: '', lead: '', cards: [{ id: 'a', title: 'A', rows: [] }] }],
    ['an unknown key', { version: 1, title: 'T', lead: '', cards: [], colour: 'red' }],
    ['a card with no id', { version: 1, title: 'T', lead: '', cards: [{ title: 'A', rows: [] }] }],
    ['a duplicate card id', {
      version: 1, title: 'T', lead: '',
      cards: [{ id: 'a', title: 'A', rows: [] }, { id: 'a', title: 'B', rows: [] }],
    }],
    ['a row with no term', {
      version: 1, title: 'T', lead: '',
      cards: [{ id: 'a', title: 'A', rows: [{ text: 'x' }] }],
    }],
  ];

  for (const [label, value] of bad) {
    const result = await probe(value);
    check(`${label} falls back without throwing`,
      result.threw === false && result.fellBack === true && result.title === 'How this works',
      JSON.stringify(result));
  }

  const nothingStored = await probe(null);
  eq('nothing stored is not reported as an error', nothingStored.issues, 0);
  const broken = await probe('{"version":1,');
  check('a broken file does report why', broken.issues > 0);

  /* And the good cases. */
  const minimal = await probe({
    version: 1,
    title: 'Mine',
    lead: '',
    cards: [{ id: 'one', title: 'A card', rows: [{ term: 'drag', text: 'Move it.', key: true }] }],
  });
  check('a minimal valid guide is used as is',
    minimal.threw === false && minimal.fellBack === false && minimal.title === 'Mine',
    JSON.stringify(minimal));

  const asJson = await probe(JSON.stringify(JSON.parse(readFileSync(DEFAULT_JSON_PATH, 'utf8'))));
  check('and default-guide.json validates as stored content',
    asJson.fellBack === false && asJson.title === 'How this works', JSON.stringify(asJson));

  check('no console errors', noise.length === 0, noise.join(' | '));
  await context.close();
}

/* -------------------------------------------------------------------------- */

await browser.close();
server.close();

process.stdout.write(`\n  ${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`    - ${failure}\n`);
}
process.stdout.write(`  shots: ${SHOTS}\n\n`);
process.exit(failures.length === 0 ? 0 : 1);
