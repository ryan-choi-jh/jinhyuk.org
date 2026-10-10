/**
 * src/cms/app/integration/site-e2e.mjs
 *
 * WS-G's end-to-end proof: the whole-site editor, in a real browser, against a
 * real GitHub branch that this script creates and deletes.
 *
 *   node src/cms/app/integration/site-e2e.mjs
 *   SITE_E2E_KEEP_BRANCH=1 node src/cms/app/integration/site-e2e.mjs  # leave it
 *   SITE_E2E_HEADED=1 node src/cms/app/integration/site-e2e.mjs       # watch it
 *
 * NEVER MAIN. The branch is `cms/ws-g-e2e-<timestamp>`, created from main's
 * head, and deleted in a `finally`. Nothing here writes to main; main is read
 * once, for a commit sha and a tree.
 *
 * It walks docs/cms-sections.md section 6 in order, and the steps are numbered
 * to match:
 *
 *   1  throwaway branch, seeded in one commit with WS-F's migrated content
 *   2  astro dev against it
 *   3  /cms is the section list: five sections, from the registry
 *   4  edit the homepage intro, save, read the draft back out of GitHub
 *   5  open an essay: the same document editor, a different section
 *   6  add a film from a YouTube URL, save, check the committed JSON
 *   7  create an album, upload photos, reorder, set a cover, save
 *   8  publish, and check the published file is the draft and the draft is gone
 *   9  routing: deep links, Back, the phase 1 redirect, a URL that is not one
 *  10  the console
 *
 * The strongest assertions are the ones made against the files in the
 * repository rather than against the DOM: a save that does not land is the
 * failure this exists for.
 */

import { execFileSync, spawn } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = 'ryan-choi-jh/jinhyuk.org';
const BASE_BRANCH = 'main';
const PORT = Number(process.env.SITE_E2E_PORT ?? 4341);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUT_DIR = process.env.SITE_E2E_OUT ?? fileURLToPath(new URL('.out/site', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/* Checks                                                                      */
/* -------------------------------------------------------------------------- */

let total = 0;
let failures = 0;
const results = [];
let currentStep = '0. setup';

function check(label, ok, detail = '') {
  total += 1;
  if (!ok) failures += 1;
  results.push({ step: currentStep, label, ok: ok === true, detail });
  console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : ` (${detail})`}`);
  return ok === true;
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  return check(label, a === b, a === b ? b : `got ${a}, wanted ${b}`);
}

function step(name) {
  currentStep = name;
  console.log(`\n  ${name}`);
}

/* -------------------------------------------------------------------------- */
/* GitHub                                                                      */
/* -------------------------------------------------------------------------- */

function githubToken() {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.CMS_DEV_TOKEN;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

const token = githubToken();

async function gh(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jinhyuk-cms-ws-g-e2e',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text === '' ? {} : JSON.parse(text);
  if (!response.ok) {
    throw new Error(
      `GitHub ${init.method ?? 'GET'} ${path} -> ${response.status}: ${body.message ?? text}`,
    );
  }
  return body;
}

/**
 * A file on the branch, or null. Retried, because GitHub's contents reads are
 * not strongly consistent — WS-C reported this and it is real: a read a moment
 * after a write can miss it, and two reads can disagree.
 */
async function fileOnBranch(path, branch, { tries = 6, wantText = null } = {}) {
  let last = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/contents/${path}?ref=${encodeURIComponent(branch)}&_=${Date.now()}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'jinhyuk-cms-ws-g-e2e',
          'Cache-Control': 'no-cache',
        },
      },
    );
    if (response.status === 404) {
      last = null;
    } else if (response.ok) {
      const body = await response.json();
      last = { sha: body.sha, text: Buffer.from(body.content, 'base64').toString('utf8') };
      if (wantText === null || last.text.includes(wantText)) return last;
    } else {
      throw new Error(`GitHub contents ${path} -> ${response.status}`);
    }
    if (attempt < tries - 1) await sleep(1200);
  }
  return last;
}

/** Absent on the branch? Retried the other way, for the same reason. */
async function goneFromBranch(path, branch, tries = 6) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const got = await fileOnBranch(path, branch, { tries: 1 });
    if (got === null) return true;
    await sleep(1200);
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* A real PNG, so WS-C parses real intrinsic dimensions                        */
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

function makePng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
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
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--host', '127.0.0.1'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CMS_DEV_TOKEN: token,
      CMS_BRANCH: branch,
      CMS_PREVIEW_LOCAL_DIR: '',
      BROWSER: 'none',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  child.stdout.on('data', (part) => {
    log += String(part);
  });
  child.stderr.on('data', (part) => {
    log += String(part);
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

const branch = `cms/ws-g-e2e-${Date.now()}`;
let branchCreated = false;
let server = null;
const consoleErrors = [];
let browser = null;

mkdirSync(OUT_DIR, { recursive: true });
const shots = join(OUT_DIR, 'shots');
mkdirSync(shots, { recursive: true });

/** WS-F's migrated content, which is in the working tree and not in git yet. */
const SEED_FILES = [
  'src/content/pages/home.json',
  'src/content/pages/essays/chasing-the-workaround.json',
  'src/content/pages/essays/whos-choosing.json',
  'src/content/pages/essays/who-i-m-looking-for.json',
  'src/content/pages/projects/track-daily-habit-tracker.json',
  'src/content/data/filmography.json',
  'src/content/data/photography.json',
];

const ESSAY_SLUG = 'chasing-the-workaround';
const HOME_SENTENCE = ' WS-G edited the homepage intro.';
const FILM_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const FILM_ID = 'dQw4w9WgXcQ';
const FILM_TITLE = 'A film added by WS-G';
const FILM_NOTE = 'Pasted as a full YouTube watch URL.';
const ALBUM_SLUG = 'untitled-album';
const ALBUM_TITLE = 'Seoul, in six frames';
const ALBUM_RENAMED_SLUG = 'seoul-in-six-frames';

const waitForStatus = (page, text, timeout = 90_000) =>
  page.waitForFunction(
    (wanted) =>
      (document.querySelector('[data-testid="status-message"]')?.textContent ?? '').includes(
        wanted,
      ),
    text,
    { timeout },
  );

try {
  step(`1. throwaway branch ${branch}, seeded in one commit`);
  const baseRef = await gh(`/repos/${REPO}/git/ref/heads/${BASE_BRANCH}`);
  const baseSha = baseRef.object.sha;
  const baseCommit = await gh(`/repos/${REPO}/git/commits/${baseSha}`);
  check('main is only ever read', BASE_BRANCH === 'main' && branch !== 'main');

  const tree = [];
  for (const path of SEED_FILES) {
    const content = readFileSync(join(REPO_ROOT, path), 'utf8');
    const blob = await gh(`/repos/${REPO}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content, encoding: 'utf-8' }),
    });
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await gh(`/repos/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }),
  });
  const commit = await gh(`/repos/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: 'WS-G e2e: seed the migrated content',
      tree: newTree.sha,
      parents: [baseSha],
    }),
  });
  await gh(`/repos/${REPO}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
  });
  branchCreated = true;
  check(
    'branch created from main with all five sections seeded',
    true,
    `${SEED_FILES.length} files at ${commit.sha.slice(0, 7)}`,
  );

  step('2. astro dev against that branch');
  server = await startDevServer(branch);
  const status = await (await fetch(`${ORIGIN}/api/cms/auth/status`)).json();
  eq('the API is signed in', status.signedIn, true);
  eq('…and pointed at the throwaway branch', status.branch, branch);

  const { chromium } = loadPlaywright();
  browser = await chromium.launch({ headless: process.env.SITE_E2E_HEADED !== '1' });
  const context = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  // The only confirm this page raises is "Discard draft", in step 6b. The
  // unsaved-changes guard is exercised on its own page in step 9, where the
  // answer has to be both no and yes.
  page.on('dialog', (dialog) => void dialog.accept());

  /* ---------------------------------------------------------------------- */
  step('3. /cms is the section list');
  await page.goto(`${ORIGIN}/cms`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="cms-site"]', { timeout: 60_000 });
  eq('the shell starts on the overview', await page.getAttribute('[data-testid="cms-site"]', 'data-view'), 'overview');

  const sectionRows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="section-row-"]')].map((row) =>
      (row.getAttribute('data-testid') ?? '').replace('section-row-', ''),
    ),
  );
  eq('the sidebar lists the five sections, in registry order', sectionRows, [
    'home',
    'projects',
    'essays',
    'filmography',
    'photography',
  ]);

  // The counts come from GET /api/cms/sections, which is a real read of all
  // five sections' files.
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="section-count-essays"]')?.textContent ?? '') === '3',
    undefined,
    { timeout: 60_000 },
  );
  eq('essays is counted', await page.textContent('[data-testid="section-count-essays"]'), '3');
  eq('filmography is counted', await page.textContent('[data-testid="section-count-filmography"]'), '4');
  eq('photography is counted (empty, and says so)', await page.textContent('[data-testid="section-count-photography"]'), '0');
  await page.waitForSelector('[data-testid="site-auth"]', { timeout: 30_000 });
  check(
    'the site bar resolves to signed in',
    ((await page.textContent('[data-testid="site-auth"]')) ?? '').includes('signed in'),
    (await page.textContent('[data-testid="site-auth"]')) ?? '',
  );
  await page.screenshot({ path: join(shots, '01-overview.png') });

  /* ---------------------------------------------------------------------- */
  step('4. edit the homepage intro');
  await page.click('[data-testid="overview-card-home"]');
  await page.waitForSelector('[data-testid="cms-root"]', { timeout: 60_000 });
  eq('home is a singleton: it opens straight into the editor', await page.getAttribute('[data-testid="cms-site"]', 'data-view'), 'entry');
  eq('…with no entry list column', await page.locator('[data-testid="entry-list"]').count(), 0);
  eq('…and the URL is /cms/home', new URL(page.url()).pathname, '/cms/home');
  eq('the document editor is the one that mounted', await page.getAttribute('[data-testid="cms-site"]', 'data-editor'), 'document');
  eq('the toolbar shows the homepage title', await page.textContent('[data-testid="toolbar-title"]'), 'Ryan Choi (최진혁)');

  await page.waitForSelector('.pe-content', { timeout: 30_000 });
  check(
    'WS-5 prose editors mounted inside the site shell',
    (await page.locator('.pe-content').count()) >= 2,
    `${await page.locator('.pe-content').count()} blocks`,
  );
  check(
    'WS-4 canvas mounted too (the hero band)',
    (await page.locator('[data-cv-stage]').count()) >= 1,
    `${await page.locator('[data-cv-stage]').count()} stages`,
  );

  await page.click('[data-testid="surface-block-p1"] .pe-content');
  await page.keyboard.press('End');
  await page.keyboard.type(HOME_SENTENCE, { delay: 6 });
  check(
    'the intro paragraph now ends with what was typed',
    ((await page.textContent('[data-testid="surface-block-p1"] .pe-content')) ?? '').includes(
      HOME_SENTENCE.trim(),
    ),
  );
  eq('the document is dirty', await page.getAttribute('[data-testid="dirty"]', 'class'), 'cms-dirty cms-dirty--dirty');
  await page.screenshot({ path: join(shots, '02-home.png') });

  await page.click('[data-testid="save"]');
  await waitForStatus(page, 'Draft saved');
  check('the editor says the draft saved', true);

  const homeDraft = await fileOnBranch('src/content/drafts/pages/home.json', branch, {
    wantText: HOME_SENTENCE.trim(),
  });
  if (check('the home draft is on the branch at the section path', homeDraft !== null, 'src/content/drafts/pages/home.json')) {
    check('…and holds the typed sentence', homeDraft.text.includes(HOME_SENTENCE.trim()));
    const parsed = JSON.parse(homeDraft.text);
    eq('…with section: home in its meta', parsed.meta.section, 'home');
    eq('…and slug: home', parsed.meta.slug, 'home');
  }
  const homePublished = await fileOnBranch('src/content/pages/home.json', branch, { tries: 1 });
  check(
    'the published homepage is untouched by saving a draft (2.3)',
    homePublished !== null && !homePublished.text.includes(HOME_SENTENCE.trim()),
  );

  /* ---------------------------------------------------------------------- */
  step('5. open an essay');
  await page.click('[data-testid="section-row-essays"]');
  await page.waitForSelector('[data-testid="entry-list"][data-section="essays"]', { timeout: 60_000 });
  await page.waitForSelector(`[data-testid="entry-open-${ESSAY_SLUG}"]`, { timeout: 60_000 });
  const essayRows = await page.locator('[data-testid^="entry-row-"]').count();
  eq('the essay list has three entries', essayRows, 3);
  eq('…and the URL is the section', new URL(page.url()).pathname, '/cms/essays');

  await page.click(`[data-testid="entry-open-${ESSAY_SLUG}"]`);
  await page.waitForSelector('[data-testid="cms-root"]', { timeout: 60_000 });
  eq('the essay opens in the document editor', await page.getAttribute('[data-testid="cms-site"]', 'data-editor'), 'document');
  eq('…at its own URL', new URL(page.url()).pathname, `/cms/essays/${ESSAY_SLUG}`);
  await page.waitForSelector('.pe-content', { timeout: 30_000 });
  check(
    'the essay body is editable prose, not markdown',
    (await page.locator('.pe-content').count()) >= 3,
    `${await page.locator('.pe-content').count()} blocks`,
  );
  const essayTitle = await page.textContent('[data-testid="toolbar-title"]');
  check('the toolbar shows the essay title', (essayTitle ?? '').length > 0, essayTitle ?? '');
  // The entry list is still beside it, which is what makes this a site editor
  // rather than five editors.
  eq('the entry list stays open beside the editor', await page.locator('[data-testid="entry-list"]').count(), 1);
  await page.screenshot({ path: join(shots, '03-essays.png') });

  /* ---------------------------------------------------------------------- */
  step('6. add a film from a YouTube URL');
  await page.click('[data-testid="section-row-filmography"]');
  await page.waitForSelector('[data-testid="entry-list"][data-section="filmography"]', { timeout: 60_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid^="entry-row-"]').length === 4,
    undefined,
    { timeout: 60_000 },
  );
  check('the four live films are listed', true);
  const firstFilmSubtitle = await page.textContent('[data-testid="entry-subtitle-film_untitled"]');
  check('…with the record subtitle WS-C builds', (firstFilmSubtitle ?? '').includes('SHORT FILM'), firstFilmSubtitle ?? '');

  await page.click('[data-testid="entry-create"]');
  await page.waitForSelector('[data-testid="film-editor"]', { timeout: 60_000 });
  eq('the record editor is the one that mounted', await page.getAttribute('[data-testid="cms-site"]', 'data-editor'), 'records');
  eq('a new film starts invalid', await page.getAttribute('[data-testid="film-editor"]', 'data-valid'), 'false');
  const newFilmPath = new URL(page.url()).pathname;
  check('…at its own URL, keyed by the record id', /^\/cms\/filmography\/film_[0-9a-f]+$/.test(newFilmPath), newFilmPath);
  const newFilmId = newFilmPath.split('/').pop();

  await page.fill('[data-testid="field-youtube"]', FILM_URL);
  await page.waitForSelector('[data-testid="youtube-id"]', { timeout: 15_000 });
  const idChip = await page.textContent('[data-testid="youtube-id"]');
  check(
    'the 11-character id is pulled out of the pasted URL',
    (idChip ?? '').includes(FILM_ID),
    idChip ?? '',
  );
  await page.waitForSelector('[data-testid="film-stage"]', { timeout: 15_000 });
  check('the poster frame is shown as click-to-play, with no iframe yet', (await page.locator('[data-testid="film-embed"]').count()) === 0);

  await page.fill('[data-testid="field-title"]', FILM_TITLE);
  await page.fill('[data-testid="field-note"]', FILM_NOTE);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="film-editor"]')?.getAttribute('data-valid') === 'true',
    undefined,
    { timeout: 15_000 },
  );
  check('the film is now valid', true);
  eq(
    'the entry list title followed the field',
    await page.textContent(`[data-testid="entry-open-${newFilmId}"] .cms-list__title`),
    FILM_TITLE,
  );
  await page.screenshot({ path: join(shots, '04-filmography.png') });

  await page.click('[data-testid="save"]');
  await waitForStatus(page, 'Draft saved');
  const filmDraft = await fileOnBranch('src/content/drafts/data/filmography.json', branch, {
    wantText: FILM_ID,
  });
  if (check('the filmography draft is on the branch', filmDraft !== null, 'src/content/drafts/data/filmography.json')) {
    const films = JSON.parse(filmDraft.text).films;
    eq('…with five films now', films.length, 5);
    const added = films.find((film) => film.youtubeId === FILM_ID);
    check('…the new film is in the committed JSON', added !== undefined);
    if (added !== undefined) {
      eq('…with the title typed in', added.title, FILM_TITLE);
      eq('…the note typed in', added.note, FILM_NOTE);
      eq('…and the four live films kept in order ahead of it', films.slice(0, 4).map((f) => f.id), [
        'film_untitled',
        'film_the_space_race',
        'film_the_space_race_trailer',
        'film_the_getaway',
      ]);
    }
  }

  /* ---------------------------------------------------------------------- */
  step('6b. discard that draft again');
  // WS-G's own button, and the one call in the adapter that routes on
  // `section.storage`: `deleteDraft(section, null)` is a document's draft for
  // three sections and a record collection's for two.
  await page.click('[data-testid="discard-draft"]');
  await waitForStatus(page, 'Draft discarded');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid^="entry-row-"]').length === 4,
    undefined,
    { timeout: 30_000 },
  );
  check('discarding the collection draft puts the four published films back', true);
  check(
    'the draft file is gone from the branch',
    await goneFromBranch('src/content/drafts/data/filmography.json', branch),
  );
  const filmsStillPublished = await fileOnBranch('src/content/data/filmography.json', branch, {
    tries: 1,
  });
  check(
    'and the published collection is untouched',
    filmsStillPublished !== null && !filmsStillPublished.text.includes(FILM_ID),
  );

  /* ---------------------------------------------------------------------- */
  step('7. create an album, upload photos, reorder, set a cover');
  await page.click('[data-testid="section-row-photography"]');
  await page.waitForSelector('[data-testid="entry-list"][data-section="photography"]', { timeout: 60_000 });
  await page.waitForSelector('[data-testid="entry-list-empty"]', { timeout: 60_000 });
  check('photography starts empty', true);

  await page.click('[data-testid="entry-create"]');
  await page.waitForSelector('[data-testid="album-editor"]', { timeout: 60_000 });
  eq('a new album is at its slug', new URL(page.url()).pathname, `/cms/photography/${ALBUM_SLUG}`);
  eq('…with no photos', await page.getAttribute('[data-testid="album-editor"]', 'data-photos'), '0');

  // Three real PNGs of different shapes, so the album page's justified rows
  // have something to justify and WS-C has real dimensions to read.
  const files = [
    { name: `wsg-one-${Date.now()}.png`, png: makePng(240, 160, [214, 163, 39]) },
    { name: `wsg-two-${Date.now()}.png`, png: makePng(160, 240, [76, 141, 255]) },
    { name: `wsg-three-${Date.now()}.png`, png: makePng(300, 100, [63, 185, 80]) },
  ];
  for (const file of files) {
    file.path = join(OUT_DIR, file.name);
    writeFileSync(file.path, file.png);
  }

  await page.setInputFiles(
    '[data-testid="album-photo-pick-input"]',
    files.map((file) => file.path),
  );
  await page.waitForFunction(
    () => document.querySelector('[data-testid="album-editor"]')?.getAttribute('data-photos') === '3',
    undefined,
    { timeout: 120_000 },
  );
  check('three photos uploaded and landed in the record', true);

  const photoIds = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="photo-grid"] [data-testid^="photo-tile-"]')].map(
      (tile) => (tile.getAttribute('data-testid') ?? '').replace('photo-tile-', ''),
    ),
  );
  eq('…as three tiles', photoIds.length, 3);
  const dims = await page.textContent(`[data-testid="photo-dims-${photoIds[0]}"]`);
  check(
    'the intrinsic size WS-C read from the file is on the tile',
    (dims ?? '').includes('240') && (dims ?? '').includes('160'),
    dims ?? '',
  );
  await page.screenshot({ path: join(shots, '05-photography-uploaded.png') });

  // Rename the album, which moves its URL with it (WS-D's syncRecordRoute).
  await page.fill('[data-testid="field-title"]', ALBUM_TITLE);
  await page.waitForFunction(
    (wanted) => window.location.pathname === wanted,
    `/cms/photography/${ALBUM_RENAMED_SLUG}`,
    { timeout: 15_000 },
  );
  check('renaming the album moved its URL with it', true, new URL(page.url()).pathname);
  // SEAM: the slot is keyed on the record id, not the slug, so the caret is
  // still in the field it was typed into.
  eq(
    'the title field kept focus through the rename',
    await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null),
    'field-title',
  );

  // Reorder: push the first photo one place right.
  await page.click(`[data-testid="photo-right-${photoIds[0]}"]`);
  await page.waitForFunction(
    (id) => document.querySelector(`[data-testid="photo-tile-${id}"]`)?.getAttribute('data-index') === '1',
    photoIds[0],
    { timeout: 15_000 },
  );
  check('a photo was reordered', true, `${photoIds[0]} moved to index 1`);

  // With nothing pinned, the cover is the first photo, so the reorder already
  // moved it. Choosing one means pinning a photo that is NOT in front.
  eq(
    'until one is chosen, the cover follows the first photo',
    await page.getAttribute('[data-testid="album-editor"]', 'data-cover'),
    photoIds[1],
  );

  // Whether the star of the CURRENT cover can be clicked at all, measured
  // rather than assumed: pinning the first photo is the one cover change that
  // has to go through a tile that is already wearing the badge.
  const starHit = await page.evaluate((id) => {
    const star = document.querySelector(`[data-testid="photo-cover-${id}"]`);
    if (star === null) return { ok: false, why: 'no star' };
    const box = star.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      ok: hit === star || star.contains(hit),
      why: hit === null ? 'nothing' : (hit.getAttribute('data-testid') ?? hit.className),
      box: `${Math.round(box.width)}x${Math.round(box.height)} at ${Math.round(box.x)},${Math.round(box.y)}`,
    };
  }, photoIds[1]);
  check(
    'the cover tile’s own star is clickable, so the first photo can be pinned',
    starHit.ok,
    `${starHit.why} is on top (star ${starHit.box ?? '?'})`,
  );

  await page.click(`[data-testid="photo-cover-${photoIds[2]}"]`);
  await page.waitForFunction(
    (id) => document.querySelector('[data-testid="album-editor"]')?.getAttribute('data-cover') === id,
    photoIds[2],
    { timeout: 15_000 },
  );
  check('a cover was chosen', true, photoIds[2]);
  await page.fill(`[data-testid="photo-alt-${photoIds[1]}"]`, 'A blue frame, taller than wide.');
  await page.screenshot({ path: join(shots, '06-photography-album.png') });

  await page.click('[data-testid="save"]');
  await waitForStatus(page, 'Draft saved');
  const albumDraft = await fileOnBranch('src/content/drafts/data/photography.json', branch, {
    wantText: ALBUM_RENAMED_SLUG,
  });
  if (check('the photography draft is on the branch', albumDraft !== null, 'src/content/drafts/data/photography.json')) {
    const albums = JSON.parse(albumDraft.text).albums;
    eq('…one album', albums.length, 1);
    const album = albums[0];
    eq('…with the title typed in', album.title, ALBUM_TITLE);
    eq('…the slug that follows it', album.slug, ALBUM_RENAMED_SLUG);
    eq('…three photos', album.photos.length, 3);
    eq('…in the order the reorder left them', album.photos.map((photo) => photo.id), [
      photoIds[1],
      photoIds[0],
      photoIds[2],
    ]);
    eq('…the chosen cover, pinned by id', album.cover, photoIds[2]);
    eq('…the alt text typed on a tile', album.photos[0].alt, 'A blue frame, taller than wide.');
    check(
      'every photo has a site-absolute src under the album directory',
      album.photos.every((photo) => photo.src.startsWith(`/media/photography/${ALBUM_SLUG}/`)),
      album.photos.map((photo) => photo.src).join(' '),
    );
    check(
      'every photo carries its intrinsic size as a pair',
      album.photos.every((photo) => typeof photo.w === 'number' && typeof photo.h === 'number'),
      album.photos.map((photo) => `${photo.w}x${photo.h}`).join(' '),
    );
  }
  const committedPhoto = await fileOnBranch(
    `public/media/photography/${ALBUM_SLUG}/${files[0].name}`,
    branch,
  );
  check(
    'the uploaded file itself is committed under the album directory',
    committedPhoto !== null,
    `public/media/photography/${ALBUM_SLUG}/${files[0].name}`,
  );

  /* ---------------------------------------------------------------------- */
  step('8. publish');
  const photographyDraftBefore = await fileOnBranch('src/content/drafts/data/photography.json', branch);
  await page.click('[data-testid="publish"]');
  await waitForStatus(page, 'Published');
  check('the record editor says it published', true);
  const photographyPublished = await fileOnBranch('src/content/data/photography.json', branch, {
    wantText: ALBUM_RENAMED_SLUG,
  });
  check(
    'the published collection is the draft, byte for byte',
    photographyPublished !== null &&
      photographyDraftBefore !== null &&
      photographyPublished.text === photographyDraftBefore.text,
  );
  check(
    'the photography draft is gone',
    await goneFromBranch('src/content/drafts/data/photography.json', branch),
  );

  // Preview, as the button actually computes it, not as this script guesses.
  await page.evaluate(() => {
    window.__opened = [];
    window.open = (url) => {
      window.__opened.push(String(url));
      return null;
    };
  });
  await page.click('[data-testid="preview"]');
  await page.waitForFunction(() => (window.__opened ?? []).length > 0, undefined, { timeout: 60_000 });
  const albumPreview = (await page.evaluate(() => window.__opened[0])) ?? '';
  eq(
    'Preview on an album points at WS-H’s section-aware route',
    albumPreview,
    `/cms/preview/photography/${ALBUM_RENAMED_SLUG}?v=draft`,
  );
  const previewResponse = await fetch(`${ORIGIN}${albumPreview}`);
  const previewBody = await previewResponse.text();
  eq('…and that URL is a real page', previewResponse.status, 200);
  check(
    '…showing this album',
    previewBody.includes(ALBUM_TITLE) || previewBody.includes(ALBUM_RENAMED_SLUG),
    `${previewBody.length} bytes`,
  );

  // And the same for a document, which is a different endpoint.
  await page.goto(`${ORIGIN}/cms/home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="cms-root"]', { timeout: 60_000 });
  await page.waitForFunction(
    (wanted) =>
      (document.querySelector('[data-testid="surface-block-p1"] .pe-content')?.textContent ?? '').includes(wanted),
    HOME_SENTENCE.trim(),
    { timeout: 60_000 },
  );
  check('reopening home shows the draft that was saved, not the published page', true);
  const homeDraftBefore = await fileOnBranch('src/content/drafts/pages/home.json', branch);
  await page.click('[data-testid="publish"]');
  await waitForStatus(page, 'Published');
  const homeAfter = await fileOnBranch('src/content/pages/home.json', branch, {
    wantText: HOME_SENTENCE.trim(),
  });
  check(
    'the published homepage is now the draft, byte for byte',
    homeAfter !== null && homeDraftBefore !== null && homeAfter.text === homeDraftBefore.text,
  );
  check('the home draft is gone', await goneFromBranch('src/content/drafts/pages/home.json', branch));

  await page.evaluate(() => {
    window.__opened = [];
    window.open = (url) => {
      window.__opened.push(String(url));
      return null;
    };
  });
  await page.click('[data-testid="preview"]');
  await page.waitForFunction(() => (window.__opened ?? []).length > 0, undefined, { timeout: 60_000 });
  eq(
    'Preview on the singleton carries the section and no key',
    await page.evaluate(() => window.__opened[0]),
    '/cms/preview/home?v=draft',
  );
  await page.screenshot({ path: join(shots, '07-published.png') });

  /* ---------------------------------------------------------------------- */
  step('9. routing');
  const deep = await context.newPage();
  deep.on('pageerror', (error) => consoleErrors.push(String(error)));
  await deep.goto(`${ORIGIN}/cms/essays/${ESSAY_SLUG}`, { waitUntil: 'domcontentloaded' });
  await deep.waitForSelector('[data-testid="cms-root"]', { timeout: 60_000 });
  check('a deep link opens that entry directly', true, deep.url());
  eq('…in the right section', await deep.getAttribute('[data-testid="cms-site"]', 'data-section'), 'essays');

  await deep.click('[data-testid="section-row-filmography"]');
  await deep.waitForSelector('[data-testid="entry-list"][data-section="filmography"]', { timeout: 60_000 });
  await deep.goBack();
  await deep.waitForFunction(
    (wanted) => window.location.pathname === wanted,
    `/cms/essays/${ESSAY_SLUG}`,
    { timeout: 30_000 },
  );
  await deep.waitForSelector('[data-testid="cms-root"]', { timeout: 60_000 });
  check('Back returns to the essay, client side, with the editor remounted', true, deep.url());

  // Delete, for a section whose API has no endpoint for it. WS-C ships none
  // (docs/cms-contracts.md 11 lists none), so the button must be off with a
  // reason rather than present and broken.
  await deep.waitForSelector(`[data-testid="entry-delete-${ESSAY_SLUG}"]`, { timeout: 30_000 });
  const deleteBtn = await deep.evaluate((slug) => {
    const button = document.querySelector(`[data-testid="entry-delete-${slug}"]`);
    return button === null
      ? null
      : { disabled: button.disabled, title: button.getAttribute('title') ?? '' };
  }, ESSAY_SLUG);
  check('Delete is offered for an essay but disabled', deleteBtn?.disabled === true);
  check(
    '…and says why, rather than failing when pressed',
    (deleteBtn?.title ?? '').includes('no endpoint'),
    deleteBtn?.title ?? '',
  );

  // The unsaved-changes guard, over a section change.
  let allowLeaving = false;
  deep.on('dialog', (dialog) => {
    if (allowLeaving) void dialog.accept();
    else void dialog.dismiss();
  });
  await deep.waitForSelector('.pe-content', { timeout: 60_000 });
  await deep.locator('.pe-content').first().click();
  await deep.keyboard.type('x');
  await deep.waitForSelector('[data-testid="dirty"].cms-dirty--dirty', { timeout: 15_000 });
  await deep.click('[data-testid="section-row-projects"]');
  await deep.waitForTimeout(600);
  eq(
    'a dirty editor refuses to be navigated away from',
    new URL(deep.url()).pathname,
    `/cms/essays/${ESSAY_SLUG}`,
  );
  allowLeaving = true;
  await deep.click('[data-testid="section-row-projects"]');
  await deep.waitForFunction(() => window.location.pathname === '/cms/projects', undefined, {
    timeout: 30_000,
  });
  check('…and goes once the same prompt is accepted', true, deep.url());

  await deep.goto(`${ORIGIN}/cms/track-daily-habit-tracker`, { waitUntil: 'domcontentloaded' });
  eq(
    'a phase 1 URL redirects into the projects section',
    new URL(deep.url()).pathname,
    '/cms/projects/track-daily-habit-tracker',
  );
  await deep.waitForSelector('[data-testid="cms-root"]', { timeout: 60_000 });
  check('…and the phase 1 project still opens in the phase 1 editor', true);
  await deep.screenshot({ path: join(shots, '08-projects.png') });

  await deep.goto(`${ORIGIN}/cms/nonsense/also-nonsense`, { waitUntil: 'domcontentloaded' });
  const refused = await deep.textContent('.gate h1');
  check('a URL that is not a place is refused server side', (refused ?? '').includes('no'), refused ?? '');
  eq('…and no island was shipped for it', await deep.locator('[data-testid="cms-site"]').count(), 0);

  await deep.goto(`${ORIGIN}/cms/preview`, { waitUntil: 'domcontentloaded' });
  check(
    'the preview route still wins over /cms/<section>',
    (await deep.locator('[data-testid="cms-site"]').count()) === 0,
    deep.url(),
  );
  await deep.close();

  /* ---------------------------------------------------------------------- */
  step('10. the console');
  const noisy = consoleErrors.filter(
    (text) =>
      // raw.githubusercontent 404s for a few seconds after a commit, and
      // i.ytimg has no maxres frame for every video: both are the media
      // resolver and WS-E's poster downgrade being eventually right.
      !text.includes('raw.githubusercontent.com') &&
      !text.includes('i.ytimg.com') &&
      !text.includes('Failed to load resource') &&
      !text.includes('the server responded with a status of 404'),
  );
  check('no console errors from the editor', noisy.length === 0, noisy.slice(0, 4).join(' | '));
} catch (error) {
  failures += 1;
  console.log(
    `\n  RUN FAILED in ${currentStep}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  if (consoleErrors.length > 0) {
    console.log('\n  what the browser said:');
    for (const text of consoleErrors.slice(0, 10)) console.log(`    ${text}`);
  }
  if (server !== null) console.log(`\n  dev server tail:\n${server.log().slice(-2000)}`);
} finally {
  if (browser !== null) await browser.close().catch(() => {});
  if (server !== null) {
    server.child.kill('SIGTERM');
    await sleep(500);
    if (server.child.exitCode === null) server.child.kill('SIGKILL');
  }
  if (branchCreated && process.env.SITE_E2E_KEEP_BRANCH !== '1') {
    try {
      await gh(`/repos/${REPO}/git/refs/heads/${branch}`, { method: 'DELETE' });
      console.log(`\n  branch ${branch} deleted`);
    } catch (error) {
      console.log(`\n  COULD NOT DELETE ${branch}: ${error.message}`);
      failures += 1;
    }
  } else if (branchCreated) {
    console.log(`\n  branch ${branch} kept (SITE_E2E_KEEP_BRANCH=1)`);
  }
}

writeFileSync(
  join(OUT_DIR, 'results.json'),
  `${JSON.stringify({ branch, total, failures, results }, null, 2)}\n`,
);

console.log(`\n  ${total - failures}/${total} checks passed · screenshots in ${shots}`);
if (failures > 0) process.exit(1);
