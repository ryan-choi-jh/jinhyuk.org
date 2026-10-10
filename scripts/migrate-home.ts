/**
 * scripts/migrate-home.ts
 *
 * WS-F MIGRATION, 1 of 3.
 *
 *   src/content/home.yaml   ->   src/content/pages/home.json   (a Doc)
 *
 * The homepage is a `name`, an `intro` textarea and a hero illustration that
 * is not in the YAML at all. docs/cms-contracts.md §12 fixes all three:
 *
 *   - `name` becomes `meta.title`. It is NOT a prose block, or the page renders
 *     the name twice.
 *   - `intro` is a textarea: blank lines separate paragraphs and `*asterisks*`
 *     mark italics on film titles. One `p` block per paragraph, one `italic`
 *     mark per asterisk pair. Exactly the conversion `src/pages/index.astro`
 *     does today, and this script reads its regexes from the same shape.
 *   - the hero is hardcoded in `src/pages/index.astro` as `/home/hero.webp`,
 *     2688 x 1648. It becomes one full-width canvas item so the owner can
 *     move or replace it from the editor. Its `src`, `alt` and intrinsic size
 *     are read out of the page rather than copied into this file, so a change
 *     to the page cannot silently disagree with the migration.
 *
 * Modes
 *   node scripts/migrate-home.ts               convert and write
 *   node scripts/migrate-home.ts --verify      live-vs-migrated diff + report
 *   node scripts/migrate-home.ts --selftest    synthetic intros, no network
 *   node scripts/migrate-home.ts --check       fail if the committed JSON is stale
 *   node scripts/migrate-home.ts --dry-run     convert, validate, write nothing
 *
 * Flags: --date=YYYY-MM-DD, --offline, --refresh, --quiet, --no-report,
 *        --origin=<url>, --live-dir=<dir>.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { REFERENCE_WIDTH, formatIssues, validateDoc } from '../src/cms/schema.ts';
import type { Doc, ProseBlock } from '../src/cms/schema.ts';
import { CONTENT_ROOT, contentPathFor, requireSection } from '../src/cms/sections.ts';

import {
  Checks,
  MODE,
  PROJECT,
  cutSubtrees,
  diffBlock,
  diffLines,
  fetchLive,
  finish,
  findSubtree,
  foldTypography,
  hasFatal,
  inventoryDoc,
  inventoryHtml,
  mdCell,
  note,
  option,
  readJsonIfPresent,
  say,
  sentences,
  shout,
  squash,
  statusLine,
  upsertReportSection,
  words,
  writeJsonFile,
  fatal,
  type Loss,
} from './migrate-lib.ts';

const require_ = createRequire(import.meta.url);
/** js-yaml is in the tree as a transitive dependency and ships no types. */
const yaml = require_('js-yaml') as { load: (text: string) => unknown };

const HOME_SECTION = requireSection('home');
const SOURCE = join(PROJECT, CONTENT_ROOT, 'home.yaml');
const INDEX_PAGE = join(PROJECT, 'src/pages/index.astro');
const OUT = join(PROJECT, contentPathFor(HOME_SECTION));

/* ========================================================================== */
/* The source                                                                 */
/* ========================================================================== */

type HomeYaml = { name: string; intro: string };

function readHomeYaml(text: string, losses: Loss[]): HomeYaml {
  const raw = yaml.load(text);
  if (typeof raw !== 'object' || raw === null) {
    fatal(losses, 'home.yaml', 'the file does not parse as a YAML mapping');
    return { name: '', intro: '' };
  }
  const record = raw as Record<string, unknown>;
  const known = new Set(['name', 'intro']);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      fatal(losses, `home.yaml:${key}`, `an unknown key with no home for it in Doc.meta: ${JSON.stringify(record[key])}`);
    }
  }
  const name = typeof record.name === 'string' ? record.name : '';
  const intro = typeof record.intro === 'string' ? record.intro : '';
  if (name === '') fatal(losses, 'home.yaml:name', 'missing or not a string');
  if (intro === '') fatal(losses, 'home.yaml:intro', 'missing or not a string');
  return { name, intro };
}

/**
 * Paragraphs, exactly as `src/pages/index.astro` splits them today: blank
 * lines separate, and a wrapped line inside a paragraph joins with one space.
 */
export function introParagraphs(intro: string): string[] {
  return intro
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim().replace(/\s*\n\s*/g, ' '))
    .filter((paragraph) => paragraph !== '');
}

/**
 * `*asterisks*` to italic marks, with the same regex the page uses, so the
 * same spans end up italic. An unpaired asterisk is left as a literal, which
 * is also what the page does; it is reported rather than swallowed.
 */
export function inlineNodes(paragraph: string, losses: Loss[], where: string): unknown[] {
  const nodes: unknown[] = [];
  const pattern = /\*([^*]+)\*/g;
  let at = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(paragraph)) !== null) {
    if (match.index > at) nodes.push({ type: 'text', text: paragraph.slice(at, match.index) });
    nodes.push({ type: 'text', marks: [{ type: 'italic' }], text: match[1] ?? '' });
    at = match.index + match[0].length;
  }
  if (at < paragraph.length) nodes.push({ type: 'text', text: paragraph.slice(at) });

  const tail = paragraph.slice(at);
  if (tail.includes('*')) {
    note(losses, where, `an unpaired "*" is kept as a literal asterisk, which is what the live page does: ${JSON.stringify(tail)}`);
  }
  return nodes;
}

/* ========================================================================== */
/* The hero                                                                   */
/* ========================================================================== */

export type Hero = { src: string; alt: string; width: number; height: number };

/**
 * The hero as `src/pages/index.astro` declares it. Read, not copied: if WS-B
 * changes the illustration, this migration either picks it up or fails loudly.
 */
function readHero(pageSource: string, losses: Loss[]): Hero | null {
  const img = /<img\s+([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = img.exec(pageSource)) !== null) {
    const attrs = match[1] ?? '';
    const src = /src="([^"]+)"/.exec(attrs)?.[1] ?? '';
    if (!src.startsWith('/home/')) continue;
    const alt = /alt="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const width = Number(/width="(\d+)"/.exec(attrs)?.[1] ?? '0');
    const height = Number(/height="(\d+)"/.exec(attrs)?.[1] ?? '0');
    // The lightbox holds a second copy with an empty alt; the first one with a
    // real alt is the hero itself.
    if (alt === '' || width <= 0 || height <= 0) continue;
    return { src, alt, width, height };
  }
  fatal(losses, 'src/pages/index.astro', 'no hero <img> with a /home/ src, an alt and intrinsic dimensions');
  return null;
}

/* ========================================================================== */
/* The conversion                                                             */
/* ========================================================================== */

const TODAY = new Date().toISOString().slice(0, 10);

/** Keep the date already committed, so re-running does not churn the file. */
function dateFor(): string {
  const explicit = option('date', '');
  if (explicit !== '') return explicit;
  const existing = readJsonIfPresent(OUT) as { meta?: { date?: unknown } } | null;
  const committed = existing?.meta?.date;
  if (typeof committed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(committed)) return committed;
  return TODAY;
}

export function buildHomeDoc(source: HomeYaml, hero: Hero | null, date: string, losses: Loss[]): Doc {
  const paragraphs = introParagraphs(source.intro);
  const blocks: ProseBlock[] = paragraphs.map((paragraph, index) => ({
    id: `p${index + 1}`,
    kind: 'p',
    content: inlineNodes(paragraph, losses, `home.yaml:intro paragraph ${index + 1}`),
  }));

  const doc: Doc = {
    version: 1,
    meta: {
      title: source.name,
      slug: 'home',
      date,
      section: 'home',
    },
    bands: [],
  };

  if (hero !== null) {
    // x and w are reference px against REFERENCE_WIDTH; the band's height is
    // the illustration's own aspect ratio at that width, so nothing is cropped
    // and nothing is stretched.
    const height = Math.round((hero.height * REFERENCE_WIDTH) / hero.width);
    doc.bands.push({
      id: 'b_hero',
      type: 'canvas',
      height,
      items: [
        {
          id: 'i_hero',
          kind: 'image',
          src: hero.src,
          alt: hero.alt,
          x: 0,
          y: 0,
          w: REFERENCE_WIDTH,
          h: height,
          z: 0,
        },
      ],
    });
  }

  doc.bands.push({ id: 'b_intro', type: 'prose', blocks });
  return doc;
}

type Conversion = { doc: Doc; losses: Loss[]; hero: Hero | null; source: HomeYaml; paragraphs: string[] };

function convert(): Conversion {
  const losses: Loss[] = [];
  const source = readHomeYaml(readFileSync(SOURCE, 'utf8'), losses);
  const hero = existsSync(INDEX_PAGE) ? readHero(readFileSync(INDEX_PAGE, 'utf8'), losses) : null;
  if (hero === null && !existsSync(INDEX_PAGE)) {
    fatal(losses, 'src/pages/index.astro', 'the page is gone, so the hero cannot be read from it');
  }
  const doc = buildHomeDoc(source, hero, dateFor(), losses);
  return { doc, losses, hero, source, paragraphs: introParagraphs(source.intro) };
}

/* ========================================================================== */
/* Write                                                                      */
/* ========================================================================== */

function migrate(): { conversion: Conversion; ok: boolean; outcome: string } {
  const conversion = convert();

  for (const loss of conversion.losses) {
    shout(`${loss.fatal ? 'FATAL' : 'note '} ${loss.where}: ${loss.what}`);
  }
  if (hasFatal(conversion.losses)) {
    return { conversion, ok: false, outcome: 'not written: a fatal loss' };
  }

  const validated = validateDoc(conversion.doc);
  if (!validated.ok) {
    shout(`FATAL ${OUT} does not validate:\n${formatIssues(validated.issues)}`);
    return { conversion, ok: false, outcome: 'not written: invalid' };
  }

  const outcome = writeJsonFile(OUT, conversion.doc);
  say(`${outcome.padEnd(11)} ${contentPathFor(HOME_SECTION)}`);
  return { conversion, ok: outcome !== 'stale', outcome };
}

/* ========================================================================== */
/* Verify: the live page against the migrated document                        */
/* ========================================================================== */

/**
 * Differences that are supposed to be there. Every entry is a pair of (what the
 * diff will show, why), and the verification fails if the diff shows anything
 * that is not in here.
 */
const JUSTIFIED: { key: string; title: string; body: string }[] = [
  {
    key: 'name',
    title: 'The name is `meta.title`, not a prose block',
    body:
      'The live page renders `name` as `<p class="name">`, the first paragraph of `.intro`. ' +
      'docs/cms-contracts.md §12 says it becomes `meta.title` and explicitly not a prose block, ' +
      '"or it renders twice": the page template prints the title itself. The assertion below is ' +
      'that the dropped paragraph is character-for-character `meta.title`, so no text is lost.',
  },
  {
    key: 'summary',
    title: '`meta.summary` is left unset',
    body:
      "`home.yaml` has no summary. The homepage's `<meta name=\"description\">` is a string hardcoded in " +
      '`src/pages/index.astro`, not content, so migrating it would mean inventing a content field from a ' +
      'template literal — and if WS-B renders `summary` the way the essay page does, as a visible lead ' +
      'paragraph, the homepage would gain a line of text it does not have today. It stays unset; the ' +
      'description stays where it is. Noted for WS-B rather than guessed at.',
  },
  {
    key: 'hero',
    title: 'The hero illustration becomes a canvas band',
    body:
      'It is not in `home.yaml` at all: `src/pages/index.astro` hardcodes `/home/hero.webp`. ' +
      'docs/cms-sections.md 3.2 wants it editable, so it migrates as one full-width canvas item at ' +
      "the illustration's own aspect ratio. `src` and `alt` are read out of the page, and the " +
      'assertions below compare them against the live `<img>`.',
  },
  {
    key: 'lightbox',
    title: 'The lightbox copy of the hero is not migrated',
    body:
      'The page holds a second `<img src="/home/hero.webp" alt="">` inside `.lightbox`, which is the ' +
      'enlarge-on-tap overlay, plus its hint text. That is page chrome built by the template around the ' +
      'illustration, not content: one illustration migrates once. The verification cuts the `.lightbox` ' +
      'subtree out of the live page before comparing, and says so here rather than letting the ' +
      'inventory quietly swallow it.',
  },
];

async function verify(conversion: Conversion): Promise<boolean> {
  const checks = new Checks();
  const live = await fetchLive('/');
  say(`live: ${live.url} (${live.from}, ${live.html.length} bytes)`);

  const main = findSubtree(live.html, { tag: 'main' });
  if (main === null) {
    checks.add('the live homepage has a <main>', false, 'no <main> element found');
    return report(conversion, checks, live.url, '', 0, []);
  }

  const { html: body, cut } = cutSubtrees(main.inner, [{ cls: 'lightbox' }]);
  const liveInv = inventoryHtml(body);
  const docInv = inventoryDoc(conversion.doc);

  checks.add('the `.lightbox` chrome was cut before comparing', cut === 1, `${cut} subtree(s) removed`);

  /* -- the name ------------------------------------------------------------ */
  const first = liveInv.blocks[0];
  checks.add(
    'the first live block is the name, and it is exactly `meta.title`',
    first !== undefined && first.text === conversion.doc.meta.title,
    `live ${JSON.stringify(first?.text ?? null)} vs meta.title ${JSON.stringify(conversion.doc.meta.title)}`,
  );
  checks.add(
    'the name is not also a prose block (it would render twice)',
    !docInv.blocks.some((block) => block.text === conversion.doc.meta.title),
    `${docInv.blocks.length} migrated blocks, none of them the name`,
  );

  /* -- the prose ----------------------------------------------------------- */
  const liveProse = liveInv.blocks.slice(1).map((block) => `${block.tag} | ${block.text}`);
  const docProse = docInv.blocks.map((block) => `${block.tag} | ${block.text}`);
  checks.same('every intro paragraph, tag and text, in order', liveProse, docProse);

  /* -- sentences, the no-silent-drop check --------------------------------- */
  const liveSentences = sentences(liveInv.blocks.slice(1).map((block) => block.text).join('\n'));
  const migratedPlain = docInv.plain;
  const missing = liveSentences.filter((sentence) => !migratedPlain.includes(sentence));
  checks.add(
    `all ${liveSentences.length} sentences on the live homepage appear verbatim in the migrated document`,
    missing.length === 0,
    missing.length === 0 ? 'none missing' : `missing: ${missing.map((s) => JSON.stringify(s)).join(' ')}`,
  );

  const liveWords = words(liveInv.blocks.slice(1).map((block) => block.text).join(' '));
  const docWords = words(migratedPlain);
  checks.add('prose word count', liveWords === docWords, `live ${liveWords}, migrated ${docWords}`);

  /* -- italics ------------------------------------------------------------- */
  checks.same('every inline decoration (the italic film titles), in order', liveInv.marks, docInv.marks);
  checks.add(
    'no link is lost',
    liveInv.links.length === docInv.links.length,
    `live ${liveInv.links.length}, migrated ${docInv.links.length}`,
  );

  /* -- the hero ------------------------------------------------------------ */
  checks.same('media (src and alt), in order', liveInv.media, docInv.media);

  const liveImg = /<img\s+([^>]*?)\/?>/.exec(body)?.[1] ?? '';
  const liveW = Number(/width="(\d+)"/.exec(liveImg)?.[1] ?? '0');
  const liveH = Number(/height="(\d+)"/.exec(liveImg)?.[1] ?? '0');
  const heroItem = conversion.doc.bands
    .flatMap((band) => (band.type === 'canvas' ? band.items : []))
    .find((item) => item.kind === 'image');
  const liveRatio = liveH === 0 ? 0 : liveW / liveH;
  const docRatio = heroItem === undefined ? 0 : heroItem.w / heroItem.h;
  checks.add(
    'the hero keeps its aspect ratio at the 1344px reference width',
    heroItem !== undefined && Math.abs(liveRatio - docRatio) < 0.002,
    `live ${liveW}x${liveH} (${liveRatio.toFixed(4)}), item ${heroItem?.w}x${heroItem?.h} (${docRatio.toFixed(4)})`,
  );
  checks.add(
    'the hero is full width',
    heroItem !== undefined && heroItem.x === 0 && heroItem.w === REFERENCE_WIDTH,
    `x=${heroItem?.x}, w=${heroItem?.w}, reference width ${REFERENCE_WIDTH}`,
  );

  /* -- source against migration (not only live against migration) ---------- */
  const sourceParagraphs = conversion.paragraphs.map((paragraph) => paragraph.replace(/\*/g, ''));
  checks.same('every paragraph of `home.yaml`, asterisks removed, in order', sourceParagraphs, docProse.map((line) => line.slice(4)));

  /* -- typography ---------------------------------------------------------- */
  const folded = liveProse.map(foldTypography).join('\n') === docProse.map(foldTypography).join('\n');
  checks.add(
    'the homepage intro is not run through a markdown typographer (straight quotes stay straight)',
    folded && liveProse.join('\n') === docProse.join('\n'),
    'live text and migrated text are identical before and after folding curly punctuation',
  );

  const edits = diffLines(liveInv.blocks.map((block) => `${block.tag} | ${block.text}`), docProse);
  return report(conversion, checks, live.url, body, cut, edits);
}

/* ========================================================================== */
/* Report                                                                     */
/* ========================================================================== */

function report(
  conversion: Conversion,
  checks: Checks,
  liveUrl: string,
  body: string,
  cut: number,
  edits: { op: string; value: string }[],
): boolean {
  const lines: string[] = [];
  lines.push(statusLine(checks.passed ? 'PASS' : 'FAIL', checks.rows.length));
  lines.push('');
  lines.push(
    `\`src/content/home.yaml\` -> \`${contentPathFor(HOME_SECTION)}\`. ` +
      `Baseline: ${liveUrl}, \`<main>\` extracted (${body.length} bytes after cutting ${cut} chrome subtree), ` +
      'reduced to the text of each block, each inline decoration and each picture, in document order.',
  );
  lines.push('');
  lines.push('### 1.1 Nothing was lost');
  lines.push('');
  lines.push(checks.table());
  lines.push('');
  const differing = edits.filter((edit) => edit.op !== 'same');
  lines.push('### 1.2 The block diff, in full');
  lines.push('');
  lines.push(
    differing.length === 0
      ? 'No differences at all: the live blocks and the migrated blocks are the same list.'
      : 'Every block of both sides, in order. `-` is the live page, `+` is the migration, and ' +
          `${differing.length} of ${edits.length} entries ${differing.length === 1 ? 'differs' : 'differ'}. ` +
          'Each one is justified in 1.3.',
  );
  lines.push('');
  lines.push(diffBlock(edits as never, 40));
  lines.push('');
  lines.push('### 1.3 Every difference, and why');
  lines.push('');
  for (const [index, item] of JUSTIFIED.entries()) {
    lines.push(`**1.3.${index + 1} ${item.title}.** ${item.body}`);
    lines.push('');
  }
  let next = 4;
  if (conversion.losses.length > 0) {
    lines.push(`### 1.${next} What the converter recorded`);
    next += 1;
    lines.push('');
    lines.push('| where | severity | what |');
    lines.push('|---|---|---|');
    for (const loss of conversion.losses) {
      lines.push(`| \`${loss.where}\` | ${loss.fatal ? '**fatal**' : 'note'} | ${mdCell(loss.what)} |`);
    }
    lines.push('');
  }
  lines.push(`### 1.${next} The migrated document`);
  lines.push('');
  lines.push(
    `\`${contentPathFor(HOME_SECTION)}\`: ${conversion.doc.bands.length} bands — ` +
      conversion.doc.bands
        .map((band) =>
          band.type === 'prose'
            ? `\`${band.id}\` prose, ${band.blocks.length} blocks`
            : `\`${band.id}\` canvas, height ${band.height}, ${band.items.length} item`,
        )
        .join('; ') +
      `. \`meta\`: ${Object.keys(conversion.doc.meta)
        .map((key) => `\`${key}\``)
        .join(', ')}.`,
  );
  lines.push('');

  const written = upsertReportSection('home', lines.join('\n'));
  if (written !== null) say(`report: ${written}`);
  return checks.passed;
}

/* ========================================================================== */
/* Selftest                                                                   */
/* ========================================================================== */

function selftest(): boolean {
  const checks = new Checks();

  const losses: Loss[] = [];
  const paragraphs = introParagraphs('one\nline\n\n  two  \n\n\nthree\n');
  checks.add('blank lines separate paragraphs, wrapped lines join', JSON.stringify(paragraphs) === JSON.stringify(['one line', 'two', 'three']), JSON.stringify(paragraphs));

  const italic = inlineNodes('A *Film, Two,* and *Three* end.', losses, 'selftest');
  checks.add(
    'asterisk pairs become italic marks, text either side survives',
    JSON.stringify(italic) ===
      JSON.stringify([
        { type: 'text', text: 'A ' },
        { type: 'text', marks: [{ type: 'italic' }], text: 'Film, Two,' },
        { type: 'text', text: ' and ' },
        { type: 'text', marks: [{ type: 'italic' }], text: 'Three' },
        { type: 'text', text: ' end.' },
      ]),
    JSON.stringify(italic),
  );

  const unpaired = inlineNodes('a * b', losses, 'selftest');
  checks.add(
    'an unpaired asterisk stays literal and is reported',
    JSON.stringify(unpaired) === JSON.stringify([{ type: 'text', text: 'a * b' }]) && losses.length === 1,
    `${JSON.stringify(unpaired)}, ${losses.length} note(s)`,
  );

  const doc = buildHomeDoc(
    { name: 'A Name', intro: 'First para.\n\nSecond *italic* para.' },
    { src: '/home/hero.webp', alt: 'alt text', width: 2688, height: 1648 },
    '2026-10-09',
    losses,
  );
  const validated = validateDoc(doc);
  checks.add('a synthetic home document validates', validated.ok, validated.ok ? 'ok' : formatIssues(validated.issues));

  const inv = inventoryDoc(doc);
  checks.add(
    'the name is not in the prose',
    !inv.blocks.some((block) => block.text === 'A Name'),
    `blocks: ${JSON.stringify(inv.blocks.map((b) => b.text))}`,
  );
  checks.add('the hero is 1344 x 824 at the reference width', doc.bands[0]?.type === 'canvas' && doc.bands[0].height === 824, JSON.stringify(doc.bands[0]?.type === 'canvas' ? doc.bands[0].height : null));
  checks.add('italic survives into the inventory', inv.marks.includes('em: italic'), JSON.stringify(inv.marks));

  const empty = buildHomeDoc({ name: 'N', intro: '' }, null, '2026-10-09', losses);
  checks.add('an empty intro is an empty prose band, not a crash', validateDoc(empty).ok, `${empty.bands.length} band(s)`);

  const missingName: Loss[] = [];
  readHomeYaml('intro: hello', missingName);
  checks.add('a missing `name` is fatal', missingName.some((loss) => loss.fatal), JSON.stringify(missingName.map((l) => l.where)));

  const strange: Loss[] = [];
  readHomeYaml('name: n\nintro: i\ntagline: something new', strange);
  checks.add('an unknown YAML key is fatal rather than dropped', strange.some((loss) => loss.fatal), JSON.stringify(strange.map((l) => l.where)));

  const heroLosses: Loss[] = [];
  const hero = readHero(
    '<img src="/home/hero.webp" alt="A grid." width="2688" height="1648" />',
    heroLosses,
  );
  checks.add('the hero is read out of the page source', hero?.src === '/home/hero.webp' && hero?.width === 2688, JSON.stringify(hero));

  const noHero: Loss[] = [];
  readHero('<p>no pictures here</p>', noHero);
  checks.add('a page with no hero is fatal', noHero.some((loss) => loss.fatal), JSON.stringify(noHero.map((l) => l.where)));

  const htmlInv = inventoryHtml(
    '<div class="intro"><p class="name">A Name</p><p>First para.</p><p>Second <em>italic</em> para.</p></div>',
  );
  checks.add(
    'the HTML inventory and the Doc inventory agree on a hand-written pair',
    JSON.stringify(htmlInv.blocks.slice(1)) === JSON.stringify(inv.blocks) && JSON.stringify(htmlInv.marks) === JSON.stringify(inv.marks),
    `${JSON.stringify(htmlInv.blocks)} vs ${JSON.stringify(inv.blocks)}`,
  );

  const cutTest = cutSubtrees('<main><div class="lightbox"><img src="/a.png"></div><p>keep</p></main>', [{ cls: 'lightbox' }]);
  checks.add('cutSubtrees removes the lightbox and nothing else', cutTest.cut === 1 && squash(inventoryHtml(cutTest.html).blocks[0]?.text ?? '') === 'keep' && inventoryHtml(cutTest.html).media.length === 0, cutTest.html);

  return checks.passed;
}

/* ========================================================================== */
/* main                                                                       */
/* ========================================================================== */

if (MODE.selftest) {
  finish('migrate-home --selftest', selftest());
}

const result = migrate();
if (MODE.verify) {
  if (!result.ok && MODE.check) finish('migrate-home --check', false);
  const ok = await verify(result.conversion);
  finish('migrate-home --verify', ok && result.ok);
}
finish(`migrate-home (${result.outcome})`, result.ok);
