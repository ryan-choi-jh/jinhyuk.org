/**
 * src/cms/app/records/harness/drive.mjs
 *
 * WS-E's browser proof. Builds the harness, opens it in headless Chrome over
 * `file://`, drives the REAL film and album editors with synthesised input —
 * typing, a multi-file selection, a pointer drag, clicks — asserts the JSON
 * they emit, and writes screenshots.
 *
 *   node src/cms/app/records/harness/drive.mjs
 *   CMS_RECORDS_OUT=/tmp/wse node src/cms/app/records/harness/drive.mjs
 *
 * No server and no API: the page is a local file, the fixtures are baked into
 * the bundle, and uploads go to a fake function inside the page. The request
 * log is asserted at the end, so "it never talks to the network" is a check
 * rather than a claim. Chrome is spoken to over the DevTools protocol with
 * Node's built-in WebSocket, so there is no new dependency.
 *
 * Exit code 0 means every check passed.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUT_DIR = process.env.CMS_RECORDS_OUT ?? fileURLToPath(new URL('.out', import.meta.url));
const SHOTS_DIR = join(OUT_DIR, 'shots');
const FILES_DIR = join(OUT_DIR, 'files');
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const WIDE = { width: 1500, height: 1000 };
const NARROW = { width: 820, height: 1000 };

/* -------------------------------------------------------------------------- */
/* Checks                                                                      */
/* -------------------------------------------------------------------------- */

let failures = 0;
let total = 0;

function check(label, ok, detail = '') {
  total += 1;
  if (ok) console.log(`    ok    ${label}${detail ? ` (${detail})` : ''}`);
  else {
    failures += 1;
    console.log(`    FAIL  ${label}${detail ? ` (${detail})` : ''}`);
  }
}

function equal(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, a === b ? '' : `got ${a} want ${b}`);
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
        if (message.error !== undefined) entry.reject(new Error(message.error.message));
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
      socket.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), {
        once: true,
      });
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

const t = (id) => `[data-testid="${id}"]`;

class Page {
  constructor(cdp) {
    this.cdp = cdp;
    this.consoleErrors = [];
    this.consoleWarnings = [];
    this.pageErrors = [];
    this.requests = [];
    this.failedRequests = [];
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
      throw new Error(`evaluate failed: ${text}\n  while evaluating: ${expression.slice(0, 240)}`);
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
    return this.evaluate('window.__wse.probe()');
  }

  seam(call) {
    return this.evaluate(`window.__wse.${call}`);
  }

  async waitFor(expression, label, timeout = 8000) {
    const started = Date.now();
    for (;;) {
      if (await this.evaluate(`Boolean(${expression})`)) return true;
      if (Date.now() - started > timeout) {
        throw new Error(`timed out waiting for ${label}: ${expression}`);
      }
      await sleep(50);
    }
  }

  rect(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 };
    })()`);
  }

  exists(selector) {
    return this.evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`);
  }

  count(selector) {
    return this.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  }

  text(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el === null ? null : el.textContent.trim();
    })()`);
  }

  attr(selector, name) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el === null ? null : el.getAttribute(${JSON.stringify(name)});
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

  async scrollIntoView(selector) {
    await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return false;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      return true;
    })()`);
    await this.settle();
  }

  async click(selector) {
    await this.scrollIntoView(selector);
    const box = await this.rect(selector);
    if (box === null || !box.visible) throw new Error(`cannot click ${selector}: not visible`);
    const x = box.x + box.w / 2;
    const y = box.y + box.h / 2;
    await this.mouse('mouseMoved', x, y, { buttons: 0 });
    await this.mouse('mousePressed', x, y);
    await this.mouse('mouseReleased', x, y);
    await this.settle();
  }

  /** Press in the middle of `selector`, travel to (x, y) in steps, release. */
  async dragFromTo(selector, x, y, steps = 14) {
    const box = await this.rect(selector);
    if (box === null) throw new Error(`cannot drag ${selector}`);
    const startX = box.x + box.w / 2;
    const startY = box.y + box.h / 2;
    await this.mouse('mouseMoved', startX, startY, { buttons: 0 });
    await this.mouse('mousePressed', startX, startY);
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      await this.mouse('mouseMoved', startX + (x - startX) * ratio, startY + (y - startY) * ratio);
      await sleep(10);
    }
    await this.mouse('mouseReleased', x, y);
    await this.settle();
  }

  /** Focus a field, select what is in it, type `text` as real input events. */
  async type(selector, text) {
    await this.click(selector);
    await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.focus();
      if (typeof el.select === 'function') el.select();
      return true;
    })()`);
    await this.cdp.send('Input.insertText', { text });
    await this.settle();
  }

  /** Put real files on a real `<input type="file">`, the way a file dialog does. */
  async setFiles(selector, paths) {
    const node = await this.cdp.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
    });
    const objectId = node.result?.objectId;
    if (objectId === undefined) throw new Error(`no file input at ${selector}`);
    await this.cdp.send('DOM.setFileInputFiles', { files: paths, objectId });
    await this.settle();
  }

  /** A real drop, with a DataTransfer built in the page. */
  async dropFiles(selector, names) {
    await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) throw new Error('no drop target');
      const transfer = new DataTransfer();
      for (const name of ${JSON.stringify(names)}) {
        transfer.items.add(new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' }));
      }
      const rect = el.getBoundingClientRect();
      const base = {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      };
      el.dispatchEvent(new DragEvent('dragenter', base));
      el.dispatchEvent(new DragEvent('dragover', base));
      el.dispatchEvent(new DragEvent('drop', base));
      return true;
    })()`);
    await this.settle();
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
  const profile = await mkdtemp(join(tmpdir(), 'cms-wse-chrome-'));
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--window-size=${WIDE.width},${WIDE.height}`,
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
    if (child.exitCode !== null) throw new Error(`Chrome exited with ${child.exitCode}:\n${stderr}`);
    await sleep(100);
  }
  if (port === null) throw new Error(`Chrome never reported a debugging port:\n${stderr}`);
  return { child, profile, port };
}

async function firstPageTarget(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    const target = targets.find(
      (candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl,
    );
    if (target !== undefined) return target;
    await sleep(100);
  }
  throw new Error('Chrome never produced a page target');
}

/* -------------------------------------------------------------------------- */
/* The files a "file dialog" hands over                                        */
/* -------------------------------------------------------------------------- */

/** A valid 1x1 PNG. The content is irrelevant: the upload is fake, the name is not. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const BATCH = [
  '01-arrival.png',
  '02-rooftops.png',
  '03-market.png',
  '04-fail-the-first-time.png',
  '05-river.png',
  '06-last-light.png',
];
/** Not an image, so the editor must refuse it without losing the other six. */
const REFUSED = 'notes.pdf';

function writeFakeFiles() {
  mkdirSync(FILES_DIR, { recursive: true });
  const paths = [];
  for (const name of [...BATCH, REFUSED]) {
    const file = join(FILES_DIR, name);
    writeFileSync(file, ONE_PIXEL_PNG);
    paths.push(file);
  }
  return paths;
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

async function main() {
  if (process.env.CMS_RECORDS_SKIP_BUILD !== '1') await import('./build.mjs');

  mkdirSync(SHOTS_DIR, { recursive: true });
  const filePaths = writeFakeFiles();

  const htmlPath = join(OUT_DIR, 'harness.html');
  if (!existsSync(htmlPath)) throw new Error(`no harness at ${htmlPath}; run build.mjs first`);
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
  cdp.on('Network.requestWillBeSent', (params) => {
    page.requests.push(params.request.url);
  });
  cdp.on('Network.loadingFailed', (params) => {
    page.failedRequests.push(params.requestId);
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Network.enable');
  // Nothing in these editors should reach YouTube until someone presses play,
  // and even then nothing should leave this machine during a test run.
  await cdp.send('Network.setBlockedURLs', { urls: ['*youtube-nocookie.com*', '*ytimg.com*'] });
  await page.setViewport(WIDE);

  const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
  await cdp.send('Page.navigate', { url });
  await loaded;

  let booted = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    booted = await page.evaluate(
      'Boolean(window.__wse) && document.querySelector("[data-testid=\\"film-editor\\"]") !== null',
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

  try {
    await run(page, filePaths);
  } finally {
    cdp.close();
    chrome.child.kill('SIGKILL');
    await rm(chrome.profile, { recursive: true, force: true }).catch(() => {});
  }
}

async function run(page, filePaths) {
  const batchPaths = filePaths.filter((path) => !path.endsWith(REFUSED));
  const refusedPath = filePaths.find((path) => path.endsWith(REFUSED));

  /* ====================================================================== */
  section('the film editor, from WS-A\'s first fixture film');

  let probe = await page.probe();
  equal('it opens on the fixture film', probe.film.id, 'film_untitled');
  equal('with its video id', probe.film.youtubeId, 'EudrajWcwwg');
  check('and it is valid as it stands', probe.film.valid === true);
  equal('the poster is the film\'s own upload', await page.text(t('poster-origin')), 'Your poster');
  check('the poster image is in the DOM', await page.exists(t('film-poster-img')));
  check(
    'the poster really drew (a file from public/)',
    await page.evaluate(
      `(() => { const i = document.querySelector('${t('film-poster-img')}'); return i !== null && i.naturalWidth > 0; })()`,
    ),
  );
  check('the player is NOT mounted until someone asks', !(await page.exists(t('film-embed'))));
  await page.shot('01-film-poster');

  /* ---------------------------------------------------------------------- */
  section('pasting a link that is not YouTube');

  await page.type(t('field-youtube'), 'https://vimeo.com/123456');
  probe = await page.probe();
  equal('the record is untouched', probe.film.youtubeId, 'EudrajWcwwg');
  check('and the editor says so', (await page.text(t('problem-youtubeId'))).includes('not a YouTube link'));
  await page.shot('02-film-bad-link');

  /* ---------------------------------------------------------------------- */
  section('pasting a real one, in every shape');

  for (const [input, expected] of [
    ['https://www.youtube.com/watch?v=6SUlwRLFuCc&t=12s', '6SUlwRLFuCc'],
    ['https://youtu.be/2jiXj6uOuDs?t=9', '2jiXj6uOuDs'],
    ['https://www.youtube.com/embed/i98vcdfRUqE', 'i98vcdfRUqE'],
    ['https://m.youtube.com/shorts/EudrajWcwwg', 'EudrajWcwwg'],
  ]) {
    await page.type(t('field-youtube'), input);
    probe = await page.probe();
    equal(`${input.slice(0, 46)} -> ${expected}`, probe.film.youtubeId, expected);
  }
  equal('the id is shown back', await page.text(t('youtube-id')), 'id EudrajWcwwg');
  check('no problem line any more', !(await page.exists(t('problem-youtubeId'))));

  /* ---------------------------------------------------------------------- */
  section('the poster frame');

  await page.click(t('poster-clear'));
  probe = await page.probe();
  equal('clearing the upload falls back to YouTube', probe.film.poster, null);
  check(
    'and the badge says which frame this is',
    (await page.text(t('poster-origin'))).startsWith('YouTube'),
    await page.text(t('poster-origin')),
  );
  await page.shot('03-film-youtube-frame');

  await page.click(t('poster-pin'));
  probe = await page.probe();
  check(
    'keeping YouTube\'s frame writes it into the record',
    probe.film.poster === 'https://i.ytimg.com/vi/EudrajWcwwg/maxresdefault.jpg' ||
      probe.film.poster === 'https://i.ytimg.com/vi/EudrajWcwwg/hqdefault.jpg' ||
      probe.film.poster === 'https://i.ytimg.com/vi/EudrajWcwwg/mqdefault.jpg',
    String(probe.film.poster),
  );
  check('which is still a valid film', probe.film.valid === true);

  await page.setFiles(t('film-poster-pick-input'), [batchPaths[0]]);
  await page.waitFor(
    `window.__wse.probe().film.poster.startsWith('/projects/')`,
    'the poster upload to land',
  );
  probe = await page.probe();
  check('an uploaded poster replaces it', probe.film.poster.startsWith('/projects/'), probe.film.poster);
  equal('one upload call was made', probe.uploads.length, 1);
  equal('the badge flips back', await page.text(t('poster-origin')), 'Your poster');

  /* ---------------------------------------------------------------------- */
  section('the other fields, and the JSON that comes out');

  await page.type(t('field-title'), 'The Space Race');
  await page.type(t('field-kind'), 'TRAILER');
  await page.type(t('field-year'), '2018-2019');
  await page.type(t('field-note'), 'Role: Perseus. UCL Film Festival.');
  probe = await page.probe();
  equal('title', probe.film.title, 'The Space Race');
  equal('kind', probe.film.kind, 'TRAILER');
  equal('year', probe.film.year, '2018-2019');
  equal('note', probe.film.note, 'Role: Perseus. UCL Film Festival.');
  equal('keys come out in schema order', probe.film.keys, [
    'id',
    'youtubeId',
    'title',
    'note',
    'kind',
    'year',
    'poster',
  ]);
  check('the record validates', probe.film.valid === true);
  equal('the heading follows the title', await page.text(t('film-heading')), 'The Space Race');

  await page.type(t('field-note'), '   ');
  probe = await page.probe();
  equal('a blanked note is dropped, not stored as ""', probe.film.note, null);
  equal('and the key is gone', probe.film.keys.includes('note'), false);

  await page.type(t('field-year'), '19');
  probe = await page.probe();
  check('a bad year is refused by the validator', probe.film.valid === false);
  check('the field says why', (await page.text(t('problem-year'))).includes('Four digits'));
  check('and the editor lists what is outstanding', await page.exists(t('film-outstanding')));
  await page.shot('04-film-year-problem');
  await page.type(t('field-year'), '2019');
  probe = await page.probe();
  check('fixing it clears the block', probe.film.valid === true);

  /* ---------------------------------------------------------------------- */
  section('click to play, exactly like the live page');

  await page.click(t('film-play'));
  check('the player mounts', await page.exists(t('film-embed')));
  equal(
    'with the privacy-preserving autoplay embed',
    await page.attr(t('film-embed'), 'src'),
    'https://www.youtube-nocookie.com/embed/EudrajWcwwg?autoplay=1&rel=0',
  );
  await page.shot('05-film-playing');
  await page.click(t('film-stop'));
  check('and goes back to the poster', !(await page.exists(t('film-embed'))));

  /* ---------------------------------------------------------------------- */
  section('a film with no video yet');

  await page.seam('loadBlankFilm()');
  await page.settle();
  probe = await page.probe();
  check('a new film is NOT saveable', probe.film.valid === false);
  check('the stage says what is missing', await page.exists(t('film-stage-empty')));
  check('the YouTube field is the thing being asked for', await page.exists(t('problem-youtubeId')));
  await page.shot('06-film-empty');

  /* ====================================================================== */
  section('the album editor, starting empty');

  await page.click(t('tab-album'));
  check('the album editor is up', await page.exists(t('album-editor')));
  probe = await page.probe();
  equal('with no photos', probe.album.photoIds, []);
  check('an empty album is still valid', probe.album.valid === true);
  check('and it says what to do', await page.exists(t('photo-empty')));
  equal('the slug came from the title', probe.album.slug, 'summer-in-seoul');
  equal('and the URL is shown', await page.text(t('url-slug')), '/photography/summer-in-seoul/');
  await page.shot('07-album-empty');

  /* ---------------------------------------------------------------------- */
  section('six photos and a PDF in one go');

  await page.setFiles(t('album-photo-pick-input'), [...batchPaths, refusedPath]);
  // Mid-flight: three in the air, the rest queued.
  await sleep(120);
  const flight = await page.evaluate(`({
    uploading: document.querySelectorAll('[data-testid^="upload-task-"][data-status="uploading"]').length,
    queued: document.querySelectorAll('[data-testid^="upload-task-"][data-status="queued"]').length,
    status: (document.querySelector('${t('upload-status')}') || {}).textContent || '',
  })`);
  check('three are in the air at once', flight.uploading === 3, `uploading ${flight.uploading}`);
  check('the rest are queued', flight.queued === 3, `queued ${flight.queued}`);
  check('with a line saying so', /Uploading \d of 6/.test(flight.status), flight.status);
  await page.shot('08-album-uploading');

  await page.waitFor(
    `document.querySelectorAll('[data-testid^="upload-task-"][data-status="uploading"], [data-testid^="upload-task-"][data-status="queued"]').length === 0`,
    'the batch to finish',
  );
  probe = await page.probe();
  equal('five landed, one failed', probe.album.photoIds.length, 5);
  equal(
    'in the order they were chosen, not the order they finished',
    probe.album.photoSrcs.map((src) => src.match(/blocks\/(\d+)\//)[1]),
    ['2', '6', '8', '12', '14'],
  );
  check('the PDF was refused', probe.notices.some((line) => line.includes('notes.pdf')));
  check(
    'and all six images were sent (the first was also the film poster, so it is on attempt 2)',
    BATCH.every((name) => probe.uploads.some((line) => line.startsWith(name))),
    probe.uploads.join(' '),
  );
  check('every photo carries both intrinsic dimensions', probe.album.dims.every((dim) => dim !== null));
  check('the album validates', probe.album.valid === true);
  equal('one failed tile is still on screen', await page.count('[data-status="failed"]'), 1);

  /* ---------------------------------------------------------------------- */
  section('retrying the one that failed');

  const failedKey = await page.evaluate(
    `document.querySelector('[data-status="failed"]').dataset.testid.replace('upload-task-', '')`,
  );
  await page.click(t(`upload-retry-${failedKey}`));
  await page.waitFor(`window.__wse.probe().album.photoIds.length === 6`, 'the retry to land');
  probe = await page.probe();
  equal('it lands back in its own place', probe.album.photoSrcs.map((src) => src.match(/blocks\/(\d+)\//)[1]), [
    '2',
    '6',
    '8',
    '10',
    '12',
    '14',
  ]);
  equal('the retried file was asked for twice', probe.uploads.filter((line) => line.includes('04-fail')).length, 2);
  check('no failed tiles left', (await page.count('[data-status="failed"]')) === 0);
  check('the album still validates', probe.album.valid === true);
  await page.shot('09-album-six-photos');

  /* ---------------------------------------------------------------------- */
  section('dragging a photo into place');

  const before = (await page.probe()).album.photoIds;
  const fifth = before[4];
  const second = before[1];
  const targetCell = await page.rect(t(`photo-tile-${second}`));
  await page.dragFromTo(
    t(`photo-thumb-${fifth}`),
    targetCell.x + targetCell.w / 2,
    targetCell.y + targetCell.h / 2,
  );
  probe = await page.probe();
  equal(
    'the fifth photo is now the second',
    probe.album.photoIds,
    [before[0], before[4], before[1], before[2], before[3], before[5]],
  );
  check('and the album is still valid', probe.album.valid === true);
  equal(
    'the tile numbers follow the new order',
    await page.attr(t(`photo-tile-${fifth}`), 'data-index'),
    '1',
  );

  const arrowed = (await page.probe()).album.photoIds;
  await page.click(t(`photo-left-${arrowed[1]}`));
  probe = await page.probe();
  equal(
    'the arrow buttons are the keyboard path to the same thing',
    probe.album.photoIds,
    [arrowed[1], arrowed[0], arrowed[2], arrowed[3], arrowed[4], arrowed[5]],
  );
  await page.shot('10-album-reordered');

  /* ---------------------------------------------------------------------- */
  section('choosing a cover');

  let ids = (await page.probe()).album.photoIds;
  equal('with nothing chosen, the first photo is the cover', await page.attr(t('album-editor'), 'data-cover'), ids[0]);
  equal('and the editor says it is following', await page.text(t('cover-state')), 'The first photo · photo 1');

  await page.click(t(`photo-cover-${ids[3]}`));
  probe = await page.probe();
  equal('starring the fourth tile pins it', probe.album.cover, ids[3]);
  check('the tag moved', await page.exists(t(`photo-cover-tag-${ids[3]}`)));
  check('and the header shows it', (await page.text(t('cover-state'))).startsWith('Chosen'));
  check('the album validates with a chosen cover', probe.album.valid === true);

  await page.click(t(`photo-right-${ids[0]}`));
  probe = await page.probe();
  equal('reordering does not move a pinned cover', probe.album.cover, ids[3]);

  await page.click(t('cover-clear'));
  probe = await page.probe();
  equal('and it can be handed back to the first photo', probe.album.cover, null);
  await page.click(t(`photo-cover-${ids[3]}`));
  await page.shot('11-album-cover');

  /* ---------------------------------------------------------------------- */
  section('alt text and captions, without leaving the grid');

  ids = (await page.probe()).album.photoIds;
  await page.type(t(`photo-alt-${ids[0]}`), 'A tiled roof against a white sky');
  await page.type(t(`photo-caption-${ids[0]}`), 'Bukchon, first morning.');
  probe = await page.probe();
  equal('alt text lands on the right photo', probe.album.alts[0], 'A tiled roof against a white sky');
  equal('so does the caption', probe.album.captions[0], 'Bukchon, first morning.');
  equal('and nothing else was touched', probe.album.alts.slice(1), [null, null, null, null, null]);
  check('the nudge counts the rest', (await page.text(t('alt-nudge'))).startsWith('5 without'));

  await page.type(t(`photo-alt-${ids[0]}`), '  ');
  probe = await page.probe();
  equal('clearing it removes the key rather than storing ""', probe.album.alts[0], null);
  await page.type(t(`photo-alt-${ids[0]}`), 'A tiled roof against a white sky');

  /* ---------------------------------------------------------------------- */
  section('deleting a photo, and changing your mind');

  ids = (await page.probe()).album.photoIds;
  const doomed = ids[2];
  await page.click(t(`photo-remove-${doomed}`));
  probe = await page.probe();
  equal('it is gone', probe.album.photoIds.includes(doomed), false);
  equal('five left', probe.album.photoIds.length, 5);
  check('and there is an undo', await page.exists(t('undo-bar')));
  await page.shot('12-album-undo');

  await page.click(t('undo-remove'));
  probe = await page.probe();
  equal('undo puts it back where it was', probe.album.photoIds, ids);
  check('the undo bar is gone', !(await page.exists(t('undo-bar'))));
  check('and the album validates', probe.album.valid === true);

  const cover = (await page.probe()).album.cover;
  await page.click(t(`photo-remove-${cover}`));
  probe = await page.probe();
  equal('deleting the cover photo clears `cover` in the same edit', probe.album.cover, null);
  check('so the album is never invalid', probe.album.valid === true);
  check('and the undo says what it was', (await page.text(t('undo-bar'))).includes('which was the cover'));
  await page.click(t('undo-remove'));
  probe = await page.probe();
  equal('undo restores the cover choice too', probe.album.cover, cover);

  /* ---------------------------------------------------------------------- */
  section('dropping files on the grid');

  const dropBefore = (await page.probe()).album.photoIds.length;
  await page.dropFiles(t('photo-drop'), ['21-dropped.png', '22-dropped.png']);
  await page.waitFor(
    `window.__wse.probe().album.photoIds.length === ${dropBefore + 2}`,
    'the dropped files to land',
  );
  probe = await page.probe();
  equal('two more photos', probe.album.photoIds.length, dropBefore + 2);
  check('they went to the end', probe.album.photoSrcs.length === dropBefore + 2);
  check('the album still validates', probe.album.valid === true);

  /* ---------------------------------------------------------------------- */
  section('WS-A\'s own six-photo album, and a narrow window');

  await page.seam('loadFullAlbum()');
  await page.settle();
  probe = await page.probe();
  equal('the fixture album loads', probe.album.slug, 'first-build');
  equal('with its six photos', probe.album.photoIds.length, 6);
  equal('and its chosen cover', probe.album.cover, 'ph_build_04');
  check('every photo drew from public/', await page.evaluate(`
    [...document.querySelectorAll('${t('photo-grid')} img')].every((img) => img.naturalWidth > 0)
  `));
  equal('the editor round-trips it unchanged', await page.evaluate(
    'JSON.stringify(window.__wse.album()) === JSON.stringify(window.__wse.fixtures.albums[0])',
  ), true);
  await page.shot('13-album-fixture');

  await page.setViewport(NARROW);
  check('the album editor still fits', (await page.rect(t('album-editor'))).w <= NARROW.width);
  const noOverflow = await page.evaluate(
    'document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1',
  );
  check('with no sideways scroll at 820px', noOverflow === true);
  await page.shot('14-album-narrow');
  await page.setViewport(WIDE);

  /* ---------------------------------------------------------------------- */
  section('nothing went to a server');

  const http = page.requests.filter((request) => request.startsWith('http'));
  const api = page.requests.filter((request) => request.includes('/api/'));
  equal('no API call was ever made', api, []);
  check(
    'the only network URL in the whole run is the blocked YouTube embed',
    http.every((request) => request.includes('youtube-nocookie.com') || request.includes('ytimg.com')),
    http.join(' '),
  );
  check('and it was blocked, so nothing left the machine', page.failedRequests.length >= http.length);
  equal(
    'no uncaught exceptions',
    page.pageErrors.filter((error) => !error.includes('ERR_BLOCKED_BY_CLIENT')),
    [],
  );
  const noise = page.consoleErrors.filter(
    (line) => !line.includes('ERR_BLOCKED_BY_CLIENT') && !line.includes('net::'),
  );
  equal('no console errors', noise, []);

  console.log('');
  console.log(`screenshots in ${SHOTS_DIR}`);
  console.log('');
  if (failures === 0) console.log(`PASS  ${total} checks`);
  else console.log(`FAIL  ${failures} of ${total} checks`);
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((error) => {
    console.error(`\nFAIL  ${error.stack ?? error.message}`);
    process.exit(1);
  });
