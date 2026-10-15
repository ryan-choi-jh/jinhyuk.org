/**
 * src/cms/render/verify-home-note.mjs
 *
 * The 원고지 note's browser proof: docs/wongoji-note.md section 8, measured.
 * The string half is in ./selftest.ts; this is the half that needs a page.
 *
 *   node src/cms/render/verify-home-note.mjs                 build, then check
 *   node src/cms/render/verify-home-note.mjs --site=dist     check an existing build
 *   NOTE_OUT=/tmp/note node src/cms/render/verify-home-note.mjs   screenshots there
 *
 * It builds the real site (`astro build` into a temporary folder, so `dist/`
 * is not touched), serves it, and drives headless Chrome over the DevTools
 * protocol with Node's own WebSocket: no dependency. Everything is the
 * shipped page and the shipped bundle, not a harness assembling its own
 * document (cms/AGENTS.md section 4 says why that matters).
 *
 * What it proves, each against real geometry and real timers:
 *
 *   - the three heading squares sit on the grid's own squares, columns 5 to
 *     7 of the first row, to within 1px, at 1440 and at 1100: measured
 *     against the red lines found in the grid image's PIXELS, not against
 *     the numbers the stylesheet was written from;
 *   - the first visit plays at 3s (and not before), on a resting pointer at
 *     600ms, and marks itself seen; a reload does not play and shows the
 *     button from the start;
 *   - every way out (CLOSE, Escape, a click on the sheet, the hold running
 *     out) flies into the button; scrolling away and the lightbox do not;
 *   - the button lands centred under the sheet without moving the intro;
 *   - the hold pauses under the pointer;
 *   - on a phone it is a caption, a tap on the grid enlarges and never
 *     starts it, and the row reads TAP THE GRID TO ENLARGE | button;
 *   - dark mode, reduced motion, the keyboard, the accessibility tree, and
 *     storage that throws;
 *   - with no script, as in the editor's preview, nothing of it shows.
 *
 * Two Chrome settings, said out loud because cms/AGENTS.md asks: the window
 * keeps its scrollbar for every measurement (no --hide-scrollbars, so the
 * stage is 15px narrower than the window, as it is on a Mac with a mouse),
 * and the scrollbar is hidden only for the comparison screenshots, so they
 * are 1440 wide like the Paper artboards they sit next to.
 *
 * Exit code 0 means every check passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.NOTE_OUT ?? join(tmpdir(), 'verify-home-note');
const SEEN_KEY = 'wongoji-note-seen';

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

function near(label, actual, expected, tolerance) {
  const ok = typeof actual === 'number' && Math.abs(actual - expected) <= tolerance;
  check(label, ok, `${typeof actual === 'number' ? actual.toFixed(2) : actual} vs ${expected.toFixed(2)}, ±${tolerance}`);
}

const section = (name) => console.log(`\n  ${name}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* -------------------------------------------------------------------------- */
/* The site                                                                   */
/* -------------------------------------------------------------------------- */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

async function buildSite() {
  const given = process.argv.find((arg) => arg.startsWith('--site='));
  if (given !== undefined) return { dir: resolve(REPO, given.slice('--site='.length)), temp: false };
  const dir = await mkdtemp(join(tmpdir(), 'verify-home-note-site-'));
  const result = spawnSync(process.execPath, [join(REPO, 'node_modules/astro/astro.js'), 'build', '--outDir', dir], {
    cwd: REPO,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.log(result.stdout, result.stderr);
    throw new Error('astro build failed');
  }
  return { dir, temp: true };
}

/** Serves the build, plus one copy of the homepage with its scripts taken out:
 *  the page as the editor's preview has it, which never runs the player. */
function serve(dir) {
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
    if (path === '/no-script/') {
      import('node:fs').then(({ readFileSync }) => {
        const html = readFileSync(join(dir, 'index.html'), 'utf8').replace(/<script\b[^>]*type="module"[^>]*><\/script>/g, '');
        response.writeHead(200, { 'content-type': TYPES['.html'] });
        response.end(html);
      });
      return;
    }
    let file = join(dir, path.replace(/\.\./g, ''));
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!file.startsWith(dir) || !existsSync(file)) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      done({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((closed) => server.close(closed)) });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* A very small DevTools client                                               */
/* -------------------------------------------------------------------------- */

async function openChrome() {
  if (!existsSync(CHROME)) throw new Error(`no Chrome at ${CHROME} (set CHROME_PATH)`);
  const profile = await mkdtemp(join(tmpdir(), 'verify-home-note-chrome-'));
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--window-size=1440,900',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const portFile = join(profile, 'DevToolsActivePort');
  let port = null;
  for (let attempt = 0; attempt < 150 && port === null; attempt += 1) {
    if (existsSync(portFile)) {
      const { readFileSync } = await import('node:fs');
      port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
    } else await sleep(100);
  }
  if (port === null) throw new Error('Chrome did not open a DevTools port');
  let target = null;
  for (let attempt = 0; attempt < 50 && target === null; attempt += 1) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((entry) => entry.type === 'page') ?? null;
    if (target === null) await sleep(100);
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    socket.addEventListener('open', done, { once: true });
    socket.addEventListener('error', () => fail(new Error('cannot reach Chrome')), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  const errors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) entry.fail(new Error(message.error.message));
      else entry.done(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      errors.push(details.exception?.description ?? details.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
    }
    for (const listener of [...listeners]) listener(message);
  });
  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = nextId++;
      pending.set(id, { done, fail });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');

  const page = {
    errors,
    send,
    async size(width, height, { touch = false } = {}) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch });
      await send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
    },
    async media(features) {
      await send('Emulation.setEmulatedMedia', { features });
    },
    async go(url) {
      const loaded = new Promise((done) => {
        const listener = (message) => {
          if (message.method !== 'Page.loadEventFired') return;
          listeners.splice(listeners.indexOf(listener), 1);
          done();
        };
        listeners.push(listener);
      });
      await send('Page.navigate', { url });
      await loaded;
      await page.run('document.fonts.ready.then(() => true)');
    },
    async run(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (result.exceptionDetails !== undefined) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      }
      return result.result.value;
    },
    /** Poll a condition in the page, rather than sleeping a guessed time. */
    async until(expression, timeout = 6000) {
      const began = Date.now();
      while (Date.now() - began < timeout) {
        if (await page.run(expression)) return Date.now() - began;
        await sleep(25);
      }
      return null;
    },
    async mouse(type, x, y) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    },
    async click(x, y) {
      await page.mouse('mouseMoved', x, y);
      await page.mouse('mousePressed', x, y);
      await page.mouse('mouseReleased', x, y);
    },
    async tap(x, y) {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
    /** A real key. Enter has to carry its text: a button is activated by the
     *  character, and a bare rawKeyDown moves nothing (Tab and Escape are
     *  handled on the keydown, so they do not need it). */
    async key(key, code, keyCode) {
      const text = key === 'Enter' ? '\r' : undefined;
      await send('Input.dispatchKeyEvent', { type: text === undefined ? 'rawKeyDown' : 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    },
    async shot(name) {
      mkdirSync(OUT, { recursive: true });
      await send('Emulation.setScrollbarsHidden', { hidden: true });
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await send('Emulation.setScrollbarsHidden', { hidden: false });
      writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    },
    /** Freeze every running animation and transition at `ms` after they
     *  started. Everything a trigger starts, starts in the same task, so one
     *  time fits them all. */
    async freezeAt(ms) {
      await page.run(`(() => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = ${ms}; } })()`);
    },
    async thaw() {
      await page.run('document.getAnimations().forEach((a) => a.play())');
    },
    close() {
      socket.close();
      child.kill();
      return rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
  return page;
}

/* -------------------------------------------------------------------------- */
/* Probes, run in the page                                                    */
/* -------------------------------------------------------------------------- */

const STATE = `(() => {
  const note = document.querySelector('.note');
  const hero = document.querySelector('.hero');
  const replay = document.querySelector('.note-replay');
  return {
    open: !document.querySelector('.note-layer').hidden || !document.querySelector('.note-caption').hidden,
    note: note.className,
    hero: hero.className,
    replayShown: !replay.hidden && getComputedStyle(replay).display !== 'none',
    flight: document.querySelector('.note-flight') !== null,
    seen: (() => { try { return localStorage.getItem('${SEEN_KEY}'); } catch { return 'throws'; } })(),
  };
})()`;

const RECT = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (el === null) return null;
  const b = el.getBoundingClientRect();
  return { left: b.left, top: b.top, width: b.width, height: b.height, right: b.right, bottom: b.bottom };
})()`;

/**
 * Find the grid's own lines in the grid image's pixels, in viewport px.
 *
 * Draws the ground piece's image into a canvas at its natural size and looks
 * for red: a vertical profile across the first row for the columns, and a
 * horizontal one across columns 5 to 7 for the row. Then maps both onto the
 * screen through the image's on-screen box. The result is where the paper's
 * squares actually are, independent of every number in the stylesheet.
 */
const GRID_LINES = `(async () => {
  const img = document.querySelector('.hero .hero-piece[data-note="ground"] img');
  await img.decode().catch(() => {});
  const W = img.naturalWidth, H = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, W, H).data;
  const red = (x, y) => { const i = (y * W + x) * 4; return px[i] - (px[i + 1] + px[i + 2]) / 2; };
  const k = W / 1344; // image px per stage px
  const box = img.getBoundingClientRect();
  const sx = box.width / W, sy = box.height / H;
  // A drawn line is about 1.5px of soft red, so its position is the weighted
  // centre of the redness across it, not its single reddest pixel.
  const centre = (from, to, strength) => {
    const sums = [];
    for (let i = from; i <= to; i++) sums.push(strength(i));
    const floor = Math.min(...sums);
    let weight = 0, moment = 0;
    sums.forEach((s, j) => { const w = s - floor; weight += w; moment += w * (from + j + 0.5); });
    return weight > 0 ? moment / weight : (from + to) / 2;
  };
  // Columns: redness down the first row's interior, near 240/288/336/384.
  const columns = [240, 288, 336, 384].map((want) => {
    const at = centre(Math.round((want - 5) * k), Math.round((want + 5) * k), (x) => {
      let sum = 0;
      for (let y = Math.round(20 * k); y < Math.round(52 * k); y++) sum += Math.max(0, red(x, y));
      return sum;
    });
    return box.left + at * sx;
  });
  // Rows: redness across columns 5 to 7, near the first row's top and bottom
  // (12 and 60 in the image, which starts at stage y 48).
  const rows = [12, 60].map((want) => {
    const at = centre(Math.round((want - 5) * k), Math.round((want + 5) * k), (y) => {
      let sum = 0;
      for (let x = Math.round(244 * k); x < Math.round(380 * k); x++) sum += Math.max(0, red(x, y));
      return sum;
    });
    return box.top + at * sy;
  });
  return { columns, rows };
})()`;

const HEAD_CELLS = `[...document.querySelectorAll('.note-cell')].map((c) => { const b = c.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; })`;

async function measureAlignment(page, width) {
  const lines = await page.run(GRID_LINES);
  const cells = await page.run(HEAD_CELLS);
  // A square's border is 1px and the drawn line is about 1.5px, so compare the
  // centre of the border with the centre of the line.
  for (let i = 0; i < 3; i += 1) {
    near(`${width}: square ${i + 1}'s left edge is on the grid's line`, cells[i].left + 0.5, lines.columns[i], 1);
  }
  near(`${width}: square 3's right edge is on the grid's line`, cells[2].right - 0.5, lines.columns[3], 1);
  near(`${width}: the squares' top is the first row's top line`, cells[0].top + 0.5, lines.rows[0], 1);
  near(`${width}: the squares' bottom is the first row's bottom line`, cells[0].bottom - 0.5, lines.rows[1], 1);
}

/** Point at the middle of the grid without clicking. */
async function heroPoint(page, fx = 0.6, fy = 0.6) {
  const box = await page.run(RECT('.hero'));
  return { x: box.left + box.width * fx, y: box.top + box.height * fy };
}

async function freshVisit(page, url) {
  await page.go(url);
  await page.run(`localStorage.removeItem('${SEEN_KEY}')`);
  await page.go(url);
}

/** Play the note now, on a desktop, by resting the pointer on the grid. */
async function playByHover(page) {
  const point = await heroPoint(page);
  await page.mouse('mouseMoved', point.x, point.y);
  return page.until(`document.querySelector('.note').classList.contains('is-building')`, 2000);
}

/** Wait for the hold, i.e. the build is over. */
const holding = (page, timeout = 4000) => page.until(`document.querySelector('.note').classList.contains('is-holding')`, timeout);
const idle = (page, timeout = 4000) =>
  page.until(`document.querySelector('.note-layer').hidden && document.querySelector('.note-caption').hidden && !document.querySelector('.note-flight')`, timeout);

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                  */
/* -------------------------------------------------------------------------- */

async function desktopFirstVisit(origin) {
  section('Desktop, 1440, first visit');
  const page = await openChrome();
  await page.size(1440, 900);
  await freshVisit(page, `${origin}/`);
  const before = await page.run(STATE);
  check('nothing shows before it plays', !before.open && !before.replayShown && !before.flight, JSON.stringify(before));
  const introBefore = await page.run(RECT('.intro'));

  // The dwell: not at 2.5s, yes by 3.5s. The pointer is off the page.
  await sleep(2500);
  check('it has not played at 2.5s', !(await page.run(STATE)).open);
  const playedAt = await page.until(`document.querySelector('.note').classList.contains('is-building')`, 1500);
  check('it plays by itself at 3s', playedAt !== null, `${playedAt === null ? 'never' : `${2500 + playedAt}ms after load`}`);
  check('playing marks it seen', (await page.run(STATE)).seen === '1');
  check('it does not take focus', await page.run(`document.activeElement === document.body`));

  // The write-on frame.
  await page.freezeAt(700);
  await page.shot('desktop-1-build-700ms');
  const glyphs = await page.run(`[...document.querySelectorAll('.note-glyph')].map((g) => getComputedStyle(g).clipPath)`);
  check('at 700ms 원 and 고 are written and 지 is being written', /inset\(-25%\)|inset\(-25% -25% -25% -25%\)/.test(glyphs[0]) && !/100%/.test(glyphs[2]), glyphs.join(' | '));
  await page.thaw();

  await holding(page);
  await page.shot('desktop-2-note');
  await measureAlignment(page, 1440);

  const look = await page.run(`(() => {
    const ground = document.querySelector('.hero .hero-piece[data-note="ground"]');
    const keep = document.querySelector('.hero .hero-piece[data-note="keep"]');
    const back = document.querySelector('.hero .hero-piece[data-note="step-back"]');
    const p = document.querySelector('.note-body p');
    const em = document.querySelector('.note-body em');
    const g = document.querySelector('.note-glyph');
    return {
      ground: getComputedStyle(ground).opacity, keep: getComputedStyle(keep).opacity,
      back: getComputedStyle(back).opacity, backFilter: getComputedStyle(back).filter,
      keeps: document.querySelectorAll('.hero .hero-piece[data-note="keep"]').length,
      stage: document.querySelector('.hero-stage').getBoundingClientRect().width,
      bodySize: parseFloat(getComputedStyle(p).fontSize), bodyColour: getComputedStyle(p).color,
      bodyWidth: document.querySelector('.note-layer .note-body').getBoundingClientRect().width,
      italic: getComputedStyle(em).fontStyle + ' ' + getComputedStyle(em).fontWeight,
      italicLoaded: document.fonts.check('italic 400 16px Inter', 'draft'),
      pen: document.fonts.check('48px "Nanum Pen Script"', '원고지won-gji'), penColour: getComputedStyle(g).color,
    };
  })()`);
  near('the grid steps back to 0.38', Number(look.ground), 0.38, 0.001);
  near('a scene steps back to 0.10', Number(look.back), 0.1, 0.001);
  check('a scene goes grey', look.backFilter === 'grayscale(1)', look.backFilter);
  check('the four subjects stay at full strength', Number(look.keep) === 1 && look.keeps === 4, `${look.keeps} at ${look.keep}`);
  near('the body is 16px at 1344 and scales with the stage', look.bodySize, Math.min(16, Math.max(14, look.stage * 0.011905)), 0.05);
  near('the body is 580 wide at 1344', look.bodyWidth, (580 * look.stage) / 1344, 0.5);
  check('the body is #1A1A1A on the sheet', look.bodyColour === 'rgb(26, 26, 26)', look.bodyColour);
  check('draft is real italic 400 Inter, not synthesised', look.italic === 'italic 400' && look.italicLoaded, look.italic);
  check('the pen font is loaded for every letter it writes', look.pen && look.penColour === 'rgb(215, 38, 30)');

  // The hold waits under the pointer.
  const point = await heroPoint(page, 0.8, 0.8);
  await page.mouse('mouseMoved', point.x, point.y);
  await sleep(100);
  const paused = await page.run(`document.querySelector('.note-timer-bar').getAnimations()[0]?.playState`);
  await page.mouse('mouseMoved', point.x, 899);
  await page.mouse('mouseMoved', 5, 899);
  await sleep(100);
  const running = await page.run(`document.querySelector('.note-timer-bar').getAnimations()[0]?.playState`);
  check('the hold pauses while the pointer is on the hero', paused === 'paused' && running === 'running', `${paused} then ${running}`);

  // CLOSE, frozen at +350ms, then the landing.
  await page.run(`document.querySelector('.note-close').click()`);
  await sleep(180);
  await page.freezeAt(350);
  const midway = await page.run(`(() => { const f = document.querySelector('.note-flight span'); return f && f.getBoundingClientRect().toJSON(); })()`);
  check('CLOSE: the heading is in flight at +350ms', midway !== null && midway.width < 48 && midway.width > 20, JSON.stringify(midway));
  await page.shot('desktop-3-collapse-350ms');
  await page.thaw();
  check('CLOSE: it lands and is put away', (await idle(page)) !== null);
  check('CLOSE: the label underline draws on landing', await page.run(`document.querySelector('.note-replay').classList.contains('is-landed')`));
  await sleep(2000);
  await page.shot('desktop-4-handed-back');

  const rest = await page.run(`(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect().toJSON();
    return { cells: r('.note-replay-cells'), label: r('.note-replay-label'), button: r('.note-replay'), hero: r('.hero'), stage: r('.hero-stage'), intro: r('.intro'),
      hero2: document.querySelector('.hero').className, underline: document.querySelector('.note-replay').classList.contains('is-landed') };
  })()`);
  const scale = rest.stage.width / 1344;
  near('the button is centred under the sheet', (rest.cells.left + rest.label.right) / 2, rest.stage.left + rest.stage.width / 2, 1);
  near('its squares are 10px under the grid (stage y 790)', (rest.cells.top - rest.stage.top) / scale, 790, 1);
  check('its target is at least 44px tall', rest.button.height >= 44, `${rest.button.height}`);
  near('the intro has not moved', rest.intro.top, introBefore.top, 0.5);
  check('the drawings are all back', rest.hero2 === 'hero', rest.hero2);
  check('the underline is gone again', !rest.underline);

  // Replay, then Escape.
  await page.run(`document.querySelector('.note-replay').click()`);
  const replayed = await page.run(STATE);
  check('the button replays it, and hides while it is up', replayed.open && !replayed.replayShown, JSON.stringify(replayed));
  check('a replay flies the squares up', replayed.flight);
  await holding(page);
  await page.key('Escape', 'Escape', 27);
  await sleep(250);
  check('Escape closes it, into the button', (await page.run(STATE)).flight);
  await idle(page);

  // A click on the sheet, beside the grid (the paper is painted to the edge).
  await page.run(`document.querySelector('.note-replay').click()`);
  await holding(page);
  const band = await page.run(RECT('.hero'));
  await page.click(10, band.top + 200);
  await sleep(250);
  check('a click on the sheet closes it, into the button', (await page.run(STATE)).flight);
  await idle(page);

  // The hold running out.
  await page.run(`document.querySelector('.note-replay').click()`);
  await holding(page);
  await page.run(`document.querySelector('.note-timer-bar').getAnimations()[0].currentTime = 11950`);
  await sleep(250);
  check('the hold running out closes it, into the button', (await page.run(STATE)).flight);
  await idle(page);

  // Scrolling away: no flight, the button is just there.
  await page.run(`document.querySelector('.note-replay').click()`);
  await holding(page);
  await page.run(`window.scrollTo(0, document.querySelector('.hero').getBoundingClientRect().bottom + window.scrollY - 300)`);
  await sleep(250);
  const scrolled = await page.run(STATE);
  check('scrolling the hero half out of view closes it without a flight', !scrolled.flight && scrolled.replayShown, JSON.stringify(scrolled));
  await idle(page);
  await page.run('window.scrollTo(0, 0)');

  // A reload: seen, so no auto-play, and the button from the start.
  await page.go(`${origin}/`);
  check('a reload shows the button from the start', (await page.run(STATE)).replayShown);
  await sleep(3800);
  check('a reload does not play it', !(await page.run(STATE)).open);

  check('no errors in the page', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

async function desktopHover(origin) {
  section('Desktop, the pointer resting on the grid');
  const page = await openChrome();
  await page.size(1440, 900);
  await freshVisit(page, `${origin}/`);
  const began = Date.now();
  const after = await playByHover(page);
  check('600ms of rest on the grid plays it, before the 3s dwell', after !== null && Date.now() - began < 1500, `${Date.now() - began}ms`);
  await page.close();
}

async function narrowDesktop(origin) {
  section('Desktop, 1100 wide');
  const page = await openChrome();
  await page.size(1100, 900);
  await freshVisit(page, `${origin}/`);
  await playByHover(page);
  await holding(page);
  await measureAlignment(page, 1100);
  await page.close();
}

async function phone(origin) {
  section('Phone, 390, touch');
  const page = await openChrome();
  await page.size(390, 844, { touch: true });
  await freshVisit(page, `${origin}/`);

  // A tap on the grid enlarges and never starts the note, even past 3s.
  const point = await heroPoint(page, 0.5, 0.5);
  await page.tap(point.x, point.y);
  await sleep(150);
  check('a tap on the grid opens the lightbox', await page.run(`document.querySelector('#hero-lightbox').classList.contains('is-open')`));
  await sleep(3600);
  check('and the note does not start behind it', !(await page.run(STATE)).open);
  await page.key('Escape', 'Escape', 27);
  await sleep(100);

  // Now the 3s dwell (the clock waited while the lightbox was up).
  check('it plays as a caption once the lightbox is shut', (await page.until(`!document.querySelector('.note-caption').hidden`, 3600)) !== null);
  await page.freezeAt(700);
  await page.shot('mobile-1-build-700ms');
  await page.thaw();
  await holding(page);
  const caption = await page.run(`(() => {
    const note = document.querySelector('.note');
    const cell = document.querySelector('.note-cell').getBoundingClientRect();
    const p = getComputedStyle(document.querySelector('.note-body p'));
    return { inCaption: note.closest('.note-caption') !== null, layerHidden: document.querySelector('.note-layer').hidden,
      cell: cell.width, glyph: getComputedStyle(document.querySelector('.note-glyph')).fontSize,
      size: p.fontSize, line: p.lineHeight, rowAway: getComputedStyle(document.querySelector('.hero-hint')).display };
  })()`);
  check('the note is under the sheet, not over the grid', caption.inCaption && caption.layerHidden);
  check('30px squares, 34px glyphs, 14/22 body', caption.cell === 30 && caption.glyph === '34px' && caption.size === '14px' && caption.line === '22px', JSON.stringify(caption));
  check('the caption is in place of the hint row', caption.rowAway === 'none');
  await page.shot('mobile-2-note');

  await page.run(`document.querySelector('.note-close').click()`);
  await sleep(180);
  await page.freezeAt(350);
  await page.shot('mobile-3-collapse-350ms');
  check('CLOSE: the heading flies into the row', (await page.run(STATE)).flight);
  await page.thaw();
  await idle(page);
  await sleep(2000);
  await page.shot('mobile-4-handed-back');
  const row = await page.run(`(() => {
    const mid = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { y: b.top + b.height / 2, l: b.left, r: b.right }; };
    return { tap: mid('.hero-hint-tap'), rule: mid('.hero-hint-rule'), cells: mid('.note-replay-cells'), label: mid('.note-replay-label'),
      cell: document.querySelector('.note-replay-cell').getBoundingClientRect().width,
      button: document.querySelector('.note-replay').getBoundingClientRect().height,
      vw: document.documentElement.clientWidth };
  })()`);
  check('one row: tap hint, rule, button', Math.abs(row.tap.y - row.rule.y) < 1.5 && Math.abs(row.rule.y - row.cells.y) < 1.5 && row.tap.r < row.rule.l && row.rule.r < row.cells.l, JSON.stringify(row));
  near('the row is centred', (row.tap.l + row.label.r) / 2, row.vw / 2, 1);
  check('16px squares', row.cell === 16);
  check('the button target is at least 44px tall', row.button >= 44, `${row.button}`);

  // Scrolling to read the caption takes the hero below half before the
  // caption goes anywhere. That must not close it; scrolling past both must.
  await page.run(`document.querySelector('.note-replay').click()`);
  await holding(page);
  // The geometry is measured BEFORE anything could close: a close would
  // shrink the page and the scroll would clamp, confusing the picture.
  const reading = await page.run(`(async () => {
    const hero = document.querySelector('.hero').getBoundingClientRect();
    window.scrollTo(0, window.scrollY + hero.top + hero.height * 0.6);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const h = document.querySelector('.hero').getBoundingClientRect();
    const c = document.querySelector('.note-caption').getBoundingClientRect();
    const vh = window.innerHeight;
    const seen = (b) => Math.max(0, Math.min(b.bottom, vh) - Math.max(b.top, 0)) / b.height;
    const geometry = { scrolled: window.scrollY, hero: seen(h), caption: seen(c) };
    await new Promise((r) => setTimeout(r, 450)); // longer than the fade-out
    return { ...geometry, note: document.querySelector('.note').className };
  })()`);
  check(
    'reading the caption with the hero mostly scrolled off keeps it open',
    reading.hero < 0.5 && reading.caption > 0.9 && reading.note.includes('is-holding'),
    JSON.stringify(reading),
  );
  // At 390x844 the page cannot scroll the caption away at all (it is still
  // three quarters on screen at the bottom), so this half is on a short one.
  await page.size(390, 500, { touch: true });
  await page.run('window.scrollTo(0, document.documentElement.scrollHeight)');
  await sleep(450);
  const past = await page.run(STATE);
  check('scrolling past the hero and the caption closes it, without a flight', !past.open && !past.flight && past.replayShown, JSON.stringify(past));
  await page.size(390, 844, { touch: true });
  await page.run('window.scrollTo(0, 0)');
  await sleep(100);

  // The note is up and the lightbox opens: it goes at once, no flight.
  await page.run(`document.querySelector('.note-replay').click()`);
  await holding(page);
  await page.tap(point.x, point.y);
  await sleep(60);
  const gone = await page.run(STATE);
  check('opening the lightbox closes the note at once, without a flight', !gone.open && !gone.flight && gone.replayShown, JSON.stringify(gone));
  check('no errors in the page', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

async function dark(origin) {
  section('Dark mode');
  const page = await openChrome();
  await page.size(1440, 900);
  await page.go(`${origin}/`);
  await page.run(`localStorage.setItem('theme', 'dark'); localStorage.removeItem('${SEEN_KEY}')`);
  await page.go(`${origin}/`);
  await playByHover(page);
  await holding(page);
  const sheet = await page.run(`(() => ({
    theme: document.documentElement.dataset.theme,
    body: getComputedStyle(document.querySelector('.note-body p')).color,
    cell: getComputedStyle(document.querySelector('.note-cell')).backgroundColor,
    sheet: getComputedStyle(document.querySelector('.hero')).backgroundColor,
  }))()`);
  check('the note stays dark ink on the white sheet', sheet.theme === 'dark' && sheet.body === 'rgb(26, 26, 26)' && sheet.sheet === 'rgb(255, 255, 255)', JSON.stringify(sheet));
  await page.shot('dark-desktop-note');
  await page.key('Escape', 'Escape', 27);
  await idle(page);
  await sleep(2000);
  const button = await page.run(`(() => ({
    label: getComputedStyle(document.querySelector('.note-replay-label')).color,
    cell: getComputedStyle(document.querySelector('.note-replay-cell')).backgroundColor,
    page: getComputedStyle(document.body).backgroundColor,
  }))()`);
  check('the button label is --muted on the dark page, its squares stay white', button.label === 'rgb(138, 138, 138)' && button.cell === 'rgb(255, 255, 255)' && button.page === 'rgb(15, 15, 15)', JSON.stringify(button));
  await page.shot('dark-desktop-handed-back');

  await page.size(390, 844, { touch: true });
  await page.run(`document.querySelector('.note-replay').click()`);
  await holding(page);
  const phoneDark = await page.run(`getComputedStyle(document.querySelector('.note-body p')).color`);
  check('under the sheet, on the dark page, the caption is light ink', phoneDark === 'rgb(242, 242, 242)', phoneDark);
  await page.shot('dark-mobile-note');
  await page.close();
}

async function reducedMotion(origin) {
  section('Reduced motion');
  const page = await openChrome();
  await page.size(1440, 900);
  await page.media([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await freshVisit(page, `${origin}/`);
  await playByHover(page);
  const writes = await page.run(`document.querySelector('.note-glyph').getAnimations().length + document.querySelector('.note-body p').getAnimations().length`);
  const fade = await page.run(`document.querySelector('.note').getAnimations().map((a) => a.effect.getTiming().duration)`);
  check('nothing is written on or staggered, the note fades in', writes === 0 && fade.length === 1 && fade[0] === 200, `${writes} part animations, note ${JSON.stringify(fade)}`);
  const delays = await page.run(`[...new Set([...document.querySelectorAll('.hero .hero-piece')].map((p) => getComputedStyle(p).transitionDelay + ' ' + getComputedStyle(p).transitionDuration))]`);
  check('the drawings step back in one 200ms fade', delays.length === 1 && delays[0].startsWith('0s 0.2s'), JSON.stringify(delays));
  await holding(page, 1000);
  await page.run(`document.querySelector('.note-close').click()`);
  let flew = false;
  for (let i = 0; i < 12; i += 1) {
    flew ||= await page.run(`document.querySelector('.note-flight') !== null`);
    await sleep(25);
  }
  check('closing does not fly', !flew);
  check('it fades out and the button is there', (await idle(page, 1000)) !== null && (await page.run(STATE)).replayShown);
  await page.close();
}

async function keyboardAndTree(origin) {
  section('Keyboard and the accessibility tree');
  const page = await openChrome();
  await page.size(1440, 900);
  await freshVisit(page, `${origin}/`);
  await page.send('Accessibility.enable');

  const tree = async () => {
    const { nodes } = await page.send('Accessibility.getFullAXTree');
    return nodes.filter((n) => !n.ignored).map((n) => ({ role: n.role?.value, name: n.name?.value ?? '' }));
  };
  const label = await page.run(`document.querySelector('.hero-stage').getAttribute('aria-label')`);
  const quiet = await tree();
  check('the illustration is announced once', quiet.filter((n) => n.name === label).length === 1, `${quiet.filter((n) => n.name === label).length} times`);
  check('none of the 23 scenes is announced on its own', quiet.filter((n) => n.role === 'image').length === 1);
  check('the hidden note is not in the tree', !quiet.some((n) => n.name.startsWith('Korean manuscript paper')));

  await playByHover(page);
  await holding(page);
  const open = await tree();
  check('the note is a landmark named by its heading, 원고지 as one word', open.some((n) => n.role === 'complementary' && n.name === '원고지 won-go-ji'), JSON.stringify(open.filter((n) => n.role === 'complementary')));
  check('its text can be reached', open.some((n) => n.role === 'StaticText' && n.name.startsWith('Korean manuscript paper')));
  check('focus was not moved', await page.run(`document.activeElement === document.body`));

  // Tab from the top reaches CLOSE.
  let reached = false;
  for (let i = 0; i < 20 && !reached; i += 1) {
    await page.key('Tab', 'Tab', 9);
    reached = await page.run(`document.activeElement === document.querySelector('.note-close')`);
  }
  check('Tab reaches CLOSE', reached);
  await page.key('Enter', 'Enter', 13);
  await idle(page);
  check('closing from the keyboard leaves focus on the hero, not the page top', await page.run(`document.activeElement === document.querySelector('.hero')`));
  await page.key('Tab', 'Tab', 9);
  check('the next Tab is the replay button', await page.run(`document.activeElement === document.querySelector('.note-replay')`));
  await page.key('Enter', 'Enter', 13);
  await sleep(50);
  check('a keyboard replay puts focus on the note', await page.run(`document.activeElement === document.querySelector('.note')`));
  await page.key('Escape', 'Escape', 27);
  await idle(page);
  check('no errors in the page', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

async function blockedStorage(origin) {
  section('Storage that throws');
  const page = await openChrome();
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });`,
  });
  await page.size(1440, 900);
  await page.go(`${origin}/`);
  check('it still plays, as a first visit', (await playByHover(page)) !== null);
  await holding(page);
  await page.key('Escape', 'Escape', 27);
  await idle(page);
  check('the button still appears', (await page.run(STATE)).replayShown);
  check('no errors in the page', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

async function noScript(origin) {
  section('No script (the editor preview never runs the player)');
  const page = await openChrome();
  await page.size(1440, 900);
  await page.go(`${origin}/no-script/`);
  await sleep(3500);
  const shown = await page.run(`(() => ['.note-layer', '.note-caption', '.note-replay', '.hero-hint-rule', '.note'].map((s) => {
    const el = document.querySelector(s); return s + ':' + (el.getClientRects().length > 0);
  }))()`);
  check('nothing of the note is drawn', shown.every((entry) => entry.endsWith('false')), shown.join(' '));
  check('the hint row takes no room on a desktop', (await page.run(RECT('.hero-hint'))).height === 0);
  await page.close();
}

/* -------------------------------------------------------------------------- */

const site = await buildSite();
const server = await serve(site.dir);
console.log(`verify-home-note: ${site.dir}\n  screenshots: ${OUT}`);
try {
  await desktopFirstVisit(server.origin);
  await desktopHover(server.origin);
  await narrowDesktop(server.origin);
  await phone(server.origin);
  await dark(server.origin);
  await reducedMotion(server.origin);
  await keyboardAndTree(server.origin);
  await blockedStorage(server.origin);
  await noScript(server.origin);
} finally {
  await server.close();
  if (site.temp) await rm(site.dir, { recursive: true, force: true });
}

console.log(`\n${total - failures} passed, ${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
