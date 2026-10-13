/**
 * src/cms/styles/sync-doc-css.mjs
 *
 * Copy the shared style blocks into doc.css.
 *
 *   node src/cms/styles/sync-doc-css.mjs            # write
 *   node src/cms/styles/sync-doc-css.mjs --check    # just say whether it would
 *
 * WHY THIS EXISTS. Some rules are needed in two places: the published page
 * gets them from `doc.css`, and the editor, which does not load `doc.css`,
 * injects them at runtime from a TypeScript module. A stylesheet cannot
 * import TypeScript, so `doc.css` carries a copy between named markers, and
 * `src/cms/fixtures/verify.ts` asserts the copy is byte-identical.
 *
 * That guard has always worked. What was missing was the other half: the copy
 * was made by hand, so editing `callout.ts` meant remembering to paste the
 * new text into `doc.css` and getting every byte right, with a failing check
 * as the only reminder. This writes it instead, which removes the step the
 * guard was there to catch.
 *
 * Run it after touching `highlight.ts` or `callout.ts`, then run
 * `npm run cms:verify`, which is the thing that actually proves it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOC_CSS = fileURLToPath(new URL('./doc.css', import.meta.url));

const { HIGHLIGHT_CSS } = await import('./highlight.ts');
const { CALLOUT_CSS } = await import('./callout.ts');
const { SPACING_CSS } = await import('./spacing.ts');

/** Marker name -> the text that belongs between its START and END lines. */
const BLOCKS = [
  ['HIGHLIGHT', HIGHLIGHT_CSS],
  ['CALLOUT', CALLOUT_CSS],
  ['SPACING', SPACING_CSS],
];

const checkOnly = process.argv.includes('--check');

let css = readFileSync(DOC_CSS, 'utf8');
const before = css;
const missing = [];

for (const [name, text] of BLOCKS) {
  const start = `/* ${name}:START */`;
  const end = `/* ${name}:END */`;
  const from = css.indexOf(start);
  const to = css.indexOf(end);
  if (from < 0 || to < 0 || to < from) {
    missing.push(name);
    continue;
  }
  css = `${css.slice(0, from + start.length)}\n${text}\n${css.slice(to)}`;
}

if (missing.length > 0) {
  console.error(`doc.css has no markers for: ${missing.join(', ')}`);
  console.error('Add the START/END comment pair where the block should go.');
  process.exit(2);
}

if (css === before) {
  console.log('doc.css is already in step with highlight.ts and callout.ts.');
  process.exit(0);
}

if (checkOnly) {
  console.error('doc.css is OUT OF STEP. Run: node src/cms/styles/sync-doc-css.mjs');
  process.exit(1);
}

writeFileSync(DOC_CSS, css);
console.log('doc.css updated from highlight.ts and callout.ts.');
console.log('Now run: npm run cms:verify');
