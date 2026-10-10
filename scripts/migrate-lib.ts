/**
 * scripts/migrate-lib.ts
 *
 * WS-F MIGRATION, shared machinery. The three converters
 * (`migrate-home.ts`, `migrate-essays.ts`, `migrate-data.ts`) each own their
 * source format; everything that is the same for all three lives here:
 *
 *   - the CLI surface, so the three scripts take the same flags
 *   - JSON writing with --dry-run / --check
 *   - an HTML tag scanner, and a reduction of a page to what a reader gets
 *   - the same reduction of a `Doc`, so live and migrated are comparable
 *   - an LCS diff, sentence splitting and word counting
 *   - fetching (and caching) the live pages the acceptance diffs against
 *   - the one report file, `docs/cms-migration-report-2.md`, which any one
 *     script can regenerate its own section of without clobbering the others
 *
 * This file is modelled on `scripts/migrate-mdoc.ts` (phase 1, WS-9): the
 * scanner, the `Inventory` idea, the LCS diff and the justification-per-
 * difference report are its, deliberately, because that was the bar set for
 * this workstream. What is new is the `Doc`-side inventory: phase 1 compared
 * live HTML against the *renderer's* HTML, and the renderer is being rewritten
 * by WS-B right now. Reducing the stored JSON directly means this verification
 * runs alone, and it checks the thing that must not lose text — the content —
 * rather than today's markup for it.
 *
 * Owned by WS-F. Writes nothing outside `src/content/pages/**`,
 * `src/content/data/**` and `docs/cms-migration-report-2.md`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROSE_NODE_TYPE } from '../src/cms/schema.ts';
import type { Doc, ProseBlockKind } from '../src/cms/schema.ts';

/* ========================================================================== */
/* Paths and CLI                                                              */
/* ========================================================================== */

const HERE = dirname(fileURLToPath(import.meta.url));

/** The repository root. Every path in this workstream is relative to it. */
export const PROJECT = resolve(HERE, '..');

export const REPORT_PATH = join(PROJECT, 'docs/cms-migration-report-2.md');

const argv = process.argv.slice(2);

export function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}

export function option(name: string, fallback: string): string {
  const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/** Modes every converter understands, so the three behave identically. */
export const MODE = {
  verify: flag('verify'),
  selftest: flag('selftest'),
  dryRun: flag('dry-run'),
  check: flag('check'),
  quiet: flag('quiet'),
  /** Use the cached copy of a live page even when one could be fetched. */
  offline: flag('offline'),
  /** Fetch the live pages again even when a cached copy exists. */
  refresh: flag('refresh'),
  report: !flag('no-report'),
} as const;

export function say(line: string): void {
  if (!MODE.quiet) process.stdout.write(`${line}\n`);
}

export function shout(line: string): void {
  process.stdout.write(`${line}\n`);
}

/* ========================================================================== */
/* Reading and writing                                                        */
/* ========================================================================== */

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

export type WriteOutcome = 'written' | 'unchanged' | 'would-write' | 'stale';

/**
 * Write JSON the way the rest of the tree is written: two-space indent, one
 * trailing newline. Returns what it did rather than printing, so a caller can
 * fail a `--check` run on `'stale'`.
 *
 * `--check` never writes. `--dry-run` never writes. Both are how this script
 * can be run on a tree somebody else is editing.
 */
export function writeJsonFile(path: string, value: unknown): WriteOutcome {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;

  if (MODE.check) return existing === text ? 'unchanged' : 'stale';
  if (existing === text) return 'unchanged';
  if (MODE.dryRun) return 'would-write';

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return 'written';
}

/** The committed JSON, if there is any and it parses. Used to keep ids stable. */
export function readJsonIfPresent(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/* ========================================================================== */
/* Losses                                                                     */
/* ========================================================================== */

/**
 * Something the converter could not carry across. `fatal` means visible text,
 * a link or a picture would be dropped: the file is NOT written, because a
 * half-migrated page that looks fine is the failure mode this workstream
 * exists to prevent.
 */
export type Loss = {
  where: string;
  what: string;
  fatal: boolean;
};

export function note(losses: Loss[], where: string, what: string): void {
  losses.push({ where, what, fatal: false });
}

export function fatal(losses: Loss[], where: string, what: string): void {
  losses.push({ where, what, fatal: true });
}

export function hasFatal(losses: Loss[]): boolean {
  return losses.some((loss) => loss.fatal);
}

/* ========================================================================== */
/* HTML scanning                                                              */
/* ========================================================================== */

export type Attrs = Record<string, string>;

export type Token =
  | { kind: 'open'; name: string; attrs: Attrs; selfClosing: boolean; start: number; end: number }
  | { kind: 'close'; name: string; start: number; end: number }
  | { kind: 'text'; text: string; start: number; end: number };

const VOID_TAGS = new Set([
  'img',
  'br',
  'hr',
  'input',
  'source',
  'meta',
  'link',
  'col',
  'area',
  'base',
  'embed',
  'param',
  'track',
  'wbr',
]);

/**
 * A tag scanner, not an HTML parser, and the same one phase 1 used. The input
 * is always Astro's own output or a fragment of it: no comments inside the
 * regions this reads, every attribute double quoted. Offsets are kept so a
 * subtree can be sliced out of the original string instead of re-serialised.
 */
export function scanHtml(html: string): Token[] {
  const tokens: Token[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)(\/?)>/g;
  let at = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(html)) !== null) {
    if (match.index > at) {
      tokens.push({ kind: 'text', text: html.slice(at, match.index), start: at, end: match.index });
    }
    const start = match.index;
    at = match.index + match[0].length;
    const name = (match[2] ?? '').toLowerCase();

    if (match[1] === '/') {
      tokens.push({ kind: 'close', name, start, end: at });
      continue;
    }

    const attrs: Attrs = {};
    const attrRe = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*"([^"]*)")?/g;
    let attr: RegExpExecArray | null;
    while ((attr = attrRe.exec(match[3] ?? '')) !== null) {
      const key = attr[1];
      if (key === undefined) continue;
      attrs[key.toLowerCase()] = attr[2] ?? '';
    }

    const selfClosing = match[4] === '/' || VOID_TAGS.has(name);
    tokens.push({ kind: 'open', name, attrs, selfClosing, start, end: at });
    if (selfClosing) tokens.push({ kind: 'close', name, start: at, end: at });
  }

  if (at < html.length) tokens.push({ kind: 'text', text: html.slice(at), start: at, end: html.length });
  return tokens;
}

export function decode(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_all, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_all, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&middot;/g, '·')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, '&');
}

/** HTML's own whitespace rules: every run of whitespace collapses to one space. */
export function squash(value: string): string {
  return decode(value).replace(/\s+/g, ' ').trim();
}

/**
 * What a subtree is picked out by: a tag name, a class, or both. `once` cuts
 * only the first match, which is how an essay's template `<h1>` (the title the
 * page prints for itself) is told apart from the `<h1>` the markdown body
 * opens with.
 */
export type Pick = { tag?: string; cls?: string; once?: boolean };

function matches(token: Token, pick: Pick): boolean {
  if (token.kind !== 'open') return false;
  if (pick.tag !== undefined && token.name !== pick.tag) return false;
  if (pick.cls !== undefined) {
    const cls = (token.attrs.class ?? '').split(/\s+/);
    if (!cls.includes(pick.cls)) return false;
  }
  return true;
}

/** The index of the token that closes the element opened at `from`. */
function closeIndexOf(tokens: Token[], from: number): number {
  const open = tokens[from];
  if (open === undefined || open.kind !== 'open') return from;
  if (open.selfClosing) return from + 1;
  let depth = 0;
  for (let i = from + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) break;
    if (token.kind === 'open' && token.name === open.name && !token.selfClosing) depth += 1;
    else if (token.kind === 'close' && token.name === open.name) {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return tokens.length - 1;
}

export type Subtree = { inner: string; outer: string };

/** The first subtree matching `pick`, or null. `inner` excludes its own tags. */
export function findSubtree(html: string, pick: Pick): Subtree | null {
  const tokens = scanHtml(html);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || !matches(token, pick)) continue;
    const closeAt = closeIndexOf(tokens, i);
    const close = tokens[closeAt];
    const openEnd = token.end;
    const closeStart = close === undefined ? html.length : close.start;
    const closeEnd = close === undefined ? html.length : close.end;
    return {
      inner: html.slice(openEnd, Math.max(openEnd, closeStart)),
      outer: html.slice(token.start, closeEnd),
    };
  }
  return null;
}

/** Every subtree matching `pick`, outermost only (a match inside a match is skipped). */
export function findSubtrees(html: string, pick: Pick): Subtree[] {
  const tokens = scanHtml(html);
  const found: Subtree[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined) break;
    if (!matches(token, pick)) {
      i += 1;
      continue;
    }
    const closeAt = closeIndexOf(tokens, i);
    const close = tokens[closeAt];
    const closeStart = close === undefined ? html.length : close.start;
    const closeEnd = close === undefined ? html.length : close.end;
    found.push({
      inner: html.slice(token.end, Math.max(token.end, closeStart)),
      outer: html.slice(token.start, closeEnd),
    });
    i = closeAt + 1;
  }
  return found;
}

/**
 * The same HTML with every subtree matching one of `picks` removed. This is how
 * page chrome (a lightbox holding a second copy of the hero, the date line
 * above an essay) is taken out before the body is compared, with the cut named
 * out loud in the report rather than quietly skipped by the inventory.
 */
export function cutSubtrees(html: string, picks: Pick[]): { html: string; cut: number } {
  let working = html;
  let cut = 0;
  for (const pick of picks) {
    for (;;) {
      const hit = findSubtree(working, pick);
      if (hit === null) break;
      working = working.replace(hit.outer, ' ');
      cut += 1;
      if (pick.once === true) break;
    }
  }
  return { html: working, cut };
}

/** `<script>` and `<style>` carry no prose and would pollute the text. */
export function stripNonContent(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

/* ========================================================================== */
/* Inventory: a page, and a document, reduced to what a reader gets           */
/* ========================================================================== */

/**
 * The comparison that matters. Class names, ids, element nesting and which
 * wrapper a caption lives in are all deliberately absent: what is here is the
 * text of each block in document order, every inline decoration, every link,
 * and every picture.
 */
export type Inventory = {
  /** One entry per block-level run of prose, in document order. */
  blocks: { tag: string; text: string }[];
  /** `em: text`, `strong: text`, `a[href]: text`, `color(#hex): text`. */
  marks: string[];
  /** `img <src> alt="<alt>"`, `iframe <src>`, `video <src>`. */
  media: string[];
  /** Every link, as a target and the words that carry it. */
  links: { href: string; label: string }[];
  /** Media captions, in document order. */
  captions: string[];
  /** Every block's text, newline separated. The input to the sentence check. */
  plain: string;
};

export function emptyInventory(): Inventory {
  return { blocks: [], marks: [], media: [], links: [], captions: [], plain: '' };
}

/** Block-level elements whose text is one entry in `blocks`. */
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'pre']);

/** Elements that start a new line, so text either side of them does not run together. */
const BREAKS = new Set([
  'p',
  'li',
  'br',
  'div',
  'blockquote',
  'ul',
  'ol',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'figure',
  'figcaption',
  'main',
  'article',
  'section',
  'span',
]);

const MARK_TAGS = new Set(['em', 'i', 'strong', 'b', 'a', 'code', 's', 'u', 'span']);

function markLabel(name: string, attrs: Attrs): string | null {
  if (name === 'em' || name === 'i') return 'em';
  if (name === 'strong' || name === 'b') return 'strong';
  if (name === 'a') return `a[${attrs.href ?? ''}]`;
  if (name === 'code') return 'code';
  if (name === 's') return 'strike';
  if (name === 'u') return 'underline';
  if (name === 'span') {
    const style = attrs.style ?? '';
    const colour = /color\s*:\s*([^;]+)/i.exec(style);
    if (colour !== null) return `color(${colour[1]?.trim().toLowerCase() ?? ''})`;
    // A span with no colour carries no decoration a reader can see; the site
    // uses them for layout labels ("card-title"), which the caller's region
    // selection has already decided to include.
    return null;
  }
  return null;
}

type Frame = {
  name: string;
  /** Non-null when this frame's text is one entry in `blocks`. */
  block: string | null;
  caption: boolean;
  mark: string | null;
  buf: string[];
};

/**
 * Reduce a fragment of the live site to an `Inventory`.
 *
 * `blockTags` lets a caller treat the site's own non-semantic markup as blocks:
 * the filmography cards are `<span class="card-title">`, not paragraphs, and
 * they still have to be compared.
 */
export function inventoryHtml(
  html: string,
  options: { extraBlocks?: Pick[] } = {},
): Inventory {
  const inv = emptyInventory();
  const tokens = scanHtml(stripNonContent(html));
  const extras = options.extraBlocks ?? [];
  const stack: Frame[] = [];
  const inBlock = (): boolean => stack.some((frame) => frame.block !== null);

  for (const token of tokens) {
    if (token.kind === 'text') {
      for (const frame of stack) frame.buf.push(token.text);
      continue;
    }

    if (token.kind === 'open') {
      const { name, attrs } = token;
      const cls = attrs.class ?? '';

      if (BREAKS.has(name)) for (const frame of stack) frame.buf.push(' ');

      if (name === 'img') inv.media.push(`img ${attrs.src ?? ''} alt="${squash(attrs.alt ?? '')}"`);
      if (name === 'video') inv.media.push(`video ${attrs.src ?? ''}`);
      if (name === 'iframe') inv.media.push(`iframe ${attrs.src ?? ''}`);

      const isCaption = name === 'figcaption' || /\bcaption\b/.test(cls);
      const extraHit = extras.some((pick) => matches(token, pick));
      let block: string | null = null;
      if (!isCaption && !inBlock()) {
        if (BLOCK_TAGS.has(name)) block = name;
        else if (extraHit) block = name;
      }

      const mark = MARK_TAGS.has(name) ? markLabel(name, attrs) : null;
      if (name === 'a' && attrs.href !== undefined) {
        // Pushed on close, when the label is known.
      }

      if (!token.selfClosing || block !== null || isCaption) {
        stack.push({ name, block, caption: isCaption, mark, buf: [] });
        if (name === 'a') {
          (stack[stack.length - 1] as Frame & { href?: string }).href = attrs.href ?? '';
        }
      }
      continue;
    }

    // close
    if (BREAKS.has(token.name)) for (const frame of stack) frame.buf.push(' ');
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const frame = stack[i];
      if (frame === undefined || frame.name !== token.name) continue;
      stack.splice(i, 1);
      const text = squash(frame.buf.join(''));
      if (frame.mark !== null && text !== '') inv.marks.push(`${frame.mark}: ${text}`);
      if (frame.name === 'a') {
        const href = (frame as Frame & { href?: string }).href ?? '';
        if (text !== '') inv.links.push({ href, label: text });
      }
      if (frame.caption) {
        if (text !== '') inv.captions.push(text);
      } else if (frame.block !== null && text !== '') {
        inv.blocks.push({ tag: frame.block, text });
      }
      break;
    }
  }

  inv.plain = inv.blocks.map((block) => block.text).join('\n');
  return inv;
}

/* -------------------------------------------------------------------------- */
/* The same reduction, from stored Doc JSON                                    */
/* -------------------------------------------------------------------------- */

/** The element each prose kind is compared as. Mirrors `PROSE_NODE_TYPE`. */
export const DOC_BLOCK_TAG: Readonly<Record<ProseBlockKind, string>> = {
  p: 'p',
  h2: 'h2',
  h3: 'h3',
  quote: 'blockquote',
  ul: 'ul',
  ol: 'ol',
};

type TipTapNode = {
  type?: unknown;
  text?: unknown;
  content?: unknown;
  marks?: unknown;
  attrs?: unknown;
};

function asNode(value: unknown): TipTapNode | null {
  return typeof value === 'object' && value !== null ? (value as TipTapNode) : null;
}

function markOf(raw: unknown): { label: string; href?: string } | null {
  const node = asNode(raw);
  if (node === null || typeof node.type !== 'string') return null;
  const attrs = asNode(node.attrs) ?? {};
  if (node.type === 'italic') return { label: 'em' };
  if (node.type === 'bold') return { label: 'strong' };
  if (node.type === 'link') {
    const href = typeof (attrs as { href?: unknown }).href === 'string' ? (attrs as { href: string }).href : '';
    return { label: `a[${href}]`, href };
  }
  if (node.type === 'textStyle') {
    const colour = (attrs as { color?: unknown }).color;
    return { label: `color(${typeof colour === 'string' ? colour.toLowerCase() : ''})` };
  }
  return { label: node.type };
}

/**
 * Walk one block's TipTap content, collecting text, marks and links. A
 * `listItem` or a `paragraph` inside a block separates its text with a space,
 * which is what the browser does to `<li>a</li><li>b</li>`.
 */
function walkInline(
  content: unknown,
  inv: Inventory,
  out: string[],
): void {
  if (!Array.isArray(content)) return;
  for (const raw of content) {
    const node = asNode(raw);
    if (node === null) continue;
    if (node.type === 'text') {
      const text = typeof node.text === 'string' ? node.text : '';
      out.push(text);
      const marks = Array.isArray(node.marks) ? node.marks : [];
      for (const rawMark of marks) {
        const mark = markOf(rawMark);
        if (mark === null) continue;
        const squashed = squash(text);
        if (squashed === '') continue;
        inv.marks.push(`${mark.label}: ${squashed}`);
        if (mark.href !== undefined) inv.links.push({ href: mark.href, label: squashed });
      }
      continue;
    }
    if (node.type === 'hardBreak') {
      out.push(' ');
      continue;
    }
    // paragraph, listItem, blockquote: block-ish inside a block.
    out.push(' ');
    walkInline(node.content, inv, out);
    out.push(' ');
  }
}

/** Reduce a stored `Doc` to the same shape `inventoryHtml` produces. */
export function inventoryDoc(doc: Doc): Inventory {
  const inv = emptyInventory();
  for (const band of doc.bands) {
    if (band.type === 'prose') {
      for (const block of band.blocks) {
        const out: string[] = [];
        walkInline(block.content, inv, out);
        const text = squash(out.join(''));
        if (text !== '') inv.blocks.push({ tag: DOC_BLOCK_TAG[block.kind], text });
      }
      continue;
    }
    for (const item of band.items) {
      if (item.kind === 'image') inv.media.push(`img ${item.src ?? ''} alt="${squash(item.alt ?? '')}"`);
      else if (item.kind === 'video') inv.media.push(`video ${item.src ?? ''}`);
      else if (item.kind === 'embed') inv.media.push(`iframe ${item.src ?? ''}`);
      if (item.caption !== undefined && item.caption !== '') inv.captions.push(squash(item.caption));
    }
  }
  inv.plain = inv.blocks.map((block) => block.text).join('\n');
  return inv;
}

/** Sanity: the tag table above cannot drift from the schema's node types. */
for (const kind of Object.keys(PROSE_NODE_TYPE) as ProseBlockKind[]) {
  if (DOC_BLOCK_TAG[kind] === undefined) {
    throw new Error(`migrate-lib: DOC_BLOCK_TAG has no entry for prose kind "${kind}"`);
  }
}

/* ========================================================================== */
/* Diff, sentences, words                                                     */
/* ========================================================================== */

export type Edit = { op: 'same' | 'add' | 'remove'; value: string };

/** Longest common subsequence, so the output names only the real differences. */
export function diffLines(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = table[i];
      const next = table[i + 1];
      if (row === undefined || next === undefined) continue;
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      edits.push({ op: 'same', value: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      edits.push({ op: 'remove', value: a[i] ?? '' });
      i += 1;
    } else {
      edits.push({ op: 'add', value: b[j] ?? '' });
      j += 1;
    }
  }
  while (i < n) edits.push({ op: 'remove', value: a[i++] ?? '' });
  while (j < m) edits.push({ op: 'add', value: b[j++] ?? '' });
  return edits;
}

export function changed(edits: Edit[]): Edit[] {
  return edits.filter((edit) => edit.op !== 'same');
}

/** Sentences, crudely but usefully: enough to assert none went missing. */
export function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[\p{Lu}0-9"'(“‘])/u))
    .map((part) => part.trim())
    .filter((part) => part.length >= 4);
}

export function words(text: string): number {
  const hit = text.match(/[\p{L}\p{N}'’-]+/gu);
  return hit === null ? 0 : hit.length;
}

/**
 * Punctuation folded to ASCII. Only ever used to *explain* a mismatch — "the
 * text is the same, the typography is not" — never to pass an assertion.
 */
export function foldTypography(text: string): string {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ========================================================================== */
/* The live pages                                                             */
/* ========================================================================== */

export const LIVE_ORIGIN = option('origin', 'https://jinhyuk.org');

const LIVE_CACHE = option('live-dir', join(tmpdir(), 'jinhyuk-wsf-live'));

/**
 * The live page at `path`, cached on disk so a verification can be re-run, and
 * re-read in `--offline`, without hammering the site. `--refresh` forces a
 * fetch. A `--live-dir` holding hand-saved HTML is how this runs with no
 * network at all.
 */
export async function fetchLive(path: string): Promise<{ url: string; html: string; from: 'network' | 'cache' }> {
  const url = `${LIVE_ORIGIN}${path}`;
  const file = join(LIVE_CACHE, `${path.replace(/[^a-zA-Z0-9]+/g, '_') || 'root'}.html`);

  if (!MODE.refresh && existsSync(file)) {
    return { url, html: readFileSync(file, 'utf8'), from: 'cache' };
  }
  if (MODE.offline) {
    throw new Error(`--offline and no cached copy of ${url} at ${file}`);
  }

  const response = await fetch(url, { headers: { 'user-agent': 'jinhyuk.org-ws-f-migration' } });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  const html = await response.text();
  mkdirSync(LIVE_CACHE, { recursive: true });
  writeFileSync(file, html, 'utf8');
  return { url, html, from: 'network' };
}

export const LIVE_CACHE_DIR = LIVE_CACHE;

/* ========================================================================== */
/* Assertions                                                                 */
/* ========================================================================== */

export type Check = { name: string; pass: boolean; detail: string };

export class Checks {
  readonly rows: Check[] = [];

  add(name: string, pass: boolean, detail: string): boolean {
    this.rows.push({ name, pass, detail });
    say(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
    return pass;
  }

  /** Two ordered lists must be identical. Prints the edits when they are not. */
  same(name: string, live: string[], migrated: string[], limit = 12): boolean {
    const edits = changed(diffLines(live, migrated));
    const detail =
      edits.length === 0
        ? `${live.length} entries, in the same order`
        : `${edits.length} differences: ${edits
            .slice(0, limit)
            .map((edit) => `${edit.op === 'remove' ? '-' : '+'}${JSON.stringify(edit.value)}`)
            .join(' ')}`;
    return this.add(name, edits.length === 0, detail);
  }

  get failures(): Check[] {
    return this.rows.filter((row) => !row.pass);
  }

  get passed(): boolean {
    return this.failures.length === 0;
  }

  table(): string {
    const lines = ['| assertion | result | detail |', '|---|---|---|'];
    for (const row of this.rows) {
      lines.push(`| ${row.name} | ${row.pass ? 'pass' : '**FAIL**'} | ${mdCell(row.detail)} |`);
    }
    return lines.join('\n');
  }
}

/** Markdown table cells cannot hold a pipe or a newline. */
export function mdCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

/* ========================================================================== */
/* The report                                                                 */
/* ========================================================================== */

/**
 * `docs/cms-migration-report-2.md` is one file written by three scripts. Each
 * script owns a marked region of it, so running one converter's `--verify`
 * regenerates that converter's section and leaves the others exactly as they
 * were. The header, the result table and the contents list are regenerated
 * from the regions every time.
 */
export const SECTION_ORDER = ['home', 'essays', 'filmography', 'photography', 'notes'] as const;
export type SectionKey = (typeof SECTION_ORDER)[number];

export const SECTION_TITLES: Readonly<Record<SectionKey, string>> = {
  home: 'Home: `src/content/home.yaml` to `src/content/pages/home.json`',
  essays: 'Essays: `src/content/writing/*.md` to `src/content/pages/essays/<slug>.json`',
  filmography: 'Filmography: `src/data/filmography.ts` to `src/content/data/filmography.json`',
  photography: 'Photography: `src/data/photography.ts` to `src/content/data/photography.json`',
  notes: 'What this migration did not do',
};

const BEGIN = (key: string): string => `<!-- WSF:BEGIN ${key} -->`;
const END = (key: string): string => `<!-- WSF:END ${key} -->`;

type Region = { key: SectionKey; body: string };

function readRegions(): Map<SectionKey, string> {
  const found = new Map<SectionKey, string>();
  if (!existsSync(REPORT_PATH)) return found;
  const text = readFileSync(REPORT_PATH, 'utf8');
  for (const key of SECTION_ORDER) {
    const from = text.indexOf(BEGIN(key));
    const to = text.indexOf(END(key));
    if (from === -1 || to === -1 || to < from) continue;
    found.set(key, text.slice(from + BEGIN(key).length, to).trim());
  }
  return found;
}

function statusOf(body: string): { result: string; checks: string; generated: string } {
  const meta = /<!-- WSF:STATUS result=(\w+) checks=(\d+) generated=([^ ]+) -->/.exec(body);
  if (meta === null) return { result: '?', checks: '?', generated: '?' };
  return { result: meta[1] ?? '?', checks: meta[2] ?? '?', generated: meta[3] ?? '?' };
}

export function statusLine(result: 'PASS' | 'FAIL', checks: number): string {
  return `<!-- WSF:STATUS result=${result} checks=${checks} generated=${new Date().toISOString().slice(0, 10)} -->`;
}

/**
 * Put `body` in the report as section `key`, rewriting the header. Returns the
 * path written. `--no-report` turns this off for a run that only wants the
 * console output.
 */
export function upsertReportSection(key: SectionKey, body: string): string | null {
  if (!MODE.report) return null;

  const regions = readRegions();
  regions.set(key, body.trim());

  const present: Region[] = SECTION_ORDER.filter((candidate) => regions.has(candidate)).map((candidate) => ({
    key: candidate,
    body: regions.get(candidate) ?? '',
  }));

  const statuses = present.map((region) => ({ key: region.key, ...statusOf(region.body) }));
  const anyFail = statuses.some((status) => status.result !== 'PASS');
  const missing = SECTION_ORDER.filter((candidate) => !regions.has(candidate) && candidate !== 'notes');

  const head: string[] = [
    '# The other four content sources: the migration diff',
    '',
    'WS-F, phase 2. Generated by the three converters. Do not hand-edit; re-run them:',
    '',
    '```',
    'node scripts/migrate-home.ts --verify',
    'node scripts/migrate-essays.ts --verify',
    'node scripts/migrate-data.ts --verify',
    '```',
    '',
    anyFail
      ? '**Result: at least one assertion failed.** The failing rows are marked **FAIL** in the tables below.'
      : '**Result: every assertion passed.** No prose, link, button, film field or picture differs between the live page and the migrated content, except the differences listed and justified in each section.',
    '',
    '| source | result | assertions | generated |',
    '|---|---|---|---|',
  ];
  for (const status of statuses) {
    head.push(
      `| ${SECTION_TITLES[status.key].split(':')[0]} | ${status.result === 'PASS' ? 'pass' : `**${status.result}**`} | ${status.checks} | ${status.generated} |`,
    );
  }
  if (missing.length > 0) {
    head.push('', `Not yet generated in this file: ${missing.map((key) => `\`${key}\``).join(', ')}.`);
  }
  head.push('', '## Contents', '');
  present.forEach((region, index) => {
    head.push(`${index + 1}. ${SECTION_TITLES[region.key]}`);
  });
  head.push('', '---', '', '');

  // The heading sits OUTSIDE the markers: the region holds only the body, so
  // re-running a converter replaces its text instead of stacking a second
  // heading on top of the first.
  const parts = present.map(
    (region, index) =>
      `## ${index + 1}. ${SECTION_TITLES[region.key]}\n\n${BEGIN(region.key)}\n\n${region.body}\n\n${END(region.key)}`,
  );

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${head.join('\n')}${parts.join('\n\n---\n\n')}\n`, 'utf8');
  return REPORT_PATH;
}

/** A fenced diff block, `-` live and `+` migrated. */
export function diffBlock(edits: Edit[], limit = 200): string {
  const lines = edits
    .slice(0, limit)
    .map((edit) => `${edit.op === 'remove' ? '- ' : edit.op === 'add' ? '+ ' : '  '}${edit.value}`);
  if (edits.length > limit) lines.push(`  ... ${edits.length - limit} more`);
  return ['```diff', ...lines, '```'].join('\n');
}

/* ========================================================================== */
/* Exit                                                                      */
/* ========================================================================== */

export function finish(label: string, ok: boolean): never {
  shout(ok ? `\n${label}: OK` : `\n${label}: FAILED`);
  process.exit(ok ? 0 : 1);
}
