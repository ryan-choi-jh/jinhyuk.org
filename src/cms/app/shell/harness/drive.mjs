/**
 * src/cms/app/shell/harness/drive.mjs
 *
 * WS-3's browser proof. Builds the harness, opens it in headless Chrome over
 * `file://`, drives the real UI with synthesised input, asserts what the store
 * and the stub API ended up holding, and writes screenshots.
 *
 *   node src/cms/app/shell/harness/drive.mjs
 *   CMS_HARNESS_OUT=/tmp/ws3 node src/cms/app/shell/harness/drive.mjs
 *
 * No network: the page is a local file, the fixture is baked into the bundle,
 * and the API is the in-memory stub. Chrome is spoken to over the DevTools
 * protocol using Node's built-in WebSocket, so there is no new dependency.
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
  process.env.CMS_HARNESS_OUT ?? fileURLToPath(new URL('.out', import.meta.url));
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
    return this.evaluate('window.__ws3.probe()');
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
      // NOT --hide-scrollbars. It was here to keep the screenshots clean,
      // and it made every scrollbar in the editor zero pixels wide, which
      // is a configuration no reader has. It also made this harness
      // structurally incapable of seeing the "Fit fights the scrollbar"
      // loop below, which is the one that made the editor jitter. The
      // screenshots are a little less tidy and a lot more honest.
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

async function main() {
  // Build first, so a run always tests the current source. CMS_HARNESS_SKIP_BUILD=1
  // to reuse the last bundle.
  if (process.env.CMS_HARNESS_SKIP_BUILD !== '1') await import('./build.mjs');

  mkdirSync(SHOTS_DIR, { recursive: true });

  const htmlPath = join(OUT_DIR, 'harness.html');
  if (!existsSync(htmlPath)) {
    throw new Error(`no harness at ${htmlPath}. Run build.mjs first (same CMS_HARNESS_OUT).`);
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
    page.pageErrors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? '?');
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await page.setViewport(WIDE);

  const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
  await cdp.send('Page.navigate', { url });
  await loaded;

  // Wait for React to mount and the harness seam to appear.
  let booted = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    booted = await page.evaluate('Boolean(window.__ws3) && Boolean(document.querySelector("[data-testid=\\"cms-root\\"]"))');
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
    await run(page);
  } finally {
    cdp.close();
    chrome.child.kill('SIGKILL');
    await rm(chrome.profile, { recursive: true, force: true }).catch(() => {});
  }
}

async function run(page) {
  /* ---------------------------------------------------------------------- */
  section('boot (dense.json, stub API, no network)');
  const boot = await page.probe();
  check('six bands in the document', boot.bandCount === 6, `${boot.bandCount}`);
  check('one overlay band', boot.overlayBandIds.length === 1, boot.overlayBandIds.join(','));
  check('clean on boot', boot.dirty === false);
  check('no history on boot', boot.canUndo === false && boot.canRedo === false);
  check('nothing selected on boot', boot.selection.kind === 'none');
  check('the document validates', boot.valid === true);
  check('the stub was asked who is signed in', boot.calls.includes('authStatus'));
  check('nothing was written on boot', !boot.calls.includes('putDraft'));

  const counts = await page.evaluate(`({
    outlineRows: document.querySelectorAll('[data-testid^="band-row-"]').length,
    surfaceBands: document.querySelectorAll('[data-testid^="surface-band-"]').length,
    stages: document.querySelectorAll('[data-testid^="surface-stage-"]').length,
    items: document.querySelectorAll('[data-testid^="surface-item-"]').length,
    blocks: document.querySelectorAll('[data-testid^="surface-block-"]').length,
    images: document.querySelectorAll('.cms-ph-item__img').length,
    loadedImages: [...document.querySelectorAll('.cms-ph-item__img')].filter((img) => img.naturalWidth > 0).length,
    scale: Number(document.querySelector('[data-testid="page-surface"]').dataset.scale),
    gaps: document.querySelectorAll('[data-testid^="band-gap-"]').length,
  })`);
  check('the outline lists every band', counts.outlineRows === 6, `${counts.outlineRows} rows`);
  check('the page draws every band', counts.surfaceBands === 6, `${counts.surfaceBands}`);
  check('the page draws every canvas stage', counts.stages === 3, `${counts.stages}`);
  check('the page draws every canvas item', counts.items === 11, `${counts.items}`);
  check('the page draws every prose block', counts.blocks === 7, `${counts.blocks}`);
  check('there is an insert gap above and below every band', counts.gaps === 7, `${counts.gaps}`);
  check('the page is scaled down to fit the pane', counts.scale > 0 && counts.scale < 1, `scale ${counts.scale}`);
  check('fixture images really loaded from public/', counts.loadedImages === counts.images && counts.images === 5, `${counts.loadedImages}/${counts.images}`);

  const panes = await page.evaluate(`(() => {
    const r = (sel) => { const el = document.querySelector(sel); const b = el.getBoundingClientRect(); return Math.round(b.width); };
    return { left: r('.cms-pane--left'), centre: r('.cms-pane--centre'), right: r('.cms-pane--right'),
             narrow: getComputedStyle(document.querySelector('[data-testid="narrow-notice"]')).display };
  })()`);
  check('three panes, left and right fixed', panes.left === 268 && panes.right === 304, `${panes.left}/${panes.centre}/${panes.right}`);
  check('the desktop-only notice is hidden at 1600px', panes.narrow === 'none');

  const insertSelector = '[data-testid="band-gap-1"] .cms-outline__insert';
  const gapResting = await page.evaluate(`getComputedStyle(document.querySelector('${insertSelector}')).opacity`);
  check('the insert buttons stay out of the way until a gap is hovered', gapResting === '0', gapResting);
  const gapBox = await page.rect('band-gap-1');
  await page.mouse('mouseMoved', gapBox.x + gapBox.w / 2, gapBox.y + gapBox.h / 2, { buttons: 0 });
  await sleep(200);
  const gapHovered = await page.evaluate(`getComputedStyle(document.querySelector('${insertSelector}')).opacity`);
  check('and appear when it is', gapHovered === '1', gapHovered);
  await page.mouse('mouseMoved', 800, 980, { buttons: 0 });
  await sleep(200);
  console.log(`    shot  ${await page.shot('01-boot')}`);

  /* ---------------------------------------------------------------------- */
  section('selection: band, prose block, canvas item');
  await page.click('band-row-b_dense_overlay');
  let state = await page.probe();
  check('clicking an outline row selects the band', state.selection.kind === 'band' && state.selection.bandId === 'b_dense_overlay');
  const overlayToggle = await page.evaluate(
    `document.querySelector('[data-testid="overlay-toggle"]').checked`,
  );
  check('the inspector shows the overlay flag set', overlayToggle === true);
  const heightValue = await page.evaluate(`document.querySelector('[data-testid="band-height"]').value`);
  check('the inspector shows the band height', heightValue === '460', heightValue);
  check('selecting is not an edit', state.dirty === false && state.canUndo === false);
  console.log(`    shot  ${await page.shot('02-band-selected')}`);

  await page.click('outline-item-i_dense_rotated');
  state = await page.probe();
  check('clicking an outline child selects the canvas item', state.selection.kind === 'item' && state.selection.itemIds[0] === 'i_dense_rotated');
  const xValue = await page.evaluate(`document.querySelector('[data-testid="item-x"]').value`);
  check('the inspector shows the item geometry', xValue === '1070', xValue);

  await page.click('surface-block-p_dense_anchor');
  state = await page.probe();
  check('clicking a paragraph on the page selects that block', state.selection.kind === 'block' && state.selection.blockId === 'p_dense_anchor');

  await page.click('surface-item-i_dense_stack_3');
  state = await page.probe();
  check('clicking an item on the page selects it', state.selection.kind === 'item' && state.selection.itemIds[0] === 'i_dense_stack_3');

  /* ---------------------------------------------------------------------- */
  section('editing through the inspector');
  await page.click('outline-item-i_dense_rotated');
  await page.type('item-x', '900');
  state = await page.probe();
  const movedX = await page.evaluate(
    `window.__ws3.store.getState().doc.bands[1].items.find((i) => i.id === 'i_dense_rotated').x`,
  );
  check('typing in the inspector writes to the document', movedX === 900, `x = ${movedX}`);
  check('that edit marks the document dirty', state.dirty === true);
  check('that edit is undoable', state.canUndo === true, `undo "${state.undoLabel}"`);
  check('the document is still valid', state.valid === true);
  console.log(`    shot  ${await page.shot('03-item-edited')}`);

  /* ---------------------------------------------------------------------- */
  section('the Date field says which number is the month');
  {
    // Page metadata only shows when nothing is selected, and the section
    // above left a canvas item selected.
    await page.click('inspector-back');
    await page.settle();

    // The input holds ISO and the browser renders it in its own locale, so
    // the number order on screen is whatever this machine prefers. What has
    // to be true is that the written-out line under it agrees with the stored
    // date, because that line is the one the author reads.
    const stored = await page.evaluate('window.__ws3.store.getState().doc.meta.date');
    const shown = await page.evaluate(
      `document.querySelector('[data-testid="meta-date"]').value`,
    );
    const written = await page.evaluate(
      `document.querySelector('[data-testid="meta-date-read"]').textContent`,
    );
    check('the input carries the stored ISO date', shown === stored, `${shown} vs ${stored}`);
    check(
      'and it is written out underneath with the month as a word',
      /^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(written ?? ''),
      written,
    );
    // The point of the feature: the words have to name the same day the ISO
    // does, or the field is worse than no field.
    const [y, m, d] = (stored ?? '').split('-').map(Number);
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    check(
      'and it names the same day, not one either side of it',
      written === `${months[m - 1]} ${d}, ${y}`,
      `${written} for ${stored}`,
    );

    // Clicking anywhere in the field opens the calendar, rather than only the
    // small icon at its right-hand end.
    await page.evaluate(`(() => {
      window.__pickerOpens = 0;
      HTMLInputElement.prototype.showPicker = function () { window.__pickerOpens += 1; };
      return true;
    })()`);
    await page.click('meta-date');
    const opens = await page.evaluate('window.__pickerOpens');
    check('clicking the field opens the calendar', opens >= 1, `showPicker called ${opens}x`);

    // And the field is still an editor, not a readout.
    await page.evaluate(`(() => {
      const el = document.querySelector('[data-testid="meta-date"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, '2031-03-07');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await page.settle();
    const after = await page.evaluate('window.__ws3.store.getState().doc.meta.date');
    const afterWritten = await page.evaluate(
      `document.querySelector('[data-testid="meta-date-read"]').textContent`,
    );
    check('picking a date writes it to the document', after === '2031-03-07', after);
    // 03/07 is the case the whole field exists for: March or July depending on
    // where you live, and the words have to settle it.
    check('and the words follow it', afterWritten === 'March 7, 2031', afterWritten);

    await page.evaluate('window.__ws3.store.undo()');
    await page.settle();
  }

  /* ---------------------------------------------------------------------- */
  section('an overlay band is outlined round its items, not its layer');
  {
    const overlayId = await page.evaluate(`(() => {
      const b = window.__ws3.store.getState().doc.bands.find((x) => x.type === 'canvas' && x.overlay === true);
      return b ? b.id : null;
    })()`);
    check('the fixture has an overlay band', overlayId !== null, String(overlayId));

    await page.click(`band-row-${overlayId}`);
    await page.settle();

    const m = await page.evaluate(`(() => {
      const band = document.querySelector('.cms-band-box--overlay');
      const frame = document.querySelector('.cms-band-box__frame');
      const items = [...document.querySelectorAll('.cms-band-box--overlay [data-item-id]')]
        .map((e) => e.getBoundingClientRect());
      const hull = items.length === 0 ? null : {
        left: Math.round(Math.min(...items.map((i) => i.left))),
        top: Math.round(Math.min(...items.map((i) => i.top))),
        right: Math.round(Math.max(...items.map((i) => i.right))),
        bottom: Math.round(Math.max(...items.map((i) => i.bottom))),
      };
      const f = frame === null ? null : frame.getBoundingClientRect();
      const layer = band === null ? null : band.getBoundingClientRect();
      return {
        layerOutline: band === null ? null : getComputedStyle(band).outlineStyle,
        frame: f === null ? null : {
          left: Math.round(f.left), top: Math.round(f.top),
          right: Math.round(f.right), bottom: Math.round(f.bottom),
        },
        hull,
        layerHeight: layer === null ? null : Math.round(layer.height),
        label: document.querySelector('.cms-band-box__frame .cms-band-box__label')?.textContent?.trim() ?? null,
      };
    })()`);

    check('the layer itself is not outlined', m.layerOutline === 'none', String(m.layerOutline));
    check('a frame is drawn instead', m.frame !== null);
    if (m.frame !== null && m.hull !== null) {
      // Against the AUTHORED boxes, not the measured DOM. The placeholder
      // items wear a little type tag that overhangs them by a few pixels,
      // and that is editor chrome, not part of the item: the frame is
      // supposed to hug what is on the page.
      const want = await page.evaluate(`(() => {
        const band = window.__ws3.store.getState().doc.bands.find((x) => x.id === '${overlayId}');
        const xs = band.items.map((i) => i.x);
        const ys = band.items.map((i) => i.y);
        return {
          left: Math.min(...xs),
          top: Math.min(...ys),
          width: Math.max(...band.items.map((i) => i.x + i.w)) - Math.min(...xs),
          height: Math.max(...band.items.map((i) => i.y + i.h)) - Math.min(...ys),
        };
      })()`);
      const got = await page.evaluate(`(() => {
        const f = document.querySelector('.cms-band-box__frame');
        return { left: f.offsetLeft, top: f.offsetTop, width: f.offsetWidth, height: f.offsetHeight };
      })()`);
      const near = (a, b) => Math.abs(a - b) <= 1;
      check(
        'and it is exactly the items’ authored bounding box',
        near(got.left, want.left) && near(got.top, want.top) &&
          near(got.width, want.width) && near(got.height, want.height),
        `${JSON.stringify(got)} vs ${JSON.stringify(want)}`,
      );
      check(
        'which is smaller than the layer it floats in',
        m.frame.bottom - m.frame.top < m.layerHeight,
        `${m.frame.bottom - m.frame.top}px of ${m.layerHeight}px`,
      );
    }
    check('the band label rides on the frame', (m.label ?? '').includes('overlay'), String(m.label));

    // A NON-overlay canvas band still outlines its whole box: there the box
    // is the band's real footprint on the page.
    const plainId = await page.evaluate(`(() => {
      const b = window.__ws3.store.getState().doc.bands.find((x) => x.type === 'canvas' && x.overlay !== true);
      return b ? b.id : null;
    })()`);
    await page.click(`band-row-${plainId}`);
    await page.settle();
    const plain = await page.evaluate(`(() => {
      const el = document.querySelector('[data-band-id="${'$'}{plainId}"]');
      return null;
    })()`).catch(() => null);
    const plainOutline = await page.evaluate(
      `getComputedStyle(document.querySelector('[data-band-id="${'PLAIN'}"]') || document.body).outlineStyle`,
    );
    check('a plain canvas band keeps its full outline',
      (await page.evaluate(`(() => {
        const el = document.querySelector('.cms-band-box--selected:not(.cms-band-box--overlay)');
        return el === null ? null : getComputedStyle(el).outlineStyle;
      })()`)) === 'solid');
  }

  /* ---------------------------------------------------------------------- */
  section('connectors are drawn over the editing surface');
  {
    // The fixture anchors i_dense_connector to a paragraph. Until this worked,
    // an anchored item looked inert here and the curve only appeared in
    // Preview — a strange way to find out the anchor had taken.
    const conn = await page.evaluate(`(() => {
      const svg = document.querySelector('.cms-surface .doc-connectors');
      const paths = svg === null ? [] : [...svg.querySelectorAll('path')];
      const inner = document.querySelector('.cms-surface__inner');
      return {
        svg: svg !== null,
        paths: paths.length,
        d: paths[0]?.getAttribute('d') ?? null,
        hooked: document.querySelectorAll('.doc-item[data-anchor-block]').length,
        seeded: document.querySelectorAll('[data-connector-seed]').length > 0,
        breakpoint: getComputedStyle(inner).getPropertyValue('--doc-mobile-breakpoint').trim(),
      };
    })()`);
    check('the overlay is in the surface', conn.svg);
    check('the anchored item carries the hook the script looks for', conn.hooked === 1, `${conn.hooked}`);
    check('and a wobble seed, so the curve matches the published one', conn.seeded);
    check('the breakpoint is readable from the surface', conn.breakpoint === '900px', conn.breakpoint);
    check('a curve is drawn', conn.paths === 1, `${conn.paths} path(s)`);

    // Moving the item must move the line: that is the whole point of drawing
    // it here rather than only in Preview.
    await page.evaluate(`(() => {
      const s = window.__ws3.store;
      const band = s.getState().doc.bands.find((b) => b.type === 'canvas' && b.items.some((i) => i.anchor));
      const i = band.items.find((x) => x.anchor);
      s.updateCanvasItem(band.id, i.id, { y: i.y + 90 });
    })()`);
    await page.settle();
    await sleep(250);
    const moved = await page.evaluate(
      `document.querySelector('.cms-surface .doc-connectors path')?.getAttribute('d') ?? null`,
    );
    check('and it follows the item', moved !== null && moved !== conn.d);

    await page.evaluate(`(() => {
      const s = window.__ws3.store;
      const band = s.getState().doc.bands.find((b) => b.type === 'canvas' && b.items.some((i) => i.anchor));
      const i = band.items.find((x) => x.anchor);
      s.updateCanvasItem(band.id, i.id, { y: i.y - 90 });
    })()`);
    await page.settle();
  }

  /* ---------------------------------------------------------------------- */
  section('a canvas band follows its contents');
  {
    // Non-destructive on purpose: this runs in the middle of the harness, and
    // a section that deletes the fixture's items leaves every later check
    // testing a different document. Two edits, two undos, back where it was.
    // `bottom` IS `canvasContentHeight`, reached through the harness seam,
    // so the two cannot disagree about captions, padding or rotation.
    const read = () => page.evaluate(`(() => {
      const band = window.__ws3.store.getState().doc.bands.find((b) => b.type === 'canvas');
      return {
        id: band.id,
        height: band.height,
        // The REAL fit, through the seam, not a copy of its formula here.
        // A copy drifted once already: it did not know that a rotated item
        // reaches past its own box, and reported a correct band as 8px wrong.
        bottom: window.__ws3.fitHeight(band.id),
        items: band.items.length,
      };
    })()`);
    const lowest = () => page.evaluate(`(() => {
      const s = window.__ws3.store;
      const band = s.getState().doc.bands.find((b) => b.type === 'canvas');
      let low = band.items[0];
      for (const i of band.items) if (i.y + i.h > low.y + low.h) low = i;
      return low.id;
    })()`);

    // Past COALESCE_MS, so these edits are their own history steps rather
    // than folding into the inspector edit the section above just made.
    await sleep(700);
    const start = await read();
    const lowId = await lowest();
    const lowH = await page.evaluate(
      `window.__ws3.store.getState().doc.bands.find((b) => b.type === 'canvas').items.find((i) => i.id === '${await lowest()}').h`,
    );

    await page.evaluate(`(() => {
      const s = window.__ws3.store;
      const band = s.getState().doc.bands.find((b) => b.type === 'canvas');
      const i = band.items.find((x) => x.id === '${lowId}');
      s.updateCanvasItem(band.id, i.id, { h: i.h / 2 });
    })()`);
    await page.settle();
    const shrunk = await read();
    check('shrinking the lowest item shrinks the band', shrunk.height < start.height,
      `${start.height} -> ${shrunk.height}`);
    check('and the band ends exactly on it', shrunk.height === shrunk.bottom,
      `${shrunk.height} vs ${shrunk.bottom}`);

    await page.evaluate(`(() => {
      const s = window.__ws3.store;
      const band = s.getState().doc.bands.find((b) => b.type === 'canvas');
      const i = band.items.find((x) => x.id === '${lowId}');
      s.updateCanvasItem(band.id, i.id, { h: i.h * 4 });
    })()`);
    await page.settle();
    const grown = await read();
    check('growing it grows the band to match', grown.height === grown.bottom && grown.height > start.height,
      `${grown.height} vs ${grown.bottom}`);

    // Put it back with a forward edit rather than undo. Undo here would walk
    // into the previous section's edit — history folds same-band changes —
    // and later checks read that edit back out of the saved draft.
    await page.evaluate(`(() => {
      const s = window.__ws3.store;
      const band = s.getState().doc.bands.find((b) => b.type === 'canvas');
      s.updateCanvasItem(band.id, '${lowId}', { h: ${lowH} });
    })()`);
    await page.settle();
    const restored = await read();
    check('and restoring the item restores the band',
      restored.height === start.height && restored.items === start.items,
      `${restored.height}/${restored.items} vs ${start.height}/${start.items}`);
  }

  /* ---------------------------------------------------------------------- */
  section('band outline: reorder by drag');
  const before = (await page.probe()).bandIds;
  const lastRow = await page.rect('band-row-b_dense_prose_3');
  await page.dragTo('band-grip-b_dense_prose_1', lastRow.x + 40, lastRow.y + lastRow.h - 2);
  state = await page.probe();
  check('dragging a band changes the order', state.bandIds.join(',') !== before.join(','), state.bandIds.join(' '));
  check('dragging keeps every band', state.bandIds.length === 6);
  check('dragging keeps the same set of bands', [...state.bandIds].sort().join(',') === [...before].sort().join(','));
  check('the drag moved the dragged band down the list', state.bandIds.indexOf('b_dense_prose_1') > before.indexOf('b_dense_prose_1'), `index ${state.bandIds.indexOf('b_dense_prose_1')}`);
  check('the reordered document still validates', state.valid === true);
  check(
    'the overlay band that floated to position 0 lost its overlay flag',
    state.bandIds[0] !== 'b_dense_overlay' || state.overlayBandIds.length === 0,
  );
  check('the drag is one undo step', state.undoLabel === 'move band', String(state.undoLabel));

  /* ---------------------------------------------------------------------- */
  section('band outline: insert and delete');
  await page.click('insert-prose-0');
  state = await page.probe();
  check('inserting at the top adds a band', state.bandCount === 7, `${state.bandCount}`);
  check('the new band is first', state.bandIds[0] !== before[0]);
  check('the new band is selected', state.selection.kind === 'band' && state.selection.bandId === state.bandIds[0]);
  check('the document with a new band validates', state.valid === true);
  const insertedId = state.bandIds[0];

  await page.click(`band-delete-${insertedId}`);
  state = await page.probe();
  check('deleting removes it again', state.bandCount === 6);
  check('the status line offers an undo', state.notice?.undoable === true, String(state.notice?.message));
  await page.click('status-undo');
  state = await page.probe();
  check('that undo brings the band back', state.bandCount === 7);
  check('and it comes back in the same place', state.bandIds[0] === insertedId);

  await page.click('insert-canvas-2');
  state = await page.probe();
  check('a canvas band can be inserted mid-page', state.bandCount === 8, `${state.bandCount}`);
  check('the document still validates', state.valid === true);
  console.log(`    shot  ${await page.shot('04-edited')}`);

  /* ---------------------------------------------------------------------- */
  section('undo and redo actually restore state');
  const editedJson = await page.evaluate('window.__ws3.docJson()');
  const editedProbe = await page.probe();

  let steps = 0;
  while ((await page.probe()).canUndo && steps < 40) {
    await page.click('undo');
    steps += 1;
  }
  state = await page.probe();
  check('undo runs out', state.canUndo === false, `${steps} steps`);
  check('undoing everything restores the original document exactly', state.matchesOriginal === true);
  check('and the document is clean again', state.dirty === false);
  check('and the original band order is back', state.bandIds.join(',') === boot.bandIds.join(','));
  check('and the overlay band is an overlay again', state.overlayBandIds.join(',') === boot.overlayBandIds.join(','));
  check('redo is available', state.canRedo === true, `redo "${state.redoLabel}"`);
  const restoredCounts = await page.evaluate(`({
    outlineRows: document.querySelectorAll('[data-testid^="band-row-"]').length,
    items: document.querySelectorAll('[data-testid^="surface-item-"]').length,
  })`);
  check('the UI redrew the original band list', restoredCounts.outlineRows === 6, `${restoredCounts.outlineRows}`);
  check('the UI redrew the original items', restoredCounts.items === 11, `${restoredCounts.items}`);
  console.log(`    shot  ${await page.shot('05-undone')}`);

  let redone = 0;
  while ((await page.probe()).canRedo && redone < 40) {
    await page.click('redo');
    redone += 1;
  }
  state = await page.probe();
  check('redo runs out', state.canRedo === false, `${redone} steps`);
  check('redo and undo are symmetrical', redone === steps, `${steps} undo, ${redone} redo`);
  const redoneJson = await page.evaluate('window.__ws3.docJson()');
  check('redoing everything restores the edited document byte for byte', redoneJson === editedJson);
  check('the redone document is dirty again', state.dirty === true);
  check('the redone band order matches', state.bandIds.join(',') === editedProbe.bandIds.join(','));
  console.log(`    shot  ${await page.shot('06-redone')}`);

  /* ---------------------------------------------------------------------- */
  section('save, publish, preview');
  await page.click('save');
  for (let attempt = 0; attempt < 50 && (await page.probe()).phase !== 'idle'; attempt += 1) await sleep(50);
  state = await page.probe();
  check('save clears the dirty flag', state.dirty === false);
  check('save wrote a draft to the stub', state.server.hasDraft === true);
  check('save did not touch the published document', state.server.publishedBandCount === 6, `${state.server.publishedBandCount}`);
  check('save recorded a commit', typeof state.lastCommit === 'string' && state.lastCommit.startsWith('stub'), String(state.lastCommit));
  const draftX = await page.evaluate(
    `(() => { const d = window.__ws3.api.snapshot()['fixture-dense'].draft;
       const band = d.bands.find((b) => b.items && b.items.some((i) => i.id === 'i_dense_rotated'));
       return band.items.find((i) => i.id === 'i_dense_rotated').x; })()`,
  );
  check('the saved draft carries the inspector edit', draftX === 900, `x = ${draftX}`);
  check('the Save button disables itself when clean', await page.evaluate(`document.querySelector('[data-testid="save"]').disabled`));

  await page.click('preview');
  for (let attempt = 0; attempt < 50 && (await page.probe()).phase !== 'idle'; attempt += 1) await sleep(50);
  state = await page.probe();
  check('Preview asks to open the preview route', state.previewCount === 1);
  const previewUrl = await page.evaluate('window.__ws3.previews[0].url');
  check('and it addresses the draft', previewUrl === '/preview/fixture-dense?draft=1', String(previewUrl));

  /* Publish goes through the pre-publish checklist now. The dense fixture
     has images with no alt text in it, so the first press opens the list
     rather than publishing: warnings, never a block, and the second press
     goes. A page with nothing to say publishes on the first press, which is
     the case asserted further down. */
  await page.click('publish');
  await sleep(80);
  const listed = await page.evaluate(
    `(() => { const el = document.querySelector('[data-testid="preflight"]'); return el === null ? 0 : el.querySelectorAll('li').length; })()`,
  );
  check('the first press shows the checklist rather than publishing', listed > 0, `${listed} items`);
  check('…and nothing has been published yet', (await page.probe()).server.hasDraft === true);
  await page.click('preflight-go');
  for (let attempt = 0; attempt < 80 && (await page.probe()).phase !== 'idle'; attempt += 1) await sleep(50);
  state = await page.probe();
  check('publish copies the draft over the published document', state.server.publishedBandCount === 8, `${state.server.publishedBandCount}`);
  check('publish deletes the draft (2.3)', state.server.hasDraft === false);
  check('the store knows the draft is gone', state.hasDraft === false);
  check('still clean after publishing', state.dirty === false);
  console.log(`    shot  ${await page.shot('07-published')}`);

  /* ---------------------------------------------------------------------- */
  /* ---------------------------------------------------------------------- */
  section('the crash copy');
  {
    /* The editor keeps a copy of unsaved work in this browser, debounced,
       and clears it the moment a real save lands. It is never sent
       anywhere; the point is covering a crash, which the beforeunload guard
       below cannot do because the process is gone. */
    const KEY = 'jinhyuk-cms.local-draft.v1:essays/fixture-dense';
    const keyFor = await page.evaluate(
      `(() => { const s = window.__ws3.store.getState(); return 'jinhyuk-cms.local-draft.v1:' + (s.doc.meta.section ?? 'page') + '/' + s.slug; })()`,
    );
    await page.evaluate(`localStorage.removeItem(${JSON.stringify(keyFor)})`);

    await page.evaluate(
      `window.__ws3.store.updateMeta({ title: 'Typed but never saved' })`,
    );
    // Past the debounce.
    await sleep(1600);
    const stored = await page.evaluate(
      `(() => { const raw = localStorage.getItem(${JSON.stringify(keyFor)}); if (raw === null) return null; const v = JSON.parse(raw); return v.doc.meta.title; })()`,
    );
    check('unsaved work is copied into this browser', stored === 'Typed but never saved', String(stored));

    const dirty = (await page.probe()).dirty;
    check('…while the document is still unsaved', dirty === true);

    await page.click('save');
    for (let attempt = 0; attempt < 80 && (await page.probe()).phase !== 'idle'; attempt += 1) await sleep(50);
    await sleep(120);
    const afterSave = await page.evaluate(`localStorage.getItem(${JSON.stringify(keyFor)})`);
    check('and it is cleared the moment a save lands', afterSave === null, String(afterSave));
    void KEY;
  }

  section('unsaved-changes protection');
  const cleanPrompt = await page.evaluate(
    `(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()`,
  );
  check('a clean page leaves without a prompt', cleanPrompt === false);

  await page.click('insert-prose-0');
  state = await page.probe();
  check('the page is dirty again', state.dirty === true);
  const dirtyPrompt = await page.evaluate(
    `(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()`,
  );
  check('a dirty page cancels the unload', dirtyPrompt === true);
  const dirtyIndicator = await page.evaluate(
    `document.querySelector('[data-testid="dirty"]').textContent.trim()`,
  );
  // "Unsaved", not "Unsaved changes": the words in this bar were shortened
  // because at a real pane width they were being clipped mid-word.
  check('the toolbar says so', dirtyIndicator === 'Unsaved', dirtyIndicator);

  const linkGuard = await page.evaluate(`(() => {
    const anchor = document.createElement('a');
    anchor.href = '/elsewhere';
    anchor.textContent = 'leave';
    document.body.append(anchor);
    const originalConfirm = window.confirm;
    let asked = null;
    window.confirm = (message) => { asked = message; return false; };
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(event);
    window.confirm = originalConfirm;
    anchor.remove();
    return { asked, prevented: event.defaultPrevented };
  })()`);
  check('clicking a link that leaves the page asks first', typeof linkGuard.asked === 'string', String(linkGuard.asked));
  check('and answering no cancels the navigation', linkGuard.prevented === true);

  /* ---------------------------------------------------------------------- */
  section('keyboard shortcuts');
  const beforeShortcut = (await page.probe()).bandCount;
  await page.key('z', { meta: true });
  state = await page.probe();
  check('cmd+Z undoes', state.bandCount === beforeShortcut - 1, `${state.bandCount}`);
  await page.key('Z', { meta: true, shift: true });
  state = await page.probe();
  check('shift+cmd+Z redoes', state.bandCount === beforeShortcut, `${state.bandCount}`);

  await page.click('inspector-back');
  await page.click('meta-title');
  await page.key('z', { meta: true });
  state = await page.probe();
  check(
    'cmd+Z is left alone while typing in a field (TipTap keeps its own undo)',
    state.bandCount === beforeShortcut,
    `${state.bandCount}`,
  );

  /* ---------------------------------------------------------------------- */
  section('zoom and the desktop-only rule');
  await page.evaluate(`(() => {
    const select = document.querySelector('[data-testid="zoom"]');
    select.value = '1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await page.settle();
  const zoomed = await page.evaluate(`Number(document.querySelector('[data-testid="page-surface"]').dataset.scale)`);
  check('100% zoom draws the page at reference width', zoomed === 1, `scale ${zoomed}`);
  const surfaceWidth = await page.evaluate(
    `Math.round(document.querySelector('.cms-surface').getBoundingClientRect().width)`,
  );
  check('and the sheet is the full 1440px page', surfaceWidth === 1440, `${surfaceWidth}px`);
  // The column inside it is what canvas geometry is authored against, so this
  // is the number that must stay 1344 whatever the sheet does around it.
  const columnWidth = await page.evaluate(
    `(() => {
      const el = document.querySelector('.cms-surface__inner');
      const cs = getComputedStyle(el);
      return Math.round(el.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
    })()`,
  );
  check('with a 1344px content column in it', columnWidth === 1344, `${columnWidth}px`);
  const gutters = await page.evaluate(
    `(() => {
      const cs = getComputedStyle(document.querySelector('.cms-surface__inner'));
      return [cs.paddingLeft, cs.paddingRight].join(' ');
    })()`,
  );
  check('and 48px of paper down each side, as on the site', gutters === '48px 48px', gutters);
  // --doc-measure in src/cms/styles/doc.css, and what a .doc-p measures on the
  // published page. It was 760 here, so paragraphs broke in the wrong places.
  const measure = await page.evaluate(
    `Math.round(document.querySelector('.cms-prose-col').getBoundingClientRect().width)`,
  );
  check('prose reads at the site’s 720px measure', measure === 720, `${measure}px`);
  console.log(`    shot  ${await page.shot('08-zoom-100')}`);

  /* ---------------------------------------------------------------------- */
  section('the toolbar fits, at every width it is shown at');
  {
    /*
     * It did not. Every control had the default flex-shrink of 1, so the
     * browser took space from whatever would give it up: the page title
     * collapsed to nothing, the guide button to 8px, and the deploy chip
     * and Reload to 11px between them, while the theme select kept 202px
     * because its longest option — "Theme: system" — would not fit in less.
     * Reload rendered as "Re" behind the Preview button.
     *
     * The important part of that: the content never exceeded the bar.
     * Flex SHRANK things to fit, so scrollWidth equalled clientWidth the
     * whole time and nothing stuck out. The visible damage was controls
     * OVERLAPPING each other inside it, and a control crushed to a sliver.
     * So those are what this measures, and an overflow check alone would
     * have passed on the broken bar.
     *
     * Measured on the real toolbar rather than a copy of its markup,
     * because the thing that broke it was the text in an option.
     */
    const widths = [920, 1000, 1120, 1280, 1440, 1600];
    for (const width of widths) {
      await page.setViewport({ width, height: 900 });
      await sleep(90);
      const bar = await page.evaluate(`(() => {
        const bar = document.querySelector('[data-testid="toolbar"]');
        if (bar === null) return null;
        const box = bar.getBoundingClientRect();
        const controls = [...bar.querySelectorAll('button, select, .cms-toolbar__name, .cms-dirty')]
          .map((el) => {
            const r = el.getBoundingClientRect();
            return {
              what: (el.textContent || el.tagName).trim().slice(0, 16) || el.tagName,
              left: r.left, right: r.right, top: r.top, bottom: r.bottom,
              w: Math.round(r.width),
            };
          })
          .filter((el) => el.w > 0);
        const overlaps = [];
        for (let i = 0; i < controls.length; i += 1) {
          for (let j = i + 1; j < controls.length; j += 1) {
            const a = controls[i];
            const b = controls[j];
            // Only siblings on the same row can overlap meaningfully; a
            // tolerance of 1px absorbs subpixel rounding.
            const across = a.left < b.right - 1 && b.left < a.right - 1;
            const down = a.top < b.bottom - 1 && b.top < a.bottom - 1;
            if (across && down) overlaps.push(a.what + ' / ' + b.what);
          }
        }
        return {
          overflow: bar.scrollWidth - bar.clientWidth,
          height: Math.round(box.height),
          overlaps,
          slivers: controls.filter((el) => el.w < 20).map((el) => el.what + '@' + el.w),
          shown: controls.length,
        };
      })()`);
      if (bar === null) {
        check(`${width}px: the toolbar is on screen`, false, 'not rendered');
        continue;
      }
      check(
        `${width}px: nothing overlaps (${bar.shown} controls)`,
        bar.overlaps.length === 0,
        bar.overlaps.join(', '),
      );
      check(`${width}px: nothing is crushed to a sliver`, bar.slivers.length === 0, bar.slivers.join(', '));
      check(`${width}px: the content fits`, bar.overflow <= 0, `${bar.overflow}px over`);
      check(`${width}px: one or two rows`, bar.height <= 80, `${bar.height}px`);
    }
    await page.setViewport(WIDE);
  }

  /* ---------------------------------------------------------------------- */
  section('Publish asks which of the waiting things should go live');
  {
    /*
     * Publishing used to be three unrelated buttons: this one for the open
     * document, one in the nav-and-footer panel for site.json, one more for
     * a record collection. Pressing the big blue one with a body-size change
     * in site.json and an unfinished essay saved as a draft answered "There
     * is no draft of home to publish", which is true and tells you nothing
     * about either of the two things that really were waiting.
     *
     * So it lists them, and publishes EXACTLY what is ticked. The last part
     * is the one worth measuring: an unticked draft must still be a draft
     * afterwards.
     */
    await page.setViewport(WIDE);
    await page.click('publish');
    await sleep(250);

    const rows = await page.evaluate(
      `[...document.querySelectorAll('[data-testid="pending"] .cms-pending__label')].map((el) => el.textContent.trim())`,
    );
    check('the panel lists everything that is waiting', rows.length === 4, rows.join(' | '));
    check(
      'the open page is first and is marked',
      rows[0]?.includes('Ryan Choi') && rows[0]?.includes('open now'),
      rows[0],
    );
    check(
      'and a page that is not on the site yet says so',
      (await page.evaluate(
        `[...document.querySelectorAll('[data-testid="pending"] .cms-pending__detail')].map((el) => el.textContent.trim()).join(' | ')`,
      )).includes('new page, not on the site yet'),
    );

    const ticked = () =>
      page.evaluate(
        `[...document.querySelectorAll('[data-testid="pending"] input')].filter((el) => el.checked).length`,
      );
    check('only the open page is ticked to begin with', (await ticked()) === 1);
    check(
      'and the button says what it would do',
      (await page.evaluate(`document.querySelector('[data-testid="preflight-go"]').textContent.trim()`)) ===
        'Publish 1 thing',
    );

    // Tick the site settings, leave the unfinished essay alone. This is the
    // owner's actual case: publish the body size, not the half-written essay.
    await page.evaluate(`document.querySelector('[data-testid="pending-chrome"]').click()`);
    await sleep(80);
    await page.evaluate(`document.querySelector('[data-testid="pending-page:home:home"]').click()`);
    await sleep(80);
    check('ticking and unticking moves the count', (await ticked()) === 1);
    check(
      'the button follows',
      (await page.evaluate(`document.querySelector('[data-testid="preflight-go"]').textContent.trim()`)) ===
        'Publish 1 thing',
    );
    console.log(`    shot  ${await page.shot('11-publish-picker')}`);

    await page.evaluate(`document.querySelector('[data-testid="preflight-go"]').click()`);
    await sleep(500);

    const published = await page.evaluate('window.__ws3.publishedIds');
    const left = await page.evaluate('window.__ws3.stillPending()');
    check('exactly the ticked one went live', published.join(',') === 'chrome', published.join(','));
    check(
      'and the unticked drafts are still drafts',
      left.includes('page:essays:new-essay') && left.includes('page:home:home') && left.length === 3,
      left.join(','),
    );
    check(
      'the panel closed',
      (await page.evaluate(`document.querySelector('[data-testid="preflight"]') === null`)) === true,
    );

    /* Nothing ticked is not a publish. */
    await page.click('publish');
    await sleep(250);
    await page.evaluate(`[...document.querySelectorAll('[data-testid="pending"] input')].forEach((el) => { if (el.checked) el.click(); })`);
    await sleep(100);
    check(
      'with nothing ticked the button is disabled and says so',
      (await page.evaluate(`document.querySelector('[data-testid="preflight-go"]').disabled`)) === true,
    );
    check(
      'it does not pretend otherwise',
      (await page.evaluate(`document.querySelector('[data-testid="preflight-go"]').textContent.trim()`)) ===
        'Nothing ticked',
    );

    /* A failure part-way says how far it got. */
    await page.evaluate(`window.__failPublish = 'page:projects:track'`);
    await page.evaluate(`document.querySelector('[data-testid="pending-page:essays:new-essay"]').click()`);
    await page.evaluate(`document.querySelector('[data-testid="pending-page:projects:track"]').click()`);
    await sleep(80);
    await page.evaluate(`document.querySelector('[data-testid="preflight-go"]').click()`);
    await sleep(600);
    const problem = await page.evaluate(
      `document.querySelector('[data-testid="preflight-problem"]')?.textContent.trim() ?? null`,
    );
    check(
      'a failure part-way through says what did go live and what stopped it',
      problem !== null && problem.includes('1 thing went live') && problem.includes('Track'),
      String(problem),
    );
    check(
      'and the panel stays open over the ones that are left',
      (await page.evaluate(`document.querySelector('[data-testid="pending"]') !== null`)) === true,
    );
    await page.evaluate(`window.__failPublish = undefined`);
    await page.evaluate(`document.querySelector('[data-testid="preflight-cancel"]').click()`);
    await sleep(150);
  }

  /* ---------------------------------------------------------------------- */
  section('Fit does not fight the scrollbar');
  {
    /*
     * A feedback loop, and the reason the editor "spazzes out".
     *
     *   .cms-surface-scroll is overflow:auto
     *   .cms-surface-measure is width:100% inside it, and a ResizeObserver
     *     on it sets `available`
     *   scale = available / 1440
     *   the frame's height is surfaceHeight * scale
     *
     * So the scrollbar takes ~15px out of `available`, which lowers the
     * scale, which lowers the height, which can take the content back under
     * the pane height, which removes the scrollbar, which gives the 15px
     * back. On a page whose scaled height lands within a scrollbar's width
     * of the pane, that oscillates every frame: the sheet visibly jitters
     * and every line in it rewraps.
     *
     * Measured as the dependency rather than as the jitter, because the
     * jitter needs a document of exactly the wrong height and the
     * dependency does not: at one width, the fit scale must be the same
     * whether or not the page is tall enough to scroll.
     */
    /*
     * CLASSIC SCROLLBARS, ON PURPOSE. Headless Chrome draws overlay
     * scrollbars, which float above the content and take no width, so the
     * loop cannot happen here and this check passed on the broken build.
     * macOS "Show scroll bars: Always" — and any Mac with a mouse plugged
     * in, under the default setting — draws the old kind, which takes 15px
     * out of the layout. That is the configuration the bug lives in, so the
     * test makes it, rather than hoping for it.
     */
    await page.evaluate(`(() => {
      const style = document.createElement('style');
      style.id = 'harness-classic-scrollbars';
      style.textContent =
        '.cms-surface-scroll::-webkit-scrollbar { width: 15px; height: 15px; }' +
        '.cms-surface-scroll::-webkit-scrollbar-thumb { background: #888; }' +
        '.cms-surface-scroll::-webkit-scrollbar-track { background: #ddd; }';
      document.head.append(style);
      const select = document.querySelector('[data-testid="zoom"]');
      if (select === null) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'fit');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);

    const readFit = async (height) => {
      await page.setViewport({ width: 1400, height });
      await sleep(260);
      return page.evaluate(`(() => {
        const surface = document.querySelector('[data-testid="page-surface"]');
        const measure = document.querySelector('.cms-surface-measure');
        return {
          scale: Number(surface.dataset.scale),
          scrolls: surface.scrollHeight > surface.clientHeight,
          lost: surface.offsetWidth - surface.clientWidth,
          measured: Math.round(measure.getBoundingClientRect().width),
        };
      })()`);
    };

    // Short enough that the fixture page cannot fit, and tall enough that it
    // comfortably can. Same width in both, so the fit scale must not move.
    const scrolling = await readFit(700);
    const roomy = await readFit(4000);

    check('the short pane does scroll', scrolling.scrolls, `scale ${scrolling.scale}`);
    check('the tall pane does not', !roomy.scrolls, `scale ${roomy.scale}`);
    check(
      'and the fit scale is the same either way',
      scrolling.scale === roomy.scale,
      `scrolling ${scrolling.scale} (measured ${scrolling.measured}px) vs roomy ${roomy.scale} (measured ${roomy.measured}px)`,
    );
    check(
      'because the scrollbar gutter is reserved, not taken from the page',
      scrolling.measured === roomy.measured,
      `${scrolling.measured}px vs ${roomy.measured}px`,
    );
    console.log(
      `    note  scrollbar took ${scrolling.lost}px when scrolling, ${roomy.lost}px when not`,
    );

    /*
     * And the symptom itself: at the height where the scaled page is within
     * a scrollbar's width of the pane, the loop never settles. Sampled over
     * half a second rather than read once, because one read of an
     * oscillation looks exactly like a stable value.
     */
    /*
     * And the symptom itself. The loop only shows at the pane height where
     * the scaled page is within a scrollbar's width of fitting, so find
     * that height rather than hope a round number lands on it: measure the
     * content and the chrome around the pane, then sweep the neighbourhood.
     *
     * Sampled over time, not read once. One read of an oscillation looks
     * exactly like a stable value.
     */
    await page.setViewport({ width: 1400, height: 700 });
    await sleep(260);
    const geometry = await page.evaluate(`(() => {
      const surface = document.querySelector('[data-testid="page-surface"]');
      return {
        content: surface.scrollHeight,
        pane: surface.clientHeight,
        viewport: window.innerHeight,
      };
    })()`);
    const edge = geometry.content + (geometry.viewport - geometry.pane);
    console.log(`    note  the page only just fits at a viewport of about ${edge}px`);

    const unstable = [];
    for (let height = edge - 40; height <= edge + 40; height += 4) {
      await page.setViewport({ width: 1400, height });
      await sleep(320);
      const samples = await page.evaluate(`(async () => {
        const surface = document.querySelector('[data-testid="page-surface"]');
        const seen = [];
        for (let i = 0; i < 10; i += 1) {
          seen.push(surface.dataset.scale);
          await new Promise((r) => setTimeout(r, 40));
        }
        return [...new Set(seen)];
      })()`);
      if (samples.length > 1) unstable.push(`${height}px: ${samples.join(' <-> ')}`);
    }
    check(
      'and the fit settles at every pane height around the edge',
      unstable.length === 0,
      unstable.slice(0, 3).join('; '),
    );

    await page.evaluate(
      `document.getElementById('harness-classic-scrollbars')?.remove()`,
    );
    await page.setViewport(WIDE);
    await sleep(120);
  }

  /* ---------------------------------------------------------------------- */
  section('Theme draws the page in the theme');
  {
    /*
     * The control set `data-theme` on <html> and nothing happened, because
     * nothing in the editor DEFINED the tokens it flips. `--paper`, `--ink`
     * and the rest live in src/styles/global.css, which the published page
     * loads and the CMS route does not; every `var(--paper, #fff)` in the
     * editor was therefore resolving to its light fallback, in both themes,
     * forever. The attribute was right and the page stayed white.
     *
     * So this measures the SURFACE, not the attribute. An attribute check
     * would have passed on the broken build.
     */
    const read = (theme) => page.evaluate(`(async () => {
      const select = document.querySelector('[data-testid="surface-theme"]');
      if (select === null) return null;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, ${JSON.stringify(theme)});
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const surface = getComputedStyle(document.querySelector('.cms-surface'));
      const root = getComputedStyle(document.documentElement);
      return {
        attr: document.documentElement.getAttribute('data-theme'),
        bg: surface.backgroundColor,
        fg: surface.color,
        paper: root.getPropertyValue('--paper').trim(),
        ink: root.getPropertyValue('--ink').trim(),
        rule: root.getPropertyValue('--rule').trim(),
        accent: root.getPropertyValue('--accent').trim(),
      };
    })()`);

    const dark = await read('dark');
    if (dark === null) {
      check('the Theme control is in the toolbar', false, 'no [data-testid="surface-theme"]');
    } else {
      check('Dark sets data-theme on <html>', dark.attr === 'dark', String(dark.attr));
      // global.css: --paper #0f0f0f, --ink #f2f2f2 under [data-theme='dark'].
      check('and the sheet goes dark', dark.bg === 'rgb(15, 15, 15)', dark.bg);
      check('and the text goes light', dark.fg === 'rgb(242, 242, 242)', dark.fg);
      check('--rule is the dark hairline', dark.rule === '#2a2a2a', dark.rule || '(undefined)');
      check('--accent is the dark accent', dark.accent === '#f5a623', dark.accent || '(undefined)');
    }

    const light = await read('light');
    if (light !== null) {
      check('Light puts it back', light.attr === 'light', String(light.attr));
      check('and the sheet is paper again', light.bg === 'rgb(255, 255, 255)', light.bg);
      check('and the text is ink again', light.fg === 'rgb(17, 17, 17)', light.fg);
      check('--rule is the light hairline', light.rule === '#e4e4e4', light.rule || '(undefined)');
      check('--accent is the light accent', light.accent === '#ff5722', light.accent || '(undefined)');
    }

    // The chrome is on its own scale and must not move with the page.
    const chrome = await page.evaluate(
      `getComputedStyle(document.querySelector('.cms-root')).backgroundColor`,
    );
    check('the editor’s own chrome stays dark', chrome === 'rgb(21, 23, 26)', chrome);

    await read('dark');
    console.log(`    shot  ${await page.shot('10-theme-dark')}`);
    await read('light');
  }

  await page.setViewport(NARROW);
  const narrow = await page.evaluate(`({
    notice: getComputedStyle(document.querySelector('[data-testid="narrow-notice"]')).display,
    panes: getComputedStyle(document.querySelector('.cms-panes')).display,
    toolbar: getComputedStyle(document.querySelector('[data-testid="toolbar"]')).display,
  })`);
  check('below 900px the editor is replaced by a notice', narrow.notice !== 'none', narrow.notice);
  check('and the three panes are gone', narrow.panes === 'none');
  check('and so is the toolbar', narrow.toolbar === 'none');
  console.log(`    shot  ${await page.shot('09-narrow')}`);
  await page.setViewport(WIDE);

  /* ---------------------------------------------------------------------- */
  section('console');
  const realErrors = page.consoleErrors.filter((text) => !text.includes('Download the React DevTools'));
  check('no console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
  check('no uncaught exceptions', page.pageErrors.length === 0, page.pageErrors.slice(0, 2).join(' | '));
  if (page.consoleWarnings.length > 0) {
    console.log(`    note  ${page.consoleWarnings.length} console warning(s): ${page.consoleWarnings.slice(0, 3).join(' | ')}`);
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
    console.log('  WS-3 editor shell verified in headless Chrome\n');
  })
  .catch((error) => {
    console.error(`\n  harness run failed: ${error.message}`);
    if (error.stack) console.error(error.stack.split('\n').slice(1, 4).join('\n'));
    process.exit(1);
  });
