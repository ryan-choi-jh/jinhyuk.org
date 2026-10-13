/**
 * src/cms/verify-hidden.ts
 *
 * `meta.hidden` keeps a page off the site. This checks what "off" means.
 *
 *   node src/cms/verify-hidden.ts
 *
 * The distinction worth guarding is unlisted versus absent. A page dropped
 * from its index but still built keeps a live URL: anyone holding a link
 * still reads it, and a search engine that already indexed it keeps serving
 * it. That is not what taking a page off the site means, and it is the
 * failure mode you would never notice, because the index looks right.
 *
 * So the filter sits in `src/lib/site-content.ts`, at the one place every
 * route reads through, and these assertions are about the lists the routes
 * build from rather than about the markup.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { formatIssues, validateDoc, validateDocJson } from './schema.ts';
import type { Doc } from './schema.ts';

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));

let passed = 0;
const failures: string[] = [];
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1;
  else failures.push(`${name}${detail === '' ? '' : `\n      ${detail}`}`);
}

/* -------------------------------------------------------------------------- */
/* The schema takes it, and the default is visible                            */
/* -------------------------------------------------------------------------- */

function doc(hidden?: boolean): Doc {
  const meta: Record<string, unknown> = {
    title: 'T',
    slug: 'a-page',
    date: '2026-01-01',
    section: 'essays',
  };
  if (hidden !== undefined) meta.hidden = hidden;
  const result = validateDoc({ version: 1, meta, bands: [] });
  if (!result.ok) throw new Error(formatIssues(result.issues));
  return result.doc;
}

ok('a document with no `hidden` key is valid', doc().meta.hidden === undefined);
ok('…and that means visible', doc().meta.hidden !== true);
ok('hidden: true is valid', doc(true).meta.hidden === true);
ok('hidden: false is valid', doc(false).meta.hidden === false);

/* -------------------------------------------------------------------------- */
/* The filter is the one `src/pages/` reads through                           */
/* -------------------------------------------------------------------------- */

{
  // Not imported: site-content.ts uses `import.meta.glob`, which is Vite's
  // and does not exist under bare node. The rule it applies is one line, and
  // what matters is that it is applied in ONE place, which is checked below
  // by reading the source.
  const source = readFileSync(join(PROJECT, 'src/lib/site-content.ts'), 'utf8');
  ok(
    'site-content filters on meta.hidden',
    source.includes("doc.meta.hidden !== true"),
    'the filter is what makes a hidden page absent rather than unlisted',
  );
  ok(
    'essayDocs goes through the filter',
    /export const essayDocs = \(\): Doc\[\] => visible\(/.test(source),
  );
  ok(
    'projectDocs goes through the filter',
    /export const projectDocs = \(\): Doc\[\] => visible\(/.test(source),
  );
  ok(
    'the index metas are built from the filtered lists',
    source.includes('essayMetas = (): DocMeta[] => essayDocs()') &&
      source.includes('projectMetas = (): DocMeta[] => projectDocs()'),
  );
}

{
  /*
   * Every route under src/pages/ that lists or builds a document page must
   * go through those functions. A route that reached past them — globbing
   * the directory itself, say — would keep building hidden pages, and the
   * index would still look correct.
   */
  const pages = join(PROJECT, 'src/pages');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  // `import.meta.glob` is the one way a route could reach the content
  // directory itself and bypass the filter. Matching on the path string
  // instead would hit the comments that explain where content lives, which
  // is what the first version of this did.
  const offenders = walk(pages).filter((file) =>
    readFileSync(file, 'utf8').includes('import.meta.glob'),
  );
  ok(
    'no page route reaches past site-content for documents',
    offenders.length === 0,
    offenders.map((f) => f.replace(PROJECT, '')).join(', '),
  );
}

/* -------------------------------------------------------------------------- */
/* What is actually on the site right now                                     */
/* -------------------------------------------------------------------------- */

{
  const counts: Record<string, { total: number; hidden: number }> = {};
  const invalid: string[] = [];
  for (const section of ['essays', 'projects']) {
    const dir = join(PROJECT, 'src/content/pages', section);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    let hidden = 0;
    for (const file of files) {
      const result = validateDocJson(readFileSync(join(dir, file), 'utf8'));
      if (!result.ok) {
        invalid.push(`${section}/${file}: ${formatIssues(result.issues)}`);
        continue;
      }
      if (result.doc.meta.hidden === true) hidden += 1;
    }
    counts[section] = { total: files.length, hidden };
  }
  // A local list, not the global one: asserting on `failures` here would
  // report any EARLIER failure as a validation problem too.
  ok('every published document still validates with the new field', invalid.length === 0, invalid.join('\n      '));
  console.log(
    `  essays: ${counts.essays?.hidden ?? 0} of ${counts.essays?.total ?? 0} hidden; ` +
      `projects: ${counts.projects?.hidden ?? 0} of ${counts.projects?.total ?? 0} hidden`,
  );
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  process.exitCode = 1;
}
