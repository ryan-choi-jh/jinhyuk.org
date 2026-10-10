/**
 * src/cms/app/guide/harness/build.mjs
 *
 * Bundles the guide harness with the esbuild already in node_modules, the way
 * the canvas and prose harnesses do. No install, no dev server, no Astro.
 *
 *   node src/cms/app/guide/harness/build.mjs
 *
 * Output goes to harness/.out/, which is gitignored.
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
  mkdirSync(OUT_DIR, { recursive: true });

  const result = await esbuild.build({
    entryPoints: [join(here, 'harness.tsx')],
    bundle: true,
    outfile: join(OUT_DIR, 'harness.js'),
    // Classic script, so the page opens from file:// as well as over HTTP.
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    jsx: 'automatic',
    jsxImportSource: 'react',
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    define: { 'process.env.NODE_ENV': '"development"' },
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
