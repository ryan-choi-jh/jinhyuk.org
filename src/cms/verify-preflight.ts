/**
 * src/cms/verify-preflight.ts
 *
 * The pre-publish checklist, against documents built to trip each item.
 *
 *   node src/cms/verify-preflight.ts
 *
 * `preflight()` is pure, so this needs no browser and no network. What it is
 * really guarding is the two ways a checklist goes wrong: missing the thing
 * it exists to catch, and crying wolf. Every case below is paired — one
 * document that should raise the finding and one that should not — because
 * a checklist that fires on a clean page is one people stop reading, which
 * is exactly how seven images ended up published with no alt text while the
 * field sat in the inspector.
 */

import { formatIssues, validateDoc } from './schema.ts';
import type { Doc } from './schema.ts';
import { preflight, preflightSummary } from './preflight.ts';

let passed = 0;
const failures: string[] = [];

function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1;
  else failures.push(`${name}${detail === '' ? '' : `\n      ${detail}`}`);
}

/** Validate first: a check against a document the schema rejects proves nothing. */
function doc(bands: Doc['bands'], meta: Partial<Doc['meta']> = {}): Doc {
  const value = {
    version: 1,
    meta: { title: 'T', slug: 'preflight', date: '2026-01-01', section: 'essays', ...meta },
    bands,
  };
  const result = validateDoc(value);
  if (!result.ok) throw new Error(`fixture does not validate:\n${formatIssues(result.issues)}`);
  return result.doc;
}

const text = (t: string) => [{ type: 'text', text: t }];
const prose = (id: string, blocks: unknown[]) => ({ id, type: 'prose' as const, blocks: blocks as never });
const p = (id: string, t: string) => ({ id, kind: 'p' as const, content: text(t) });
const linked = (id: string, href: string) => ({
  id,
  kind: 'p' as const,
  content: [
    { type: 'text', marks: [{ type: 'link', attrs: { href } }], text: 'a link' },
  ],
});
const canvas = (id: string, items: unknown[]) => ({
  id,
  type: 'canvas' as const,
  height: 300,
  items: items as never,
});
const image = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'image' as const,
  src: '/media/projects/x/a.png',
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  ...extra,
});

const messages = (d: Doc): string => preflight(d).map((f) => f.message).join(' | ');
const has = (d: Doc, needle: string): boolean => messages(d).includes(needle);

/* -------------------------------------------------------------------------- */

{
  const bad = doc([prose('b1', [p('a', 'x')]), canvas('c1', [image('i1')])]);
  ok('alt: an image with none is reported', has(bad, 'no alt text'));
  const good = doc([prose('b1', [p('a', 'x')]), canvas('c1', [image('i1', { alt: 'A chart' })])]);
  ok('alt: and one with alt text is not', !has(good, 'no alt text'), messages(good));
  const blank = doc([prose('b1', [p('a', 'x')]), canvas('c1', [image('i1', { alt: '   ' })])]);
  ok('alt: whitespace does not count as alt text', has(blank, 'no alt text'));
  // The finding has to say WHICH image, or a page with nine of them is a
  // list of nine identical sentences.
  const found = preflight(bad).find((f) => f.message.includes('no alt text'));
  ok('alt: it names the item', found?.itemId === 'i1', JSON.stringify(found));
}

{
  const withGaps = doc([prose('b1', [p('a', 'x'), { id: 'g', kind: 'p', content: [] }, p('b', 'y')])]);
  ok('empty rows: counted', has(withGaps, '1 empty row in this page'), messages(withGaps));
  ok(
    'empty rows: and explained, rather than just counted',
    has(withGaps, 'nothing at all on the page'),
  );
  const clean = doc([prose('b1', [p('a', 'x'), p('b', 'y')])]);
  ok('empty rows: a page without them says nothing', !has(clean, 'empty row'), messages(clean));
}

{
  const blankHeading = doc([prose('b1', [p('a', 'x'), { id: 'h', kind: 'h2', content: [] }])]);
  ok('headings: an empty one is a warning', has(blankHeading, 'heading, blank'));
  const hangul = doc([
    prose('b1', [p('a', 'x'), { id: 'h', kind: 'h2', content: text('한국어 제목') }]),
  ]);
  ok('headings: one with nothing to slug is a note', has(hangul, 'no letters or digits'));
  const normal = doc([prose('b1', [p('a', 'x'), { id: 'h', kind: 'h2', content: text('Why a heatmap') }])]);
  ok('headings: an ordinary one says nothing', !has(normal, 'heading'), messages(normal));
}

{
  const toEditor = doc([prose('b1', [p('a', 'x'), linked('l', '/cms/essays/thing')])]);
  ok('links: one into the editor is caught', has(toEditor, 'the editor and not a page'));
  const toNowhere = doc([prose('b1', [p('a', 'x'), linked('l', '#')])]);
  ok('links: a bare # is caught', has(toNowhere, 'goes nowhere'));
  const fine = doc([prose('b1', [p('a', 'x'), linked('l', 'https://example.com')])]);
  ok('links: an ordinary one is not', !has(fine, 'link to'), messages(fine));
  const anchor = doc([prose('b1', [p('a', 'x'), linked('l', '#why-a-heatmap')])]);
  ok('links: a real fragment is not', !has(anchor, 'goes nowhere'), messages(anchor));

  const button = doc([prose('b1', [p('a', 'x')])], {
    buttons: [{ label: 'Go', href: '/cms' }],
  });
  ok('links: a button is checked too', has(button, '“Go” button'), messages(button));
}

{
  const empty = doc([prose('b1', [{ id: 'g', kind: 'p', content: [] }])]);
  ok('a page with nothing on it says so', has(empty, 'no content on it yet'));
  const full = doc([prose('b1', [p('a', 'x')])]);
  ok('…and a page with something does not', !has(full, 'no content'), messages(full));
}

{
  // The whole point: a finished page must produce an empty list.
  const clean = doc(
    [
      prose('b1', [p('a', 'An opening paragraph.'), { id: 'h', kind: 'h2', content: text('A heading') }, p('b', 'More.')]),
      canvas('c1', [image('i1', { alt: 'A diagram of the flow' })]),
    ],
    { buttons: [{ label: 'Email me', href: 'mailto:a@b.c' }] },
  );
  ok('a finished page raises nothing at all', preflight(clean).length === 0, messages(clean));
  ok('…and summarises as nothing', preflightSummary(preflight(clean)) === null);
}

{
  const mixed = doc([
    prose('b1', [p('a', 'x'), { id: 'g', kind: 'p', content: [] }]),
    canvas('c1', [image('i1')]),
  ]);
  const found = preflight(mixed);
  ok('warnings come before notes', found[0]?.level === 'warn' && found.at(-1)?.level === 'note',
    found.map((f) => f.level).join(','));
  ok('the summary counts the warnings', preflightSummary(found) === '1 thing worth a look',
    String(preflightSummary(found)));
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  process.exitCode = 1;
}
