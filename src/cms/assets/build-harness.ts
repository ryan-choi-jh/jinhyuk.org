/**
 * src/cms/assets/build-harness.ts
 *
 * Bundles the picker harness into one page that opens from the filesystem.
 *
 *   node src/cms/assets/build-harness.ts
 *   open src/cms/assets/.build/harness.html
 *
 * Uses the esbuild that is already in node_modules (vite's). Installs nothing.
 * Output lives under .build/, which is a build artifact: safe to delete.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const outDir = here('./.build/');
mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [here('./harness.tsx')],
  outfile: `${outDir}harness.js`,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"development"' },
});

writeFileSync(
  `${outDir}harness.html`,
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WS-6 picker harness</title>
<style>
  body { margin: 0; background: #ffffff; color: #111111;
         font-family: 'Inter', system-ui, -apple-system, sans-serif; }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 44px 24px 80px; }
  h1 { font-size: 26px; margin: 0 0 6px; letter-spacing: -0.02em; }
  p.sub { color: #6b6b6b; font-size: 14px; margin: 0 0 30px; max-width: 72ch; line-height: 1.55; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Asset picker</h1>
  <p class="sub">WS-6 standalone harness. Configure an asset and insert it: every insert is
  turned into a real CanvasItem with draftToItem and run through WS-0's validateDoc, and the
  result is drawn from the item exactly as the renderer would draw it. No shell, no API, no
  network.</p>
  <div id="root"></div>
</div>
<script type="module" src="./harness.js"></script>
</body>
</html>
`,
  'utf8',
);

console.log(`harness -> ${outDir}harness.html`);
