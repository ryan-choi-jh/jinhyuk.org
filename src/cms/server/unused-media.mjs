/**
 * src/cms/server/unused-media.mjs
 *
 * Which uploaded files nothing points at any more.
 *
 *   node src/cms/server/unused-media.mjs
 *   node src/cms/server/unused-media.mjs --json
 *
 * A REPORT, AND DELIBERATELY NOT A DELETE BUTTON.
 *
 * Removing an item from a canvas, or a photo from an album, removes the
 * reference and not the file: there is no delete endpoint, by design, because
 * a button that removes a file some other page still uses is how you lose a
 * picture you cannot get back. So `public/media/` only grows, and the way to
 * shrink it safely is to look at the list first. This prints the list.
 *
 * It reads the PUBLISHED tree only. A draft is a working copy the site never
 * serves, but a file a draft points at is one you are about to publish, so
 * drafts are scanned too and anything they claim is reported as kept, with a
 * note. Deleting a file your unpublished draft needs would be the one thing
 * this must never encourage.
 *
 * Nothing is deleted here. The last lines print the `git rm` you would run.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = fileURLToPath(new URL('../../../', import.meta.url));
const MEDIA_DIR = join(PROJECT, 'public/media');
const CONTENT = join(PROJECT, 'src/content');
const DRAFTS = join(CONTENT, 'drafts');

const asJson = process.argv.includes('--json');

/** Every file under a directory, as paths relative to the project. */
function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * Every `/media/...` path mentioned anywhere in a JSON file.
 *
 * Deliberately a regex over the raw text rather than a walk of the parsed
 * document. The schema has five fields that can hold one (`src`, `cover`,
 * `poster`, a photo's `src`, a film's `poster`) and a sixth would be missed
 * by a walk written against today's shape. A reference this finds and should
 * not have is a file kept needlessly, which is the safe direction to be
 * wrong in.
 */
const MEDIA_REF = /["'(]((?:\/media\/)[^"')\s]+)/g;

function referencesIn(file) {
  const text = readFileSync(file, 'utf8');
  const found = new Set();
  for (const match of text.matchAll(MEDIA_REF)) {
    // A URL-encoded space or similar, so the comparison is against the path
    // as it sits on disk.
    found.add(decodeURIComponent(match[1]));
  }
  return found;
}

const published = walk(CONTENT).filter(
  (file) => file.endsWith('.json') && !file.startsWith(DRAFTS),
);
const drafts = walk(DRAFTS).filter((file) => file.endsWith('.json'));

const claimedByPublished = new Set();
for (const file of published) for (const ref of referencesIn(file)) claimedByPublished.add(ref);

const claimedByDraft = new Set();
for (const file of drafts) for (const ref of referencesIn(file)) claimedByDraft.add(ref);

const onDisk = walk(MEDIA_DIR).map((file) => ({
  path: relative(PROJECT, file),
  url: `/media/${relative(MEDIA_DIR, file).split('\\').join('/')}`,
  bytes: statSync(file).size,
}));

const unused = onDisk.filter(
  (file) => !claimedByPublished.has(file.url) && !claimedByDraft.has(file.url),
);
const draftOnly = onDisk.filter(
  (file) => !claimedByPublished.has(file.url) && claimedByDraft.has(file.url),
);
// A reference with no file behind it: the opposite problem, and worse, since
// it is a broken image on a page that is live.
const missing = [...claimedByPublished].filter(
  (url) => !onDisk.some((file) => file.url === url),
);

const sum = (files) => files.reduce((total, file) => total + file.bytes, 0);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

if (asJson) {
  console.log(
    JSON.stringify(
      {
        unused: unused.map((f) => f.path),
        keptForDrafts: draftOnly.map((f) => f.path),
        missing,
        bytes: { all: sum(onDisk), unused: sum(unused) },
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(`public/media: ${onDisk.length} files, ${mb(sum(onDisk))}`);
console.log(`scanned ${published.length} published and ${drafts.length} draft documents\n`);

if (missing.length > 0) {
  console.log(`BROKEN: ${missing.length} reference(s) with no file behind them.`);
  console.log('These are live pages pointing at something that is not there.');
  for (const url of missing) console.log(`  ${url}`);
  console.log('');
}

if (draftOnly.length > 0) {
  console.log(`Kept: ${draftOnly.length} file(s) only an unpublished draft uses.`);
  for (const file of draftOnly) console.log(`  ${file.path}`);
  console.log('');
}

if (unused.length === 0) {
  console.log('Nothing is unused. Every file has something pointing at it.');
  process.exit(0);
}

console.log(`Unused: ${unused.length} file(s), ${mb(sum(unused))}`);
for (const file of unused.sort((a, b) => b.bytes - a.bytes)) {
  console.log(`  ${String(Math.round(file.bytes / 1024)).padStart(6)}KB  ${file.path}`);
}
console.log('\nNothing has been deleted. To remove them, having read the list:');
console.log(`  git rm ${unused.map((file) => `'${file.path}'`).join(' ')}`);
