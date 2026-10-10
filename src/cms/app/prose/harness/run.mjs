/**
 * src/cms/app/prose/harness/run.mjs
 *
 * Builds the harness, runs it in headless Chrome, and prints the assertions it
 * made against the live component. Exits non-zero on any failure, so it works
 * as a check and not only as a demo.
 *
 *   node src/cms/app/prose/harness/run.mjs
 *
 * The page is served over loopback HTTP rather than opened from file://, and
 * it POSTs its results back to this script when it finishes. That is the whole
 * design: the run ends when the assertions end, not when a timer guesses they
 * have. Driving --dump-dom with --virtual-time-budget was tried first and is
 * not reliable here: an idle page never exhausts the budget, and awaiting
 * requestAnimationFrame under virtual time can stall indefinitely.
 *
 * Nothing is installed. It uses the Chrome already on the machine, and says so
 * clearly if there is none.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
// src/cms/app/prose/harness -> src/
const srcRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const screenshot = `${here}screenshot.png`;
const DEADLINE_MS = 120_000;

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const chrome = CHROME_CANDIDATES.find((path) => existsSync(path));
if (chrome === undefined) {
  console.error('No Chrome, Chromium or Edge found. Tried:');
  for (const path of CHROME_CANDIDATES) console.error(`  ${path}`);
  console.error('\nRun `node src/cms/app/prose/harness/build.mjs` and open index.html by hand instead.');
  process.exit(2);
}

console.log('building the harness bundle');
execFileSync(process.execPath, [`${here}build.mjs`], { stdio: 'inherit' });

/* -------------------------------------------------------------------------- */
/* Serve the harness                                                           */
/* -------------------------------------------------------------------------- */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** Only these paths are readable, so the harness cannot serve the repo. */
const FILES = {
  '/': `${here}index.html`,
  '/index.html': `${here}index.html`,
  '/bundle.js': `${here}bundle.js`,
  // The harness page asks for the real site stylesheet at this path.
  '/styles/global.css': `${srcRoot}styles/global.css`,
};

let resolveReport;
const reported = new Promise((resolve) => {
  resolveReport = resolve;
});

const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/results') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      response.writeHead(204).end();
      try {
        resolveReport(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        resolveReport({ error: `results were not JSON: ${error.message}` });
      }
    });
    return;
  }

  const file = FILES[request.url ?? ''];
  if (file === undefined || !existsSync(file)) {
    response.writeHead(404).end('not found');
    return;
  }
  const extension = file.slice(file.lastIndexOf('.'));
  response.writeHead(200, { 'content-type': TYPES[extension] ?? 'application/octet-stream' });
  response.end(readFileSync(file));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const pageUrl = `http://127.0.0.1:${port}/`;

/* -------------------------------------------------------------------------- */
/* Drive it                                                                    */
/* -------------------------------------------------------------------------- */

const profile = mkdtempSync(join(tmpdir(), 'ws5-prose-'));
console.log(`running ${pageUrl}`);

const browser = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    '--window-size=1344,2200',
    pageUrl,
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

let browserError = '';
browser.stderr.on('data', (chunk) => {
  browserError += chunk.toString();
});

const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), DEADLINE_MS));
const outcome = await Promise.race([reported, timeout]);

browser.kill('SIGKILL');
server.close();
// Chrome may still be flushing its profile as we delete it. The directory is
// in the OS temp dir either way, so a failure here is not worth a crash.
const sweep = (directory) => {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* the OS will get it */
  }
};
sweep(profile);

if (outcome === 'timeout') {
  console.error(`the harness did not report within ${DEADLINE_MS / 1000}s.`);
  console.error(browserError.split('\n').slice(0, 30).join('\n'));
  process.exit(1);
}
if (outcome.error !== undefined) {
  console.error(outcome.error);
  process.exit(1);
}

console.log('');
console.log('WS-5 prose editing verification (headless Chrome, live React component)');
for (const line of outcome.lines) console.log(line);
console.log('');
console.log(outcome.verdict);

/* -------------------------------------------------------------------------- */
/* And a picture, from a second, throwaway browser                             */
/* -------------------------------------------------------------------------- */

try {
  const shotServer = createServer((request, response) => {
    const file = FILES[request.url ?? ''];
    if (file === undefined || !existsSync(file)) {
      response.writeHead(404).end('not found');
      return;
    }
    const extension = file.slice(file.lastIndexOf('.'));
    response.writeHead(200, { 'content-type': TYPES[extension] ?? 'application/octet-stream' });
    response.end(readFileSync(file));
  });
  await new Promise((resolve) => shotServer.listen(0, '127.0.0.1', resolve));
  const shotProfile = mkdtempSync(join(tmpdir(), 'ws5-shot-'));
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--hide-scrollbars',
      `--user-data-dir=${shotProfile}`,
      '--window-size=1344,2200',
      '--virtual-time-budget=6000',
      `--screenshot=${screenshot}`,
      `http://127.0.0.1:${shotServer.address().port}/`,
    ],
    { stdio: 'ignore', timeout: 60_000 },
  );
  shotServer.close();
  sweep(shotProfile);
  console.log(`screenshot: ${screenshot}`);
} catch {
  console.log('(screenshot skipped)');
}

process.exit(outcome.failed === 0 ? 0 : 1);
