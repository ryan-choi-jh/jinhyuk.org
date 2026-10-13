/**
 * src/cms/check.mjs
 *
 * Run the CMS's checks and say which ones failed.
 *
 *   npm run cms:check            the offline suites, about ten seconds
 *   npm run cms:check:browser    the ones that open a browser, a few minutes
 *   npm run cms:check:e2e        the two that write to GitHub on a throwaway branch
 *   node src/cms/check.mjs all   everything except e2e
 *
 * WHY A RUNNER AND NOT `a && b && c`. A chain stops at the first failure, so
 * one broken suite hides every suite after it, and you fix things one slow
 * round trip at a time. This runs all of them and prints a table. Exit code
 * is the number of suites that failed, capped at 1, so CI reads it normally.
 *
 * Each suite already prints its own detail. This only prints the detail of
 * the ones that failed, at the end, so a passing run is six lines.
 *
 * The suites are listed here and nowhere else; `cms/README.md` describes what
 * each one is for.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** Nothing here opens a browser or touches the network. */
const OFFLINE = [
  ['fixtures', 'src/cms/fixtures/verify.ts'],
  ['render', 'src/cms/render/selftest.ts'],
  ['state', 'src/cms/app/state/verify-state.ts'],
  ['site state', 'src/cms/app/state/verify-site-state.ts'],
  ['crash copy', 'src/cms/app/state/verify-local-draft.ts'],
  ['prose', 'src/cms/app/prose/verify.ts'],
  ['canvas geometry', 'src/cms/app/canvas/verify-geometry.ts'],
  ['records', 'src/cms/app/records/verify.ts'],
  ['assets', 'src/cms/assets/verify.ts'],
  ['preview', 'src/cms/preview/selftest.ts'],
  ['pre-publish checklist', 'src/cms/verify-preflight.ts'],
  ['server', 'src/cms/server/verify.ts', ['--offline']],
];

/**
 * These open headless Chrome. `render/verify-sections.ts` also fetches
 * jinhyuk.org, because comparing against the live page is the whole point
 * of it.
 */
const BROWSER = [
  ['prose component', 'src/cms/app/prose/harness/run.mjs'],
  ['block-boundary keys', 'src/cms/app/prose/harness/keys.mjs'],
  ['editor shell', 'src/cms/app/shell/harness/drive.mjs'],
  ['site shell', 'src/cms/app/shell/site-harness/drive.mjs'],
  ['editor vs page type', 'src/cms/app/shell/verify-typography.mjs'],
  ['space above a block', 'src/cms/styles/verify-spacing.mjs'],
  ['record editors', 'src/cms/app/records/harness/drive.mjs'],
  ['nav and footer', 'src/cms/app/chrome/harness/run.mjs'],
  ['the guide', 'src/cms/app/guide/harness/run.mjs'],
  ['the library', 'src/cms/app/library/harness/run.mjs'],
  ['canvas in a browser', 'src/cms/app/canvas/harness/verify-browser.mjs'],
  ['preview', 'src/cms/preview/verify.ts'],
  ['render layout', 'src/cms/render/verify.ts'],
  ['render vs the live site', 'src/cms/render/verify-sections.ts'],
  ['integration', 'src/cms/app/integration/verify.ts'],
];

/**
 * These create a branch on GitHub, drive a real dev server against it, and
 * delete the branch in a `finally`. They never write to main. Separate
 * because they need a token and take a few minutes each.
 */
const E2E = [
  ['one page, end to end', 'src/cms/app/integration/e2e.mjs'],
  ['the whole site, end to end', 'src/cms/app/integration/site-e2e.mjs'],
];

const GROUPS = { offline: OFFLINE, browser: BROWSER, e2e: E2E };

const asked = process.argv[2] ?? 'offline';
const suites =
  asked === 'all' ? [...OFFLINE, ...BROWSER] : GROUPS[asked] ?? null;

if (suites === null) {
  console.error(`Unknown group "${asked}". One of: offline, browser, e2e, all.`);
  process.exit(2);
}

function run(file, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

console.log(`${suites.length} ${asked === 'all' ? '' : `${asked} `}suites\n`);

const failed = [];
const started = Date.now();

for (const [label, file, args = []] of suites) {
  process.stdout.write(`  ${label.padEnd(28)}`);
  const began = Date.now();
  const result = await run(file, args);
  const took = `${((Date.now() - began) / 1000).toFixed(1)}s`;
  if (result.code === 0) {
    console.log(`pass  ${took.padStart(7)}`);
  } else {
    console.log(`FAIL  ${took.padStart(7)}`);
    failed.push([label, file, result.output]);
  }
}

const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;

if (failed.length === 0) {
  console.log(`\nAll ${suites.length} passed in ${elapsed}.`);
  process.exit(0);
}

for (const [label, file, output] of failed) {
  console.log(`\n${'='.repeat(70)}\n${label}  (node ${file})\n${'='.repeat(70)}`);
  // The tail, because every one of these prints its failures last.
  console.log(output.split('\n').slice(-40).join('\n').trimEnd());
}

console.log(`\n${failed.length} of ${suites.length} failed in ${elapsed}.`);
process.exit(1);
