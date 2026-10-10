/**
 * src/cms/app/shell/site-harness/drive.mjs
 *
 * WS-D's browser proof. Builds the navigation harness, opens it in headless
 * Chrome over `file://`, drives the real UI with synthesised input, asserts
 * what the site store, the record store and the in-memory API ended up
 * holding, and screenshots every one of the five sections.
 *
 *   node src/cms/app/shell/site-harness/drive.mjs
 *   CMS_SITE_HARNESS_OUT=/tmp/wsd node src/cms/app/shell/site-harness/drive.mjs
 *
 * What it proves, in order: the sidebar is the registry; every section opens;
 * an entry in every section opens into the right editor; the record slot
 * contract is honoured both ways (the shell's stub with nothing mounted,
 * WS-E's component with something mounted); create, duplicate, delete and
 * reorder; the unsaved-changes guard refuses a section change; and the
 * desktop-only fallback below 900px.
 *
 * No network: the page is a local file, every fixture is baked into the
 * bundle, and the API is in memory. Chrome is spoken to over the DevTools
 * protocol using Node's built-in WebSocket, so there is no new dependency.
 *
 * The CDP client, the page driver and the Chrome launcher are the same ones
 * `../harness/drive.mjs` uses; they are duplicated rather than imported
 * because that file runs its own `main()` on import.
 *
 * Exit code 0 means every check passed.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUT_DIR =
  process.env.CMS_SITE_HARNESS_OUT ?? fileURLToPath(new URL('.out', import.meta.url));
const SHOTS_DIR = join(OUT_DIR, 'shots');
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const WIDE = { width: 1600, height: 1000 };
const NARROW = { width: 820, height: 900 };

/* -------------------------------------------------------------------------- */
/* Checks                                                                      */
/* -------------------------------------------------------------------------- */

let failures = 0;
let total = 0;

function check(label, ok, detail = '') {
  total += 1;
  if (ok) {
    console.log(`    ok    ${label}${detail ? ` (${detail})` : ''}`);
  } else {
    failures += 1;
    console.log(`    FAIL  ${label}${detail ? ` (${detail})` : ''}`);
  }
}

function section(name) {
  console.log(`\n  ${name}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/* A very small DevTools protocol client                                       */
/* -------------------------------------------------------------------------- */

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (entry === undefined) return;
        this.pending.delete(message.id);
        if (message.error !== undefined) entry.reject(new Error(`${message.error.message}`));
        else entry.resolve(message.result);
        return;
      }
      const list = this.handlers.get(message.method);
      if (list !== undefined) for (const handler of list) handler(message.params);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new Cdp(socket);
  }

  on(method, handler) {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30_000);
    });
  }

  close() {
    this.socket.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Page driving                                                                */
/* -------------------------------------------------------------------------- */

class Page {
  constructor(cdp) {
    this.cdp = cdp;
    this.consoleErrors = [];
    this.consoleWarnings = [];
    this.pageErrors = [];
  }

  async evaluate(expression) {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails !== undefined) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`evaluate failed: ${text}\n  while evaluating: ${expression.slice(0, 200)}`);
    }
    return result.result.value;
  }

  /** Two frames, which is enough for React to commit and the layout to settle. */
  settle() {
    return this.evaluate(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
    );
  }

  probe() {
    return this.evaluate('window.__wsd.probe()');
  }

  rect(testId) {
    return this.evaluate(`(() => {
      const el = document.querySelector('[data-testid="${testId}"]');
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 };
    })()`);
  }

  async mouse(type, x, y, extra = {}) {
    await this.cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
      buttons: extra.buttons ?? (type === 'mouseReleased' ? 0 : 1),
      ...extra,
    });
  }

  /** Bring it into view first: the page surface scrolls, and dense.json is tall. */
  async scrollIntoView(testId) {
    await this.evaluate(`(() => {
      const el = document.querySelector('[data-testid="${testId}"]');
      if (el === null) return false;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      return true;
    })()`);
    await this.settle();
  }

  async click(testId) {
    await this.scrollIntoView(testId);
    const box = await this.rect(testId);
    if (box === null || !box.visible) throw new Error(`cannot click [data-testid="${testId}"]: not visible`);
    const x = box.x + box.w / 2;
    const y = box.y + box.h / 2;
    await this.mouse('mouseMoved', x, y, { buttons: 0 });
    await this.mouse('mousePressed', x, y);
    await this.mouse('mouseReleased', x, y);
    await this.settle();
  }

  /** Press on `testId`, move to `(x, y)` in steps, release. */
  async dragTo(testId, x, y, steps = 12) {
    const box = await this.rect(testId);
    if (box === null) throw new Error(`cannot drag [data-testid="${testId}"]`);
    const startX = box.x + box.w / 2;
    const startY = box.y + box.h / 2;
    await this.mouse('mouseMoved', startX, startY, { buttons: 0 });
    await this.mouse('mousePressed', startX, startY);
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      await this.mouse('mouseMoved', startX + (x - startX) * t, startY + (y - startY) * t);
      await sleep(8);
    }
    await this.mouse('mouseReleased', x, y);
    await this.settle();
  }

  /** Focus a field, select what is in it, type `text` as real input events. */
  async type(testId, text) {
    await this.click(testId);
    await this.evaluate(`(() => {
      const el = document.querySelector('[data-testid="${testId}"]');
      el.focus();
      if (typeof el.select === 'function') el.select();
      return true;
    })()`);
    await this.cdp.send('Input.insertText', { text });
    await this.settle();
  }


  /** A real key event, so the shell's own keydown handler sees it. */
  async key(key, { meta = false, shift = false, ctrl = false, alt = false } = {}) {
    const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
    const code = `Key${key.toUpperCase()}`;
    const vk = key.toUpperCase().charCodeAt(0);
    for (const type of ['keyDown', 'keyUp']) {
      await this.cdp.send('Input.dispatchKeyEvent', {
        type,
        modifiers,
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      });
    }
    await this.settle();
  }
  /**
   * Settle, then give any in-flight store fetch a turn. The site store's
   * routing is asynchronous — it reads the entry list and the entry itself
   * through the API — so a click is not finished when the frame is.
   */
  async quiet(rounds = 4) {
    for (let i = 0; i < rounds; i += 1) {
      await this.evaluate('new Promise((r) => setTimeout(r, 0))');
      await this.settle();
    }
  }

  exists(testId) {
    return this.evaluate(`document.querySelector('[data-testid="${testId}"]') !== null`);
  }

  async setViewport({ width, height }) {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await this.settle();
  }

  async shot(name) {
    const result = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = join(SHOTS_DIR, `${name}.png`);
    writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
  }
}

/* -------------------------------------------------------------------------- */
/* Chrome                                                                      */
/* -------------------------------------------------------------------------- */

async function launchChrome() {
  if (!existsSync(CHROME)) throw new Error(`no Chrome at ${CHROME} (set CHROME_PATH)`);
  const profile = await mkdtemp(join(tmpdir(), 'cms-ws3-chrome-'));
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--window-size=${WIDE.width},${WIDE.height}`,
      // The page is a file:// URL and so are the images it draws.
      '--allow-file-access-from-files',
      '--hide-scrollbars',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const portFile = join(profile, 'DevToolsActivePort');
  let port = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (existsSync(portFile)) {
      const [line] = readFileSync(portFile, 'utf8').split('\n');
      if (line !== undefined && line.trim() !== '') {
        port = Number(line.trim());
        break;
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited with ${child.exitCode}:\n${stderr}`);
    }
    await sleep(100);
  }
  if (port === null) throw new Error(`Chrome never reported a debugging port:\n${stderr}`);

  return { child, profile, port };
}

async function firstPageTarget(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    const target = targets.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl);
    if (target !== undefined) return target;
    await sleep(100);
  }
  throw new Error('Chrome never produced a page target');
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

/** The five section ids, in the order the registry puts them in. */
const SECTION_IDS = ['home', 'projects', 'essays', 'filmography', 'photography'];

/** Fixture keys. Baked into the harness by ./build.mjs, asserted here. */
const PROJECT = 'fixture-dense';
const ESSAY = 'fixture-essay';
const FILM = 'film_getaway';
const ALBUM = 'first-build';

async function main() {
  // Build first, so a run always tests the current source.
  // CMS_SITE_HARNESS_SKIP_BUILD=1 to reuse the last bundle.
  if (process.env.CMS_SITE_HARNESS_SKIP_BUILD !== '1') await import('./build.mjs');

  mkdirSync(SHOTS_DIR, { recursive: true });

  const htmlPath = join(OUT_DIR, 'harness.html');
  if (!existsSync(htmlPath)) {
    throw new Error(`no harness at ${htmlPath}. Run build.mjs first (same CMS_SITE_HARNESS_OUT).`);
  }
  const url = pathToFileURL(htmlPath).href;

  const chrome = await launchChrome();
  const target = await firstPageTarget(chrome.port);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  const page = new Page(cdp);

  cdp.on('Runtime.consoleAPICalled', (params) => {
    const text = (params.args ?? [])
      .map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? '')
      .join(' ');
    if (params.type === 'error') page.consoleErrors.push(text);
    else if (params.type === 'warning') page.consoleWarnings.push(text);
  });
  cdp.on('Runtime.exceptionThrown', (params) => {
    page.pageErrors.push(
      params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? '?',
    );
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await page.setViewport(WIDE);

  const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
  await cdp.send('Page.navigate', { url });
  await loaded;

  let booted = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    booted = await page.evaluate(
      'Boolean(window.__wsd) && Boolean(document.querySelector("[data-testid=\\"cms-site\\"]"))',
    );
    if (booted) break;
    await sleep(100);
  }
  if (!booted) {
    throw new Error(
      `the harness never booted.\n  page errors: ${page.pageErrors.join('\n')}\n  console: ${page.consoleErrors.join('\n')}`,
    );
  }
  await page.settle();
  // The boot route fetches the section list and the auth status.
  await page.quiet();

  try {
    await run(page);
  } finally {
    cdp.close();
    chrome.child.kill('SIGKILL');
    await rm(chrome.profile, { recursive: true, force: true }).catch(() => {});
  }
}

async function run(page) {
  /* ---------------------------------------------------------------------- */
  section('boot: the overview (all five fixtures, in-memory API, no network)');
  const boot = await page.probe();
  check('it lands on the overview', boot.view === 'overview', boot.view);
  check('no editor is mounted yet', boot.editorKind === null);
  check('the API was asked for the sections', boot.calls.includes('listSections:'));
  check('and who is signed in', boot.auth?.signedIn === true, JSON.stringify(boot.auth));
  check('nothing was written on boot', !boot.calls.some((call) => call.startsWith('putDraft')));

  const sidebar = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-testid^="section-row-"]')];
    return {
      ids: rows.map((row) => row.dataset.section),
      storages: rows.map((row) => row.dataset.storage),
      shapes: rows.map((row) => row.dataset.shape),
      counts: rows.map((row) => row.querySelector('[data-testid^="section-count-"]').textContent),
      drafts: [...document.querySelectorAll('[data-testid^="section-draft-"]')].map((dot) => dot.dataset.testid),
      cards: document.querySelectorAll('[data-testid^="overview-card-"]').length,
      lists: document.querySelectorAll('[data-testid="entry-list"]').length,
    };
  })()`);
  check(
    'the sidebar is the registry, in registry order',
    sidebar.ids.join(',') === SECTION_IDS.join(','),
    sidebar.ids.join(','),
  );
  check(
    'each row carries what the section is',
    sidebar.storages.join(',') === 'document,document,document,records,records' &&
      sidebar.shapes.join(',') === 'singleton,collection,collection,collection,collection',
    `${sidebar.storages.join(',')} / ${sidebar.shapes.join(',')}`,
  );
  check(
    'counts came from the API',
    sidebar.counts.join(',') === '1,3,1,4,2',
    sidebar.counts.join(','),
  );
  check(
    'the one section with a draft has the dot',
    sidebar.drafts.length === 1 && sidebar.drafts[0] === 'section-draft-projects',
    sidebar.drafts.join(','),
  );
  check('the overview offers every section as a card', sidebar.cards === 5, `${sidebar.cards}`);
  check('and there is no entry list on the overview', sidebar.lists === 0);
  console.log(`    shot  ${await page.shot('01-overview')}`);

  /* ---------------------------------------------------------------------- */
  section('moving between all five sections');

  const shots = {
    home: '02-home',
    projects: '03-projects',
    essays: '04-essays',
    filmography: '05-filmography',
    photography: '06-photography',
  };

  for (const id of SECTION_IDS) {
    await page.click(`section-row-${id}`);
    await page.quiet();
    const state = await page.probe();
    check(`${id}: the shell is on it`, state.section === id, state.section ?? 'none');

    const dom = await page.evaluate(`(() => {
      const root = document.querySelector('[data-testid="cms-site"]');
      const rows = [...document.querySelectorAll('[data-testid^="entry-row-"]')];
      return {
        view: root.dataset.view,
        current: [...document.querySelectorAll('.cms-nav__row--current')].map((row) => row.dataset.section),
        hasList: document.querySelector('[data-testid="entry-list"]') !== null,
        rows: rows.map((row) => row.dataset.testid.replace('entry-row-', '')),
        thumbs: document.querySelectorAll('.cms-list__thumb').length,
        loadedThumbs: [...document.querySelectorAll('.cms-list__thumb img')].filter((img) => img.naturalWidth > 0).length,
        editor: root.dataset.editor,
        docEditor: document.querySelector('[data-testid="page-surface"]') !== null,
        recordEditor: document.querySelector('[data-testid="record-view"]') !== null,
        createLabel: document.querySelector('[data-testid="entry-create"]')?.textContent ?? null,
      };
    })()`);
    check(`${id}: exactly one row is marked current`, dom.current.join(',') === id, dom.current.join(','));

    if (id === 'home') {
      check('home: a singleton has no entry list', dom.hasList === false);
      check('home: it goes straight into the document editor', dom.view === 'entry' && dom.docEditor === true);
      check('home: and the store bound a document', state.editorKind === 'document', String(state.editorKind));
      check('home: on the home document', state.document?.slug === 'home', state.document?.slug ?? 'none');
    } else {
      check(`${id}: a collection shows its entry list`, dom.hasList === true && dom.view === 'list');
      check(`${id}: no editor is open yet`, dom.docEditor === false && dom.recordEditor === false);
      check(`${id}: the list has rows`, dom.rows.length > 0, dom.rows.join(','));
      check(
        `${id}: the New button is named after the section's noun`,
        typeof dom.createLabel === 'string' && dom.createLabel.startsWith('+ New '),
        dom.createLabel ?? 'none',
      );
      if (id === 'filmography' || id === 'photography') {
        check(`${id}: record rows carry a thumbnail`, dom.thumbs === dom.rows.length, `${dom.thumbs}/${dom.rows.length}`);
        check(
          `${id}: and the thumbnails really loaded from public/`,
          dom.loadedThumbs >= dom.rows.length - 1,
          `${dom.loadedThumbs}/${dom.rows.length}`,
        );
      } else {
        check(`${id}: document rows carry no thumbnail`, dom.thumbs === 0, `${dom.thumbs}`);
      }
    }
    console.log(`    shot  ${await page.shot(shots[id])}`);
  }

  /* ---------------------------------------------------------------------- */
  section('opening an entry in every section, and the dispatch');

  const opens = [
    ['projects', PROJECT, 'document', '07-projects-entry'],
    ['essays', ESSAY, 'document', '08-essays-entry'],
    ['filmography', FILM, 'records', '09-filmography-entry'],
    ['photography', ALBUM, 'records', '10-photography-entry'],
  ];

  for (const [id, key, kind, shot] of opens) {
    await page.click(`section-row-${id}`);
    await page.quiet();
    await page.click(`entry-open-${key}`);
    await page.quiet();

    const state = await page.probe();
    check(`${id}/${key}: the route is the entry`, state.view === 'entry' && state.entryKey === key, `${state.view} ${state.entryKey}`);
    check(`${id}/${key}: the right editor is bound`, state.editorKind === kind, String(state.editorKind));

    const dom = await page.evaluate(`(() => ({
      editor: document.querySelector('[data-testid="cms-site"]').dataset.editor,
      docEditor: document.querySelector('[data-testid="page-surface"]') !== null,
      recordView: document.querySelector('[data-testid="record-view"]') !== null,
      stub: document.querySelector('[data-testid="record-stub"]') !== null,
      stubSection: document.querySelector('[data-testid="record-stub"]')?.dataset.section ?? null,
      fields: [...document.querySelectorAll('[data-testid^="record-field-"]')].map((row) => row.dataset.testid.replace('record-field-', '')),
      crumb: document.querySelector('[data-testid="crumb-entry"]')?.textContent ?? null,
      toolbarTitle: document.querySelector('[data-testid="toolbar-title"]')?.textContent ?? null,
      currentRow: document.querySelector('.cms-list__row--current')?.dataset.testid ?? null,
      save: document.querySelector('[data-testid="save"]') !== null,
      publish: document.querySelector('[data-testid="publish"]') !== null,
    }))()`);

    check(`${id}/${key}: the DOM says which editor`, dom.editor === kind, dom.editor);
    check(`${id}/${key}: the row is marked current`, dom.currentRow === `entry-row-${key}`, dom.currentRow ?? 'none');
    check(`${id}/${key}: the breadcrumb names it`, typeof dom.crumb === 'string' && dom.crumb.length > 0, dom.crumb ?? 'none');
    check(`${id}/${key}: Save and Publish are there`, dom.save && dom.publish);

    if (kind === 'document') {
      check(`${id}/${key}: the phase 1 page surface mounted`, dom.docEditor === true);
      check(`${id}/${key}: and no record view did`, dom.recordView === false);
    } else {
      check(`${id}/${key}: the record view mounted`, dom.recordView === true);
      check(`${id}/${key}: and no page surface did`, dom.docEditor === false);
      check(`${id}/${key}: the shell's stub stands in for WS-E`, dom.stub === true && dom.stubSection === id);
      check(
        `${id}/${key}: the stub shows every field the registry declares`,
        dom.fields.length === (id === 'filmography' ? 6 : 6),
        dom.fields.join(','),
      );
      if (id === 'filmography') {
        check(
          'the film stub shows exactly the fields of 9.5',
          dom.fields.join(',') === 'youtubeId,title,kind,year,note,poster',
          dom.fields.join(','),
        );
      } else {
        check(
          'the album stub shows exactly the fields of 9.5',
          dom.fields.join(',') === 'title,slug,year,summary,photos,cover',
          dom.fields.join(','),
        );
      }
    }
    console.log(`    shot  ${await page.shot(shot)}`);
  }

  /* ---------------------------------------------------------------------- */
  section('the record editor slot contract, both ways');
  {
    // Still on photography/first-build from the loop above.
    await page.evaluate('window.__wsd.setRecordSlot(true)');
    await page.settle();
    const dom = await page.evaluate(`(() => ({
      live: document.querySelector('[data-testid="record-slot-live"]') !== null,
      stub: document.querySelector('[data-testid="record-stub"]') !== null,
      section: document.querySelector('[data-testid="record-slot-live"]')?.dataset.section ?? null,
      entry: document.querySelector('[data-testid="record-slot-live"]')?.dataset.entry ?? null,
      report: document.querySelector('[data-testid="slot-report"]')?.textContent ?? null,
      title: document.querySelector('[data-testid="slot-title"]')?.value ?? null,
    }))()`);
    check('mounting a render prop replaces the stub', dom.live === true && dom.stub === false);
    check('the slot was handed its own section', dom.section === 'photography', dom.section ?? 'none');
    check('and the open record', dom.entry === ALBUM, dom.entry ?? 'none');
    check('and the record itself', dom.title === 'First Build', dom.title ?? 'none');
    check(
      'and the collection, the field list and the index',
      typeof dom.report === 'string' && dom.report.includes('album · first-build · index 0 · 6 fields · 2 in the collection'),
      dom.report ?? 'none',
    );

    // Writing through the slot's onPatch reaches the store and the list.
    await page.type('slot-title', 'First Build (edited)');
    await page.settle();
    const edited = await page.probe();
    check('onPatch dirtied the collection', edited.record?.dirty === true);
    check('and one undo step was recorded', edited.record?.canUndo === true);
    check(
      'and the entry list followed immediately',
      (edited.titles.photography ?? []).includes('First Build (edited)'),
      (edited.titles.photography ?? []).join(' | '),
    );
    const badge = await page.evaluate(
      `document.querySelector('[data-testid="entry-badge-${ALBUM}"]')?.textContent ?? null`,
    );
    check('and the row is badged as an unpublished change', badge === 'draft', String(badge));

    // Uploading through the slot lands in this album's own directory.
    await page.click('slot-upload');
    await page.quiet();
    const uploaded = await page.evaluate('window.__wsd.previews.at(-1)');
    check(
      'the slot uploads into its own media directory (9.3)',
      uploaded?.src === '/media/photography/first-build/from-the-slot.png',
      String(uploaded?.src),
    );
    check('and the upload reports intrinsic dimensions', uploaded?.w > 0 && uploaded?.h > 0, `${uploaded?.w}x${uploaded?.h}`);
    console.log(`    shot  ${await page.shot('11-record-slot')}`);

    await page.click('undo');
    await page.settle();
    const undone = await page.probe();
    check('the toolbar undo reverted the slot edit', undone.record?.dirty === false);
    check('and the list title went back', (undone.titles.photography ?? []).includes('First Build'));
    await page.evaluate('window.__wsd.setRecordSlot(false)');
    await page.settle();
    check('unmounting it brings the stub back', await page.exists('record-stub'));
  }

  /* ---------------------------------------------------------------------- */
  section('records: create, reorder, delete, save — one file, one commit');
  {
    await page.click('section-row-filmography');
    await page.quiet();
    const before = await page.probe();
    check('four films to start', (before.entries.filmography ?? []).length === 4);

    await page.click('entry-create');
    await page.quiet();
    const created = await page.probe();
    check('create added one locally', (created.entries.filmography ?? []).length === 5);
    check('create opened it', created.view === 'entry' && created.editorKind === 'records');
    check(
      'nothing was written to the API yet',
      !created.calls.some((call) => call.startsWith('putRecords')),
      created.calls.filter((call) => call.startsWith('putRecords')).join(','),
    );
    check('the collection is dirty', created.record?.dirty === true);
    check('and it does not validate without a video', created.record?.validates === false, String(created.record?.validates));

    const newKey = created.entryKey;
    await page.click(`entry-up-${newKey}`);
    await page.quiet();
    const moved = await page.probe();
    check(
      'reorder moved it up one place',
      (moved.entries.filmography ?? []).indexOf(newKey) === 3,
      (moved.entries.filmography ?? []).join(','),
    );

    await page.click(`entry-delete-${newKey}`);
    await page.quiet();
    const deleted = await page.probe();
    check('delete removed it', (deleted.entries.filmography ?? []).length === 4);
    check('and returned to the list, since what was open is gone', deleted.view === 'list');
    const afterDelete = await page.evaluate(`(() => {
      const state = window.__wsd.store.recordStore('filmography').getState();
      return { count: state.summaries.length, dirty: state.dirty, canUndo: state.canUndo, undoLabel: state.undoLabel };
    })()`);
    check('delete is one undoable edit to the file', afterDelete.canUndo === true, afterDelete.undoLabel ?? 'none');
    await page.evaluate("window.__wsd.store.recordStore('filmography').undo()");
    await page.quiet();
    const undeleted = await page.probe();
    check('undo brings the film back', (undeleted.entries.filmography ?? []).length === 5);
    await page.evaluate("window.__wsd.store.recordStore('filmography').redo()");
    await page.quiet();
    check('and redo removes it again', ((await page.probe()).entries.filmography ?? []).length === 4);

    // Add a real film and save the whole collection.
    await page.click(`entry-open-${FILM}`);
    await page.quiet();
    await page.click(`entry-duplicate-${FILM}`);
    await page.quiet();
    const duplicated = await page.probe();
    check('duplicate added a copy', (duplicated.entries.filmography ?? []).length === 5);
    check('the copy is titled as one', (duplicated.titles.filmography ?? []).some((title) => title.endsWith(' copy')), (duplicated.titles.filmography ?? []).join(' | '));
    check('a duplicated film collection validates', duplicated.record?.validates === true);

    await page.click('save');
    await page.quiet();
    const saved = await page.probe();
    check('save wrote the collection once', saved.calls.filter((call) => call === 'putRecords:filmography').length === 1);
    check('and it is clean again', saved.record?.dirty === false);
    check('the server holds a draft of the whole file', saved.server.records.filmography.draft !== null);
    check(
      'and the draft has the five films',
      saved.server.records.filmography.draft.films.length === 5,
      `${saved.server.records.filmography.draft.films.length}`,
    );
    check('the published file is untouched until Publish', saved.server.records.filmography.published.films.length === 4);
    console.log(`    shot  ${await page.shot('12-filmography-edited')}`);
  }

  /* ---------------------------------------------------------------------- */
  section('documents: create writes a draft and opens it');
  {
    await page.click('section-row-essays');
    await page.quiet();
    await page.click('entry-create');
    await page.quiet();
    const created = await page.probe();
    check('the essay list grew', (created.entries.essays ?? []).length === 2, (created.entries.essays ?? []).join(','));
    check('the new essay opened in the document editor', created.editorKind === 'document');
    check('it is a draft on the server', created.server.docs.essays['new-essay']?.draft !== null);
    check('and it was never published', created.server.docs.essays['new-essay']?.published === null);
    check('it is stamped with its section', created.document?.title === 'New essay', created.document?.title ?? 'none');

    const dom = await page.evaluate(`(() => ({
      badge: document.querySelector('[data-testid="entry-badge-new-essay"]')?.textContent ?? null,
      date: document.querySelector('[data-testid="entry-date-new-essay"]')?.textContent ?? null,
      bands: document.querySelectorAll('[data-testid^="surface-band-"]').length,
    }))()`);
    check('the row is badged new', dom.badge === 'new', dom.badge ?? 'none');
    check('and dated', /^\d{4}-\d{2}-\d{2}$/.test(dom.date ?? ''), dom.date ?? 'none');
    check('the editor opened on something typeable', dom.bands === 1, `${dom.bands} band(s)`);
    console.log(`    shot  ${await page.shot('13-essays-created')}`);
  }

  /* ---------------------------------------------------------------------- */
  section('the unsaved-changes guard refuses a section change');
  {
    // Dirty the open document, then try to leave.
    await page.evaluate(`(() => {
      window.__wsd.store.docStore('essays').updateMeta({ title: 'Edited, not saved' });
      window.__confirms = [];
      window.confirm = (message) => { window.__confirms.push(message); return false; };
      return true;
    })()`);
    await page.settle();
    const dirty = await page.probe();
    check('the document is dirty', dirty.dirty === true);

    await page.click('section-row-filmography');
    await page.quiet();
    const refused = await page.probe();
    const asked = await page.evaluate('window.__confirms.length');
    check('the guard was asked exactly once', asked === 1, `${asked}`);
    check('and the shell stayed put', refused.section === 'essays', refused.section ?? 'none');
    check('with the editor still open and still dirty', refused.editorKind === 'document' && refused.dirty === true);
    console.log(`    shot  ${await page.shot('14-guard')}`);

    await page.evaluate('window.confirm = () => true');
    await page.click('section-row-filmography');
    await page.quiet();
    const allowed = await page.probe();
    check('saying yes lets it through', allowed.section === 'filmography', allowed.section ?? 'none');
  }

  /* ---------------------------------------------------------------------- */
  section('desktop only, below 900px');
  {
    await page.setViewport(NARROW);
    const narrow = await page.evaluate(`({
      notice: getComputedStyle(document.querySelector('[data-testid="site-narrow"]')).display,
      body: getComputedStyle(document.querySelector('.cms-site__body')).display,
      bar: getComputedStyle(document.querySelector('.cms-site__bar')).display,
    })`);
    check('the shell is replaced by a notice', narrow.notice !== 'none', narrow.notice);
    check('and the three columns are gone', narrow.body === 'none');
    check('and so is the top bar', narrow.bar === 'none');
    console.log(`    shot  ${await page.shot('15-narrow')}`);
    await page.setViewport(WIDE);
  }

  /* ---------------------------------------------------------------------- */
  section('console');
  const realErrors = page.consoleErrors.filter((text) => !text.includes('Download the React DevTools'));
  check('no console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
  check('no uncaught exceptions', page.pageErrors.length === 0, page.pageErrors.slice(0, 2).join(' | '));
  if (page.consoleWarnings.length > 0) {
    console.log(
      `    note  ${page.consoleWarnings.length} console warning(s): ${page.consoleWarnings.slice(0, 3).join(' | ')}`,
    );
  }
}

main()
  .then(() => {
    console.log(`\n  ${total - failures}/${total} checks passed`);
    console.log(`  screenshots in ${SHOTS_DIR}`);
    if (failures > 0) {
      console.log(`  ${failures} FAILED\n`);
      process.exit(1);
    }
    console.log('  WS-D navigation shell verified in headless Chrome\n');
  })
  .catch((error) => {
    console.error(`\n  harness run failed: ${error.message}`);
    if (error.stack) console.error(error.stack.split('\n').slice(1, 4).join('\n'));
    process.exit(1);
  });
