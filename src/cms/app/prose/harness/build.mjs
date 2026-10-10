/**
 * src/cms/app/prose/harness/build.mjs
 *
 * Bundles the harness with the esbuild that is already in node_modules (Vite
 * depends on it). No new dependency, no dev server: the output is a classic
 * IIFE script, so index.html opens straight off the filesystem.
 *
 *   node src/cms/app/prose/harness/build.mjs
 *   open src/cms/app/prose/harness/index.html
 */

import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = fileURLToPath(new URL('.', import.meta.url));

const result = await esbuild.build({
  entryPoints: [`${here}main.tsx`],
  outfile: `${here}bundle.js`,
  bundle: true,
  // Classic script, so file:// works without a server and without CORS.
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  jsxImportSource: 'react',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.json': 'json' },
  logLevel: 'warning',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`built ${here}bundle.js (${Math.round(bytes / 1024)} kB)`);
