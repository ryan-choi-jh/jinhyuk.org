/**
 * src/cms/app/guide/write-default-json.mjs
 *
 * Writes `default-guide.json` from `content.ts`.
 *
 * The TypeScript is the source and the JSON is a copy, not the other way
 * round, because a JSON import needs a loader flag under Vite and an import
 * attribute under plain node, and this directory has to build under both
 * plus esbuild. The copy exists so whoever seeds the real content file has
 * something to paste, and so the editor's reset has a file to point at.
 *
 *   node src/cms/app/guide/write-default-json.mjs          # write it
 *   node src/cms/app/guide/write-default-json.mjs --check   # fail if stale
 *
 * The harness runs the check, so the two cannot drift in silence.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const TARGET = join(here, 'default-guide.json');

export async function renderDefaultJson() {
  // content.ts imports schema.ts, which imports zod. Bundle rather than
  // transpile, so this script does not have to resolve any of that itself.
  const scratch = mkdtempSync(join(tmpdir(), 'guide-default-'));
  const bundle = join(scratch, 'content.mjs');
  try {
    await esbuild.build({
      entryPoints: [join(here, 'content.ts')],
      outfile: bundle,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: ['node20'],
      logLevel: 'warning',
    });
    const { DEFAULT_GUIDE_CONTENT } = await import(pathToFileURL(bundle).href);
    return `${JSON.stringify(DEFAULT_GUIDE_CONTENT, null, 2)}\n`;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rendered = await renderDefaultJson();
  if (process.argv.includes('--check')) {
    let onDisk = '';
    try {
      onDisk = readFileSync(TARGET, 'utf8');
    } catch {
      /* missing counts as stale */
    }
    if (onDisk !== rendered) {
      process.stderr.write(
        `default-guide.json is stale. Run:\n  node src/cms/app/guide/write-default-json.mjs\n`,
      );
      process.exit(1);
    }
    process.stdout.write('default-guide.json matches content.ts\n');
  } else {
    writeFileSync(TARGET, rendered);
    process.stdout.write(`wrote ${TARGET} (${rendered.length} bytes)\n`);
  }
}
