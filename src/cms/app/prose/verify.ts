/**
 * src/cms/app/prose/verify.ts
 *
 * WS-5's standalone proof, part 1 of 2. Runs under bare `node`, with no
 * browser, no bundler and no other workstream:
 *
 *   node src/cms/app/prose/verify.ts
 *
 * It drives the REAL ProseMirror schema that the editor runs on (built by
 * extensions.ts, one per block kind) and asserts that every prose block in
 * src/cms/fixtures/simple.json survives block -> editor document -> block
 * unchanged, mark for mark, attr for attr, colour for colour.
 *
 * Part 2 is harness/, which mounts the actual React component in a real
 * browser and makes the same assertions against a live editor. This file is
 * the one that can run anywhere; that one is the one that proves the component
 * and not merely the data layer.
 *
 * Exit code 0 means every assertion below holds.
 */

import { readFileSync } from 'node:fs';

import { Node as PMNode } from '@tiptap/pm/model';

import {
  PROSE_MARKS,
  formatIssues,
  isProseBand,
  validateDocJson,
} from '../../schema.ts';
import type { ProseBlock, ProseBlockKind } from '../../schema.ts';
import {
  MARK_ORDER,
  blockFromDoc,
  canonicalJson,
  collectProseColors,
  collectProseMarks,
  collectProseText,
  contentForKind,
  convertBlockKind,
  docFromBlock,
  emptyContentFor,
  inlineLength,
  isSafeHref,
  joinInlineContent,
  normalizeMarks,
  normalizeProseContent,
  paragraphGroups,
  sameProseContent,
  splitInlineContent,
  splitInlineRange,
  topNodeTypeOf,
} from './block.ts';
import { PROSE_KINDS, SINGLE_LINE_KINDS, getProseSchema } from './extensions.ts';
import { PROSE_EDITOR_CSS } from './css.ts';
import {
  COLOR_TOKEN_CSS,
  PROSE_PALETTE,
  canonicalColorValue,
  isSafeStyleColorValue,
  normalizeHex,
  resolveColorToHex,
  toSixDigitHex,
} from './palette.ts';

/* -------------------------------------------------------------------------- */

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (ok) {
    console.log(`    ok    ${label}${detail ? ` (${detail})` : ''}`);
    return;
  }
  failures += 1;
  console.log(`    FAIL  ${label}${detail ? ` (${detail})` : ''}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/* -------------------------------------------------------------------------- */
/* The fixture                                                                 */
/* -------------------------------------------------------------------------- */

console.log('WS-5 prose editing verification (node, real ProseMirror schema)');

const fixturePath = new URL('../../fixtures/simple.json', import.meta.url);
const parsed = validateDocJson(readFileSync(fixturePath, 'utf8'));

if (!parsed.ok) {
  console.log('FAIL  src/cms/fixtures/simple.json does not validate');
  console.log(formatIssues(parsed.issues));
  process.exit(1);
}

const blocks: ProseBlock[] = parsed.ok
  ? parsed.doc.bands.filter(isProseBand).flatMap((band) => band.blocks)
  : [];

section(`fixture simple.json: ${blocks.length} prose blocks`);
check('document validates against WS-0 schema', true, parsed.doc.meta.slug);
check(
  'every block kind is covered by the fixture',
  PROSE_KINDS.every((kind) => blocks.some((block) => block.kind === kind)),
  [...new Set(blocks.map((block) => block.kind))].join(' '),
);

const fixtureMarks = new Set(blocks.flatMap((block) => collectProseMarks(block.content)).map((mark) => mark.type));
check(
  'every allowed mark appears in the fixture',
  PROSE_MARKS.every((mark) => fixtureMarks.has(mark)),
  [...fixtureMarks].sort().join(' '),
);

/* -------------------------------------------------------------------------- */
/* The schema, per kind                                                        */
/* -------------------------------------------------------------------------- */

section('schema per block kind');

const FORBIDDEN_MARKS = ['underline', 'strike', 'code', 'highlight', 'superscript'];
// hardBreak is NOT here: Shift-Enter's line break is in the schema on purpose,
// WS-1 has rendered it as <br /> all along, and block.ts keeps it inline.
const FORBIDDEN_NODES = ['horizontalRule', 'codeBlock', 'image'];

for (const kind of PROSE_KINDS) {
  const schema = getProseSchema(kind);
  const marks = Object.keys(schema.marks);
  const nodes = Object.keys(schema.nodes);

  check(
    `${kind}: marks are exactly PROSE_MARKS`,
    marks.length === PROSE_MARKS.length && PROSE_MARKS.every((mark) => marks.includes(mark)),
    marks.join(','),
  );
  check(
    `${kind}: MARK_ORDER matches ProseMirror's schema rank`,
    canonicalJson(marks) === canonicalJson([...MARK_ORDER]),
    marks.join(','),
  );
  check(
    `${kind}: no forbidden mark in the schema`,
    FORBIDDEN_MARKS.every((mark) => !marks.includes(mark)),
  );
  check(
    `${kind}: no forbidden node in the schema`,
    FORBIDDEN_NODES.every((node) => !nodes.includes(node)),
    nodes.join(','),
  );
  check(
    `${kind}: doc holds exactly one top node`,
    schema.nodes.doc.spec.content === schema.nodes[topNodeTypeOf(docFromBlock({ id: 'x', kind, content: [] })) ?? '']?.name,
    String(schema.nodes.doc.spec.content),
  );
  if (kind === 'ul' || kind === 'ol') {
    check(
      `${kind}: listItem holds one paragraph, so Tab cannot nest`,
      schema.nodes.listItem.spec.content === 'paragraph',
      String(schema.nodes.listItem.spec.content),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The round trip                                                              */
/* -------------------------------------------------------------------------- */

/**
 * block -> editor document -> ProseMirror node (checked against the schema)
 * -> JSON -> block. Every step the live editor takes, minus the DOM.
 */
function pmRoundTrip(block: ProseBlock): ProseBlock {
  const schema = getProseSchema(block.kind);
  const node = PMNode.fromJSON(schema, docFromBlock(block));
  node.check();
  return blockFromDoc(block, node.toJSON());
}

section('round trip through the real schema, per fixture block');

for (const block of blocks) {
  const marks = collectProseMarks(block.content);
  const markLabel = marks.length === 0 ? 'no marks' : marks.map((mark) => mark.type).join('+');
  let result: ProseBlock | null = null;
  let error = '';
  try {
    result = pmRoundTrip(block);
  } catch (caught) {
    error = (caught as Error).message;
  }

  if (result === null) {
    check(`${block.id} (${block.kind}): round trip`, false, error);
    continue;
  }

  const lossless = canonicalJson(result) === canonicalJson(block);
  check(`${block.id} (${block.kind}, ${markLabel}): lossless`, lossless);
  if (!lossless) {
    console.log(`          before ${canonicalJson(block.content)}`);
    console.log(`          after  ${canonicalJson(result.content)}`);
  }
  check(`${block.id}: id and kind preserved`, result.id === block.id && result.kind === block.kind);
  check(
    `${block.id}: top node is the one 2.3 names`,
    topNodeTypeOf(docFromBlock(block)) !== null,
    String(topNodeTypeOf(docFromBlock(block))),
  );
  check(
    `${block.id}: every mark survives with identical attrs`,
    canonicalJson(collectProseMarks(result.content)) === canonicalJson(marks),
  );
}

section('round trip of the whole band, in one pass');
{
  const after = blocks.map(pmRoundTrip);
  check(
    'all 9 blocks together are byte-identical after canonicalisation',
    canonicalJson(after) === canonicalJson(blocks),
  );
  check(
    'normalisation is a fixed point (applying it twice changes nothing)',
    blocks.every((block) =>
      sameProseContent(
        normalizeProseContent(block.kind, block.content),
        normalizeProseContent(block.kind, normalizeProseContent(block.kind, block.content)),
      ),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */

section('colour');

const coloredBlock = blocks.find((block) => collectProseColors(block.content).length > 0);
check('the fixture has a coloured run', coloredBlock !== undefined, coloredBlock?.id);
if (coloredBlock !== undefined) {
  const before = collectProseColors(coloredBlock.content);
  const after = collectProseColors(pmRoundTrip(coloredBlock).content);
  check(
    "the fixture's colour survives the round trip exactly",
    canonicalJson(before) === canonicalJson(after),
    after.join(' '),
  );
}

/** Every palette value, stored on a run and read back out of the real schema. */
for (const swatch of PROSE_PALETTE) {
  const probe: ProseBlock = {
    id: 'p_probe',
    kind: 'p',
    content: [
      { type: 'text', marks: [{ type: 'textStyle', attrs: { color: swatch.value } }], text: swatch.label },
    ],
  };
  const after = collectProseColors(pmRoundTrip(probe).content);
  check(
    `palette ${swatch.id}: "${swatch.value}" survives verbatim`,
    after.length === 1 && after[0] === swatch.value,
    after.join(' '),
  );
}

check(
  'accent, muted and ink are token references, not frozen hex',
  ['accent', 'muted', 'ink'].every((id) => {
    const swatch = PROSE_PALETTE.find((candidate) => candidate.id === id);
    return swatch !== undefined && swatch.value.startsWith('var(') && swatch.tokenExists;
  }),
);
check(
  'every palette value carries a hex fallback, so it renders with no tokens',
  PROSE_PALETTE.every((swatch) => swatch.value.includes(`, ${swatch.hex})`)),
);
check(
  'the five named colours reference --fc-* tokens COLOR_TOKEN_CSS defines',
  PROSE_PALETTE.filter((swatch) => !swatch.tokenExists).every(
    (swatch) =>
      swatch.token.startsWith('--fc-') &&
      COLOR_TOKEN_CSS.includes(`${swatch.token}: ${swatch.hex}`) &&
      COLOR_TOKEN_CSS.includes(`${swatch.token}: ${swatch.darkHex}`),
  ),
);
check(
  'an arbitrary picked colour stores as canonical lowercase hex',
  canonicalColorValue('#2E7D52') === '#2e7d52' && canonicalColorValue('abc') === '#abc',
);
check(
  'resolveColorToHex flattens a token for a preview, per theme',
  resolveColorToHex('var(--accent, #ff5722)', 'light') === '#ff5722' &&
    resolveColorToHex('var(--accent, #ff5722)', 'dark') === '#f5a623' &&
    resolveColorToHex('var(--unknown-token, #123456)') === '#123456',
);
check(
  'toSixDigitHex feeds <input type="color">',
  toSixDigitHex('#abc') === '#aabbcc' && toSixDigitHex('#ff5722cc') === '#ff5722',
);

section('colour: negative controls');
const badColors: [string, unknown][] = [
  ['a semicolon escaping the declaration', 'red; background:url(x)'],
  ['a url()', 'url(http://example.com/x.png)'],
  ['a CSS block', '#fff}body{display:none'],
  ['a quote', '"#fff"'],
  ['a named colour (not in the two stored forms)', 'rebeccapurple'],
  ['an rgb() function', 'rgb(1,2,3)'],
  ['an expression', 'expression(alert(1))'],
  ['a var() with a non-hex fallback', 'var(--x, red)'],
  ['an empty string', ''],
  ['not a string', 123],
];
for (const [label, value] of badColors) {
  check(`rejected: ${label}`, !isSafeStyleColorValue(value) && canonicalColorValue(value) === null);
}
check(
  'a rejected colour drops the whole textStyle mark rather than storing null',
  normalizeMarks([{ type: 'textStyle', attrs: { color: 'rebeccapurple' } }]).length === 0 &&
    normalizeMarks([{ type: 'textStyle', attrs: { color: null } }]).length === 0,
);
check('a hex with alpha is storable', normalizeHex('#FF5722CC') === '#ff5722cc');

/* -------------------------------------------------------------------------- */
/* Marks: what ProseMirror adds, and what the contract stores                  */
/* -------------------------------------------------------------------------- */

section('marks');

check(
  "link stores href/target/rel and drops TipTap's class and title",
  canonicalJson(
    normalizeMarks([
      {
        type: 'link',
        attrs: {
          href: 'https://example.com',
          target: '_blank',
          rel: 'noopener noreferrer',
          class: null,
          title: null,
        },
      },
    ]),
  ) ===
    canonicalJson([
      {
        type: 'link',
        attrs: { href: 'https://example.com', target: '_blank', rel: 'noopener noreferrer' },
      },
    ]),
);
check(
  'marks are sorted into MARK_ORDER, so authoring order cannot churn a document',
  canonicalJson(normalizeMarks([{ type: 'italic' }, { type: 'bold' }])) ===
    canonicalJson([{ type: 'bold' }, { type: 'italic' }]),
);
check(
  'a mark outside PROSE_MARKS is dropped',
  normalizeMarks([{ type: 'underline' }, { type: 'strike' }, { type: 'code' }]).length === 0,
);
check(
  'duplicate marks collapse',
  normalizeMarks([{ type: 'bold' }, { type: 'bold' }]).length === 1,
);

section('links: hrefs that may be stored');
for (const href of [
  'https://jinhyuk.org',
  'http://example.com/a?b=c#d',
  'mailto:hi@jinhyuk.org',
  'tel:+15550000',
  '/projects/track',
  '#heatmap',
]) {
  check(`accepted: ${href}`, isSafeHref(href));
}
for (const href of [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'data:text/html,<script>x</script>',
  'vbscript:x',
  'example.com',
  '',
]) {
  check(`refused: ${href === '' ? '(empty)' : href}`, !isSafeHref(href));
}
check(
  'a refused href drops the link mark instead of storing it',
  normalizeMarks([{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]).length === 0,
);

/* -------------------------------------------------------------------------- */
/* Shape coercion                                                              */
/* -------------------------------------------------------------------------- */

section('shape coercion into the 3.2 shape');

check(
  'an empty text node is dropped (ProseMirror forbids them)',
  canonicalJson(normalizeProseContent('p', [{ type: 'text', text: '' }])) === canonicalJson([]),
);
check(
  'adjacent runs with identical marks merge, as ProseMirror merges them',
  canonicalJson(
    normalizeProseContent('p', [
      { type: 'text', text: 'one ' },
      { type: 'text', text: 'two' },
    ]),
  ) === canonicalJson([{ type: 'text', text: 'one two' }]),
);
check(
  'a nested list is flattened into sibling items',
  canonicalJson(
    normalizeProseContent('ul', [
      {
        type: 'listItem',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'outer' }] },
          {
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inner' }] }] },
            ],
          },
        ],
      },
    ]),
  ) ===
    canonicalJson([
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'outer' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inner' }] }] },
    ]),
);
check(
  'an empty quote holds one empty paragraph, which is a legal node',
  canonicalJson(emptyContentFor('quote')) === canonicalJson([{ type: 'paragraph' }]),
);
check(
  'an empty list holds one empty item',
  canonicalJson(emptyContentFor('ul')) ===
    canonicalJson([{ type: 'listItem', content: [{ type: 'paragraph' }] }]),
);
check('an empty paragraph is []', canonicalJson(emptyContentFor('p')) === canonicalJson([]));

for (const kind of PROSE_KINDS) {
  let ok = true;
  let detail = '';
  try {
    const schema = getProseSchema(kind);
    const node = PMNode.fromJSON(schema, docFromBlock({ id: 'p_empty', kind, content: [] }));
    node.check();
  } catch (caught) {
    ok = false;
    detail = (caught as Error).message;
  }
  check(`an empty ${kind} block builds a schema-valid document`, ok, detail);
}

/* -------------------------------------------------------------------------- */
/* Kind conversion                                                             */
/* -------------------------------------------------------------------------- */

section('kind conversion: all 36 pairs');

const sample = blocks.find((block) => block.id === 'p_cover');
if (sample === undefined) {
  check('fixture block p_cover exists', false);
} else {
  const words = collectProseText(sample.content).replace(/\s+/g, ' ').trim();
  let pairs = 0;
  let bad: string[] = [];
  for (const from of PROSE_KINDS) {
    const start = convertBlockKind(sample, from);
    for (const to of PROSE_KINDS) {
      pairs += 1;
      const moved = convertBlockKind(start, to);
      const movedWords = collectProseText(moved.content).replace(/\s+/g, ' ').trim();
      let valid = true;
      try {
        PMNode.fromJSON(getProseSchema(to), docFromBlock(moved)).check();
      } catch {
        valid = false;
      }
      const roundTripped = pmRoundTrip(moved);
      if (
        moved.kind !== to ||
        moved.id !== sample.id ||
        movedWords !== words ||
        !valid ||
        canonicalJson(roundTripped) !== canonicalJson(moved)
      ) {
        bad.push(`${from}->${to}`);
      }
    }
  }
  check(
    'every pair keeps the words, the id, a valid document and a lossless round trip',
    bad.length === 0,
    bad.length === 0 ? `${pairs} pairs` : bad.join(' '),
  );
  check(
    'the coloured run survives every conversion',
    PROSE_KINDS.every(
      (to) => canonicalJson(collectProseColors(convertBlockKind(sample, to).content)) ===
        canonicalJson(collectProseColors(sample.content)),
    ),
  );
  check(
    'ul -> ol keeps the item structure untouched',
    canonicalJson(convertBlockKind({ ...sample, kind: 'ul' }, 'ol').content) ===
      canonicalJson(convertBlockKind(sample, 'ul').content),
  );
}

{
  const list = blocks.find((block) => block.kind === 'ul');
  if (list !== undefined) {
    const flattened = convertBlockKind(list, 'p');
    check(
      "a three-item list collapses to one paragraph, items joined, no node types invented",
      flattened.content.every(
        (node) => (node as { type?: string }).type === 'text',
      ) && collectProseText(flattened.content).includes('water'),
      collectProseText(flattened.content),
    );
    check(
      'and back to a list, it is one item (joining is not reversible, and says so)',
      convertBlockKind(flattened, 'ul').content.length === 1,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Enter cuts a block in two; Backspace puts it back                           */
/* -------------------------------------------------------------------------- */

section('splitting and joining an inline run');
{
  const text = (value: string, marks?: unknown[]): { type: 'text'; text: string } =>
    (marks === undefined
      ? { type: 'text', text: value }
      : { type: 'text', marks, text: value }) as { type: 'text'; text: string };

  const plain = [text("Showing up beats perfect. I'll get tomorrow's square")];
  const at = plain[0].text.indexOf("I'll");

  const [head, tail] = splitInlineContent(plain, at);
  check('the head is the text before the caret', collectProseText(head) === 'Showing up beats perfect. ', JSON.stringify(collectProseText(head)));
  check('the tail is the text after it', collectProseText(tail) === "I'll get tomorrow's square");
  check('nothing is lost in the cut', inlineLength(head) + inlineLength(tail) === inlineLength(plain));

  // The whole point of the feature: the two halves go back together exactly,
  // with no space conjured at the seam.
  check(
    'joining them back is the original, character for character',
    sameProseContent(joinInlineContent(head, tail), normalizeProseContent('p', plain)),
    collectProseText(joinInlineContent(head, tail)),
  );
  check('the seam is where the caret goes', inlineLength(head) === at, `${inlineLength(head)} vs ${at}`);

  // Both ends. A cut at 0 leaves an empty block above, a cut at the end leaves
  // an empty one below, and neither may invent an empty text node, which
  // ProseMirror refuses outright.
  const [emptyHead, whole] = splitInlineContent(plain, 0);
  check('a cut at the start gives an empty head', emptyHead.length === 0);
  check('and the whole run as the tail', collectProseText(whole) === collectProseText(plain));
  const [all, emptyTail] = splitInlineContent(plain, 9999);
  check('a cut past the end gives an empty tail', emptyTail.length === 0);
  check('and the whole run as the head', collectProseText(all) === collectProseText(plain));

  // Marks survive the cut on both sides, including a cut INSIDE a marked run.
  const marked = [text('plain and '), text('bold words', [{ type: 'bold' }])];
  const [mHead, mTail] = splitInlineContent(marked, 'plain and bold'.length);
  check(
    'a cut inside a bold run leaves bold on both halves',
    canonicalJson(mHead[1]?.marks) === canonicalJson([{ type: 'bold' }]) &&
      canonicalJson(mTail[0]?.marks) === canonicalJson([{ type: 'bold' }]),
    `${collectProseText(mHead)} | ${collectProseText(mTail)}`,
  );
  check(
    'and the characters are still all there, in order',
    collectProseText(mHead) + collectProseText(mTail) === collectProseText(marked),
  );
  check(
    'a split half is legal 3.2 content, unchanged by normalisation',
    sameProseContent(mTail, normalizeProseContent('p', mTail)),
  );

  // Enter on a selection replaces it, as it does in every text editor.
  const [rHead, rTail] = splitInlineRange(plain, 'Showing'.length, 'Showing up beats'.length);
  check(
    'Enter on a selection drops what was selected',
    collectProseText(rHead) + collectProseText(rTail) === "Showing perfect. I'll get tomorrow's square",
    collectProseText(rHead) + collectProseText(rTail),
  );
  check(
    'a backwards selection splits the same way',
    sameProseContent(splitInlineRange(plain, 'Showing up beats'.length, 'Showing'.length)[0], rHead),
  );

  check(
    'only p/h2/h3 route Enter through the split: the rest have somewhere to put it',
    [...SINGLE_LINE_KINDS].sort().join(',') === 'h2,h3,p',
    [...SINGLE_LINE_KINDS].join(','),
  );
}

section("Shift-Enter's line break stays inside the paragraph");
{
  const br = { type: 'hardBreak' };
  const broken = [
    { type: 'text', text: 'Showing up beats perfect.' },
    br,
    { type: 'text', text: "I'll get tomorrow's square" },
  ];

  // The trap this guards: before block.ts knew about hardBreak, every non-text
  // node ended the run, so normalising a line break turned it into a PARAGRAPH
  // break and the author's one block quietly became two on the next save.
  const normalized = normalizeProseContent('p', broken);
  check(
    'a line break survives normalisation as one inline run',
    canonicalJson(normalized) === canonicalJson(broken),
    canonicalJson(normalized),
  );
  check(
    'and is not promoted to a paragraph split',
    paragraphGroups(broken).length === 1,
    String(paragraphGroups(broken).length),
  );
  check(
    'normalising twice changes nothing (still a fixed point)',
    canonicalJson(normalizeProseContent('p', normalized)) === canonicalJson(normalized),
  );
  check('it reads as a newline in plain text', collectProseText(broken).includes('\n'));

  // One position wide, so a later Enter still cuts where the caret is.
  check('a break counts as one character', inlineLength(broken) === 25 + 1 + 26, String(inlineLength(broken)));

  // Splitting exactly at a break, on either side of it.
  const [beforeBr, afterBr] = splitInlineContent(broken, 25);
  check('cutting before the break leaves it on the tail', canonicalJson(afterBr[0]) === canonicalJson(br), canonicalJson(afterBr[0]));
  check('and the head is the first sentence', collectProseText(beforeBr) === 'Showing up beats perfect.');
  const [withBr, past] = splitInlineContent(broken, 26);
  check('cutting after it leaves it on the head', canonicalJson(withBr[1]) === canonicalJson(br), canonicalJson(withBr[1]));
  check('and the tail is the second sentence', collectProseText(past) === "I'll get tomorrow's square");
  check('the break is atomic: it is never sliced in half', inlineLength(withBr) + inlineLength(past) === inlineLength(broken));

  // A break is not a quote or list boundary either: flattening keeps it.
  check(
    'converting to a list keeps the break inside the one item',
    contentForKind('ul', paragraphGroups(broken)).length === 1,
    canonicalJson(contentForKind('ul', paragraphGroups(broken))),
  );
  check(
    'and no space is invented next to it',
    !collectProseText(normalized).includes(' \n') && !collectProseText(normalized).includes('\n '),
    JSON.stringify(collectProseText(normalized)),
  );
}

/* -------------------------------------------------------------------------- */
/* The chrome stylesheet does not style the page                               */
/* -------------------------------------------------------------------------- */

section('chrome CSS styles the toolbar and nothing else');
{
  // Comments first: `/* The floating toolbar. */` sits where a selector does.
  const withoutComments = PROSE_EDITOR_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [...withoutComments.matchAll(/(^|\})\s*([^{}@]+)\{/g)]
    .map((match) => match[2].trim())
    .filter((selector) => selector !== '')
    .flatMap((selector) => selector.split(',').map((part) => part.trim()));

  check('the stylesheet has rules at all', selectors.length > 10, String(selectors.length));

  // docs/cms-rebuild.md section 4: WS-5 must not style the page. Every rule has
  // to be either .pe-* chrome or ProseMirror's own machinery; a bare element
  // selector would reach into content WS-1 owns.
  const strays = selectors.filter(
    (selector) => !selector.startsWith('.pe-') && !selector.includes('.ProseMirror'),
  );
  check('every selector is .pe-* chrome or ProseMirror machinery', strays.length === 0, strays.join(' | '));

  const PROSE_TARGETS = [' p', ' h2', ' h3', ' blockquote', ' ul', ' ol', ' li', ' a', ' span'];
  const reaches = selectors.filter((selector) =>
    PROSE_TARGETS.some((target) => ` ${selector}`.includes(target) && !selector.includes('.pe-')),
  );
  check('no rule targets a prose element', reaches.length === 0, reaches.join(' | '));
  check(
    'COLOR_TOKEN_CSS is exported for WS-1 rather than injected here',
    !PROSE_EDITOR_CSS.includes('--fc-red'),
  );
}

/* -------------------------------------------------------------------------- */

console.log('');
if (failures === 0) {
  console.log(`PASS  ${checks} checks, 0 failures`);
  process.exit(0);
}
console.log(`FAIL  ${failures} of ${checks} checks failed`);
process.exit(1);
