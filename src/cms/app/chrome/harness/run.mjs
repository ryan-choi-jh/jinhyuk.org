/**
 * src/cms/app/chrome/harness/run.mjs
 *
 * The nav-and-footer panel's browser proof. Builds the harness, opens it in
 * headless Chrome over `file://`, drives the REAL panel with synthesised input
 * — typing, clicks on the reorder arrows, a `<select>` change — and asserts
 * three things that are the whole point of the feature:
 *
 *   1. the scenery around the page is the REAL nav and footer: the labels from
 *      src/content/data/site.json, the five real icons, the real copyright
 *   2. an edit in the panel reaches that scenery immediately, before any save
 *   3. Save then Publish go through the same draft-then-publish dance as
 *      everything else, with the blob sha quoted, and the in-memory server ends
 *      up holding exactly what the panel showed
 *
 *   node src/cms/app/chrome/harness/run.mjs
 *   CMS_CHROME_OUT=/tmp/chr node src/cms/app/chrome/harness/run.mjs
 *
 * No server and no API: the page is a local file and the four calls are a
 * closure inside it. Chrome is spoken to over the DevTools protocol with Node's
 * built-in WebSocket, so there is no new dependency.
 *
 * Exit code 0 means every check passed.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUT_DIR = process.env.CMS_CHROME_OUT ?? fileURLToPath(new URL('.out', import.meta.url));
const SHOTS_DIR = join(OUT_DIR, 'shots');
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const WIDE = { width: 1500, height: 1000 };

let failures = 0;
let total = 0;

function check(label, ok, detail = '') {
  total += 1;
  if (ok) console.log(`    ok    ${label}${detail === '' ? '' : ` (${detail})`}`);
  else {
    failures += 1;
    console.log(`    FAIL  ${label}${detail === '' ? '' : ` (${detail})`}`);
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

const t = (id) => `[data-testid="${id}"]`;

class Page {
  constructor(cdp) {
    this.cdp = cdp;
    this.consoleErrors = [];
    this.pageErrors = [];
    this.requests = [];
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

  settle() {
    return this.evaluate(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
    );
  }

  rect(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 };
    })()`);
  }

  text(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el === null ? null : el.textContent.trim();
    })()`);
  }

  texts(selector) {
    return this.evaluate(
      `[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => el.textContent.trim())`,
    );
  }

  attrs(selector, name) {
    return this.evaluate(
      `[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => el.getAttribute(${JSON.stringify(name)}))`,
    );
  }

  values(selector) {
    return this.evaluate(
      `[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => el.value)`,
    );
  }

  disabled(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el === null ? null : el.disabled === true;
    })()`);
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

  async mouse(type, x, y) {
    await this.cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
      buttons: type === 'mouseReleased' ? 0 : 1,
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
    await this.mouse('mouseMoved', x, y);
    await this.mouse('mousePressed', x, y);
    await this.mouse('mouseReleased', x, y);
    await this.settle();
  }

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

  /** Change a `<select>` the way a person does: set it, then fire `change`. */
  async choose(selector, value) {
    await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    })()`);
    await this.settle();
  }

  async shot(name) {
    const result = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = join(SHOTS_DIR, `${name}.png`);
    writeFileSync(file, Buffer.from(result.data, 'base64'));
    console.log(`    shot  ${file}`);
    return file;
  }
}

/* -------------------------------------------------------------------------- */
/* Chrome                                                                      */
/* -------------------------------------------------------------------------- */

async function launchChrome() {
  if (!existsSync(CHROME)) throw new Error(`no Chrome at ${CHROME} (set CHROME_PATH)`);
  const profile = await mkdtemp(join(tmpdir(), 'cms-chrome-panel-'));
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
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });

  const { OUT_DIR: built } = await import('./build.mjs');
  const html = join(built ?? OUT_DIR, 'harness.html');
  if (!existsSync(html)) throw new Error(`no harness at ${html}`);

  const site = JSON.parse(
    readFileSync(new URL('../../../../content/data/site.json', import.meta.url), 'utf8'),
  );

  const chrome = await launchChrome();
  let cdp = null;
  try {
    const target = await firstPageTarget(chrome.port);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const page = new Page(cdp);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        page.consoleErrors.push(params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });
    cdp.on('Runtime.exceptionThrown', (params) => {
      page.pageErrors.push(params.exceptionDetails?.text ?? 'exception');
    });
    cdp.on('Network.requestWillBeSent', (params) => {
      page.requests.push(params.request.url);
    });

    await cdp.send('Page.navigate', { url: pathToFileURL(html).href });
    await page.waitFor(`document.querySelector('${t('site-chrome-panel')}') !== null`, 'the panel');
    await page.waitFor(`document.querySelector('${t('surface-chrome-top')}') !== null`, 'the nav');
    await sleep(400);
    await page.settle();

    /* ------------------------------------------------------------------ */
    section('the scenery is the real nav and footer, not placeholders');

    equal(
      'the nav above the page is the stored nav, in order',
      await page.texts(`${t('surface-chrome-top')} .cms-chrome__links span`),
      site.nav.map((link) => link.label),
    );
    equal(
      'the footer line is the stored line with the year filled in',
      await page.text(`${t('surface-chrome-bottom')} .cms-chrome__footer span`),
      site.footer.copyright.replace('{year}', String(new Date().getFullYear())),
    );
    const sceneryPaths = await page.attrs(`${t('surface-chrome-bottom')} svg path`, 'd');
    check(
      'the footer draws one real icon per stored social link',
      sceneryPaths.length === site.footer.social.length,
      `${sceneryPaths.length} of ${site.footer.social.length}`,
    );
    check(
      'they are path data and not grey squares',
      sceneryPaths.every((d) => typeof d === 'string' && d.length > 40),
    );
    check(
      'the scenery is inert',
      (await page.evaluate(
        `getComputedStyle(document.querySelector('${t('surface-chrome-top')}')).pointerEvents`,
      )) === 'none' &&
        (await page.evaluate(
          `document.querySelector('${t('surface-chrome-top')}').getAttribute('aria-hidden')`,
        )) === 'true',
    );
    equal(
      'the panel shows the same labels in the same order',
      await page.values(`${t('site-chrome-panel')} [data-testid^="chrome-nav-label-"]`),
      site.nav.map((link) => link.label),
    );
    equal(
      'and the same addresses',
      await page.values(`${t('site-chrome-panel')} [data-testid^="chrome-nav-href-"]`),
      site.nav.map((link) => link.href),
    );
    equal(
      'and the same icon keys',
      await page.values(`${t('site-chrome-panel')} [data-testid^="chrome-social-icon-"]`),
      site.footer.social.map((link) => link.icon),
    );
    equal(
      'the wordmark above the page is the stored one, not a hardcoded name',
      await page.text(t('surface-chrome-mark')),
      site.wordmark.label,
    );
    equal(
      'and the panel holds it, with the address it points at',
      await page.values(`${t('site-chrome-panel')} [data-testid^="chrome-wordmark-"]`),
      [site.wordmark.label, site.wordmark.href],
    );
    equal(
      'the theme toggle is drawn above the page, both halves, in order',
      await page.attrs(`${t('surface-chrome-toggle')} [data-theme-cell]`, 'data-theme-cell'),
      ['light', 'dark'],
    );
    const toggleArt = await page.attrs(`${t('surface-chrome-toggle')} svg path`, 'd');
    check(
      'with the real sun and moon in it, not a grey pill',
      toggleArt.length === 2 && toggleArt.every((d) => typeof d === 'string' && d.length > 20),
      `${toggleArt.length} paths`,
    );
    equal(
      'and the lit half is the theme a first-time visitor gets',
      await page.attrs(`${t('surface-chrome-toggle')} [data-theme-cell]`, 'data-on'),
      site.themeToggle.initial === 'dark' ? [null, '1'] : ['1', null],
    );
    equal('nothing is unsaved on arrival', await page.text(t('chrome-state')), 'published');
    await page.shot('01-arrived');

    /* ------------------------------------------------------------------ */
    section('an edit reaches the page immediately');

    await page.type(t('chrome-nav-label-0'), 'WORK');
    equal(
      'renaming a nav link renames it above the page',
      (await page.texts(`${t('surface-chrome-top')} .cms-chrome__links span`))[0],
      'WORK',
    );
    equal('and the panel says so', await page.text(t('chrome-state')), 'unsaved');

    await page.click(t('chrome-nav-0-down'));
    equal(
      'the down arrow reorders the nav, in the panel',
      await page.values(`${t('site-chrome-panel')} [data-testid^="chrome-nav-label-"]`),
      ['ESSAYS', 'WORK', 'PHOTOGRAPHY', 'FILMOGRAPHY'],
    );
    equal(
      'and above the page',
      await page.texts(`${t('surface-chrome-top')} .cms-chrome__links span`),
      ['ESSAYS', 'WORK', 'PHOTOGRAPHY', 'FILMOGRAPHY'],
    );

    await page.type(t('chrome-copyright'), '© {year} Jin Hyuk Choi');
    equal(
      'the copyright line follows, year and all',
      await page.text(`${t('surface-chrome-bottom')} .cms-chrome__footer span`),
      `© ${new Date().getFullYear()} Jin Hyuk Choi`,
    );
    check(
      'the panel explains the token rather than hiding it',
      (await page.text(t('chrome-copyright-preview'))).includes('{year}'),
    );

    const before = await page.attrs(`${t('surface-chrome-bottom')} svg path`, 'd');
    await page.choose(t('chrome-social-icon-0'), 'email');
    const after = await page.attrs(`${t('surface-chrome-bottom')} svg path`, 'd');
    check('choosing another icon redraws it on the page', before[0] !== after[0]);
    equal(
      'and the mail icon is the mail icon',
      after[0] === after[4],
      true,
    );
    equal(
      'the name follows the icon while it was the default one',
      (await page.values(`${t('site-chrome-panel')} [data-testid^="chrome-social-name-"]`))[0],
      'Email',
    );
    await page.choose(t('chrome-social-icon-0'), 'github');
    await page.type(t('chrome-social-name-0'), 'GitHub');
    await page.shot('02-edited');

    /* ------------------------------------------------------------------ */
    section('the wordmark and the theme toggle answer to the panel too');

    await page.type(t('chrome-wordmark-label'), 'R. J. Choi');
    equal(
      'renaming the wordmark renames it above the page',
      await page.text(t('surface-chrome-mark')),
      'R. J. Choi',
    );
    await page.type(t('chrome-wordmark-label'), site.wordmark.label);
    equal(
      'and typing it back restores it',
      await page.text(t('surface-chrome-mark')),
      site.wordmark.label,
    );

    await page.choose(t('chrome-theme-initial'), 'dark');
    equal(
      'choosing a dark start moves the lit half of the toggle',
      await page.attrs(`${t('surface-chrome-toggle')} [data-theme-cell]`, 'data-on'),
      [null, '1'],
    );
    await page.choose(t('chrome-theme-initial'), 'light');
    equal(
      'and back to light moves it back',
      await page.attrs(`${t('surface-chrome-toggle')} [data-theme-cell]`, 'data-on'),
      ['1', null],
    );

    await page.click(t('chrome-theme-show'));
    check(
      'switching the toggle off takes it off the page as well',
      (await page.rect(t('surface-chrome-toggle'))) === null,
    );
    check(
      'and the nav keeps its shape without it',
      (await page.rect(t('surface-chrome-mark'))).visible === true &&
        (await page.texts(`${t('surface-chrome-top')} .cms-chrome__links span`)).length ===
          site.nav.length,
    );
    await page.click(t('chrome-theme-show'));
    check(
      'switching it back on brings it back',
      (await page.rect(t('surface-chrome-toggle'))) !== null,
    );
    // Not the dirty flag: the sections above this one left real edits pending,
    // so it says "unsaved" either way. What is being checked is that these
    // round trips put both settings back exactly where they started.
    equal(
      'and both settings are back where they began',
      [
        await page.evaluate(
          `document.querySelector('${t('chrome-theme-show')}').checked === true`,
        ),
        await page.evaluate(`document.querySelector('${t('chrome-theme-initial')}').value`),
      ],
      [site.themeToggle.show, site.themeToggle.initial],
    );

    await page.shot('02b-wordmark-and-toggle');

    /* ------------------------------------------------------------------ */
    section('the body size, and who gets it');
    {
      /*
       * The thing this panel exists for is not the number, it is knowing
       * what the number will do before doing it. So the checks follow the
       * same order the panel does: the proposal, what it says will happen,
       * and then whether that is what actually happened.
       *
       * Measured on the surface, not on the panel. The panel saying "16px"
       * and the page in the middle still being 17.5 is precisely the failure
       * mode, and reading the control back would not see it.
       */
      // The surface draws prose through the slot, and this harness mounts
      // no prose editor, so a paragraph is the read-only placeholder's
      // `p.cms-ph-p`. It inherits from `.cms-surface` exactly as a real
      // paragraph does, which is the thing being measured.
      const paragraph = `${t('page-surface')} .cms-ph-p`;
      const sizeOf = (selector) =>
        page.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el === null) return null;
          const s = getComputedStyle(el);
          return parseFloat(s.fontSize) + '/' + parseFloat(s.lineHeight);
        })()`);

      equal('the page starts at the design’s own size', await sizeOf(paragraph), '17.5/35');
      equal('and the panel says nothing is changed', await page.text(t('type-status')), 'default');

      // Nothing is ticked on a site that has never been scaled, so Apply has
      // nothing to do and says so rather than quietly applying to everything.
      equal('with nothing picked, Apply is disabled', await page.disabled(t('type-apply')), true);
      check(
        'and the panel says why',
        (await page.text(t('type-consequence'))).includes('nothing would change'),
      );

      await page.click(t('type-smaller'));
      await page.click(t('type-smaller'));
      await page.click(t('type-smaller'));
      equal('three steps down from 17.5 is 16', await page.values(t('type-size')), ['16']);
      equal(
        'the page has NOT moved, because nothing has been applied',
        await sizeOf(paragraph),
        '17.5/35',
      );
      check(
        'the sample shows the proposed size',
        (await page.text(t('type-sample'))).includes('16px over 32px'),
        await page.text(t('type-sample')),
      );

      await page.click(t('type-pick-home'));
      await page.settle();
      const scale = await page.texts(`${t('type-scale')} td`);
      check(
        'the scale says what else moves, from and to',
        scale.includes('17.5px/35px') && scale.includes('16px/32px') && scale.includes('14.5px/25.5px'),
        scale.join(' '),
      );
      equal(
        'the row says where this section is going',
        await page.text(t('type-now-home')),
        '17.5px → 16px',
      );
      check(
        'and the consequence names the pages',
        (await page.text(t('type-consequence'))).includes('the homepage'),
        await page.text(t('type-consequence')),
      );
      equal(
        'a section that is not ticked says it is staying put',
        await page.text(t('type-now-essays')),
        '17.5px',
      );

      await page.click(t('type-apply'));
      await page.settle();
      equal('applying moves the page in the middle', await sizeOf(paragraph), '16/32');
      equal('and the panel says one section is changed', await page.text(t('type-status')), '1 section changed');
      equal('and the chrome is unsaved', await page.text(t('chrome-state')), 'unsaved');

      // A quote is the other running text and moves with it. A heading does
      // not: that is the design decision, checked rather than described.
      // The callout is covered against real rendered markup in
      // src/cms/styles/verify-type-scale-browser.mjs; the placeholder here
      // draws one as an ordinary paragraph.
      const quote = await sizeOf(`${t('page-surface')} .cms-ph-quote`);
      if (quote !== null) equal('a quote moves with it', quote, '24/36.5');
      const heading = await sizeOf(`${t('page-surface')} .cms-ph-h2`);
      if (heading !== null) equal('a heading does not', heading, '22/32');

      // The one that matters for "apply only to what I picked": the stored
      // settings name home and nothing else.
      const stored = await page.evaluate('JSON.stringify(window.__chr.chrome().type)');
      equal('only the section that was picked is stored', stored, '{"size":17.5,"sections":{"home":16}}');

      await page.click(t('type-reset'));
      await page.settle();
      equal('reset puts the page back', await sizeOf(paragraph), '17.5/35');
      equal(
        'and removes the setting entirely rather than storing the default',
        await page.evaluate('String(window.__chr.chrome().type)'),
        'undefined',
      );
      await page.shot('05-type-scale');
    }

    /* ------------------------------------------------------------------ */
    section('a new link has to be filled in before it can be saved');

    await page.click(t('chrome-social-add'));
    equal(
      'it is added at the end',
      (await page.values(`${t('site-chrome-panel')} [data-testid^="chrome-social-href-"]`)).length,
      site.footer.social.length + 1,
    );
    equal('Save is refused while its address is empty', await page.disabled(t('chrome-save')), true);
    await page.shot('03-incomplete');
    await page.click(t(`chrome-social-${site.footer.social.length}-remove`));
    equal('removing it makes the panel saveable again', await page.disabled(t('chrome-save')), false);

    await page.click(t('chrome-nav-add'));
    await page.type(t('chrome-nav-label-4'), 'NOTES');
    await page.type(t('chrome-nav-href-4'), '/notes/');
    equal(
      'a new nav link appears above the page too',
      await page.texts(`${t('surface-chrome-top')} .cms-chrome__links span`),
      ['ESSAYS', 'WORK', 'PHOTOGRAPHY', 'FILMOGRAPHY', 'NOTES'],
    );

    /* ------------------------------------------------------------------ */
    section('save, then publish');

    equal('publish is refused while there are unsaved edits', await page.disabled(t('chrome-publish')), true);
    await page.click(t('chrome-save'));
    await page.waitFor(
      `document.querySelector('${t('chrome-state')}').textContent.trim() === 'draft saved'`,
      'the draft to be saved',
    );
    const afterSave = await page.evaluate('window.__chr.server()');
    equal(
      'the server holds the draft the panel showed',
      afterSave.draft.nav.map((link) => link.label),
      ['ESSAYS', 'WORK', 'PHOTOGRAPHY', 'FILMOGRAPHY', 'NOTES'],
    );
    check('and nothing is published yet', afterSave.published.nav[0].label === site.nav[0].label);
    equal('publish is offered now', await page.disabled(t('chrome-publish')), false);
    await page.shot('04-saved');

    await page.click(t('chrome-publish'));
    await page.waitFor(
      `document.querySelector('${t('chrome-state')}').textContent.trim() === 'published'`,
      'the publish',
    );
    const afterPublish = await page.evaluate('window.__chr.server()');
    equal(
      'publishing moves the draft over the published file',
      afterPublish.published.nav.map((link) => link.label),
      ['ESSAYS', 'WORK', 'PHOTOGRAPHY', 'FILMOGRAPHY', 'NOTES'],
    );
    equal('and deletes the draft', afterPublish.draft, null);
    equal(
      'the copyright line went with it',
      afterPublish.published.footer.copyright,
      '© {year} Jin Hyuk Choi',
    );
    await page.shot('05-published');

    // The foot of the page, where the real footer is: the copyright line and
    // the five real icons, at the size the published page draws them.
    await page.evaluate(`(() => {
      const scroller = document.querySelector('.cms-surface-scroll');
      scroller.scrollTop = scroller.scrollHeight;
      return true;
    })()`);
    await page.settle();
    await page.shot('06-page-footer');

    const log = await page.evaluate('window.__chr.log.map((entry) => entry.call)');
    check(
      'every write quoted the sha it was given',
      log.some((call) => call.startsWith('save(expect=')) &&
        log.some((call) => call.startsWith('publish(expect=')),
      log.join(' '),
    );

    /* ------------------------------------------------------------------ */
section('saving twice in a row');
    {
      /*
       * The first save CREATES the draft and must say so ("expect: this file
       * does not exist"); the second must UPDATE it, quoting the sha the
       * first one returned. Getting that wrong gives
       *
       *   src/content/drafts/data/site.json already exists. It was expected
       *   to be a new file; refusing to overwrite it.
       *
       * which is a dead end: the draft is on disk, the panel will not write
       * to it, and nothing in the UI says to reload.
       */
      await page.type(t('chrome-copyright'), '© {year} Twice');
      await page.click(t('chrome-save'));
      await page.waitFor(
        `document.querySelector('${t('chrome-state')}')?.textContent.trim() === 'draft saved'`,
        'the first save',
      );
      await page.type(t('chrome-copyright'), '© {year} Three times');
      await page.click(t('chrome-save'));
      await page.settle();
      await sleep(150);
      const notice = await page.text(t('chrome-notice'));
      check(
        'the second save does not claim the draft is a new file',
        notice === null || !notice.includes('already exists'),
        String(notice),
      );
      equal('and it landed', await page.text(t('chrome-state')), 'draft saved');
      const calls = await page.evaluate('window.__chr.log.map((e) => e.call).filter((c) => c.startsWith("save"))');
      check(
        'the first save expected a new file and the second expected its sha',
        calls.length >= 2 && calls[calls.length - 2].includes('null') && !calls[calls.length - 1].includes('null'),
        calls.join(' | '),
      );

      /*
       * And the case that actually happened: two saves in flight at once.
       *
       * Both are created from the same `shas.current.draft`, so if the draft
       * does not exist yet BOTH claim it is a new file. The first creates
       * it; the second is refused, and the panel is left saying "unsaved"
       * over a draft that is on disk and that it will not write to again.
       *
       * Reproduced by clicking twice inside one frame, which is a
       * double-click, which is a thing people do to a button that has not
       * visibly responded yet.
       */
      await page.click(t('chrome-discard'));
      await page.waitFor(
        `document.querySelector('${t('chrome-state')}')?.textContent.trim() === 'published'`,
        'the draft to be discarded',
      );
      await page.type(t('chrome-copyright'), '© {year} Raced');
      await page.evaluate('window.__chrLatency = 250');
      await page.evaluate(`(() => {
        const button = document.querySelector('${t('chrome-save')}');
        button.click();
        button.click();
        return true;
      })()`);
      await page.settle();
      await sleep(1200);
      await page.evaluate('window.__chrLatency = 0');
      const raced = await page.text(t('chrome-notice'));
      check(
        'two saves at once do not leave the panel refusing to write its own draft',
        raced === null || !raced.includes('already exists'),
        String(raced),
      );
      equal('and the draft is saved', await page.text(t('chrome-state')), 'draft saved');
      const racedCalls = await page.evaluate(
        'window.__chr.log.map((e) => e.call).filter((c) => c.startsWith("save")).slice(-2)',
      );
      check(
        'because the second save waited and quoted the first one’s sha',
        racedCalls.length === 2 && racedCalls[0].includes('null') && !racedCalls[1].includes('null'),
        racedCalls.join(' | '),
      );

      /*
       * And the state this leaves behind when it has ALREADY happened —
       * which is where the owner was when they reported it: a draft on disk
       * and a panel that believes there is none. Simulated by telling the
       * panel the draft is gone without telling the server.
       */
      await page.click(t('chrome-discard'));
      await page.waitFor(
        `document.querySelector('${t('chrome-state')}')?.textContent.trim() === 'published'`,
        'the draft to be discarded again',
      );
      await page.evaluate('window.__chrForget()');
      await page.type(t('chrome-copyright'), '© {year} Recovered');
      await page.click(t('chrome-save'));
      await page.settle();
      await sleep(300);
      const recovered = await page.text(t('chrome-notice'));
      check(
        'a panel whose view is already stale recovers instead of dead-ending',
        recovered !== null && recovered.includes('already there'),
        String(recovered),
      );
      equal('and the edit landed', await page.text(t('chrome-state')), 'draft saved');
      const server = await page.evaluate('window.__chr.server()');
      check(
        'on the server, not just in the panel',
        server.draft.footer.copyright === '© {year} Recovered',
        server.draft.footer.copyright,
      );

      /*
       * The OTHER conflict is deliberately not recovered from. "The draft
       * changed since you loaded it" means there is work in it that this
       * panel has never seen, and writing over that is a real loss rather
       * than a stale-view annoyance. It still says reload, and it should.
       */
      await page.evaluate('window.__chrForget()');
      await page.type(t('chrome-copyright'), '© {year} Clobber');
      await page.click(t('chrome-save'));
      await page.settle();
      await sleep(300);
      const moved = await page.text(t('chrome-notice'));
      check(
        'a draft that moved under us is reported, not overwritten',
        moved !== null && moved.includes('changed since you loaded it'),
        String(moved),
      );
    }

    /* ------------------------------------------------------------------ */
        section('hygiene');

    const offsite = page.requests.filter(
      (url) => !url.startsWith('file:') && !url.startsWith('data:') && !url.includes('fonts.g'),
    );
    equal('nothing was fetched but the page and its fonts', offsite, []);
    equal('no page exceptions', page.pageErrors, []);
    equal('no console errors', page.consoleErrors, []);
  } finally {
    cdp?.close();
    chrome.child.kill('SIGKILL');
    // Chrome is still flushing its profile as it dies, so a failed tidy-up must
    // not become the error this run reports.
    await sleep(200);
    await rm(chrome.profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }

  console.log(`\n  ${total - failures}/${total} checks passed`);
  if (failures > 0) process.exitCode = 1;
}

await main();
