/**
 * src/cms/app/chrome/harness/build.mjs
 *
 * Bundles the nav-and-footer harness into one directory that opens over
 * `file://` with no server at all.
 *
 *   node src/cms/app/chrome/harness/build.mjs
 *   CMS_CHROME_OUT=/tmp/chr node src/cms/app/chrome/harness/build.mjs
 *
 * Output: `<out>/harness.html` plus `<out>/harness.js`. The homepage fixture
 * and the real `src/content/data/site.json` are baked in as strings, because a
 * `file://` page cannot fetch either.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = new URL('.', import.meta.url);
const repoRoot = new URL('../../../../../', import.meta.url);

export const OUT_DIR = process.env.CMS_CHROME_OUT ?? fileURLToPath(new URL('.out', here));

const home = readFileSync(new URL('src/cms/fixtures/home.json', repoRoot), 'utf8');
const site = readFileSync(new URL('src/content/data/site.json', repoRoot), 'utf8');

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
    __HOME_JSON__: JSON.stringify(home),
    __SITE_JSON__: JSON.stringify(site),
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
    <title>Nav and footer</title>
    <!-- The same faces the site loads, so the scenery around the page measures
         the way the published nav does. -->
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Sarina&family=Bricolage+Grotesque:opsz,wght@12..96,500&family=Inter:ital,wght@0,300;0,400;0,600;0,700;1,300&family=Inter+Tight:wght@400;500&display=swap"
    />
    <style>
      html, body { margin: 0; height: 100%; background: #15171a; }
      #root { height: 100%; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script src="./harness.js"></script>
  </body>
</html>
`,
);

console.log(`harness written to ${OUT_DIR}`);
