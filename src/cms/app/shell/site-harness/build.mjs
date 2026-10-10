/**
 * src/cms/app/shell/site-harness/build.mjs
 *
 * Bundles WS-D's navigation harness into a single directory that opens over
 * `file://` with no server at all.
 *
 *   node src/cms/app/shell/site-harness/build.mjs
 *   CMS_SITE_HARNESS_OUT=/tmp/wsd node src/cms/app/shell/site-harness/build.mjs
 *
 * Output: `<out>/harness.html` plus `<out>/harness.js`. Every fixture WS-A
 * ships is baked in as a string, because a `file://` page cannot fetch one,
 * and each still goes through its own validator inside the harness — so this
 * fails loudly if a fixture and the schema ever disagree.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const here = new URL('.', import.meta.url);
const repoRoot = new URL('../../../../../', import.meta.url);

export const OUT_DIR = process.env.CMS_SITE_HARNESS_OUT ?? fileURLToPath(new URL('.out', here));

/** The whole corpus: three document fixtures, home, and both collections. */
const FIXTURES = [
  'home.json',
  'essay.json',
  'dense.json',
  'canvas.json',
  'simple.json',
  'filmography.json',
  'photography.json',
];

const fixtures = {};
for (const name of FIXTURES) {
  fixtures[name] = readFileSync(new URL(`src/cms/fixtures/${name}`, repoRoot), 'utf8');
}

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
    'process.env.NODE_ENV': '"development"',
    __FIXTURES_JSON__: JSON.stringify(JSON.stringify(fixtures)),
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
    <title>WS-D navigation shell · all five sections</title>
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
console.log(
  `site harness: ${join(OUT_DIR, 'harness.html')} (${(bytes / 1024).toFixed(0)} kB of script, ${FIXTURES.length} fixtures)`,
);
