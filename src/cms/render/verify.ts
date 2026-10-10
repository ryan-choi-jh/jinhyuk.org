/**
 * src/cms/render/verify.ts
 *
 * WS-1's own verification. Renders every fixture with the real renderer and the
 * real stylesheet, serves it, measures it in a real browser, and screenshots it
 * at 1440, 1100 and 390 wide.
 *
 *   node src/cms/render/verify.ts [--out=<dir>] [--keep]
 *
 * Standalone on purpose: nothing here imports another workstream, so the
 * renderer can be judged before the editor, the API or the preview exist.
 *
 * Two notes on the browser:
 *
 *  - Chrome will not open a window narrower than about 500px, so the 390 case
 *    is rendered inside a 390px iframe on a wider page. An iframe is a real
 *    viewport, so the mobile fallback's media query fires exactly as it would
 *    on a phone.
 *  - Screenshots are not the only evidence. Each page measures itself in the
 *    browser and reports through document.title, which --dump-dom hands back.
 *    Positions come from getComputedStyle().left/top and offsetWidth rather
 *    than getBoundingClientRect(), because a rotated item's bounding rect is
 *    its rotated bounding box and would make every assertion about a tilted
 *    screenshot meaningless. The assertions at the bottom check those numbers,
 *    so a regression fails the script instead of waiting to be noticed in a
 *    picture.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { MOBILE_BREAKPOINT, REFERENCE_WIDTH, formatIssues, validateDocJson } from '../schema.ts';
import type { Doc } from '../schema.ts';
import { docStyles, ensureShapeAssets, hasConnectors, renderDoc, renderDocHead } from './index.ts';

/* -------------------------------------------------------------------------- */
/* Setup                                                                      */
/* -------------------------------------------------------------------------- */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PROJECT = resolve(HERE, '../../..');
const PUBLIC_DIR = join(PROJECT, 'public');
const FIXTURES = join(PROJECT, 'src/cms/fixtures');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** 1440 is the designed page; 1100 is the awkward middle where the canvas has
 *  shrunk but the fallback has not fired; 390 is a phone. */
const WIDTHS = [1440, 1100, 390] as const;
/** Chrome's own window floor. Anything narrower is rendered in an iframe. */
const CHROME_MIN_WINDOW = 520;
/** global.css: a 1440px cap with a 48px gutter leaves REFERENCE_WIDTH. */
const PAGE_CAP = 1440;
const GUTTER = 48;
/** The reading measure at the reference width, from doc.css. */
const MEASURE = 720;

const FIXTURE_NAMES = ['simple', 'canvas', 'dense'] as const;

const args = process.argv.slice(2);
const outArg = args.find((arg) => arg.startsWith('--out='));
const OUT =
  outArg !== undefined ? resolve(outArg.slice('--out='.length)) : join(tmpdir(), 'jinhyuk-ws1-render');
const PROFILES = join(OUT, '.chrome-profiles');
/**
 * A fresh profile per launch. Each Chrome is killed rather than asked to quit,
 * which leaves a singleton lock behind, and the next launch using the same
 * directory sometimes refuses to start and drops its screenshot on the floor.
 */
let launches = 0;

type ItemGeo = {
  id: string;
  position: string;
  left: number | null;
  top: number | null;
  width: number;
  height: number;
  flowTop: number;
  transform: string;
};

type BandGeo = { id: string; position: string; height: number; overlay: boolean };

type Metrics = {
  innerWidth: number;
  clientWidth: number;
  scrollWidth: number;
  scrollHeight: number;
  docWidth: number;
  mobile: boolean;
  bandCount: number;
  overlayCount: number;
  anchored: number;
  paths: number;
  measure: number;
  quoteMeasure: number;
  bands: BandGeo[];
  geo: ItemGeo[];
};

/* -------------------------------------------------------------------------- */
/* The harness page                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Measures a document and posts the numbers into document.title, which is the
 * one channel `--dump-dom` gives back from a page. Plain script, so it needs no
 * build step of its own, and it takes a window so the 390 wrapper can measure
 * the iframe it holds.
 */
const MEASURE_SCRIPT = `
function num(value) { var n = parseFloat(value); return isNaN(n) ? null : Math.round(n * 100) / 100; }
function round(value) { return Math.round(value * 100) / 100; }
function flowTopIn(root, el) {
  var top = 0;
  var node = el;
  while (node && node !== root) { top += node.offsetTop; node = node.offsetParent; }
  return round(top);
}
function docMetrics(win) {
  var d = win.document;
  var root = d.querySelector('.doc');
  if (!root) return null;
  var cs = function (el) { return win.getComputedStyle(el); };
  var box = root.getBoundingClientRect();
  var items = [].slice.call(root.querySelectorAll('.doc-item'));
  var bands = [].slice.call(root.querySelectorAll('.doc-band'));
  var firstP = root.querySelector('.doc-p');
  var firstQuote = root.querySelector('.doc-quote');
  return {
    innerWidth: win.innerWidth,
    clientWidth: d.documentElement.clientWidth,
    scrollWidth: d.documentElement.scrollWidth,
    scrollHeight: Math.ceil(Math.max(d.documentElement.scrollHeight, d.body.scrollHeight)),
    docWidth: round(box.width),
    mobile: win.matchMedia('(max-width: 900px)').matches,
    bandCount: bands.length,
    overlayCount: root.querySelectorAll('.doc-band--overlay').length,
    anchored: root.querySelectorAll('.doc-item[data-anchor-block]').length,
    paths: root.querySelectorAll('.doc-connectors path').length,
    measure: firstP ? round(firstP.getBoundingClientRect().width) : 0,
    quoteMeasure: firstQuote ? round(firstQuote.getBoundingClientRect().width) : 0,
    bands: bands.map(function (el) {
      var s = cs(el);
      return {
        id: el.getAttribute('data-band-id'),
        position: s.position,
        height: round(el.offsetHeight),
        overlay: el.classList.contains('doc-band--overlay')
      };
    }),
    geo: items.map(function (el) {
      var frame = el.querySelector('.doc-frame') || el;
      var s = cs(el);
      return {
        id: el.getAttribute('data-item-id'),
        position: s.position,
        left: num(s.left),
        top: num(s.top),
        width: round(el.offsetWidth),
        height: round(frame.offsetHeight),
        flowTop: flowTopIn(root, frame),
        transform: s.transform
      };
    })
  };
}
function publish(metrics) { document.title = 'METRICS' + JSON.stringify(metrics); }
/**
 * renderDoc marks media loading="lazy", which is right on a real page and
 * wrong for a screenshot: a 6000px fixture has most of its pictures below any
 * plausible fold, and they stay unloaded in the one frame the camera gets.
 * This is the harness opting out of lazy loading, not the renderer.
 */
function loadEverything(win) {
  var imgs = win.document.querySelectorAll('img[loading="lazy"]');
  for (var i = 0; i < imgs.length; i += 1) imgs[i].loading = 'eager';
  return imgs.length;
}
`;

/**
 * The one change the harness makes to renderDoc's output.
 *
 * renderDoc marks media loading="lazy", which is right on a real page and
 * wrong for a camera: a lazy image is not counted in the load event, so
 * headless Chrome captures the frame while the pictures are still arriving and
 * a fixture screenshots as a page of empty boxes. Which images happen to win
 * that race changes run to run, which is worse than either outcome.
 *
 * Dropping the attribute makes the load event wait for every image, so the
 * screenshot is deterministic. It changes when an image loads, never where it
 * lands: no assertion in this file depends on it.
 */
function eagerMedia(html: string): string {
  return html.replace(/ loading="lazy"/g, '');
}

function fixturePage(name: string, doc: Doc, body: string): string {
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${name}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500&family=Inter:ital,wght@0,300;0,400;0,600;0,700;1,300&display=swap" />
<link rel="stylesheet" href="global.css" />
<link rel="stylesheet" href="doc.css" />
<style>
  /* The page shell, straight out of global.css: a ${PAGE_CAP}px cap with a
     ${GUTTER}px gutter, which leaves the ${REFERENCE_WIDTH}px content column
     REFERENCE_WIDTH refers to. This is the harness, not the renderer: doc.css
     styles everything inside .doc and nothing outside it. */
  body { margin: 0; }
  /* WS-B. global.css reserves a scrollbar on every page with
     scrollbar-gutter: stable, which takes about 15px out of the window
     whether or not the page scrolls: a 1440px window leaves a 1329px column,
     not the ${REFERENCE_WIDTH}px the assertions below are written against.
     That is right for the site and wrong for this harness, whose job is to
     measure the renderer against the artboard. Turning it off here is the
     only way the numbers can mean what they say. */
  html { scrollbar-gutter: auto; }
  .wrap { max-width: ${PAGE_CAP}px; margin: 0 auto; padding: 0 ${GUTTER}px 80px; }
</style>
</head>
<body>
<div class="wrap">
${renderDocHead(doc)}
${eagerMedia(body)}
</div>
<script type="module" src="connectors.js"></script>
<script>
${MEASURE_SCRIPT}
function run() { var m = docMetrics(window); if (m) publish(m); }
// Immediately, not on load: this script sits at the end of <body>, so every
// image is already parsed, and flipping them now lets them download in
// parallel with the fonts instead of after everything else has settled.
loadEverything(window);
window.addEventListener('load', function () {
  loadEverything(window);
  run();
  requestAnimationFrame(function () { requestAnimationFrame(run); });
  setTimeout(run, 400);
  setTimeout(run, 1200);
  if (document.fonts) document.fonts.ready.then(function () { setTimeout(run, 60); });
});
</script>
</body>
</html>
`;
}

/**
 * The 390 case. Chrome's window floor is around 500px, so the page under test
 * goes in an iframe of exactly 390px and the wrapper reports on its behalf.
 * The grey ground makes the 390px edge visible in the screenshot.
 */
function iframePage(name: string, width: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${name} @ ${width}</title>
<style>
  html, body { margin: 0; background: #8a8a8a; }
  iframe { display: block; width: ${width}px; border: 0; background: #ffffff; }
</style>
</head>
<body>
<iframe id="frame" src="${name}.html" width="${width}" height="800" scrolling="no"></iframe>
<script>
${MEASURE_SCRIPT}
var frame = document.getElementById('frame');
function run() {
  var win = frame.contentWindow;
  if (!win || !win.document || !win.document.querySelector('.doc')) return;
  loadEverything(win);
  var first = docMetrics(win);
  if (!first) return;
  // Grow the iframe to the whole document, so one screenshot holds the page,
  // then measure again now that nothing inside it is scrolled.
  frame.style.height = first.scrollHeight + 'px';
  var again = docMetrics(win) || first;
  again.scrollHeight = Math.max(first.scrollHeight, again.scrollHeight);
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
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
};

/**
 * Serves the rendered pages out of OUT and everything else out of public/, so a
 * fixture's site-absolute src resolves exactly as it will on the live site.
 * file:// cannot do that: a site-absolute path there resolves against the
 * filesystem root.
 */
function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0]!);
    const safe = path.replace(/\.\./g, '');
    for (const base of [OUT, PUBLIC_DIR]) {
      const file = join(base, safe);
      if (!file.startsWith(base)) continue;
      if (!safe.endsWith('/') && existsSync(file)) {
        response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
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

/**
 * Drive one headless Chrome and wait for it to produce what we asked for.
 *
 * Chrome 153's headless mode writes the --dump-dom output, or the --screenshot
 * file, and then keeps the browser running: it never exits on its own. So this
 * watches for the thing it was asked for, kills the process the moment it
 * arrives, and gives up after a deadline rather than hanging a build forever.
 *
 * The two passes want different flags, which is why they are at the call sites:
 *
 *  - DUMP_FLAGS uses --virtual-time-budget to fast-forward the page's clock, so
 *    the DOM is dumped after the webfonts, the images and the connector script
 *    have all settled, without waiting nine real seconds per page.
 *  - SHOT_FLAGS must not. Virtual time stops the page the moment the budget is
 *    spent, and anything still being decoded is simply not painted: with the
 *    budget on, a fixture's screenshots come out as empty boxes.
 *    --run-all-compositor-stages-before-draw is the supported way to say "paint
 *    everything first", and it cost about 150ms a page here.
 */
function chrome(
  extra: string[],
  url: string,
  width: number,
  height: number,
  ready: (stdout: string) => boolean,
  limitMs = 40000,
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
        /**
         * WS-B. global.css carries `html { scrollbar-gutter: stable }`, which
         * reserves about 15px of every window for a scrollbar whether or not
         * the page has one. That made every content-column assertion below
         * fail by exactly that much — a 1440px window measuring a 1329px
         * column where REFERENCE_WIDTH says 1344 — which is a true statement
         * about a browser and a false one about the artboard these numbers
         * come from. Hiding the scrollbar gives the harness the designed
         * 1440px page, which is what the assertions mean.
         */
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
        // Already gone.
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
const SHOT_FLAGS = ['--run-all-compositor-stages-before-draw', '--disable-new-content-rendering-timeout'];

/** The DOM dump is finished once the closing html tag has arrived. */
const domReady = (stdout: string): boolean => stdout.includes('</html>');

/** A screenshot is finished once the file has stopped growing. */
function shotReady(path: string): () => boolean {
  return () => {
    if (!existsSync(path)) return false;
    const stat = statSync(path);
    return stat.size > 1024 && Date.now() - stat.mtimeMs > 400;
  };
}

/** Pull the metrics back out of the dumped DOM's <title>. */
function readMetrics(dom: string): Metrics | null {
  const match = /<title>METRICS(.*?)<\/title>/s.exec(dom);
  if (match === null) return null;
  const json = match[1]!
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  try {
    return JSON.parse(json) as Metrics;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

const failures: string[] = [];
const notes: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function approx(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

async function main(): Promise<void> {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);

  // Use WS-6's real generator when it is in the tree, and say which one these
  // screenshots were taken with. A shape drawn by the built-in fallback is
  // still correct geometry, but it is not the drawing that ships.
  const realShapes = await ensureShapeAssets();
  console.log(`shapes: ${realShapes ? "WS-6's src/cms/assets/shapes.ts" : "WS-1's built-in fallback"}\n`);

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // The stylesheet under test, and the site's, so the fixtures are judged with
  // the real tokens and the real font stack.
  writeFileSync(join(OUT, 'doc.css'), readFileSync(join(PROJECT, docStyles().replace(/^\//, '')), 'utf8'));
  writeFileSync(join(OUT, 'global.css'), readFileSync(join(PROJECT, 'src/styles/global.css'), 'utf8'));

  // The connector script, as a browser needs it. esbuild is already in the tree
  // (Vite's), so this needs no new dependency.
  const bundle = spawnSync(
    join(PROJECT, 'node_modules/.bin/esbuild'),
    [
      join(HERE, 'connectors.ts'),
      '--bundle',
      '--format=esm',
      '--target=es2022',
      `--outfile=${join(OUT, 'connectors.js')}`,
    ],
    { encoding: 'utf8' },
  );
  if (bundle.status !== 0) throw new Error(`esbuild failed:\n${bundle.stderr}`);
  writeFileSync(
    join(OUT, 'connectors.js'),
    `${readFileSync(join(OUT, 'connectors.js'), 'utf8')}\ninitDocConnectors();\n`,
  );

  const docs = new Map<string, Doc>();
  for (const name of FIXTURE_NAMES) {
    const result = validateDocJson(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
    if (!result.ok) throw new Error(`${name}.json does not validate:\n${formatIssues(result.issues)}`);
    const doc = result.doc;
    docs.set(name, doc);

    const body = renderDoc(doc);
    // Cheap, high-value guards on the string itself, before any browser.
    check(body.startsWith('<div class="doc"'), `${name}: renderDoc output must open with .doc`);
    check(!/<script/i.test(body), `${name}: renderDoc output must not contain a script tag`);
    check(
      hasConnectors(doc) === body.includes('doc-connectors'),
      `${name}: the connector overlay must be present exactly when an anchor resolves`,
    );
    writeFileSync(join(OUT, `${name}.html`), fixturePage(name, doc, body));
    writeFileSync(join(OUT, `${name}.iframe390.html`), iframePage(name, 390));
  }

  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;

  try {
    for (const name of FIXTURE_NAMES) {
      const doc = docs.get(name)!;
      for (const width of WIDTHS) {
        const inIframe = width < CHROME_MIN_WINDOW;
        const page = inIframe ? `${name}.iframe390.html` : `${name}.html`;
        const windowWidth = inIframe ? CHROME_MIN_WINDOW : width;

        // Pass one: how tall is it, and what does it think of itself?
        const dom = await chrome(DUMP_FLAGS, `${base}/${page}`, windowWidth, 900, domReady);
        const metrics = readMetrics(dom);
        if (metrics === null) {
          failures.push(`${name} @ ${width}: the page never reported its metrics`);
          continue;
        }

        // Pass two: the picture, in a window tall enough to hold the page in
        // one frame, because headless Chrome screenshots the viewport.
        const shot = join(OUT, `${name}-${width}.png`);
        const height = Math.min(Math.max(metrics.scrollHeight + (inIframe ? 8 : 0), 600), 15000);
        const shotArgs = [...SHOT_FLAGS, `--screenshot=${shot}`];
        await chrome(shotArgs, `${base}/${page}`, windowWidth, height, shotReady(shot));
        if (!existsSync(shot)) {
          // One retry: a killed Chrome occasionally takes the next launch with
          // it, and a missing screenshot is the one failure worth re-asking.
          await chrome(shotArgs, `${base}/${page}`, windowWidth, height, shotReady(shot));
        }
        check(existsSync(shot), `${name} @ ${width}: no screenshot was written`);

        report(name, doc, width, metrics);
      }
    }
  } finally {
    await server.close();
    if (!args.includes('--keep')) rmSync(PROFILES, { recursive: true, force: true });
  }

  console.log('--- measured ---');
  for (const note of notes) console.log(note);

  console.log(`\nOutput: ${OUT}`);
  if (failures.length > 0) {
    console.log(`\n--- ${failures.length} FAILURE(S) ---`);
    for (const failure of failures) console.log(`  ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('\nAll checks passed.');
  }
}

/* -------------------------------------------------------------------------- */
/* Assertions on the measured page                                            */
/* -------------------------------------------------------------------------- */

function report(name: string, doc: Doc, width: number, m: Metrics): void {
  const label = `${name} @ ${width}`;
  const mobile = width <= MOBILE_BREAKPOINT;

  notes.push(
    `${label.padEnd(16)} doc=${m.docWidth} measure=${m.measure} quote=${m.quoteMeasure} ` +
      `mobile=${m.mobile} bands=${m.bandCount} overlay=${m.overlayCount} items=${m.geo.length} ` +
      `anchored=${m.anchored} paths=${m.paths} scrollW=${m.scrollWidth}/${m.clientWidth} h=${m.scrollHeight}`,
  );

  // 1. No horizontal scrollbar, at any width. The dense fixture says the
  //    renderer is judged on this.
  check(
    m.scrollWidth <= m.clientWidth + 1,
    `${label}: horizontal overflow of ${m.scrollWidth - m.clientWidth}px`,
  );

  // 2. The content column is the one the geometry was authored against, and
  //    the mobile fallback fires below the breakpoint and nowhere else.
  const expectedDocWidth = Math.min(width, PAGE_CAP) - GUTTER * 2;
  check(
    approx(m.docWidth, expectedDocWidth, 2),
    `${label}: content column is ${m.docWidth}, expected ${expectedDocWidth}`,
  );
  check(m.mobile === mobile, `${label}: expected mobile=${mobile}, got ${m.mobile}`);

  const scale = m.docWidth / REFERENCE_WIDTH;

  // 3. Typography: the reading measure is the site's 720px at the reference
  //    width, and scales with the canvas below it.
  const expectedMeasure = mobile
    ? Math.min(MEASURE, m.docWidth)
    : Math.min(MEASURE, MEASURE * scale);
  check(
    approx(m.measure, expectedMeasure, 2),
    `${label}: reading measure is ${m.measure}, expected ${expectedMeasure.toFixed(2)}`,
  );

  // 4. Every band and item in the document reached the page.
  const expectedOverlays = doc.bands.filter((band) => band.type === 'canvas' && band.overlay === true).length;
  const expectedItems = doc.bands.reduce(
    (total, band) => total + (band.type === 'canvas' ? band.items.length : 0),
    0,
  );
  check(m.bandCount === doc.bands.length, `${label}: ${m.bandCount} bands, document has ${doc.bands.length}`);
  check(m.geo.length === expectedItems, `${label}: ${m.geo.length} items, document has ${expectedItems}`);
  check(m.overlayCount === expectedOverlays, `${label}: ${m.overlayCount} overlays, expected ${expectedOverlays}`);

  // 5. Connectors: drawn above the breakpoint when an anchor resolves, never
  //    below it.
  const anchored = doc.bands.reduce(
    (total, band) =>
      total + (band.type === 'canvas' ? band.items.filter((item) => item.anchor !== undefined).length : 0),
    0,
  );
  check(m.anchored === anchored, `${label}: ${m.anchored} anchored items, document has ${anchored}`);
  if (mobile) check(m.paths === 0, `${label}: ${m.paths} connector paths below the breakpoint; must be 0`);
  else check(m.paths === anchored, `${label}: ${m.paths} connector paths, expected ${anchored}`);

  // 6. Bands. A non-overlay canvas band reserves its authored height, scaled.
  //    An overlay band is out of flow, so it reserves nothing. Below the
  //    breakpoint neither is positioned at all.
  const bandById = new Map(m.bands.map((band) => [band.id, band]));
  for (const band of doc.bands) {
    if (band.type !== 'canvas') continue;
    const got = bandById.get(band.id);
    if (got === undefined) {
      failures.push(`${label}: band ${band.id} is missing from the page`);
      continue;
    }
    if (mobile) {
      check(got.position === 'static', `${label}: band ${band.id} is ${got.position}, expected static`);
    } else if (band.overlay === true) {
      check(got.position === 'absolute', `${label}: overlay band ${band.id} is ${got.position}, expected absolute`);
    } else {
      check(got.position === 'relative', `${label}: band ${band.id} is ${got.position}, expected relative`);
      check(
        approx(got.height, band.height * scale, 2),
        `${label}: band ${band.id} reserves ${got.height}px, expected ${(band.height * scale).toFixed(2)}`,
      );
    }
  }

  // 7. Items. Above the breakpoint each sits where the document put it, scaled
  //    by the content width. Below it nothing is positioned: full width, no
  //    left or top, and rotation kept.
  const byId = new Map(m.geo.map((entry) => [entry.id, entry]));
  for (const band of doc.bands) {
    if (band.type !== 'canvas') continue;
    for (const item of band.items) {
      const got = byId.get(item.id);
      if (got === undefined) {
        failures.push(`${label}: item ${item.id} is missing from the page`);
        continue;
      }

      const rotated = item.rotate !== undefined && item.rotate !== 0;
      check(
        rotated === (got.transform !== 'none'),
        `${label}: ${item.id} transform is ${got.transform}; rotate=${item.rotate ?? 0}`,
      );

      if (mobile) {
        check(got.position === 'static', `${label}: ${item.id} is ${got.position}, expected static`);
        check(got.left === null, `${label}: ${item.id} still has left=${got.left}`);
        check(got.top === null, `${label}: ${item.id} still has top=${got.top}`);
        check(
          approx(got.width, m.docWidth, 1.5),
          `${label}: ${item.id} is ${got.width} wide, expected the full ${m.docWidth}`,
        );
      } else {
        check(got.position === 'absolute', `${label}: ${item.id} is ${got.position}, expected absolute`);
        check(
          got.left !== null && approx(got.left, item.x * scale, 1.5),
          `${label}: ${item.id} left=${got.left}, expected ${(item.x * scale).toFixed(2)}`,
        );
        check(
          got.top !== null && approx(got.top, item.y * scale, 1.5),
          `${label}: ${item.id} top=${got.top}, expected ${(item.y * scale).toFixed(2)}`,
        );
        check(
          approx(got.width, item.w * scale, 1.5),
          `${label}: ${item.id} width=${got.width}, expected ${(item.w * scale).toFixed(2)}`,
        );
        check(
          approx(got.height, item.h * scale, 1.5),
          `${label}: ${item.id} height=${got.height}, expected ${(item.h * scale).toFixed(2)}`,
        );
      }
    }
  }

  // 8. The mobile stack is in document order, top to bottom, with no item laid
  //    over another.
  if (mobile) {
    const order = doc.bands.flatMap((band) =>
      band.type === 'canvas' ? band.items.map((item) => item.id) : [],
    );
    let previousBottom = -Infinity;
    let previousId = '(start)';
    for (const id of order) {
      const got = byId.get(id);
      if (got === undefined) continue;
      check(
        got.flowTop >= previousBottom - 1,
        `${label}: ${id} starts at ${got.flowTop}, above ${previousId}'s bottom of ${previousBottom}`,
      );
      previousBottom = got.flowTop + got.height;
      previousId = id;
    }
  }
}

await main();
