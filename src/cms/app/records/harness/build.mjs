/**
 * src/cms/app/records/harness/build.mjs
 *
 * Bundles WS-E's harness into one directory that opens over `file://` with no
 * server at all.
 *
 *   node src/cms/app/records/harness/build.mjs
 *   CMS_RECORDS_OUT=/tmp/wse node src/cms/app/records/harness/build.mjs
 *
 * Output: `<out>/harness.html` plus `<out>/harness.js`. Both record fixtures
 * are baked in as strings, because a `file://` page cannot fetch one.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const here = new URL('.', import.meta.url);
const repoRoot = new URL('../../../../../', import.meta.url);

export const OUT_DIR = process.env.CMS_RECORDS_OUT ?? fileURLToPath(new URL('.out', here));

const films = readFileSync(new URL('src/cms/fixtures/filmography.json', repoRoot), 'utf8');
const albums = readFileSync(new URL('src/cms/fixtures/photography.json', repoRoot), 'utf8');
const publicBase = pathToFileURL(fileURLToPath(new URL('public', repoRoot))).href;

mkdirSync(OUT_DIR, { recursive: true });

const result = await build({
  entryPoints: [fileURLToPath(new URL('harness.tsx', here))],
  bundle: true,
  write: false,
  // A classic script, not a module: a `file://` page refuses module scripts,
  // because their origin is "null" and the CORS check fails.
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  jsxImportSource: 'react',
  sourcemap: 'inline',
  define: {
    'process.env.NODE_ENV': '"development"',
    __FILMS_JSON__: JSON.stringify(films),
    __ALBUMS_JSON__: JSON.stringify(albums),
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
    <title>WS-E record editors</title>
    <style>
      html, body { margin: 0; height: 100%; background: #15171a; color: #e7eaed; }
      #root, .harness { height: 100%; }
      .harness { display: flex; flex-direction: column; }
      .harness__bar {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: none;
        height: 30px;
        padding: 0 10px;
        border-bottom: 1px solid #2d3238;
        background: #101214;
        font: 11px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif;
      }
      .harness__tab {
        height: 20px;
        padding: 0 8px;
        border: 1px solid #3b424a;
        border-radius: 999px;
        background: #22262b;
        color: #8d969f;
        font: inherit;
        cursor: pointer;
      }
      .harness__tab--on { background: #4c8dff; border-color: #4c8dff; color: #fff; }
      .harness__spacer { flex: 1 1 auto; }
      .harness__notice { color: #8d969f; }
      .harness__stage { flex: 1 1 auto; min-height: 0; display: flex; }
      .harness__stage > * { flex: 1 1 auto; min-width: 0; }
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
console.log(`harness: ${join(OUT_DIR, 'harness.html')} (${(bytes / 1024).toFixed(0)} kB of script)`);
