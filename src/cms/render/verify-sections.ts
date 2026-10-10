/**
 * src/cms/render/verify-sections.ts
 *
 * WS-B's standalone proof. Renders all five surfaces of the site from WS-A's
 * fixtures, measures them in a real browser, screenshots them at 1440 and 390,
 * and — for the two pages the brief names — compares them pixel for pixel
 * against the markup that is live on jinhyuk.org right now.
 *
 *   node src/cms/render/verify-sections.ts [--out=<dir>] [--offline] [--keep]
 *
 * Nothing here imports another workstream. It does not run `astro build`, and
 * it does not need the CMS, the API or the editor to exist.
 *
 * How the comparison works, because this is the part that matters:
 *
 *   1. Fetch the live page. Take its whole document — header, nav, footer,
 *      theme script, everything — as the shell.
 *   2. Build two local pages from that one shell. One keeps the live
 *      `<main>` exactly as it came off the wire. The other replaces the
 *      inside of `<main>` with what this workstream's renderer produced.
 *   3. Point both at the LOCAL src/styles/global.css instead of the deployed
 *      /_astro bundle, so the CSS under test is the one that will ship.
 *   4. Screenshot both and count the pixels that differ.
 *
 * So the only difference between the two pictures is the markup, which is the
 * only thing this workstream changed. A nonzero diff is a real regression and
 * not a font landing a frame late or a deploy being a week old.
 *
 * Two notes on the browser, both learned the hard way in WS-1's verify.ts:
 *
 *  - Chrome will not open a window narrower than about 500px, so the 390 case
 *    is rendered inside a 390px iframe on a wider page. An iframe is a real
 *    viewport, so the 900px media query fires exactly as it would on a phone.
 *  - Screenshots are not the only evidence: each page measures itself and
 *    reports through document.title, and the assertions at the bottom check
 *    those numbers, so a regression fails the script instead of waiting to be
 *    noticed in a picture.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  MOBILE_BREAKPOINT,
  formatIssues,
  validateDocJson,
  validateFilmographyJson,
  validatePhotographyJson,
  youtubeThumbUrl,
} from '../schema.ts';
import type { Album, Doc, Film } from '../schema.ts';
import {
  albumLightboxId,
  docStyles,
  ensureShapeAssets,
  renderAlbumPage,
  renderDoc,
  renderDocPage,
  renderFilmography,
  renderLedgerPage,
  renderPhotography,
  sectionStyles,
} from './index.ts';
import type { LedgerItem } from './pages/ledger.ts';

/* -------------------------------------------------------------------------- */
/* Setup                                                                      */
/* -------------------------------------------------------------------------- */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PROJECT = resolve(HERE, '../../..');
const PUBLIC_DIR = join(PROJECT, 'public');
const FIXTURES = join(PROJECT, 'src/cms/fixtures');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SITE = 'https://jinhyuk.org';

/** The designed page, and a phone. */
const WIDTHS = [1440, 390] as const;
/** Chrome's own window floor. Anything narrower is rendered in an iframe. */
const CHROME_MIN_WINDOW = 520;
/** See the server: a blocking script that answers late, to settle the fonts. */
const HOLD_SCRIPT = '__hold.js';
const HOLD_MS = 1500;

const args = process.argv.slice(2);
const outArg = args.find((arg) => arg.startsWith('--out='));
const OUT =
  outArg !== undefined
    ? resolve(outArg.slice('--out='.length))
    : join(tmpdir(), 'jinhyuk-wsb-sections');
const PROFILES = join(OUT, '.chrome-profiles');
const OFFLINE = args.includes('--offline');
/** A fresh Chrome profile per launch; a reused one sometimes refuses to start. */
let launches = 0;

const failures: string[] = [];
const notes: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function approx(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

/**
 * The content column, measured rather than assumed: `<main>` sits inside
 * `.wrap`, so its width is the column after the gutter.
 *
 * Measured and not hardcoded because `html { scrollbar-gutter: stable }`
 * reserves the scrollbar whether or not the page scrolls, so the designed
 * 1344px column is 1329px in a 1440px window, and the gutter itself halves
 * below the breakpoint. An assertion against 1344 would be wrong about the
 * right thing.
 */
function columnWidth(metrics: Metrics): number {
  return metrics.el.main?.w ?? metrics.clientWidth;
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function readDoc(name: string): Doc {
  const result = validateDocJson(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
  if (!result.ok) throw new Error(`${name}.json does not validate:\n${formatIssues(result.issues)}`);
  return result.doc;
}

function readFilms(): Film[] {
  const result = validateFilmographyJson(readFileSync(join(FIXTURES, 'filmography.json'), 'utf8'));
  if (!result.ok) throw new Error(`filmography.json:\n${formatIssues(result.issues)}`);
  return result.data.films;
}

function readAlbums(): Album[] {
  const result = validatePhotographyJson(readFileSync(join(FIXTURES, 'photography.json'), 'utf8'));
  if (!result.ok) throw new Error(`photography.json:\n${formatIssues(result.issues)}`);
  return result.data.albums;
}

/**
 * Frontmatter off the live content files, for the two ledger surfaces. Reading
 * the real content rather than a fixture is the point: an index page that
 * renders the same rows as the live one is the only way to compare it.
 */
type Front = { title: string; date: string; summary?: string; draft: boolean; slug: string };

function readFrontmatter(dir: string, ext: string): Front[] {
  const full = join(PROJECT, dir);
  if (!existsSync(full)) return [];
  const out: Front[] = [];
  for (const file of readdirSync(full).sort()) {
    if (!file.endsWith(ext)) continue;
    const text = readFileSync(join(full, file), 'utf8');
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (block === null) continue;
    const body = block[1]!;
    const one = (key: string): string | undefined => {
      const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(body);
      if (match === null) return undefined;
      return match[1]!.trim().replace(/^['"]|['"]$/g, '');
    };
    // A folded summary (`summary: >-`) runs over several indented lines, and
    // ends at the first line that is not indented. No `m` flag: with it, `$`
    // matches at the end of every line and the lazy body stops after one.
    const folded = (key: string): string | undefined => {
      const match = new RegExp(`(?:^|\\n)${key}:[ \\t]*>-?[ \\t]*\\r?\\n((?:[ \\t]+[^\\n]*\\r?\\n?)+)`).exec(
        body,
      );
      if (match === null) return undefined;
      return match[1]!
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .join(' ');
    };
    const title = one('title');
    const date = one('date');
    if (title === undefined || date === undefined) continue;
    const summary = folded('summary') ?? one('summary');
    const entry: Front = {
      title,
      date: date.slice(0, 10),
      draft: one('draft') === 'true',
      slug: file.slice(0, -ext.length),
    };
    if (summary !== undefined) entry.summary = summary;
    out.push(entry);
  }
  return out;
}

function ledgerItems(front: Front[], base: string, withSummary: boolean): LedgerItem[] {
  return front
    .filter((entry) => !entry.draft)
    .map((entry) => {
      const item: LedgerItem = {
        href: `${base}${entry.slug}/`,
        title: entry.title,
        date: entry.date,
      };
      if (withSummary && entry.summary !== undefined) item.summary = entry.summary;
      return item;
    });
}

/* -------------------------------------------------------------------------- */
/* The measuring script                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Measures a page and posts the numbers into document.title, which is the one
 * channel `--dump-dom` gives back. Plain script, so it needs no build step,
 * and it takes a window so the 390 wrapper can measure the iframe it holds.
 *
 * Positions come from offsetLeft/offsetTop and offsetWidth rather than
 * getBoundingClientRect, for the same reason WS-1's harness does it: a rotated
 * item's bounding rect is its rotated bounding box.
 */
const MEASURE_SCRIPT = `
function round(v) { return Math.round(v * 100) / 100; }
function num(v) { var n = parseFloat(v); return isNaN(n) ? null : round(n); }
function boxes(win, selector) {
  return [].slice.call(win.document.querySelectorAll(selector)).map(function (el) {
    var r = el.getBoundingClientRect();
    return { w: round(r.width), h: round(r.height), x: round(r.left + win.scrollX), y: round(r.top + win.scrollY) };
  });
}
function first(win, selector) {
  var el = win.document.querySelector(selector);
  if (!el) return null;
  var r = el.getBoundingClientRect();
  var s = win.getComputedStyle(el);
  return {
    w: round(r.width), h: round(r.height),
    display: s.display, position: s.position,
    fontSize: num(s.fontSize), lineHeight: num(s.lineHeight),
    marginBottom: num(s.marginBottom), marginTop: num(s.marginTop),
    paddingTop: num(s.paddingTop), color: s.color,
    borderLeftColor: s.borderLeftColor, borderTopWidth: num(s.borderTopWidth),
    aspect: r.height > 0 ? round(r.width / r.height) : null
  };
}
function pageMetrics(win) {
  var d = win.document;
  return {
    innerWidth: win.innerWidth,
    clientWidth: d.documentElement.clientWidth,
    scrollWidth: d.documentElement.scrollWidth,
    scrollHeight: Math.ceil(Math.max(d.documentElement.scrollHeight, d.body.scrollHeight)),
    mobile: win.matchMedia('(max-width: ${MOBILE_BREAKPOINT}px)').matches,
    counts: {
      card: d.querySelectorAll('.card').length,
      cardLink: d.querySelectorAll('.card-link').length,
      video: d.querySelectorAll('.video').length,
      videoWithEmbed: d.querySelectorAll('.video[data-embed]').length,
      iframe: d.querySelectorAll('iframe').length,
      emptyState: d.querySelectorAll('.empty-state').length,
      albumPhoto: d.querySelectorAll('.album-photo').length,
      albumOpen: d.querySelectorAll('.album-open').length,
      ledgerRow: d.querySelectorAll('.ledger li').length,
      docP: d.querySelectorAll('.doc-p').length,
      introP: d.querySelectorAll('.intro p').length,
      docButton: d.querySelectorAll('.doc-button').length,
      lightbox: d.querySelectorAll('.lightbox').length,
      openLightbox: d.querySelectorAll('.lightbox.is-open').length,
      hero: d.querySelectorAll('.hero').length,
      connectors: d.querySelectorAll('.doc-connectors path').length
    },
    el: {
      main: first(win, 'main'),
      intro: first(win, '.intro'),
      heroImg: first(win, '.hero img'),
      firstVideo: first(win, '.video'),
      firstCardMedia: first(win, '.card-media'),
      docP: first(win, '.doc-p'),
      docQuote: first(win, '.doc-quote'),
      docList: first(win, '.doc-list'),
      docButtons: first(win, '.doc-buttons'),
      docHead: first(win, '.doc-head'),
      albumMeta: first(win, '.album-meta'),
      albumGrid: first(win, '.album-grid'),
      lightbox: first(win, '.lightbox'),
      emptyArt: first(win, '.empty-art')
    },
    state: {
      bodyLocked: d.body.classList.contains('is-locked'),
      videoHasPlayer: !!d.querySelector('.video iframe'),
      postersLeft: d.querySelectorAll('.video img').length,
      playerSrc: (function () {
        var f = d.querySelector('.video iframe');
        return f ? f.getAttribute('src') : null;
      })(),
      stageSrc: (function () {
        var i = d.querySelector('.lightbox.is-open .lightbox-stage img');
        return i ? i.getAttribute('src') : null;
      })(),
      counter: (function () {
        var c = d.querySelector('.lightbox-count');
        return c ? c.textContent : null;
      })()
    },
    albumPhotos: boxes(win, '.album-photo'),
    albumImgs: boxes(win, '.album-photo img'),
    cards: boxes(win, '.card')
  };
}
function publish(m) { document.title = 'METRICS' + JSON.stringify(m); }
/* renderers mark media loading="lazy", which is right on a real page and wrong
   for a camera: a lazy image is not counted in the load event, so Chrome
   captures the frame while the pictures are still arriving. Flipping them is
   the harness opting out of lazy loading, not the renderer. */
function loadEverything(win) {
  var imgs = win.document.querySelectorAll('img[loading="lazy"]');
  for (var i = 0; i < imgs.length; i += 1) imgs[i].loading = 'eager';
  return imgs.length;
}
`;

/**
 * The interaction pass. A screenshot proves the markup; this proves the two
 * client modules this workstream ships actually do something, which a picture
 * of a page nobody touched cannot.
 *
 * Driven by `?act=` on the URL. The static server ignores the query string, so
 * the same file serves both the quiet and the clicked run.
 *
 *   play      click the first film facade; a player should replace the still
 *   open      click the first photograph; the overlay should open on it
 *   next      open, then press ArrowRight; the overlay should advance
 *   escape    open, then press Escape; the overlay should close and unlock
 *
 * Idempotent: it runs on every measuring pass and marks the window when it is
 * done, so the three passes do not click three times.
 */
const ACT_SCRIPT = `
function press(key) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true }));
}
function act(win) {
  if (win.__acted) return;
  var which = new URLSearchParams(win.location.search).get('act');
  if (!which) return;
  var d = win.document;
  if (which === 'play') {
    var video = d.querySelector('.video');
    if (!video) return;
    video.click();
  } else if (which === 'open' || which === 'next' || which === 'escape') {
    var photo = d.querySelector('.album-open');
    if (!photo) return;
    photo.click();
    if (which === 'next') press('ArrowRight');
    if (which === 'escape') press('Escape');
  }
  win.__acted = true;
}
`;

type ElementMetrics = {
  w: number;
  h: number;
  display: string;
  position: string;
  fontSize: number | null;
  lineHeight: number | null;
  marginBottom: number | null;
  marginTop: number | null;
  paddingTop: number | null;
  color: string;
  borderLeftColor: string;
  borderTopWidth: number | null;
  aspect: number | null;
};

type Box = { w: number; h: number; x: number; y: number };

type Metrics = {
  innerWidth: number;
  clientWidth: number;
  scrollWidth: number;
  scrollHeight: number;
  mobile: boolean;
  counts: Record<string, number>;
  el: Record<string, ElementMetrics | null>;
  state: {
    bodyLocked: boolean;
    videoHasPlayer: boolean;
    postersLeft: number;
    playerSrc: string | null;
    stageSrc: string | null;
    counter: string | null;
  };
  albumPhotos: Box[];
  albumImgs: Box[];
  cards: Box[];
};

/* -------------------------------------------------------------------------- */
/* Building the pages                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Swap a live page's deployed stylesheet for the local one, drop its own
 * module scripts, give it a title this harness can overwrite, and append the
 * measuring script. Everything else — the header, the nav, the theme script,
 * the footer, the font link — is left exactly as it came off the wire, which
 * is what makes the two pages comparable.
 */
function localise(liveHtml: string, mainInner: string | null, label: string): string {
  let html = liveHtml;

  // The deployed CSS bundle becomes the local one. First hit is replaced,
  // any others are dropped, so the two stylesheets land in a known order.
  let swapped = false;
  html = html.replace(/<link[^>]+rel="stylesheet"[^>]*href="\/_astro\/[^"]+"[^>]*>/g, () => {
    if (swapped) return '';
    swapped = true;
    return '<link rel="stylesheet" href="global.css" /><link rel="stylesheet" href="doc.css" /><link rel="stylesheet" href="sections.css" />';
  });
  if (!swapped) {
    html = html.replace(
      '</head>',
      '<link rel="stylesheet" href="global.css" /><link rel="stylesheet" href="doc.css" /><link rel="stylesheet" href="sections.css" /></head>',
    );
  }

  // The deployed page's own behaviour: the facade, the theme toggle wiring and
  // the hero overlay. Dropped so neither page runs script the other does not.
  html = html.replace(/<script[^>]+type="module"[^>]*><\/script>/g, '');

  if (mainInner !== null) {
    html = html.replace(/<main>[\s\S]*?<\/main>/, `<main>\n${mainInner}\n</main>`);
  }

  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${label}</title>`);

  /* The one change the harness makes to every page, live markup and mine
     alike. `loading="lazy"` is right on a real page and wrong for a camera: a
     lazy image is not counted in the load event, so Chrome captures the frame
     while the pictures are still arriving, and which ones win that race
     changes run to run. Dropping the attribute makes the load event wait, so
     the screenshot is deterministic. It changes when an image loads, never
     where it lands. */
  html = html.replace(/ loading="lazy"/g, '');

  /* And the same bargain for decoding. `async` lets the browser paint a frame
     before a picture has been turned into pixels, which on a 4700px album at
     phone width left three of six photographs as empty boxes in the one frame
     the camera gets. `sync` costs nothing here and nothing ships with it. */
  html = html.replace(/ decoding="async"/g, ' decoding="sync"');

  const tail = `
<script src="${HOLD_SCRIPT}"></script>
<script type="module" src="client.js"></script>
<script>
${MEASURE_SCRIPT}
${ACT_SCRIPT}
function run() { publish(pageMetrics(window)); }
loadEverything(window);
window.addEventListener('load', function () {
  loadEverything(window);
  act(window);
  run();
  requestAnimationFrame(function () { requestAnimationFrame(run); });
  setTimeout(function () { act(window); run(); }, 400);
  setTimeout(run, 1200);
  if (document.fonts) document.fonts.ready.then(function () { setTimeout(run, 60); });
});
</script>
`;
  return html.replace('</body>', `${tail}</body>`);
}

/** The 390 case, in an iframe, because Chrome will not go that narrow. */
function iframePage(page: string, width: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${page} @ ${width}</title>
<style>
  html, body { margin: 0; background: #8a8a8a; }
  iframe { display: block; width: ${width}px; border: 0; background: #ffffff; }
</style>
</head>
<body>
<iframe id="frame" src="${page}" width="${width}" height="800" scrolling="no"></iframe>
<script>
${MEASURE_SCRIPT}
var frame = document.getElementById('frame');
function run() {
  var win = frame.contentWindow;
  if (!win || !win.document || !win.document.body) return;
  loadEverything(win);
  var m = pageMetrics(win);
  frame.style.height = m.scrollHeight + 'px';
  var again = pageMetrics(win);
  again.scrollHeight = Math.max(m.scrollHeight, again.scrollHeight);
  publish(again);
}
frame.addEventListener('load', function () {
  run();
  setTimeout(run, 300);
  setTimeout(run, 900);
  setTimeout(run, 1600);
});
</script>
</body>
</html>
`;
}

/**
 * Counts the pixels two screenshots disagree about, in the browser, on a
 * canvas. In the browser because that needs no PNG decoder and therefore no
 * dependency: this project has none for images, and adding one to count
 * pixels would be a strange thing to put in a package.json.
 */
function comparePage(a: string, b: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8" /><title>compare</title>
<style>html,body{margin:0;background:#222}</style></head>
<body>
<script>
function load(src) {
  return new Promise(function (done, fail) {
    var img = new Image();
    img.onload = function () { done(img); };
    img.onerror = function () { fail(new Error('could not load ' + src)); };
    img.src = src;
  });
}
Promise.all([load('${a}'), load('${b}')]).then(function (pair) {
  var one = pair[0], two = pair[1];
  var w = Math.min(one.naturalWidth, two.naturalWidth);
  var h = Math.min(one.naturalHeight, two.naturalHeight);
  function data(img) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, w, h).data;
  }
  var A = data(one), B = data(two);
  var differing = 0, worst = 0, firstRow = -1;
  for (var i = 0; i < A.length; i += 4) {
    var d = Math.max(
      Math.abs(A[i] - B[i]),
      Math.abs(A[i + 1] - B[i + 1]),
      Math.abs(A[i + 2] - B[i + 2])
    );
    /* 8 of 255, so antialiasing on a glyph edge does not read as a diff. */
    if (d > 8) {
      differing += 1;
      if (d > worst) worst = d;
      if (firstRow === -1) firstRow = Math.floor(i / 4 / w);
    }
  }
  document.title = 'METRICS' + JSON.stringify({
    sizeA: [one.naturalWidth, one.naturalHeight],
    sizeB: [two.naturalWidth, two.naturalHeight],
    compared: [w, h],
    pixels: w * h,
    differing: differing,
    ratio: Math.round((differing / (w * h)) * 1e6) / 1e6,
    worst: worst,
    firstRow: firstRow
  });
}).catch(function (error) {
  document.title = 'METRICSERROR' + error.message;
});
</script>
</body></html>
`;
}

/* -------------------------------------------------------------------------- */
/* Static server                                                              */
/* -------------------------------------------------------------------------- */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/**
 * Serves the rendered pages out of OUT and everything else out of public/, so a
 * site-absolute `src` resolves exactly as it will on the live site. `file://`
 * cannot do that: there, a site-absolute path resolves against the filesystem
 * root.
 */
function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0]!);
    const safe = path.replace(/\.\./g, '');

    // A classic script tag that answers late. Chrome's screenshot pass fires
    // on the load event, and the webfonts occasionally land a frame after it:
    // one run in ten came back with the wordmark in a fallback face, which
    // reads as a one per cent pixel diff and is not a regression. A blocking
    // script at the end of the body holds the load event open, costs nothing
    // in layout, and is served to both pages of a comparison alike.
    if (safe === `/${HOLD_SCRIPT}`) {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        response.end('/* held the load event so the fonts could land */\n');
      }, HOLD_MS);
      return;
    }
    for (const base of [OUT, PUBLIC_DIR]) {
      const file = join(base, safe);
      if (!file.startsWith(base)) continue;
      if (!safe.endsWith('/') && existsSync(file) && statSync(file).isFile()) {
        response.writeHead(200, {
          'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        });
        createReadStream(file).pipe(response);
        return;
      }
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end(`not found: ${safe}`);
  });

  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      done({ port, close: () => new Promise<void>((closed) => server.close(() => closed())) });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Chrome                                                                     */
/* -------------------------------------------------------------------------- */

function chrome(
  extra: string[],
  url: string,
  width: number,
  height: number,
  ready: (stdout: string) => boolean,
  limitMs = 45000,
): Promise<string> {
  return new Promise((done) => {
    const child = spawn(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--force-device-scale-factor=1',
        '--hide-scrollbars',
        `--user-data-dir=${join(PROFILES, String((launches += 1)))}`,
        `--window-size=${width},${height}`,
        ...extra,
        url,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(deadline);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      done(stdout);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.resume();
    child.on('error', finish);
    child.on('exit', finish);

    const poll = setInterval(() => {
      if (ready(stdout)) finish();
    }, 150);
    const deadline = setTimeout(finish, limitMs);
  });
}

/** Fast-forward the clock, then dump. */
const DUMP_FLAGS = ['--virtual-time-budget=9000', '--dump-dom'];
/** Real time, and nothing captured until every compositor stage has run. */
const SHOT_FLAGS = [
  '--run-all-compositor-stages-before-draw',
  '--disable-new-content-rendering-timeout',
];

const domReady = (stdout: string): boolean => stdout.includes('</html>');

function shotReady(path: string): () => boolean {
  return () => {
    if (!existsSync(path)) return false;
    const stat = statSync(path);
    return stat.size > 1024 && Date.now() - stat.mtimeMs > 400;
  };
}

function readMetrics<T>(dom: string): T | null {
  const match = /<title>METRICS(.*?)<\/title>/s.exec(dom);
  if (match === null) return null;
  const json = match[1]!
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

async function shoot(url: string, file: string, width: number, height: number): Promise<boolean> {
  rmSync(file, { force: true });
  await chrome(
    [...SHOT_FLAGS, `--screenshot=${file}`],
    url,
    width,
    Math.min(Math.max(height, 600), 15000),
    shotReady(file),
  );
  return existsSync(file);
}

/* -------------------------------------------------------------------------- */
/* The surfaces                                                               */
/* -------------------------------------------------------------------------- */

type Surface = {
  /** File and screenshot prefix. */
  name: string;
  /** The live page whose shell it borrows, and whose markup it is compared to. */
  livePath: string;
  /** The rendered `<main>` contents. */
  body: string;
  /**
   * True when this surface renders the same content the live page renders, so
   * the two can be compared pixel for pixel. False means the screenshots are
   * evidence and the assertions are the proof.
   */
  compare: boolean;
  /** Per-surface assertions, run against the measured numbers. */
  expect?: (metrics: Metrics, width: number) => void;
};

async function fetchLive(path: string): Promise<string | null> {
  if (OFFLINE) return null;
  try {
    const response = await fetch(`${SITE}${path}`, {
      headers: { 'user-agent': 'jinhyuk.org WS-B verify-sections' },
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);

  const realShapes = await ensureShapeAssets();
  console.log(`shapes: ${realShapes ? "WS-6's generator" : "WS-1's fallback"}`);

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  for (const [file, from] of [
    ['global.css', 'src/styles/global.css'],
    ['doc.css', docStyles().replace(/^\//, '')],
    ['sections.css', sectionStyles().replace(/^\//, '')],
  ] as const) {
    writeFileSync(join(OUT, file), readFileSync(join(PROJECT, from), 'utf8'));
  }

  // The three client modules, as a browser needs them. esbuild is already in
  // the tree (Vite's), so this needs no new dependency.
  writeFileSync(
    join(OUT, 'client-entry.ts'),
    [
      `import { initDocConnectors } from '${join(HERE, 'connectors.ts')}';`,
      `import { initVideoFacades } from '${join(HERE, 'video.ts')}';`,
      `import { initLightboxes } from '${join(HERE, 'lightbox.ts')}';`,
      'initDocConnectors();',
      'initVideoFacades();',
      'initLightboxes();',
      '',
    ].join('\n'),
  );
  const bundle = spawnSync(
    join(PROJECT, 'node_modules/.bin/esbuild'),
    [
      join(OUT, 'client-entry.ts'),
      '--bundle',
      '--format=esm',
      '--target=es2022',
      `--outfile=${join(OUT, 'client.js')}`,
    ],
    { encoding: 'utf8' },
  );
  if (bundle.status !== 0) throw new Error(`esbuild failed:\n${bundle.stderr}`);

  /* ---- the content -------------------------------------------------------- */

  const home = readDoc('home');
  const essay = readDoc('essay');
  const films = readFilms();
  const albums = readAlbums();

  /**
   * The same four films, but with the trailer's poster filled in. The fixture
   * leaves `film_space_race_trailer.poster` out on purpose, so that
   * `filmPosterSrc`'s YouTube fallback is exercised by the corpus — which also
   * means the fixture cannot be compared to the live page, where all four
   * stills are local files. This is the comparable version, and the only
   * change is that one `poster`.
   */
  const filmsAsLive: Film[] = films.map((film) =>
    film.poster === undefined ? { ...film, poster: `/filmography/${film.youtubeId}.jpg` } : film,
  );
  check(
    films.some((film) => film.poster === undefined),
    'the filmography fixture should still exercise the YouTube poster fallback',
  );
  notes.push(
    `filmography: the fixture's one posterless film falls back to ${youtubeThumbUrl(
      films.find((film) => film.poster === undefined)?.youtubeId ?? '',
    )}`,
  );

  const essayFront = readFrontmatter('src/content/writing', '.md');
  const projectFront = readFrontmatter('src/content/projects', '.mdoc');

  const firstBuild = albums.find((album) => album.slug === 'first-build');
  const developing = albums.find((album) => album.slug === 'developing');
  if (firstBuild === undefined || developing === undefined) {
    throw new Error('the photography fixture no longer has first-build and developing');
  }

  /**
   * The same essay with its canvas band taken out, which is what all three
   * essays on the live site are: prose and nothing else. It is here because
   * the reading column differs between the two — a canvas-free essay keeps
   * the live 720px, one with a canvas gets the measure that scales with the
   * column so the item stays beside the text — and only testing the canvas
   * case would leave the common one unproven.
   */
  const essayProse: Doc = {
    ...essay,
    meta: { ...essay.meta, slug: 'fixture-essay-prose' },
    bands: essay.bands.filter((band) => band.type !== 'canvas'),
  };

  const surfaces: Surface[] = [
    {
      name: 'home',
      livePath: '/',
      body: renderDoc(home),
      compare: true,
      expect: (m, width) => {
        check(m.counts.hero === 1, `home @ ${width}: exactly one .hero`);
        check(m.counts.introP === 4, `home @ ${width}: the name plus three paragraphs`);
        check(m.counts.lightbox === 1, `home @ ${width}: the enlarge overlay is in the page`);
        check(
          m.counts.openLightbox === 0,
          `home @ ${width}: the overlay must start closed`,
        );
        check(m.counts.docP === 0, `home @ ${width}: the intro is .intro p, not .doc-p`);
        const column = columnWidth(m);
        check(
          m.el.intro !== null && approx(m.el.intro.w, Math.min(1184, column), 1),
          `home @ ${width}: .intro holds its 1184px measure, got ${m.el.intro?.w} of ${column}`,
        );
        check(
          m.el.heroImg !== null && approx(m.el.heroImg.w, column, 1),
          `home @ ${width}: the hero fills the column, got ${m.el.heroImg?.w} of ${column}`,
        );
      },
    },
    {
      name: 'essay',
      livePath: '/essays/chasing-the-workaround/',
      body: renderDocPage(essay),
      compare: false,
      expect: (m, width) => {
        const column = columnWidth(m);
        const measure = Math.min(720, column);
        // The live essay's own numbers: `article p { margin: 0 0 27px }`,
        // narrowed to 20px below the breakpoint by global.css.
        const gap = width < MOBILE_BREAKPOINT ? 20 : 27;

        check(m.counts.docButton === 1, `essay @ ${width}: the end-of-post button is rendered`);
        check(
          m.el.docButtons !== null && m.el.docButtons.borderTopWidth === 1,
          `essay @ ${width}: the buttons keep their top rule`,
        );
        check(
          m.el.docP !== null && m.el.docP.marginBottom === gap,
          `essay @ ${width}: paragraphs are ${gap}px apart like a live essay, got ${m.el.docP?.marginBottom}`,
        );
        check(
          m.el.docQuote !== null && approx(m.el.docQuote.fontSize ?? 0, 17.5, 0.1),
          `essay @ ${width}: the quote is body size like a live essay, got ${m.el.docQuote?.fontSize}`,
        );
        check(
          m.el.docQuote !== null && m.el.docQuote.borderLeftColor === 'rgb(228, 228, 228)',
          `essay @ ${width}: the quote keeps the live essay's --rule hairline, got ${m.el.docQuote?.borderLeftColor}`,
        );
        check(
          m.el.docHead !== null && approx(m.el.docHead.w, measure, 1),
          `essay @ ${width}: the masthead keeps the ${measure}px measure, got ${m.el.docHead?.w}`,
        );
        check(
          m.el.docButtons !== null && approx(m.el.docButtons.w, measure, 1),
          `essay @ ${width}: the buttons' rule stops at the text measure, got ${m.el.docButtons?.w}`,
        );
        // This fixture HAS a canvas band, so the measure is the scaling one:
        // 720px of the column, where the column is 1344px at the reference
        // width. `essay-prose` below checks the flat 720px a live essay has.
        const scaled = Math.min(720, (column * 720) / 1344);
        check(
          m.el.docP !== null &&
            approx(m.el.docP.w, width < MOBILE_BREAKPOINT ? measure : scaled, 2),
          `essay @ ${width}: the prose takes the scaling measure beside its canvas, expected ${width < MOBILE_BREAKPOINT ? measure : scaled}, got ${m.el.docP?.w}`,
        );
      },
    },
    {
      name: 'essay-prose',
      livePath: '/essays/chasing-the-workaround/',
      body: renderDocPage(essayProse),
      compare: false,
      expect: (m, width) => {
        const measure = Math.min(720, columnWidth(m));
        check(
          m.el.docP !== null && approx(m.el.docP.w, measure, 1),
          `essay-prose @ ${width}: an essay with no canvas keeps the live ${measure}px column, got ${m.el.docP?.w}`,
        );
        check(
          m.el.docQuote !== null && approx(m.el.docQuote.w, measure, 1),
          `essay-prose @ ${width}: so does its quote, got ${m.el.docQuote?.w}`,
        );
        check(
          m.el.docP !== null && m.el.docP.marginBottom === (width < MOBILE_BREAKPOINT ? 20 : 27),
          `essay-prose @ ${width}: and the live paragraph rhythm`,
        );
      },
    },
    {
      name: 'filmography',
      livePath: '/filmography/',
      body: renderFilmography(films),
      compare: false,
      expect: (m, width) => {
        check(m.counts.video === 4, `filmography @ ${width}: four facades`);
        check(
          m.counts.videoWithEmbed === 4,
          `filmography @ ${width}: every facade carries its embed URL`,
        );
        check(
          m.counts.iframe === 0,
          `filmography @ ${width}: no player loads before anything is clicked`,
        );
        check(
          m.el.firstVideo !== null && approx(m.el.firstVideo.aspect ?? 0, 16 / 9, 0.02),
          `filmography @ ${width}: the facade is 16:9, got ${m.el.firstVideo?.aspect}`,
        );
        const columns = new Set(m.cards.map((card) => card.x)).size;
        check(
          columns === (width === 1440 ? 2 : 1),
          `filmography @ ${width}: ${width === 1440 ? 'two' : 'one'} column, got ${columns}`,
        );
      },
    },
    {
      name: 'filmography-as-live',
      livePath: '/filmography/',
      body: renderFilmography(filmsAsLive),
      compare: true,
    },
    {
      name: 'photography',
      livePath: '/photography/',
      body: renderPhotography([]),
      compare: true,
      expect: (m, width) => {
        check(m.counts.emptyState === 1, `photography @ ${width}: the empty state is shown`);
        check(m.counts.card === 0, `photography @ ${width}: no tiles when there are no albums`);
      },
    },
    {
      name: 'photography-albums',
      livePath: '/photography/',
      body: renderPhotography(albums),
      compare: false,
      expect: (m, width) => {
        check(m.counts.card === 2, `photography-albums @ ${width}: two tiles`);
        check(
          m.counts.cardLink === 2,
          `photography-albums @ ${width}: every tile links to its album page`,
        );
        check(m.counts.emptyState === 0, `photography-albums @ ${width}: no empty state`);
        check(
          m.el.firstCardMedia !== null && approx(m.el.firstCardMedia.aspect ?? 0, 4 / 3, 0.02),
          `photography-albums @ ${width}: the tile keeps its 4:3 crop, got ${m.el.firstCardMedia?.aspect}`,
        );
        const columns = new Set(m.cards.map((card) => card.x)).size;
        check(
          columns === (width === 1440 ? 2 : 1),
          `photography-albums @ ${width}: two albums sit in ${width === 1440 ? 'two of three columns' : 'one column'}, got ${columns}`,
        );
      },
    },
    {
      name: 'album-first-build',
      livePath: '/photography/',
      body: renderAlbumPage(firstBuild),
      compare: false,
      expect: (m, width) => {
        check(m.counts.albumPhoto === 6, `album @ ${width}: six photographs`);
        check(m.counts.albumOpen === 6, `album @ ${width}: every photograph opens the overlay`);
        check(m.counts.lightbox === 1, `album @ ${width}: one overlay`);
        check(m.counts.openLightbox === 0, `album @ ${width}: the overlay starts closed`);
        check(
          m.el.albumMeta !== null,
          `album @ ${width}: the year is on the page`,
        );

        // Rows of equal height is the whole claim the justified grid makes.
        const rows = new Map<number, Box[]>();
        for (const box of m.albumImgs) {
          const key = Math.round(box.y / 8) * 8;
          const row = rows.get(key) ?? [];
          row.push(box);
          rows.set(key, row);
        }
        if (width === 1440) {
          const multi = [...rows.values()].filter((row) => row.length > 1);
          check(multi.length > 0, `album @ ${width}: the grid should put photographs side by side`);
          for (const row of multi) {
            const heights = row.map((box) => box.h);
            const spread = Math.max(...heights) - Math.min(...heights);
            check(
              spread <= 6,
              `album @ ${width}: photographs in one row should be the same height, spread ${spread.toFixed(1)}px`,
            );
          }
          // No crop and no squash: every photograph in this album is
          // 1206 x 2622, so every rendered box has to be that ratio — the
          // five with intrinsic dimensions and the sixth without.
          const shown = m.albumImgs.filter((box) => box.h > 0);
          check(
            shown.length === 6,
            `album @ ${width}: all six photographs should have a box, got ${shown.length}`,
          );
          for (const box of shown) {
            check(
              approx(box.w / box.h, 1206 / 2622, 0.01),
              `album @ ${width}: a photograph is rendered at ${box.w}x${box.h}, ratio ${(box.w / box.h).toFixed(3)}, not its own 0.460`,
            );
          }
        } else {
          const columns = new Set(m.albumPhotos.map((box) => box.x)).size;
          check(columns === 1, `album @ ${width}: one column on a phone, got ${columns}`);
        }
      },
    },
    {
      name: 'album-developing',
      livePath: '/photography/',
      body: renderAlbumPage(developing),
      compare: false,
      expect: (m, width) => {
        check(m.counts.albumPhoto === 1, `album-developing @ ${width}: one photograph`);
        check(
          m.counts.albumOpen === 1,
          `album-developing @ ${width}: the single photograph still opens`,
        );
      },
    },
    {
      name: 'essays-index',
      livePath: '/essays/',
      body: renderLedgerPage(ledgerItems(essayFront, '/essays/', false), 'essays'),
      compare: true,
      expect: (m, width) => {
        check(
          m.counts.ledgerRow === essayFront.filter((entry) => !entry.draft).length,
          `essays-index @ ${width}: one row per published essay`,
        );
      },
    },
    {
      name: 'projects-index',
      livePath: '/projects/',
      body: renderLedgerPage(ledgerItems(projectFront, '/projects/', true), 'projects'),
      compare: true,
      expect: (m, width) => {
        check(
          m.counts.ledgerRow === projectFront.filter((entry) => !entry.draft).length,
          `projects-index @ ${width}: one row per published project`,
        );
      },
    },
  ];

  /* ---- cheap guards on the strings, before any browser -------------------- */

  for (const surface of surfaces) {
    check(
      !/<script/i.test(surface.body),
      `${surface.name}: a renderer must not emit a script tag`,
    );
    check(surface.body.trim() !== '', `${surface.name}: rendered nothing`);
  }
  check(
    renderDoc(home).includes('class="hero"'),
    'renderDoc on the home document must produce the site\'s own .hero',
  );
  check(
    !renderDoc(home).includes('doc-item--image'),
    'the homepage hero must not render as a bordered canvas item',
  );
  check(
    renderDoc(essay).startsWith('<div class="doc doc--essays doc--canvas"'),
    'an essay with a canvas band must be marked as both',
  );
  check(
    renderDoc(essayProse).startsWith('<div class="doc doc--essays"'),
    'an essay with no canvas must not claim one',
  );
  check(
    renderDoc(readDoc('simple')).startsWith('<div class="doc"'),
    'a phase 1 document with no meta.section must render exactly as it did',
  );
  check(
    renderDoc(essay).includes('essay-buttons doc-buttons'),
    'an essay with meta.buttons must render them',
  );
  check(
    renderAlbumPage(firstBuild).includes(`id="${albumLightboxId(firstBuild)}"`),
    'an album page must carry its own overlay id',
  );
  check(
    renderPhotography([]).includes('empty-state'),
    'no albums means the live empty state, not an empty grid',
  );
  check(
    renderFilmography(films).includes('data-video-id="EudrajWcwwg"'),
    'a facade must carry the YouTube id, not the record id',
  );
  check(
    !renderFilmography(films).includes('data-video-id="film_untitled"'),
    'the record id must not be used as a video id',
  );
  check(
    renderDoc(essay).includes('data-anchor-block="p_essay_anchor"'),
    'the essay fixture\'s anchored canvas item must keep its connector hooks',
  );

  /* ---- the live shells ---------------------------------------------------- */

  const shells = new Map<string, string>();
  for (const path of new Set(surfaces.map((surface) => surface.livePath))) {
    const html = await fetchLive(path);
    if (html === null) {
      notes.push(`could not fetch ${SITE}${path}; its surfaces are screenshotted without a shell`);
      continue;
    }
    shells.set(path, html);
  }

  /** A bare shell, for when the live site cannot be reached. */
  const FALLBACK_SHELL = `<!doctype html>
<html lang="en" data-theme="light"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>x</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sarina&family=Bricolage+Grotesque:opsz,wght@12..96,500&family=Inter:ital,wght@0,300;0,400;0,600;0,700;1,300&family=Inter+Tight:wght@400;500&display=swap" />
</head><body><div class="wrap"><main></main></div></body></html>`;

  for (const surface of surfaces) {
    const shell = shells.get(surface.livePath) ?? FALLBACK_SHELL;
    writeFileSync(
      join(OUT, `${surface.name}.html`),
      localise(shell, surface.body, surface.name),
    );
    writeFileSync(
      join(OUT, `${surface.name}.iframe390.html`),
      iframePage(`${surface.name}.html`, 390),
    );
    if (surface.compare && shells.has(surface.livePath)) {
      // The same shell with the live `<main>` untouched. The only difference
      // between this page and the one above is the markup inside <main>.
      writeFileSync(
        join(OUT, `${surface.name}.live.html`),
        localise(shell, null, `${surface.name} live`),
      );
      writeFileSync(
        join(OUT, `${surface.name}.live.iframe390.html`),
        iframePage(`${surface.name}.live.html`, 390),
      );
    }
  }

  /* ---- measure, shoot, compare ------------------------------------------- */

  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;
  const comparisons: string[] = [];

  try {
    for (const surface of surfaces) {
      for (const width of WIDTHS) {
        const inIframe = width < CHROME_MIN_WINDOW;
        const windowWidth = inIframe ? CHROME_MIN_WINDOW : width;
        const variants: { suffix: string; page: string }[] = [
          { suffix: '', page: inIframe ? `${surface.name}.iframe390.html` : `${surface.name}.html` },
        ];
        if (surface.compare && shells.has(surface.livePath)) {
          variants.push({
            suffix: '-live',
            page: inIframe
              ? `${surface.name}.live.iframe390.html`
              : `${surface.name}.live.html`,
          });
        }

        const heights: Record<string, number> = {};
        for (const variant of variants) {
          const dom = await chrome(DUMP_FLAGS, `${base}/${variant.page}`, windowWidth, 900, domReady);
          const metrics = readMetrics<Metrics>(dom);
          if (metrics === null) {
            failures.push(`${surface.name}${variant.suffix} @ ${width}: never reported metrics`);
            continue;
          }
          heights[variant.suffix] = metrics.scrollHeight;

          if (variant.suffix === '') {
            check(
              metrics.mobile === width < MOBILE_BREAKPOINT,
              `${surface.name} @ ${width}: the mobile query should be ${width < MOBILE_BREAKPOINT}`,
            );
            check(
              metrics.scrollWidth <= metrics.clientWidth + 1,
              `${surface.name} @ ${width}: no horizontal overflow (${metrics.scrollWidth} > ${metrics.clientWidth})`,
            );
            surface.expect?.(metrics, width);
          }

          const file = join(OUT, `${surface.name}${variant.suffix}-${width}.png`);
          const took = await shoot(
            `${base}/${variant.page}`,
            file,
            windowWidth,
            metrics.scrollHeight + (inIframe ? 8 : 0),
          );
          if (!took) failures.push(`${surface.name}${variant.suffix} @ ${width}: no screenshot`);
        }

        if (variants.length === 2) {
          const mine = `${surface.name}-${width}.png`;
          const live = `${surface.name}-live-${width}.png`;
          if (existsSync(join(OUT, mine)) && existsSync(join(OUT, live))) {
            const page = `compare-${surface.name}-${width}.html`;
            writeFileSync(join(OUT, page), comparePage(mine, live));
            const dom = await chrome(
              ['--virtual-time-budget=6000', '--dump-dom'],
              `${base}/${page}`,
              900,
              600,
              (out) => out.includes('</html>') && out.includes('METRICS'),
            );
            const diff = readMetrics<{
              sizeA: [number, number];
              sizeB: [number, number];
              compared: [number, number];
              pixels: number;
              differing: number;
              ratio: number;
              worst: number;
              firstRow: number;
            }>(dom);
            if (diff === null) {
              failures.push(`${surface.name} @ ${width}: the pixel comparison did not run`);
            } else {
              const line =
                `${surface.name} @ ${width}: ${diff.differing} of ${diff.pixels} pixels differ ` +
                `(${(diff.ratio * 100).toFixed(4)}%), worst channel delta ${diff.worst}, ` +
                `mine ${diff.sizeA.join('x')} vs live ${diff.sizeB.join('x')}` +
                (diff.firstRow >= 0 ? `, first at row ${diff.firstRow}` : '');
              comparisons.push(line);
              check(
                Math.abs(diff.sizeA[1] - diff.sizeB[1]) <= 2,
                `${surface.name} @ ${width}: my page is ${diff.sizeA[1]}px tall, the live one is ${diff.sizeB[1]}px`,
              );
              // 0.2% of pixels, which is text antialiasing drifting between
              // two Chrome launches and nothing structural.
              check(
                diff.ratio <= 0.002,
                `${surface.name} @ ${width}: ${(diff.ratio * 100).toFixed(4)}% of pixels differ from the live page`,
              );
            }
          }
        }

        if (heights[''] !== undefined && heights['-live'] !== undefined) {
          notes.push(
            `${surface.name} @ ${width}: ${heights['']}px tall, live ${heights['-live']}px`,
          );
        }
      }
    }

    /* ---- the two client modules, driven ---------------------------------- */

    const interactions: { page: string; act: string; label: string }[] = [
      { page: 'filmography.html', act: 'play', label: 'clicking a film facade' },
      { page: 'album-first-build.html', act: 'open', label: 'clicking a photograph' },
      { page: 'album-first-build.html', act: 'next', label: 'the overlay arrow key' },
      { page: 'album-first-build.html', act: 'escape', label: 'escape closing the overlay' },
    ];

    for (const step of interactions) {
      const dom = await chrome(
        DUMP_FLAGS,
        `${base}/${step.page}?act=${step.act}`,
        1440,
        900,
        domReady,
      );
      const m = readMetrics<Metrics>(dom);
      if (m === null) {
        failures.push(`${step.label}: the page never reported its metrics`);
        continue;
      }

      if (step.act === 'play') {
        check(m.state.videoHasPlayer, `${step.label}: a player should replace the still`);
        check(
          m.state.postersLeft === 3,
          `${step.label}: that one still and its play mark should be gone, the other three left alone; ${m.state.postersLeft} stills remain`,
        );
        check(
          m.state.playerSrc ===
            'https://www.youtube-nocookie.com/embed/EudrajWcwwg?autoplay=1&rel=0',
          `${step.label}: the player loads the autoplay nocookie embed, got ${m.state.playerSrc}`,
        );
        check(m.counts.iframe === 1, `${step.label}: exactly one player, not four`);
      }

      if (step.act === 'open') {
        check(m.counts.openLightbox === 1, `${step.label}: the overlay should open`);
        check(m.state.bodyLocked, `${step.label}: the page behind should stop scrolling`);
        check(
          m.state.stageSrc === firstBuild.photos[0]!.src,
          `${step.label}: it should show the photograph that was clicked, got ${m.state.stageSrc}`,
        );
        check(m.state.counter === '1 / 6', `${step.label}: the counter reads 1 / 6, got ${m.state.counter}`);
      }

      if (step.act === 'next') {
        check(
          m.state.stageSrc === firstBuild.photos[1]!.src,
          `${step.label}: it should advance to the second photograph, got ${m.state.stageSrc}`,
        );
        check(m.state.counter === '2 / 6', `${step.label}: the counter reads 2 / 6, got ${m.state.counter}`);
      }

      if (step.act === 'escape') {
        check(m.counts.openLightbox === 0, `${step.label}: the overlay should close`);
        check(!m.state.bodyLocked, `${step.label}: the page should scroll again`);
      }

      // A picture of the opened overlay, because that is the one state no
      // other screenshot in this run shows.
      if (step.act === 'open') {
        await shoot(
          `${base}/${step.page}?act=${step.act}`,
          join(OUT, 'album-first-build-lightbox-1440.png'),
          1440,
          900,
        );
      }
      if (step.act === 'play') {
        await shoot(
          `${base}/${step.page}?act=${step.act}`,
          join(OUT, 'filmography-playing-1440.png'),
          1440,
          Math.min(m.scrollHeight, 2600),
        );
      }
    }

    /* ---- the live pages themselves, for the record ----------------------- */

    if (!OFFLINE) {
      for (const path of ['/filmography/', '/photography/']) {
        const slug = path.replace(/\//g, '') || 'home';
        for (const width of [1440, 390] as const) {
          if (width < CHROME_MIN_WINDOW) continue;
          const file = join(OUT, `zz-live-${slug}-${width}.png`);
          const ok = await shoot(`${SITE}${path}`, file, width, 2600);
          if (!ok) notes.push(`could not screenshot the deployed ${path}`);
        }
      }
    }
  } finally {
    await server.close();
    if (!args.includes('--keep')) rmSync(PROFILES, { recursive: true, force: true });
  }

  /* ---- report ------------------------------------------------------------ */

  console.log(`\nout: ${OUT}\n`);
  if (comparisons.length > 0) {
    console.log('pixel comparison against the live markup, same shell, same stylesheet:');
    for (const line of comparisons) console.log(`  ${line}`);
    console.log('');
  }
  if (notes.length > 0) {
    console.log('notes:');
    for (const note of notes) console.log(`  ${note}`);
    console.log('');
  }
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('all checks passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
