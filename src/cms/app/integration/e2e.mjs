/**
 * src/cms/app/integration/e2e.mjs
 *
 * WS-8's end-to-end proof: the real editor, in a real browser, against a real
 * GitHub branch that is created and deleted by this script.
 *
 *   node src/cms/app/integration/e2e.mjs
 *   E2E_KEEP_BRANCH=1 node src/cms/app/integration/e2e.mjs   # leave it, to look at
 *   E2E_HEADED=1 node src/cms/app/integration/e2e.mjs        # watch it happen
 *
 * NEVER MAIN. The branch is `cms/ws-8-e2e-<timestamp>`, created from main's
 * head, and deleted in a `finally`. Nothing in this script writes to main;
 * main is read once, for a commit sha.
 *
 * What it does, in order, which is also the list the brief asks to be honest
 * about:
 *
 *   1. create the throwaway branch
 *   2. seed a published page on it (the canvas fixture, re-slugged) so there
 *      is something to load
 *   3. start `astro dev` with CMS_BRANCH and CMS_DEV_TOKEN pointed at it
 *   4. open /cms/ws8-e2e and check WS-4's canvas and WS-5's prose really
 *      mounted into WS-3's slots, and that WS-6 drew the shapes
 *   5. type into a paragraph
 *   6. drag an image with the mouse
 *   7. insert a squiggle from the asset picker
 *   8. drop a PNG onto the canvas, which uploads through WS-2
 *   9. Save, then read the draft back out of GitHub and assert all four edits
 *      are in the committed JSON
 *  10. open WS-7's preview of that draft
 *  11. screenshot the editor and the preview
 *  12. delete the branch
 *
 * The strongest assertions are the ones made against the file in the
 * repository rather than against the DOM: a save that does not land is the
 * failure this is for.
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  contentPathFor,
  draftPathFor,
  mediaDirFor,
  mediaUrlFor,
  requireSection,
} from '../../sections.ts';

const REPO = 'ryan-choi-jh/jinhyuk.org';
const SLUG = 'ws8-e2e';

/**
 * Where this page's files live, asked of the registry rather than written out.
 *
 * They used to be written out, as `src/content/pages/<slug>.json` and
 * `src/content/drafts/<slug>.json` and `public/media/<slug>/`. Those were
 * phase 1's paths. Phase 2 moved them — a bare slug resolves through
 * `LEGACY_SECTION_ID` to the projects section, so it is
 * `src/content/pages/projects/<slug>.json` now, with media under
 * `public/media/projects/<slug>/` — and this file was not updated. It
 * therefore seeded a page the server would never look for, and then waited a
 * minute for an editor with nothing to open. It had been failing that way
 * since the cutover and nobody noticed, because nobody runs a check that
 * takes two minutes and creates a branch.
 *
 * Asking the registry is the part that stops it happening again.
 */
const SECTION = requireSection('projects');
const PAGE_PATH = contentPathFor(SECTION, SLUG);
const DRAFT_PATH = draftPathFor(SECTION, SLUG);
const MEDIA_DIR = mediaDirFor(SECTION, SLUG);
const MEDIA_URL = mediaUrlFor(SECTION, SLUG);
const BASE_BRANCH = 'main';
const PORT = Number(process.env.E2E_PORT ?? 4331);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUT_DIR = process.env.E2E_OUT ?? fileURLToPath(new URL('.out', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/* Checks                                                                      */
/* -------------------------------------------------------------------------- */

let total = 0;
let failures = 0;
const results = [];

function check(label, ok, detail = '') {
  total += 1;
  if (!ok) failures += 1;
  results.push({ label, ok, detail });
  console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : ` (${detail})`}`);
  return ok;
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  return check(label, a === b, a === b ? b : `got ${a}, wanted ${b}`);
}

function step(name) {
  console.log(`\n  ${name}`);
}

/* -------------------------------------------------------------------------- */
/* GitHub                                                                      */
/* -------------------------------------------------------------------------- */

function githubToken() {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.CMS_DEV_TOKEN;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('no GitHub token: set GITHUB_TOKEN or sign in with `gh auth login`');
  }
}

const token = githubToken();

async function gh(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jinhyuk-cms-ws8-e2e',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text === '' ? {} : JSON.parse(text);
  if (!response.ok) {
    throw new Error(`GitHub ${init.method ?? 'GET'} ${path} -> ${response.status}: ${body.message ?? text}`);
  }
  return body;
}

async function fileOnBranch(path, branch) {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${path}?ref=${encodeURIComponent(branch)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'jinhyuk-cms-ws8-e2e',
      },
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub contents ${path} -> ${response.status}`);
  const body = await response.json();
  return { sha: body.sha, text: Buffer.from(body.content, 'base64').toString('utf8') };
}

/* -------------------------------------------------------------------------- */
/* A real PNG, so WS-2 parses real intrinsic dimensions                        */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real, decodable PNG of exactly `width` x `height`, in one flat colour. */
function makePng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Playwright, borrowed rather than installed                                  */
/* -------------------------------------------------------------------------- */

function loadPlaywright() {
  const hosts = [
    '/Users/ryanchoi/.claude/skills/gstack/package.json',
    join(REPO_ROOT, 'package.json'),
  ];
  for (const host of hosts) {
    try {
      return createRequire(host)('playwright');
    } catch {
      /* next */
    }
  }
  throw new Error('playwright not found; this check needs a browser');
}

/* -------------------------------------------------------------------------- */
/* The dev server                                                              */
/* -------------------------------------------------------------------------- */

async function startDevServer(branch) {
  const child = spawn(
    'npm',
    ['run', 'dev', '--', '--port', String(PORT), '--host', '127.0.0.1'],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CMS_DEV_TOKEN: token,
        CMS_BRANCH: branch,
        // The preview must read GitHub, not the working tree, or it would show
        // a draft this run never wrote.
        CMS_PREVIEW_LOCAL_DIR: '',
        BROWSER: 'none',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let log = '';
  child.stdout.on('data', (chunk) => {
    log += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    log += String(chunk);
  });

  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`astro dev exited with ${child.exitCode}:\n${log.slice(-4000)}`);
    }
    try {
      const response = await fetch(`${ORIGIN}/api/cms/auth/status`);
      if (response.ok) {
        const body = await response.json();
        if (body.branch === branch) return { child, log: () => log };
      }
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  throw new Error(`astro dev never answered on ${ORIGIN}:\n${log.slice(-4000)}`);
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

const branch = `cms/ws-8-e2e-${Date.now()}`;
let branchCreated = false;
let server = null;
/** Hoisted so a failure can print what the browser complained about. */
const consoleErrors = [];
let browser = null;

mkdirSync(OUT_DIR, { recursive: true });

try {
  step(`1. throwaway branch ${branch}`);
  const baseRef = await gh(`/repos/${REPO}/git/ref/heads/${BASE_BRANCH}`);
  const baseSha = baseRef.object.sha;
  await gh(`/repos/${REPO}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });
  branchCreated = true;
  check('branch created from main', true, `${branch} at ${baseSha.slice(0, 7)}`);
  check('main is only ever read', BASE_BRANCH === 'main' && branch !== 'main');

  step('2. seed a published page on it');
  // WS-0's canvas fixture, re-slugged: prose plus one canvas band holding two
  // images and a squiggle, which is exactly the shape this run needs to edit.
  const fixture = JSON.parse(
    readFileSync(new URL('../../fixtures/canvas.json', import.meta.url), 'utf8'),
  );
  fixture.meta.slug = SLUG;
  fixture.meta.title = 'WS-8 end to end';
  const seeded = `${JSON.stringify(fixture, null, 2)}\n`;
  await gh(`/repos/${REPO}/contents/${PAGE_PATH}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `WS-8 e2e: seed ${SLUG}`,
      content: Buffer.from(seeded, 'utf8').toString('base64'),
      branch,
    }),
  });
  check('a published page exists to load', true, PAGE_PATH);

  step('3. astro dev against that branch');
  server = await startDevServer(branch);
  const status = await (await fetch(`${ORIGIN}/api/cms/auth/status`)).json();
  eq('the API is signed in', status.signedIn, true);
  eq('…and pointed at the throwaway branch', status.branch, branch);

  step('4. open /cms/<slug> and check every workstream mounted');
  const { chromium } = loadPlaywright();
  browser = await chromium.launch({ headless: process.env.E2E_HEADED !== '1' });
  const context = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
  // The guide opens itself on a FIRST VISIT, and every run here is a first
  // visit: a fresh browser context has empty localStorage. Its backdrop is
  // `position: fixed; inset: 0; z-index: 200`, so it swallows every click
  // that follows and the run dies on a 30-second timeout with no clue why.
  // Measured: with this flag seeded, the identical click works.
  await context.addInitScript(() => {
    try {
      localStorage.setItem('jinhyuk-cms.guide-seen.v1', '1');
    } catch {
      /* a context with no storage never shows it either */
    }
  });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  await page.goto(`${ORIGIN}/cms/${SLUG}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="cms-root"]', { timeout: 60_000 });
  check('the editor shell rendered', true);
  eq('the toolbar shows the page title', await page.textContent('[data-testid="toolbar-title"]'), 'WS-8 end to end');

  await page.waitForSelector('.pe-content', { timeout: 30_000 });
  const proseCount = await page.locator('.pe-content').count();
  check('WS-5 prose editors are mounted in the prose slots', proseCount >= 4, `${proseCount} blocks`);

  await page.waitForSelector('[data-cv-stage]', { timeout: 30_000 });
  const stages = await page.locator('[data-cv-stage]').count();
  check('WS-4 canvas editors are mounted in the canvas slots', stages >= 1, `${stages} stages`);

  const squigglePath = await page.getAttribute('[data-cv-item="i_canvas_sq"] svg path', 'd');
  check(
    'WS-6 drew the shape (a real generated path, not the fallback)',
    typeof squigglePath === 'string' && squigglePath.length > 200,
    `${(squigglePath ?? '').length} chars of path data`,
  );

  // `authStatus()` checks the token against GitHub, so this resolves a
  // moment after the page is up rather than with it.
  //
  // The SITE BAR, not `auth-chip`. That chip belongs to phase 1's
  // single-page toolbar, which `/cms/<slug>` no longer reaches: the URL
  // redirects to `/cms/projects/<slug>` and mounts the whole-site app, whose
  // toolbar shows an auth chip only when signed OUT, because the site bar
  // above it already says who you are. Waiting for a signed-in `auth-chip`
  // was therefore waiting for an element that appears only when the thing it
  // is asserting is false.
  await page.waitForSelector('[data-testid="site-auth"]', { timeout: 30_000 });
  const who = (await page.textContent('[data-testid="site-auth"]')) ?? '';
  check('the site bar resolves to signed in', who.includes('signed in'), who);

  const imagesLoaded = await page.evaluate(() =>
    [...document.querySelectorAll('[data-cv-stage] img')].map((img) => ({
      src: img.getAttribute('src'),
      ok: img.complete && img.naturalWidth > 0,
    })),
  );
  check(
    'the fixture images render on the canvas',
    imagesLoaded.length > 0 && imagesLoaded.every((entry) => entry.ok),
    `${imagesLoaded.filter((e) => e.ok).length}/${imagesLoaded.length} loaded`,
  );

  await page.screenshot({ path: join(OUT_DIR, '01-loaded.png'), fullPage: false });

  step('5. type into a paragraph');
  const sentence = ' WS-8 typed this through TipTap.';
  await page.click('[data-testid="surface-block-p_canvas_intro"] .pe-content');
  await page.keyboard.press('End');
  await page.keyboard.type(sentence, { delay: 8 });
  const typed = await page.textContent('[data-testid="surface-block-p_canvas_intro"] .pe-content');
  check('the paragraph now ends with what was typed', (typed ?? '').includes(sentence.trim()));
  eq('the document is dirty', await page.getAttribute('[data-testid="dirty"]', 'class'), 'cms-dirty cms-dirty--dirty');

  // WS-5's toolbar is a selection toolbar: it appears for a range, or for an
  // empty block. So select the sentence that was just typed, which is also how
  // a person would reach for bold.
  await page.keyboard.down('Shift');
  for (let i = 0; i < sentence.trim().length; i += 1) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await page.waitForSelector('[data-prose-toolbar="p_canvas_intro"]', { timeout: 10_000 });
  check('WS-5’s floating toolbar is portalled over the scaled page', true);
  const toolbarBox = await page.locator('[data-prose-toolbar="p_canvas_intro"]').boundingBox();
  const blockBox = await page.locator('[data-testid="surface-block-p_canvas_intro"]').boundingBox();
  check(
    '…and lands over the block it belongs to, at 1:1 despite the page scale',
    toolbarBox !== null &&
      blockBox !== null &&
      toolbarBox.x + toolbarBox.width > blockBox.x &&
      toolbarBox.x < blockBox.x + blockBox.width,
    toolbarBox === null ? 'no box' : `toolbar at ${Math.round(toolbarBox.x)},${Math.round(toolbarBox.y)}`,
  );

  await page.click('[data-prose-toolbar="p_canvas_intro"] .pe-btn--bold');
  check('bold applied through the floating toolbar', true);
  await page.click('[data-testid="surface-block-p_canvas_intro"] .pe-content');
  await page.keyboard.press('End');

  step('6. drag an image with the mouse');
  const itemBefore = await page.locator('[data-cv-item="i_canvas_welcome"]').boundingBox();
  const scale = Number(await page.getAttribute('[data-testid="page-surface"]', 'data-scale'));
  check('the page surface reports a scale', Number.isFinite(scale) && scale > 0, String(scale));
  const from = { x: itemBefore.x + itemBefore.width / 2, y: itemBefore.y + itemBefore.height / 2 };
  // +180 / +40 REFERENCE px, expressed as a screen distance, which is the one
  // number this integration has to get right (seam 2).
  const to = { x: from.x + 180 * scale, y: from.y + 40 * scale };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 14; i += 1) {
    const t = i / 14;
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
  }
  await page.mouse.up();
  const movedStyle = await page.evaluate(() => {
    const element = document.querySelector('[data-cv-item="i_canvas_welcome"]');
    return { left: element.style.left, top: element.style.top };
  });
  check('the image moved on screen', movedStyle.left !== '140px', JSON.stringify(movedStyle));

  step('7. insert a squiggle from WS-6’s picker');
  const itemsBeforeInsert = await page.locator('[data-cv-stage] [data-cv-item]').count();
  // The picker lives in the inspector, under whichever canvas is selected; the
  // drag just selected an item in the canvas band, so it is already the target.
  await page.waitForSelector('[data-testid="insert-asset-toggle"]', { timeout: 10_000 });
  await page.click('[data-testid="insert-asset-toggle"]');
  await page.waitForSelector('[data-testid="insert-asset-picker"] #picker-shell', { timeout: 10_000 });
  await page.click('[data-testid="insert-asset-picker"] #picker-shell button:has-text("Insert")');
  await page.waitForFunction(
    (before) => document.querySelectorAll('[data-cv-stage] [data-cv-item]').length === before + 1,
    itemsBeforeInsert,
    { timeout: 10_000 },
  );
  check('an asset was inserted onto the canvas', true, `${itemsBeforeInsert} -> ${itemsBeforeInsert + 1} items`);

  step('8. drop a PNG onto the canvas, uploading through WS-2');
  const png = makePng(160, 90, [255, 87, 34]);
  const filename = `ws8-drop-${Date.now()}.png`;
  const dropped = await page.evaluate(
    async ({ b64, name }) => {
      const host = document.querySelector('[data-ws8-canvas]');
      if (host === null) return { ok: false, why: 'no drop host' };
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], name, { type: 'image/png' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const rect = host.getBoundingClientRect();
      const options = {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: transfer,
        clientX: rect.left + rect.width * 0.75,
        clientY: rect.top + rect.height * 0.35,
      };
      host.dispatchEvent(new DragEvent('dragenter', options));
      host.dispatchEvent(new DragEvent('dragover', options));
      host.dispatchEvent(new DragEvent('drop', options));
      return { ok: true };
    },
    { b64: png.toString('base64'), name: filename },
  );
  check('a file drop reached the canvas', dropped.ok === true, dropped.why ?? '');
  await page.waitForFunction(
    (expected) =>
      [...document.querySelectorAll('[data-cv-stage] img')].some((img) =>
        (img.getAttribute('src') ?? '').includes(expected),
      ),
    filename,
    { timeout: 60_000 },
  );
  check('the upload came back and became a canvas item', true, filename);
  const statusLine = await page.textContent('[data-testid="status-message"]');
  check(
    'the status line reports the intrinsic size WS-2 read from the file',
    (statusLine ?? '').includes('160×90'),
    statusLine ?? '',
  );
  const committedMedia = await fileOnBranch(`${MEDIA_DIR}/${filename}`, branch);
  check('the file is committed to the branch', committedMedia !== null, `${MEDIA_DIR}/${filename}`);

  await page.screenshot({ path: join(OUT_DIR, '02-edited.png') });

  step('9. Save, then read the draft back out of GitHub');
  await page.click('[data-testid="save"]');
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="status-message"]')?.textContent ?? '').includes('Draft saved'),
    undefined,
    { timeout: 60_000 },
  );
  check('the editor says the draft saved', true);
  eq(
    'the dirty indicator cleared',
    await page.getAttribute('[data-testid="dirty"]', 'class'),
    'cms-dirty',
  );

  const draftFile = await fileOnBranch(DRAFT_PATH, branch);
  if (check('the draft exists on the branch', draftFile !== null, DRAFT_PATH)) {
    const draft = JSON.parse(draftFile.text);
    const stage = draft.bands.find((band) => band.id === 'b_canvas_stage');
    const intro = draft.bands
      .flatMap((band) => band.blocks ?? [])
      .find((block) => block.id === 'p_canvas_intro');
    const introText = JSON.stringify(intro?.content ?? []);
    const image = stage.items.find((item) => item.id === 'i_canvas_welcome');
    const uploaded = stage.items.find((item) => (item.src ?? '').includes(filename));
    const newShapes = stage.items.filter(
      (item) => item.kind === 'shape' && item.id !== 'i_canvas_sq',
    );

    check('the typed sentence is in the committed JSON', introText.includes('WS-8 typed this through TipTap'));
    const boldRun = (intro?.content ?? []).find(
      (node) =>
        typeof node.text === 'string' &&
        node.text.includes('WS-8 typed this') &&
        (node.marks ?? []).some((mark) => mark.type === 'bold'),
    );
    check(
      'the bold mark applied in the toolbar is in the committed JSON',
      boldRun !== undefined,
      boldRun === undefined ? JSON.stringify((intro?.content ?? []).map((n) => n.marks ?? [])) : 'bold',
    );
    // 140 + 180 and 24 + 40, within one snap.
    //
    // The tolerance has to be the snap radius AS IT APPLIES, which is not
    // `DEFAULT_SNAP_THRESHOLD`. That 6 is in screen pixels and the caller
    // divides it by the surface's scale, so in the reference pixels this
    // assertion is written in it is 6/scale, and the middle pane draws the
    // 1344px column at roughly half size. The old tolerance of 8 was tighter
    // than the editor's own snapping and failed on a legitimate pull: the
    // image lands at 330 because its centre (330 + 280/2 = 470) snaps onto
    // i_canvas_cover's left edge, which is exactly at 470.
    const SNAP_ALLOWANCE = 14;
    check(
      'the dragged image moved by the reference px the gesture asked for',
      Math.abs(image.x - 320) <= SNAP_ALLOWANCE && Math.abs(image.y - 64) <= SNAP_ALLOWANCE,
      `x ${image.x} (was 140, wanted ~320), y ${image.y} (was 24, wanted ~64)`,
    );
    check('the inserted asset is in the committed JSON', newShapes.length === 1, JSON.stringify(newShapes.map((s) => s.shape)));
    check(
      'the dropped file is a canvas item at its intrinsic size',
      uploaded !== undefined && uploaded.w === 160 && uploaded.h === 90,
      uploaded === undefined ? 'missing' : `${uploaded.w}x${uploaded.h} at ${uploaded.x},${uploaded.y}`,
    );
    eq('…with a site-absolute src', (uploaded?.src ?? '').startsWith(`${MEDIA_URL}/`), true);
    check('the slug in the file matches the URL', draft.meta.slug === SLUG, draft.meta.slug);
    check(
      'the committed JSON is two-space with a trailing newline',
      draftFile.text.endsWith('}\n') && draftFile.text.includes('\n  "version"'),
    );

    const published = await fileOnBranch(PAGE_PATH, branch);
    check(
      'the published page is untouched by saving a draft (2.3)',
      published !== null && published.text === seeded,
    );
  }

  step('10. the preview of that draft');
  const preview = await context.newPage();
  await preview.goto(`${ORIGIN}/cms/preview/${SLUG}?v=draft`, { waitUntil: 'domcontentloaded' });
  await preview.waitForSelector('iframe', { timeout: 60_000 });
  const frame = preview.frameLocator('iframe');
  await frame.locator('body').waitFor({ timeout: 60_000 });
  const previewText = await frame.locator('body').innerText();
  check(
    'the preview shows the draft, including the sentence just typed',
    previewText.includes('WS-8 typed this through TipTap'),
  );
  const previewImages = await preview.evaluate(() => {
    const iframe = document.querySelector('iframe');
    const inner = iframe.contentDocument;
    return [...inner.querySelectorAll('img')].length;
  });
  check('the preview drew the media', previewImages > 0, `${previewImages} images`);
  await preview.screenshot({ path: join(OUT_DIR, '03-preview.png') });

  step('11. Publish, which is a copy and a delete in one commit (2.3)');
  const draftBeforePublish = await fileOnBranch(DRAFT_PATH, branch);
  await page.bringToFront();
  await page.click('[data-testid="publish"]');
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="status-message"]')?.textContent ?? '').includes('Published'),
    undefined,
    { timeout: 90_000 },
  );
  check('the editor says it published', true);
  const publishedAfter = await fileOnBranch(PAGE_PATH, branch);
  check(
    'the published page is now the draft, byte for byte',
    publishedAfter !== null && draftBeforePublish !== null &&
      publishedAfter.text === draftBeforePublish.text,
  );
  eq(
    'the draft is gone',
    await fileOnBranch(DRAFT_PATH, branch),
    null,
  );
  // And the editor can keep going: the next save must create a draft again
  // rather than try to overwrite the one publish deleted.
  await page.click('[data-testid="surface-block-p_canvas_intro"] .pe-content');
  await page.keyboard.press('End');
  await page.keyboard.type(' And again after publishing.', { delay: 5 });
  await page.click('[data-testid="save"]');
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="status-message"]')?.textContent ?? '').includes('Draft saved'),
    undefined,
    { timeout: 60_000 },
  );
  const reborn = await fileOnBranch(DRAFT_PATH, branch);
  check(
    'saving after a publish creates the draft again',
    reborn !== null && reborn.text.includes('And again after publishing'),
  );

  step('12. a slug with no page yet');
  // Phase 1 opened a blank editor here and said "No page X yet. Saving will
  // create it." Phase 2 deliberately does not: a bare slug now resolves into
  // the whole-site app, where making an entry is "+ New project" and a URL
  // for something that does not exist is a mistake to be told about rather
  // than a draft to be started. This asserts THAT, which is the behaviour
  // the application actually has.
  const fresh = await context.newPage();
  await fresh.goto(`${ORIGIN}/cms/ws8-does-not-exist`, { waitUntil: 'domcontentloaded' });
  // The placeholder appears immediately saying "Opening…", so waiting for
  // the ELEMENT is not waiting for the answer. Wait for the read to come
  // back, which is what turns it into a sentence about this slug.
  await fresh.waitForSelector('[data-testid="editor-loading"]', { timeout: 60_000 });
  await fresh.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="editor-loading"]');
      // `?? ''` on a missing element would read as "not Opening" and let this
      // through before the placeholder exists at all, which is how it passed
      // with an empty string the first time.
      return el !== null && !(el.textContent ?? 'Opening').includes('Opening');
    },
    undefined,
    { timeout: 60_000 },
  );
  const missing = await fresh.evaluate(
    () => document.querySelector('[data-testid="editor-loading"]')?.textContent ?? '',
  );
  check(
    'a slug with no entry says so, by name',
    missing.includes('ws8-does-not-exist') && /no project at/i.test(missing),
    missing.replace(/\s+/g, ' ').trim(),
  );
  check('…and does not sit on a spinner', !missing.includes('Opening'), missing.replace(/\s+/g, ' ').trim());
  await fresh.close();

  step('13. the /cms index');
  // Also phase 2's, not phase 1's: `/cms` is the whole-site overview now, a
  // rail of the five sections with a list of entries beside it, rather than
  // a flat `ul` of project slugs with a new-page form on it.
  const index = await context.newPage();
  await index.goto(`${ORIGIN}/cms`, { waitUntil: 'domcontentloaded' });
  await index.waitForSelector('[data-testid="section-nav"]', { timeout: 30_000 });
  const sections = await index.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="section-row-"]')].map((el) =>
      (el.getAttribute('data-testid') ?? '').replace('section-row-', ''),
    ),
  );
  check(
    'the five sections are listed, in registry order',
    JSON.stringify(sections) ===
      JSON.stringify(['home', 'projects', 'essays', 'filmography', 'photography']),
    JSON.stringify(sections),
  );

  await index.click('[data-testid="section-row-projects"]');
  await index.waitForSelector(`[data-testid="entry-row-${SLUG}"]`, { timeout: 30_000 });
  const rowText = await index.evaluate(
    (slug) => document.querySelector(`[data-testid="entry-row-${slug}"]`)?.textContent ?? '',
    SLUG,
  );
  check('the seeded page is listed under Projects', rowText.includes('WS-8'), rowText.replace(/\s+/g, ' ').trim());

  await index.click(`[data-testid="entry-open-${SLUG}"]`);
  await index.waitForSelector('[data-testid="cms-root"]', { timeout: 60_000 });
  check(
    'a page in the list opens the editor',
    index.url().endsWith(`/cms/projects/${SLUG}`),
    index.url(),
  );
  await index.close();

  step('14. the console');
  const noisy = consoleErrors.filter(
    (text) =>
      // raw.githubusercontent can 404 for a few seconds after a commit; that is
      // the media resolver being eventually right, not the editor being wrong.
      !text.includes('raw.githubusercontent.com') && !text.includes('Failed to load resource'),
  );
  check('no console errors from the editor', noisy.length === 0, noisy.slice(0, 3).join(' | '));
} catch (error) {
  failures += 1;
  console.log(`\n  RUN FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  if (consoleErrors.length > 0) {
    console.log('\n  what the browser said:');
    for (const text of consoleErrors.slice(0, 10)) console.log(`    ${text}`);
  }
} finally {
  if (browser !== null) await browser.close().catch(() => {});
  if (server !== null) {
    server.child.kill('SIGTERM');
    await sleep(500);
    if (server.child.exitCode === null) server.child.kill('SIGKILL');
  }
  if (branchCreated && process.env.E2E_KEEP_BRANCH !== '1') {
    try {
      await gh(`/repos/${REPO}/git/refs/heads/${branch}`, { method: 'DELETE' });
      console.log(`\n  branch ${branch} deleted`);
    } catch (error) {
      console.log(`\n  COULD NOT DELETE ${branch}: ${error.message}`);
      failures += 1;
    }
  } else if (branchCreated) {
    console.log(`\n  branch ${branch} kept (E2E_KEEP_BRANCH=1)`);
  }
}

writeFileSync(
  join(OUT_DIR, 'results.json'),
  `${JSON.stringify({ branch, total, failures, results }, null, 2)}\n`,
);

console.log(`\n  ${total - failures}/${total} checks passed · screenshots in ${OUT_DIR}`);
if (failures > 0) process.exit(1);
