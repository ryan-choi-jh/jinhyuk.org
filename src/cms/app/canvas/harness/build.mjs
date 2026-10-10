/**
 * src/cms/app/canvas/harness/build.mjs
 *
 * Bundles the WS-4 harness with the esbuild that is already in node_modules.
 * No install, no Astro, no dev server from anyone else's workstream.
 *
 *   node src/cms/app/canvas/harness/build.mjs
 *
 * Output goes to harness/.out/ (dot-prefixed, so it is clearly generated).
 * src/cms/fixtures/dense.json is READ here and inlined as a string, so the
 * bundle needs no JSON import attribute and the page makes no fetch.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

export const OUT_DIR = join(here, '.out');

export async function build({ minify = false } = {}) {
  const fixture = readFileSync(join(here, '..', '..', '..', 'fixtures', 'dense.json'), 'utf8');
  mkdirSync(OUT_DIR, { recursive: true });

  const result = await esbuild.build({
    entryPoints: [join(here, 'main.tsx')],
    bundle: true,
    outfile: join(OUT_DIR, 'harness.js'),
    format: 'iife',
    target: ['chrome120'],
    jsx: 'automatic',
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    define: {
      __FIXTURE_JSON__: JSON.stringify(fixture),
      'process.env.NODE_ENV': '"development"',
    },
    sourcemap: 'inline',
    minify,
    logLevel: 'warning',
    metafile: true,
  });

  writeFileSync(join(OUT_DIR, 'index.html'), readFileSync(join(here, 'index.html')));

  const bytes = Object.values(result.metafile.outputs).reduce((total, out) => total + out.bytes, 0);
  return { outDir: OUT_DIR, bytes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { outDir, bytes } = await build();
  process.stdout.write(`built ${(bytes / 1024).toFixed(0)}kB -> ${outDir}\n`);
}
