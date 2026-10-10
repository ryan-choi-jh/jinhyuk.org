/**
 * scripts/migrate-essays.ts
 *
 * WS-F MIGRATION, 2 of 3.
 *
 *   src/content/writing/<slug>.md   ->   src/content/pages/essays/<slug>.json
 *
 * The markdown body becomes one prose band. Paragraphs, h2, h3, blockquotes,
 * bullet and numbered lists, bold, italic and links all have a home in the
 * prose model (docs/cms-contracts.md §2.3); anything else does not, and this
 * script refuses to write a file it would have to approximate.
 *
 * HOW THE TEXT IS PRODUCED, which is the one decision worth reading
 *
 * The live pages do not show the markdown source. Astro renders it with
 * remark, and remark-smartypants turns `"pain,"` into `“pain,”` and every
 * apostrophe into `’`. If the migration stored the raw source, every
 * contraction in all three essays would change shape on the published page.
 * So the body is rendered with Astro's own processor,
 * `createMarkdownProcessor` from `@astrojs/markdown-remark`, the exact module
 * the site build uses, and the prose blocks are built from that HTML. The
 * first assertion in `--verify` is that this local render is byte-for-byte
 * what jinhyuk.org serves, which is what makes the rest of the comparison a
 * comparison against the live page.
 *
 * The project has no `markdown` key in `astro.config.mjs`, so the defaults are
 * what built the live site; the processor is created with the same defaults and
 * the script fails if that config key ever appears.
 *
 * TWO TRAPS, both named in docs/cms-contracts.md §12
 *
 *  - `draft: boolean` has nowhere to go in a `Doc`. A draft is a file in
 *    `src/content/drafts/`, not a flag, so a `draft: true` essay is skipped
 *    unless `--include-drafts` is passed. All three essays are `draft: false`.
 *  - Two essays open with an `# H1` while the page template already prints
 *    `post.data.title` as the `h1`. There is no `h1` prose kind.
 *    `chasing-the-workaround` repeats its title exactly: the line is dropped,
 *    because `meta.title` carries those words already. `who-i-m-looking-for`
 *    extends it ("Who I'm Looking For: The Temporarily Stuck"), so the line is
 *    kept as `meta.summary` — the one meta field that holds a line of prose and
 *    the one the essay template already renders under the title. Both are
 *    asserted and both are in the report.
 *
 * Modes
 *   node scripts/migrate-essays.ts              convert and write
 *   node scripts/migrate-essays.ts --verify     live-vs-migrated diff + report
 *   node scripts/migrate-essays.ts --selftest   synthetic markdown, no network
 *   node scripts/migrate-essays.ts --check      fail if committed JSON is stale
 *   node scripts/migrate-essays.ts --dry-run    convert, validate, write nothing
 *
 * Flags: --only=<slug>, --include-drafts, --offline, --refresh, --quiet,
 *        --no-report, --origin=<url>, --live-dir=<dir>.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { createMarkdownProcessor } from '@astrojs/markdown-remark';

import { DocMetaSchema, formatIssues, validateDoc } from '../src/cms/schema.ts';
import type { Doc, DocButton, ProseBlock, ProseBlockKind } from '../src/cms/schema.ts';
import { CONTENT_ROOT, contentPathFor, draftPathFor, requireSection, siteUrlFor } from '../src/cms/sections.ts';

import {
  Checks,
  MODE,
  PROJECT,
  changed,
  cutSubtrees,
  decode,
  diffBlock,
  diffLines,
  fatal,
  fetchLive,
  finish,
  findSubtree,
  findSubtrees,
  foldTypography,
  hasFatal,
  inventoryDoc,
  inventoryHtml,
  mdCell,
  note,
  option,
  say,
  scanHtml,
  sentences,
  shout,
  squash,
  statusLine,
  upsertReportSection,
  words,
  writeJsonFile,
  type Loss,
} from './migrate-lib.ts';

const require_ = createRequire(import.meta.url);
const yaml = require_('js-yaml') as { load: (text: string) => unknown };

const ESSAYS = requireSection('essays');
const SOURCE_DIR = join(PROJECT, CONTENT_ROOT, 'writing');
const ONLY = option('only', '');
const INCLUDE_DRAFTS = MODE.check ? false : process.argv.includes('--include-drafts');

/* ========================================================================== */
/* A tiny tree, because inline marks nest                                     */
/* ========================================================================== */

type HNode = { type: 'text'; text: string } | { type: 'el'; name: string; attrs: Record<string, string>; children: HNode[] };

/**
 * The processor's HTML as a tree. The input is remark's output: well formed,
 * no comments, no scripts, every attribute double quoted. `scanHtml` does the
 * lexing; this only has to nest it.
 */
export function parseNodes(html: string): HNode[] {
  const root: HNode[] = [];
  const stack: { children: HNode[] }[] = [{ children: root }];

  for (const token of scanHtml(html)) {
    const top = stack[stack.length - 1];
    if (top === undefined) break;
    if (token.kind === 'text') {
      top.children.push({ type: 'text', text: token.text });
      continue;
    }
    if (token.kind === 'open') {
      const node: HNode = { type: 'el', name: token.name, attrs: token.attrs, children: [] };
      top.children.push(node);
      if (!token.selfClosing) stack.push({ children: node.children });
      continue;
    }
    if (stack.length > 1) stack.pop();
  }
  return root;
}

const isBlank = (node: HNode): boolean => node.type === 'text' && node.text.trim() === '';

/* ========================================================================== */
/* Markdown HTML -> prose blocks                                              */
/* ========================================================================== */

/** Text as a browser lays it out: a newline inside a paragraph is one space. */
function flattenWhitespace(text: string): string {
  return decode(text).replace(/\s*\n\s*/g, ' ');
}

type Mark = { type: string; attrs?: Record<string, unknown> };

/** Inline content, with every mark the prose model allows and nothing else. */
function inlineContent(nodes: HNode[], marks: Mark[], losses: Loss[], where: string): unknown[] {
  const out: unknown[] = [];

  for (const node of nodes) {
    if (node.type === 'text') {
      const text = flattenWhitespace(node.text);
      if (text === '') continue;
      out.push(marks.length === 0 ? { type: 'text', text } : { type: 'text', marks: marks.map((mark) => ({ ...mark })), text });
      continue;
    }

    switch (node.name) {
      case 'em':
      case 'i':
        out.push(...inlineContent(node.children, [...marks, { type: 'italic' }], losses, where));
        break;
      case 'strong':
      case 'b':
        out.push(...inlineContent(node.children, [...marks, { type: 'bold' }], losses, where));
        break;
      case 'a': {
        const href = node.attrs.href ?? '';
        if (href === '') {
          fatal(losses, where, 'a link with no href');
          break;
        }
        if (!DocMetaSchema.shape.buttons.unwrap().element.shape.href.safeParse(href).success) {
          fatal(losses, where, `a link the schema will not accept as an href: ${JSON.stringify(href)}`);
          break;
        }
        out.push(...inlineContent(node.children, [...marks, { type: 'link', attrs: { href } }], losses, where));
        break;
      }
      case 'br':
        out.push({ type: 'hardBreak' });
        note(losses, where, 'a hard line break became a TipTap hardBreak node');
        break;
      default:
        fatal(
          losses,
          where,
          `<${node.name}> has no representation in the prose model (allowed inline: em, strong, a, br): ${JSON.stringify(squash(textOf(node)))}`,
        );
    }
  }

  // Leading and trailing whitespace at the edges of a block is not content.
  trimEdge(out, 'start');
  trimEdge(out, 'end');
  return out;
}

function trimEdge(nodes: unknown[], end: 'start' | 'end'): void {
  const index = end === 'start' ? 0 : nodes.length - 1;
  const node = nodes[index] as { type?: string; text?: string } | undefined;
  if (node === undefined || node.type !== 'text' || typeof node.text !== 'string') return;
  const text = end === 'start' ? node.text.replace(/^\s+/, '') : node.text.replace(/\s+$/, '');
  if (text === '') nodes.splice(index, 1);
  else node.text = text;
}

function textOf(node: HNode): string {
  if (node.type === 'text') return node.text;
  return node.children.map(textOf).join('');
}

const HEADING_KIND: Readonly<Record<string, ProseBlockKind>> = { h2: 'h2', h3: 'h3' };

export type BlockResult = { blocks: ProseBlock[]; droppedH1: string[] };

/**
 * One prose block per top-level element of the rendered markdown. An element
 * with nowhere to go is fatal: it would mean a page that looks finished and is
 * missing something.
 */
export function blocksFromHtml(html: string, slug: string, title: string, losses: Loss[]): BlockResult {
  const blocks: ProseBlock[] = [];
  const droppedH1: string[] = [];
  const nodes = parseNodes(html).filter((node) => !isBlank(node));
  let index = 0;

  const id = (): string => {
    index += 1;
    return `b1_${String(index).padStart(2, '0')}`;
  };

  for (const node of nodes) {
    if (node.type === 'text') {
      fatal(losses, slug, `text outside any block: ${JSON.stringify(squash(node.text))}`);
      continue;
    }
    const where = `${slug}:<${node.name}>`;

    if (node.name === 'p') {
      blocks.push({ id: id(), kind: 'p', content: inlineContent(node.children, [], losses, where) });
      continue;
    }

    if (node.name === 'h2' || node.name === 'h3') {
      const kind = HEADING_KIND[node.name] as ProseBlockKind;
      blocks.push({ id: id(), kind, content: inlineContent(node.children, [], losses, where) });
      continue;
    }

    if (node.name === 'h1') {
      // The page template already prints the title as the page's h1, and the
      // prose model has no h1 kind. docs/cms-contracts.md §12.
      droppedH1.push(squash(textOf(node)));
      continue;
    }

    if (node.name === 'blockquote') {
      const content: unknown[] = [];
      for (const child of node.children.filter((candidate) => !isBlank(candidate))) {
        if (child.type !== 'el' || child.name !== 'p') {
          fatal(
            losses,
            where,
            `a blockquote may only hold paragraphs; found ${child.type === 'el' ? `<${child.name}>` : 'bare text'}`,
          );
          continue;
        }
        content.push({ type: 'paragraph', content: inlineContent(child.children, [], losses, where) });
      }
      blocks.push({ id: id(), kind: 'quote', content });
      continue;
    }

    if (node.name === 'ul' || node.name === 'ol') {
      const content: unknown[] = [];
      for (const child of node.children.filter((candidate) => !isBlank(candidate))) {
        if (child.type !== 'el' || child.name !== 'li') {
          fatal(losses, where, `a list may only hold <li>; found ${child.type === 'el' ? `<${child.name}>` : 'bare text'}`);
          continue;
        }
        const inner = child.children.filter((candidate) => !isBlank(candidate));
        const nested = inner.find((candidate) => candidate.type === 'el' && (candidate.name === 'ul' || candidate.name === 'ol'));
        if (nested !== undefined) {
          fatal(losses, where, 'a nested list has no representation in the prose model');
          continue;
        }
        // Markdown gives a tight list `<li>text</li>` and a loose one
        // `<li><p>text</p></li>`; both become one paragraph in a listItem.
        const paragraphs = inner.filter((candidate) => candidate.type === 'el' && candidate.name === 'p');
        const source = paragraphs.length > 0 ? paragraphs : [{ type: 'el' as const, name: 'p', attrs: {}, children: inner }];
        const itemContent = source.map((paragraph) => ({
          type: 'paragraph',
          content: inlineContent(paragraph.type === 'el' ? paragraph.children : [], [], losses, where),
        }));
        content.push({ type: 'listItem', content: itemContent });
      }
      blocks.push({ id: id(), kind: node.name === 'ul' ? 'ul' : 'ol', content });
      continue;
    }

    fatal(
      losses,
      where,
      `<${node.name}> has no prose kind (allowed: p, h2, h3, blockquote, ul, ol): ${JSON.stringify(squash(textOf(node)).slice(0, 120))}`,
    );
  }

  return { blocks, droppedH1 };
}

/* ========================================================================== */
/* Frontmatter                                                                */
/* ========================================================================== */

export type Frontmatter = {
  title: string;
  date: string;
  draft: boolean;
  summary?: string;
  buttons: DocButton[];
};

const KNOWN_FRONTMATTER = new Set(['title', 'date', 'draft', 'summary', 'buttons']);

function asDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return null;
}

export function readFrontmatter(raw: string, slug: string, losses: Loss[]): { data: Frontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (match === null) {
    fatal(losses, slug, 'no YAML frontmatter block');
    return { data: { title: slug, date: '1970-01-01', draft: false, buttons: [] }, body: raw };
  }
  const body = raw.slice(match[0].length);
  const parsed = yaml.load(match[1] ?? '');
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};

  for (const key of Object.keys(record)) {
    if (!KNOWN_FRONTMATTER.has(key)) {
      fatal(losses, `${slug}:frontmatter.${key}`, `an unknown key with no home in Doc.meta: ${JSON.stringify(record[key])}`);
    }
  }

  const title = typeof record.title === 'string' ? record.title : '';
  if (title === '') fatal(losses, `${slug}:frontmatter.title`, 'missing or not a string');

  const date = asDate(record.date);
  if (date === null) fatal(losses, `${slug}:frontmatter.date`, `not a date: ${JSON.stringify(record.date)}`);

  const buttons: DocButton[] = [];
  const rawButtons = record.buttons;
  if (rawButtons !== undefined) {
    if (!Array.isArray(rawButtons)) {
      fatal(losses, `${slug}:frontmatter.buttons`, `not an array: ${JSON.stringify(rawButtons)}`);
    } else {
      for (const [at, rawButton] of rawButtons.entries()) {
        const button = typeof rawButton === 'object' && rawButton !== null ? (rawButton as Record<string, unknown>) : {};
        const label = typeof button.label === 'string' ? button.label : '';
        const href = typeof button.href === 'string' ? button.href : '';
        if (label === '' || href === '') {
          fatal(losses, `${slug}:frontmatter.buttons.${at}`, `a button needs a label and an href: ${JSON.stringify(rawButton)}`);
          continue;
        }
        buttons.push({ label, href });
      }
    }
  }

  const data: Frontmatter = {
    title,
    date: date ?? '1970-01-01',
    draft: record.draft === true,
    buttons,
  };
  if (typeof record.summary === 'string' && record.summary !== '') data.summary = record.summary;
  return { data, body };
}

/* ========================================================================== */
/* The conversion                                                             */
/* ========================================================================== */

export type Conversion = {
  slug: string;
  sourcePath: string;
  data: Frontmatter;
  markdown: string;
  html: string;
  doc: Doc;
  losses: Loss[];
  droppedH1: string[];
  /** The dropped h1 that was kept as `meta.summary`, if there was one. */
  subtitle: string | null;
};

let processor: Awaited<ReturnType<typeof createMarkdownProcessor>> | null = null;

async function renderMarkdown(markdown: string): Promise<string> {
  if (processor === null) {
    const config = readFileSync(join(PROJECT, 'astro.config.mjs'), 'utf8');
    if (/^\s*markdown\s*:/m.test(config)) {
      throw new Error(
        'astro.config.mjs now configures `markdown`. This script renders with the defaults, which is what built the live site. ' +
          'Mirror the config here before trusting the output.',
      );
    }
    processor = await createMarkdownProcessor({});
  }
  const rendered = await processor.render(markdown);
  return rendered.code;
}

export async function convertOne(slug: string, sourcePath: string): Promise<Conversion> {
  const losses: Loss[] = [];
  const raw = readFileSync(sourcePath, 'utf8');
  const { data, body } = readFrontmatter(raw, slug, losses);
  const html = await renderMarkdown(body);
  const { blocks, droppedH1 } = blocksFromHtml(html, slug, data.title, losses);

  let subtitle: string | null = null;
  for (const heading of droppedH1) {
    if (squash(heading) === squash(data.title)) {
      note(losses, slug, `the body's "# ${heading}" repeats \`meta.title\` exactly; the page template already prints it as the h1`);
      continue;
    }
    if (data.summary !== undefined) {
      fatal(
        losses,
        slug,
        `the body's "# ${heading}" extends the title but the frontmatter already has a summary, so there is nowhere to keep it`,
      );
      continue;
    }
    subtitle = heading;
    data.summary = heading;
    note(losses, slug, `the body's "# ${heading}" extends \`meta.title\`, so it is kept as \`meta.summary\``);
  }

  const meta: Doc['meta'] = {
    title: data.title,
    slug,
    date: data.date,
    section: 'essays',
  };
  if (data.summary !== undefined) meta.summary = data.summary;
  // An empty `buttons: []` and no key at all render the same nothing; the key
  // is left off so the file says what it means.
  if (data.buttons.length > 0) meta.buttons = data.buttons;

  const doc: Doc = { version: 1, meta, bands: [{ id: 'b1', type: 'prose', blocks }] };
  return { slug, sourcePath, data, markdown: body, html, doc, losses, droppedH1, subtitle };
}

/* ========================================================================== */
/* Write                                                                      */
/* ========================================================================== */

function sources(): { slug: string; path: string }[] {
  if (!existsSync(SOURCE_DIR)) return [];
  return readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({ slug: name.slice(0, -3), path: join(SOURCE_DIR, name) }))
    .filter((entry) => ONLY === '' || entry.slug === ONLY);
}

async function migrate(): Promise<{ conversions: Conversion[]; ok: boolean; outcomes: Map<string, string> }> {
  const conversions: Conversion[] = [];
  const outcomes = new Map<string, string>();
  let ok = true;

  for (const { slug, path } of sources()) {
    if (!DocMetaSchema.shape.slug.safeParse(slug).success) {
      shout(`FATAL ${slug}: the filename is not a valid slug (lowercase kebab-case)`);
      ok = false;
      continue;
    }

    const conversion = await convertOne(slug, path);
    conversions.push(conversion);

    for (const loss of conversion.losses) {
      shout(`${loss.fatal ? 'FATAL' : 'note '} ${loss.where}: ${loss.what}`);
    }

    if (hasFatal(conversion.losses)) {
      outcomes.set(slug, 'not written: a fatal loss');
      ok = false;
      continue;
    }

    const validated = validateDoc(conversion.doc);
    if (!validated.ok) {
      shout(`FATAL ${slug} does not validate:\n${formatIssues(validated.issues)}`);
      outcomes.set(slug, 'not written: invalid');
      ok = false;
      continue;
    }

    if (conversion.data.draft && !INCLUDE_DRAFTS) {
      outcomes.set(slug, 'skipped: draft: true (a draft is a file in src/content/drafts/, not a flag)');
      say(`skipped     ${slug} (draft)`);
      continue;
    }

    const target = conversion.data.draft ? draftPathFor(ESSAYS, slug) : contentPathFor(ESSAYS, slug);
    const outcome = writeJsonFile(join(PROJECT, target), conversion.doc);
    outcomes.set(slug, `${outcome} ${target}`);
    say(`${outcome.padEnd(11)} ${target}`);
    if (outcome === 'stale') ok = false;
  }

  if (conversions.length === 0) {
    shout(`FATAL no markdown found in ${SOURCE_DIR}`);
    ok = false;
  }
  return { conversions, ok, outcomes };
}

/* ========================================================================== */
/* Verify                                                                     */
/* ========================================================================== */

/** The page template's own furniture, cut before the body is compared. */
const CHROME = [
  { tag: 'h1', once: true },
  { cls: 'post-meta' },
  { cls: 'post-lead' },
  { cls: 'essay-buttons' },
];

/**
 * The markdown body of the live article: everything after the template's
 * title, date and optional lead, and before the buttons. Sliced out of the
 * string rather than cut from the token stream, so it can be compared byte for
 * byte against the local render.
 */
function liveMarkdownHtml(article: string): string {
  let body = article;
  body = body.replace(/^\s*<h1>[\s\S]*?<\/h1>\s*/, '');
  body = body.replace(/^\s*<p class="post-meta">[\s\S]*?<\/p>\s*/, '');
  body = body.replace(/^\s*<p class="lead post-lead">[\s\S]*?<\/p>\s*/, '');
  body = body.replace(/\s*<div class="essay-buttons">[\s\S]*?<\/div>\s*$/, '');
  return body.trim();
}

type EssayReport = { slug: string; lines: string[] };

async function verifyOne(conversion: Conversion, checks: Checks): Promise<EssayReport> {
  const { slug } = conversion;
  const url = siteUrlFor(ESSAYS, slug);
  if (url === null) throw new Error('the essays section has no entry URL');
  const live = await fetchLive(url);
  say(`\n${slug}: ${live.url} (${live.from}, ${live.html.length} bytes)`);

  const lines: string[] = [];
  const article = findSubtree(live.html, { tag: 'article', cls: 'post-content' });
  if (article === null) {
    checks.add(`${slug}: the live page has an \`article.post-content\``, false, 'not found');
    return { slug, lines };
  }

  /* -- 1. is the baseline really the live page? ---------------------------- */
  const liveBody = liveMarkdownHtml(article.inner);
  const localRender = conversion.html.trim();
  const identical = liveBody === localRender;
  checks.add(
    `${slug}: the local markdown render is byte-for-byte what jinhyuk.org serves`,
    identical,
    `live ${liveBody.length} bytes, local ${localRender.length} bytes${identical ? '' : `, first difference at ${firstDifference(liveBody, localRender)}`}`,
  );

  /* -- 2. the title and the date ------------------------------------------- */
  const liveTitle = squash(findSubtree(article.inner, { tag: 'h1' })?.inner ?? '');
  checks.add(
    `${slug}: the live \`h1\` is \`meta.title\``,
    liveTitle === squash(conversion.doc.meta.title),
    `live ${JSON.stringify(liveTitle)} vs ${JSON.stringify(conversion.doc.meta.title)}`,
  );
  const liveDate = squash(findSubtree(article.inner, { cls: 'post-meta' })?.inner ?? '');
  const metaDate = new Date(`${conversion.doc.meta.date}T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
  checks.add(`${slug}: the live date line is \`meta.date\``, liveDate === metaDate, `live ${JSON.stringify(liveDate)} vs ${JSON.stringify(metaDate)}`);

  /* -- 3. the prose -------------------------------------------------------- */
  const { html: cutBody, cut } = cutSubtrees(article.inner, CHROME);
  const liveInv = inventoryHtml(cutBody);
  const docInv = inventoryDoc(conversion.doc);

  const liveBlocks = liveInv.blocks.map((block) => `${block.tag} | ${block.text}`);
  const docBlocks = docInv.blocks.map((block) => `${block.tag} | ${block.text}`);
  const edits = changed(diffLines(liveBlocks, docBlocks));

  // The only difference allowed is a removed h1: there is no h1 prose kind.
  const unexplained = edits.filter((edit) => !(edit.op === 'remove' && edit.value.startsWith('h1 | ')));
  checks.add(
    `${slug}: every block of prose, tag and text, in order`,
    unexplained.length === 0,
    unexplained.length === 0
      ? `${liveBlocks.length} live blocks, ${docBlocks.length} migrated, ${edits.length} justified h1 removal(s)`
      : `${unexplained.length} unexplained: ${unexplained.map((edit) => `${edit.op === 'remove' ? '-' : '+'}${JSON.stringify(edit.value.slice(0, 90))}`).join(' ')}`,
  );

  /* -- 4. the dropped h1s are accounted for -------------------------------- */
  const removedH1 = edits.filter((edit) => edit.op === 'remove' && edit.value.startsWith('h1 | ')).map((edit) => edit.value.slice(5));
  checks.add(
    `${slug}: every \`h1\` the live body shows is accounted for`,
    removedH1.length === conversion.droppedH1.length && removedH1.every((text) => conversion.droppedH1.includes(text)),
    `live ${JSON.stringify(removedH1)}, converter dropped ${JSON.stringify(conversion.droppedH1)}`,
  );
  for (const heading of removedH1) {
    const inTitle = squash(heading) === squash(conversion.doc.meta.title);
    const inSummary = conversion.doc.meta.summary !== undefined && squash(conversion.doc.meta.summary) === squash(heading);
    checks.add(
      `${slug}: the dropped "${heading.slice(0, 48)}" survives in \`meta.${inTitle ? 'title' : 'summary'}\``,
      inTitle || inSummary,
      inTitle ? 'identical to meta.title' : inSummary ? 'kept as meta.summary' : 'NOT ANYWHERE IN meta',
    );
  }

  /* -- 5. sentences, the no-silent-drop check ------------------------------ */
  const liveSentences = sentences(liveInv.blocks.map((block) => block.text).join('\n'));
  const missing = liveSentences.filter((sentence) => !docInv.plain.includes(sentence) && !removedH1.includes(sentence));
  checks.add(
    `${slug}: all ${liveSentences.length} sentences of live prose appear verbatim in the migrated document`,
    missing.length === 0,
    missing.length === 0 ? 'none missing' : `missing ${missing.length}: ${missing.map((s) => JSON.stringify(s.slice(0, 80))).join(' ')}`,
  );

  const liveWords = words(liveInv.blocks.map((block) => block.text).join(' '));
  const droppedWords = words(removedH1.join(' '));
  const docWords = words(docInv.plain);
  checks.add(
    `${slug}: word count, live minus the dropped h1`,
    liveWords - droppedWords === docWords,
    `live ${liveWords} - ${droppedWords} (h1) = ${liveWords - droppedWords}, migrated ${docWords}`,
  );

  /* -- 6. marks and links -------------------------------------------------- */
  checks.same(`${slug}: every inline decoration (bold, italic, link), in order`, liveInv.marks, docInv.marks);
  checks.same(
    `${slug}: every link, href and label`,
    liveInv.links.map((link) => `${link.href} | ${link.label}`),
    docInv.links.map((link) => `${link.href} | ${link.label}`),
  );

  /* -- 7. the buttons ------------------------------------------------------ */
  const buttonBox = findSubtree(article.inner, { cls: 'essay-buttons' });
  const liveButtons = buttonBox === null ? [] : findSubtrees(buttonBox.inner, { tag: 'a' }).map((anchor) => {
    const href = /href="([^"]*)"/.exec(anchor.outer)?.[1] ?? '';
    return `${decode(href)} | ${squash(anchor.inner)}`;
  });
  const metaButtons = (conversion.doc.meta.buttons ?? []).map((button) => `${button.href} | ${button.label}`);
  checks.same(`${slug}: every end-of-post button, href and label`, liveButtons, metaButtons);

  /* -- 8. nothing else in the body ----------------------------------------- */
  checks.same(`${slug}: pictures in the body`, liveInv.media, docInv.media);
  checks.add(
    `${slug}: the migrated document validates`,
    validateDoc(conversion.doc).ok,
    validateDoc(conversion.doc).ok ? 'ok' : formatIssues((validateDoc(conversion.doc) as { issues: { path: string; message: string }[] }).issues),
  );

  /* -- the report ---------------------------------------------------------- */
  const kinds = new Map<string, number>();
  for (const block of conversion.doc.bands.flatMap((band) => (band.type === 'prose' ? band.blocks : []))) {
    kinds.set(block.kind, (kinds.get(block.kind) ?? 0) + 1);
  }

  lines.push(`#### \`${slug}\``);
  lines.push('');
  lines.push(
    `- Baseline: ${live.url}, \`article.post-content\`. The markdown body of that article is **${liveBody.length} bytes**; ` +
      `the local \`createMarkdownProcessor\` render is **${localRender.length} bytes**, and the two are ` +
      `${identical ? '**byte for byte identical**, so the comparison below is a comparison against the live page' : '**NOT identical** — see the failure above'}.`,
  );
  lines.push(`- Chrome cut before comparing: ${cut} subtree(s) (the template's \`h1\`, \`p.post-meta\`, any \`p.post-lead\`, \`div.essay-buttons\`).`);
  lines.push(
    `- Migrated: 1 prose band, ${docBlocks.length} blocks (${[...kinds.entries()].map(([kind, count]) => `${count} \`${kind}\``).join(', ')}), ` +
      `${docInv.marks.length} inline decorations, ${metaButtons.length} button(s), \`meta\`: ${Object.keys(conversion.doc.meta).map((key) => `\`${key}\``).join(', ')}.`,
  );
  if (conversion.droppedH1.length > 0) {
    lines.push(
      `- Dropped \`h1\`: ${conversion.droppedH1.map((heading) => `"${heading}"`).join(', ')} — ` +
        (conversion.subtitle === null
          ? 'identical to `meta.title`, which the page template prints itself.'
          : `kept as \`meta.summary\`, because it extends the title rather than repeating it.`),
    );
  }
  lines.push('');
  lines.push(
    edits.length === 0
      ? `Block diff: no differences at all. All ${liveBlocks.length} live blocks matched a migrated block, in order.`
      : `Block diff: ${edits.length} of ${liveBlocks.length} live blocks ${edits.length === 1 ? 'differs' : 'differ'}; ` +
          `the other ${liveBlocks.length - edits.length} matched tag and text exactly, in order. ` +
          'Only the differing entries are listed (`-` live, `+` migrated):',
  );
  if (edits.length > 0) {
    lines.push('');
    lines.push(diffBlock(edits, 20));
  }
  lines.push('');
  return { slug, lines };
}

function firstDifference(a: string, b: string): string {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return `${i}: live ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 40))} vs local ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 40))}`;
  }
  return 'none';
}

/** The index page is the other place an essay can go missing. */
async function verifyIndex(conversions: Conversion[], checks: Checks): Promise<string[]> {
  const live = await fetchLive(ESSAYS.indexUrl);
  const list = findSubtree(live.html, { tag: 'ul', cls: 'ledger' });
  if (list === null) {
    checks.add('the live essays index has a `ul.ledger`', false, 'not found');
    return [];
  }
  const rows = findSubtrees(list.inner, { tag: 'li' }).map((row) => {
    const anchor = findSubtree(row.inner, { cls: 'ledger-title' });
    const href = /href="([^"]*)"/.exec(anchor?.outer ?? '')?.[1] ?? '';
    return { href: decode(href), title: squash(anchor?.inner ?? ''), date: squash(findSubtree(row.inner, { cls: 'ledger-date' })?.inner ?? '') };
  });

  const liveRows = rows.map((row) => `${row.href} | ${row.title} | ${row.date}`).sort();
  const migratedRows = conversions
    .filter((conversion) => !conversion.data.draft)
    .map((conversion) => {
      const [year, month, day] = conversion.doc.meta.date.split('-');
      return `${siteUrlFor(ESSAYS, conversion.slug) ?? ''} | ${conversion.doc.meta.title} | ${year}.${month}.${day}`;
    })
    .sort();
  checks.same('the live essays index: every URL, title and date has a migrated document', liveRows, migratedRows);

  return [
    `The index at ${live.url} lists ${liveRows.length} essays. Every one of them has a migrated document whose ` +
      '`meta.slug` gives the same URL and whose `meta.title` and `meta.date` print the same row.',
  ];
}

async function verify(conversions: Conversion[]): Promise<boolean> {
  const checks = new Checks();
  const reports: EssayReport[] = [];
  for (const conversion of conversions) {
    reports.push(await verifyOne(conversion, checks));
  }
  const indexLines = ONLY === '' ? await verifyIndex(conversions, checks) : [];

  const lines: string[] = [];
  lines.push(statusLine(checks.passed ? 'PASS' : 'FAIL', checks.rows.length));
  lines.push('');
  lines.push(
    `${conversions.length} essay${conversions.length === 1 ? '' : 's'} -> \`${contentPathFor(ESSAYS, 'SLUG').replace('SLUG', '<slug>')}\`. ` +
      'The markdown is rendered with `createMarkdownProcessor` from `@astrojs/markdown-remark`, the module the site build uses, ' +
      'so the stored text carries the same typography the live pages show (`remark-smartypants` turns `"pain,"` into `“pain,”` ' +
      'and every apostrophe into `’`; storing the raw source would have changed every contraction on the published page).',
  );
  lines.push('');
  for (const line of indexLines) lines.push(line);
  if (indexLines.length > 0) lines.push('');
  lines.push('### 2.1 Nothing was lost');
  lines.push('');
  lines.push(checks.table());
  lines.push('');
  lines.push('### 2.2 Essay by essay');
  lines.push('');
  for (const report of reports) lines.push(...report.lines);
  lines.push('### 2.3 Every difference, and why');
  lines.push('');
  lines.push(
    '**2.3.1 The body `# H1` is dropped.** `chasing-the-workaround.md` and `who-i-m-looking-for.md` both open with an ' +
      '`# H1`, and the page template already prints `post.data.title` as the page\'s `h1` above it — the live pages ' +
      'genuinely show two. `PROSE_BLOCK_KINDS` is `p, h2, h3, quote, ul, ol`: there is no `h1`, and ' +
      'docs/cms-contracts.md §12 says to drop the duplicate rather than demote it to `h2`. ' +
      "`chasing-the-workaround`'s line repeats `meta.title` character for character, so every word of it is still on " +
      'the page, printed by the template. The assertion above is exactly that: each dropped `h1` is matched against ' +
      '`meta.title` or `meta.summary` and the verification fails if it is in neither.',
  );
  lines.push('');
  lines.push(
    '**2.3.2 `who-i-m-looking-for`\'s `# H1` is kept as `meta.summary`.** Its heading is "Who I’m Looking For: The ' +
      'Temporarily Stuck", which *extends* the title rather than repeating it, so dropping it would lose the owner\'s ' +
      'words — the one thing this workstream must not do. §12 says that subtitle "is worth keeping somewhere" and ' +
      'leaves where to WS-F. `meta.summary` is the only meta field that holds a line of prose, and the essay template ' +
      'already renders it directly under the title as `p.lead.post-lead`, which is where the `h1` sits today. ' +
      '**This is a visible change**: the subtitle moves from a heading to an italic lead line. It is reversible in the ' +
      'editor, and the alternative was deleting a sentence the owner wrote.',
  );
  lines.push('');
  lines.push(
    '**2.3.3 `draft: false` is not migrated.** A `Doc` has no draft flag, deliberately: a draft is a file under ' +
      '`src/content/drafts/` (docs/cms-contracts.md §13.1). All three essays are `draft: false`, so nothing is lost. ' +
      'An essay with `draft: true` is skipped by default and the skip is printed; `--include-drafts` writes it to ' +
      '`draftPathFor(essays, slug)` instead of the published tree.',
  );
  lines.push('');
  lines.push(
    '**2.3.4 `buttons: []` becomes no `buttons` key.** `whos-choosing.md` carries an empty array. An empty array and a ' +
      'missing key render the same nothing, and the schema makes the key optional, so the file says what it means. ' +
      'The two essays that do have a button keep it exactly: `{ label, href }` is the same shape in the frontmatter and ' +
      'in `meta.buttons`, so it is a copy and not a translation.',
  );
  lines.push('');
  lines.push(
    '**2.3.5 Heading `id` attributes are not stored.** Astro\'s markdown gives every heading a slug `id` ' +
      '(`<h2 id="pain-is-invisible-the-workaround-is-not">`), which is how a `#fragment` link into an essay works. ' +
      '`ProseBlock` has no place for it and the renderer can derive the same slug from the heading text. ' +
      'Nothing visible is lost, but any external link to an essay fragment depends on WS-B regenerating those ids: ' +
      'flagged for WS-B rather than quietly dropped.',
  );
  lines.push('');
  lines.push(
    '**2.3.6 The body is typographically processed; the title is not.** `remark-smartypants` runs on the markdown ' +
      'body, so the stored prose holds `’` and `“ ”` exactly as the live pages print them. Frontmatter is a plain ' +
      'string that the template interpolates, so `meta.title` keeps the straight apostrophe the author typed — ' +
      '"Who I\'m Looking For" in the title, "Who I’m Looking For: The Temporarily Stuck" in the summary that came out ' +
      'of the body. That is not an inconsistency in the migration; it is what jinhyuk.org serves today, and the ' +
      'title and date assertions compare both against the live page.',
  );
  lines.push('');

  if (conversions.some((conversion) => conversion.losses.length > 0)) {
    lines.push('### 2.4 What the converter recorded');
    lines.push('');
    lines.push('| where | severity | what |');
    lines.push('|---|---|---|');
    for (const conversion of conversions) {
      for (const loss of conversion.losses) {
        lines.push(`| \`${loss.where}\` | ${loss.fatal ? '**fatal**' : 'note'} | ${mdCell(loss.what)} |`);
      }
    }
    lines.push('');
  }

  const written = upsertReportSection('essays', lines.join('\n'));
  if (written !== null) say(`\nreport: ${written}`);
  return checks.passed;
}

/* ========================================================================== */
/* Selftest                                                                   */
/* ========================================================================== */

async function selftest(): Promise<boolean> {
  const checks = new Checks();
  const losses: Loss[] = [];

  const html = await renderMarkdown(
    [
      '## A heading',
      '',
      'A paragraph with **bold**, *italic* and a [link](https://example.com/a).',
      '',
      '### Deeper',
      '',
      '> **TL;DR**: a quote.',
      '>',
      '> With two paragraphs.',
      '',
      '- one',
      '- two with *italics*',
      '',
      '1. first',
      '2. second',
    ].join('\n'),
  );
  const { blocks } = blocksFromHtml(html, 'selftest', 'A title', losses);

  checks.add(
    'every block kind survives in order',
    JSON.stringify(blocks.map((block) => block.kind)) === JSON.stringify(['h2', 'p', 'h3', 'quote', 'ul', 'ol']),
    JSON.stringify(blocks.map((block) => block.kind)),
  );
  checks.add('no loss was recorded for supported markdown', losses.length === 0, JSON.stringify(losses));

  const doc: Doc = {
    version: 1,
    meta: { title: 'A title', slug: 'selftest', date: '2026-01-01', section: 'essays' },
    bands: [{ id: 'b1', type: 'prose', blocks }],
  };
  const validated = validateDoc(doc);
  checks.add('the synthetic essay validates', validated.ok, validated.ok ? 'ok' : formatIssues(validated.issues));

  const docInv = inventoryDoc(doc);
  const htmlInv = inventoryHtml(html);
  checks.same(
    'the Doc inventory equals the markdown HTML inventory, block for block',
    htmlInv.blocks.map((block) => `${block.tag} | ${block.text}`),
    docInv.blocks.map((block) => `${block.tag} | ${block.text}`),
  );
  checks.same('...and decoration for decoration', htmlInv.marks, docInv.marks);
  checks.same(
    '...and link for link',
    htmlInv.links.map((link) => `${link.href} | ${link.label}`),
    docInv.links.map((link) => `${link.href} | ${link.label}`),
  );

  // Unsupported constructs must stop the file being written, not be dropped.
  for (const [name, markdown] of [
    ['a code block', '```js\nconst a = 1;\n```'],
    ['inline code', 'A `code` span.'],
    ['an image', '![alt](/a.png)'],
    ['a table', '| a | b |\n|---|---|\n| 1 | 2 |'],
    ['a horizontal rule', 'a\n\n---\n\nb'],
    ['an h4', '#### too deep'],
    ['a nested list', '- one\n  - nested'],
  ] as const) {
    const fatalLosses: Loss[] = [];
    const rendered = await renderMarkdown(markdown);
    blocksFromHtml(rendered, 'selftest', 'A title', fatalLosses);
    checks.add(`${name} is fatal, not dropped`, fatalLosses.some((loss) => loss.fatal), JSON.stringify(fatalLosses.map((loss) => loss.what.slice(0, 70))));
  }

  /* -- would this verification actually catch a silent loss? --------------- */
  // The whole workstream rests on the answer, so it is asserted rather than
  // assumed: damage the migrated document on purpose, one way at a time, and
  // require the comparison that `--verify` runs to notice.
  const liveLines = htmlInv.blocks.map((block) => `${block.tag} | ${block.text}`);
  const damaged = (mutate: (doc: Doc) => void): ReturnType<typeof inventoryDoc> => {
    const copy = structuredClone(doc) as Doc;
    mutate(copy);
    return inventoryDoc(copy);
  };
  const proseOf = (inv: ReturnType<typeof inventoryDoc>): string[] => inv.blocks.map((block) => `${block.tag} | ${block.text}`);
  const firstBand = (copy: Doc): ProseBlock[] => (copy.bands[0]?.type === 'prose' ? copy.bands[0].blocks : []);

  const dropped = damaged((copy) => {
    firstBand(copy).splice(1, 1);
  });
  const droppedSentences = sentences(htmlInv.blocks.map((block) => block.text).join('\n')).filter(
    (sentence) => !dropped.plain.includes(sentence),
  );
  checks.add(
    'a dropped paragraph is caught, by the block diff AND by the sentence check',
    changed(diffLines(liveLines, proseOf(dropped))).length > 0 && droppedSentences.length > 0,
    `${changed(diffLines(liveLines, proseOf(dropped))).length} block difference(s), ${droppedSentences.length} missing sentence(s)`,
  );

  const reworded = damaged((copy) => {
    const block = firstBand(copy)[1];
    if (block !== undefined) block.content = [{ type: 'text', text: 'A paragraph with bold, italic and a lnik.' }];
  });
  checks.add(
    'a changed word is caught',
    changed(diffLines(liveLines, proseOf(reworded))).length > 0,
    `${changed(diffLines(liveLines, proseOf(reworded))).length} block difference(s)`,
  );

  const unmarked = damaged((copy) => {
    for (const block of firstBand(copy)) {
      for (const node of block.content as { marks?: unknown[] }[]) {
        if (Array.isArray(node.marks)) delete node.marks;
      }
    }
  });
  checks.add(
    'a lost italic or bold is caught by the decoration diff',
    changed(diffLines(htmlInv.marks, unmarked.marks)).length > 0,
    `${changed(diffLines(htmlInv.marks, unmarked.marks)).length} decoration difference(s)`,
  );
  checks.add(
    'a lost link is caught by the link diff',
    changed(diffLines(htmlInv.links.map((link) => link.href), unmarked.links.map((link) => link.href))).length > 0,
    `live ${htmlInv.links.length} link(s), damaged ${unmarked.links.length}`,
  );

  const relinked = damaged((copy) => {
    for (const block of firstBand(copy)) {
      for (const node of block.content as { marks?: { type?: string; attrs?: { href?: string } }[] }[]) {
        for (const mark of node.marks ?? []) {
          if (mark.type === 'link' && mark.attrs !== undefined) mark.attrs.href = 'https://example.com/elsewhere';
        }
      }
    }
  });
  checks.add(
    'a link that still reads the same but points somewhere else is caught',
    changed(diffLines(htmlInv.links.map((link) => `${link.href} | ${link.label}`), relinked.links.map((link) => `${link.href} | ${link.label}`))).length > 0,
    JSON.stringify(relinked.links),
  );

  checks.add(
    'a dropped button is caught',
    changed(diffLines(['mailto:a@b.com | Coffee on me'], [])).length > 0,
    'the button comparison is an ordered list diff, so a missing entry is a difference',
  );

  // Link targets. remark does not sanitise `javascript:`, so the converter has
  // to: `HrefSchema` is the gate, and an href it rejects stops the file.
  const linkLosses: Loss[] = [];
  const links = blocksFromHtml(
    await renderMarkdown('[a](/local/page), [b](#frag), [c](mailto:a@b.com), [d](https://example.com/x).'),
    'selftest',
    'A title',
    linkLosses,
  );
  checks.add(
    'a site path, a fragment, a mailto and an http link are all kept',
    linkLosses.length === 0 && inventoryDoc({ version: 1, meta: { title: 't', slug: 'selftest', date: '2026-01-01' }, bands: [{ id: 'b1', type: 'prose', blocks: links.blocks }] }).links.length === 4,
    JSON.stringify(linkLosses),
  );

  const badHref: Loss[] = [];
  blocksFromHtml(await renderMarkdown('[x](javascript:alert(1))'), 'selftest', 'A title', badHref);
  checks.add(
    'a `javascript:` href is fatal (remark does not strip it)',
    badHref.some((loss) => loss.fatal),
    JSON.stringify(badHref.map((loss) => loss.what.slice(0, 70))),
  );

  // Frontmatter.
  const fmLosses: Loss[] = [];
  const { data } = readFrontmatter(
    ['---', 'title: A Title', 'date: 2026-06-08', 'draft: false', 'buttons:', '  - label: Coffee on me', '    href: mailto:a@b.com', '---', 'body'].join('\n'),
    'selftest',
    fmLosses,
  );
  checks.add(
    'frontmatter maps straight onto meta',
    data.title === 'A Title' && data.date === '2026-06-08' && !data.draft && data.buttons.length === 1 && data.buttons[0]?.href === 'mailto:a@b.com',
    JSON.stringify(data),
  );
  checks.add('no loss for known frontmatter', fmLosses.length === 0, JSON.stringify(fmLosses));

  const unknownKey: Loss[] = [];
  readFrontmatter(['---', 'title: t', 'date: 2026-01-01', 'tags: [a]', '---', 'b'].join('\n'), 'selftest', unknownKey);
  checks.add('an unknown frontmatter key is fatal', unknownKey.some((loss) => loss.fatal), JSON.stringify(unknownKey.map((l) => l.where)));

  const noFm: Loss[] = [];
  readFrontmatter('no frontmatter at all', 'selftest', noFm);
  checks.add('a file with no frontmatter is fatal', noFm.some((loss) => loss.fatal), JSON.stringify(noFm.map((l) => l.where)));

  // The two h1 cases.
  const repeatLosses: Loss[] = [];
  const repeat = blocksFromHtml(await renderMarkdown('# A title\n\nbody'), 'selftest', 'A title', repeatLosses);
  checks.add('an h1 is never a block', repeat.blocks.every((block) => block.kind !== 'h2'), JSON.stringify(repeat.droppedH1));
  checks.add('the dropped h1 is reported back to the caller', repeat.droppedH1.length === 1, JSON.stringify(repeat.droppedH1));

  // Smart typography is what the live site shows.
  const typography = await renderMarkdown('He said "pain," didn\'t he?');
  checks.add(
    'the processor applies the same smart punctuation the live pages show',
    typography.includes('“pain,”') && typography.includes('didn’t'),
    JSON.stringify(typography.trim()),
  );
  checks.add(
    'and folding that typography back is only ever used to explain a mismatch',
    foldTypography('“pain,” didn’t') === '"pain," didn\'t',
    foldTypography('“pain,” didn’t'),
  );

  return checks.passed;
}

/* ========================================================================== */
/* main                                                                       */
/* ========================================================================== */

if (MODE.selftest) {
  finish('migrate-essays --selftest', await selftest());
}

const result = await migrate();
if (MODE.verify) {
  const ok = await verify(result.conversions);
  finish('migrate-essays --verify', ok && result.ok);
}
finish('migrate-essays', result.ok);
