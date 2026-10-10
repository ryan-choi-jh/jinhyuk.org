/**
 * src/cms/app/shell/harness/build.mjs
 *
 * Bundles the WS-3 harness into a single directory that opens over `file://`
 * with no server at all.
 *
 *   node src/cms/app/shell/harness/build.mjs
 *   CMS_HARNESS_OUT=/tmp/ws3 node src/cms/app/shell/harness/build.mjs
 *
 * Output: `<out>/harness.html` plus `<out>/harness.js`. The fixture is baked
 * in as a string, because a `file://` page cannot fetch one.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const here = new URL('.', import.meta.url);
const repoRoot = new URL('../../../../../', import.meta.url);

export const OUT_DIR = process.env.CMS_HARNESS_OUT ?? fileURLToPath(new URL('.out', here));
export const FIXTURE = process.env.CMS_HARNESS_FIXTURE ?? 'dense.json';

const fixtureJson = readFileSync(new URL(`src/cms/fixtures/${FIXTURE}`, repoRoot), 'utf8');
const publicBase = pathToFileURL(fileURLToPath(new URL('public', repoRoot))).href;

mkdirSync(OUT_DIR, { recursive: true });

const result = await build({
  entryPoints: [fileURLToPath(new URL('harness.tsx', here))],
  bundle: true,
  write: false,
  // A classic script, not a module: `file://` refuses module scripts (their
  // origin is "null", so the CORS check fails), and this page has to work
  // without a server.
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  jsxImportSource: 'react',
  sourcemap: 'inline',
  define: {
    // React's CJS build reads this; without it the bundle throws on `process`.
    'process.env.NODE_ENV': '"development"',
    __FIXTURE_JSON__: JSON.stringify(fixtureJson),
    __PUBLIC_BASE__: JSON.stringify(publicBase),
  },
  logLevel: 'warning',
});

const [output] = result.outputFiles;
if (output === undefined) throw new Error('esbuild produced nothing');

writeFileSync(join(OUT_DIR, 'harness.js'), output.text);
writeFileSync(
  join(OUT_DIR, 'harness.html'),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WS-3 editor shell · ${FIXTURE}</title>
    <style>
      html, body { margin: 0; height: 100%; background: #15171a; }
      #root { height: 100%; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script src="harness.js"></script>
  </body>
</html>
`,
);

const bytes = Buffer.byteLength(output.text);
console.log(`harness: ${join(OUT_DIR, 'harness.html')} (${(bytes / 1024).toFixed(0)} kB of script, fixture ${FIXTURE})`);
