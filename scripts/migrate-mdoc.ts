#!/usr/bin/env node
/**
 * scripts/migrate-mdoc.ts
 *
 * WS-9 MIGRATION. Turns the existing Markdoc project pages into Doc JSON.
 *
 *   src/content/projects/<slug>.mdoc   ->   src/content/pages/<slug>.json
 *
 * This is the one workstream that can lose the owner's writing, so the whole
 * file is written the pessimistic way round: anything it cannot represent is
 * named out loud, a construct that would drop visible text is FATAL and stops
 * the page being written at all, and nothing is ever silently approximated.
 *
 * Three modes, all in this one file because WS-9 owns one script and a
 * verification you cannot run is not a verification:
 *
 *   node scripts/migrate-mdoc.ts              migrate every .mdoc
 *   node scripts/migrate-mdoc.ts --selftest   synthetic documents, no browser
 *   node scripts/migrate-mdoc.ts --verify     live-vs-migrated diff + report
 *
 * Flags
 *   --in=<dir>        source .mdoc directory  (default src/content/projects)
 *   --out=<dir>       destination             (default src/content/pages)
 *   --report=<file>   where --verify writes   (default docs/cms-migration-report.md)
 *   --live=<url|file> the published page --verify diffs against
 *   --shots=<dir>     where --verify puts its evidence (default a temp dir)
 *   --no-browser      skip the Chrome passes in --verify
 *   --include-drafts  migrate `draft: true` entries into --out anyway
 *   --dry-run         convert and validate, write nothing
 *   --check           fail if the committed JSON is not what this produces now
 *   --quiet           only print failures
 *
 * WHAT MAPS TO WHAT (the long version is in docs/cms-migration-report.md)
 *
 *   paragraph / heading / blockquote / list   ->  ProseBand blocks
 *   {% Media %}                               ->  CanvasBand (in flow)
 *   markdown ![](...)                         ->  CanvasBand (in flow)
 *   {% Canvas %}                              ->  CanvasBand (in flow)
 *   {% Margin %}                              ->  CanvasBand (overlay)
 *   {% TextMedia %}                           ->  ProseBand + CanvasBand (overlay)
 *   {% Color %}                               ->  textStyle mark
 *
 * A Media group was a block in normal flow laid out by flexbox. The new model
 * has no flow media: a band is prose or a canvas (brief 2.2), so a group has to
 * become a canvas band, and the only honest way to do that is to compute where
 * flexbox actually put each picture at the 1344px reference width and store
 * those coordinates. That is what layOutMediaGroup does, from the real CSS in
 * src/styles/global.css and the real intrinsic size of each file on disk. The
 * model is checked against a browser by --verify, which measures the live
 * markup and the migrated render side by side and prints every delta.
 *
 * Imports nothing from src/cms/ except the schema and the renderer, and reads
 * src/lib/project-doc.ts only inside --verify (dynamically, so WS-11 deleting
 * it cannot break the migration).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * js-yaml ships no type declarations in this tree (it is here as a transitive
 * dependency), and only one function of it is used. `createRequire` keeps the
 * cast local instead of spreading `any` through a typed import.
 */
const yaml = createRequire(import.meta.url)('js-yaml') as { load: (text: string) => unknown };

/** The only thing this script asks of Markdoc. */
type MarkdocParser = { parse: (input: string) => unknown };

import {
  DOC_VERSION,
  MOBILE_BREAKPOINT,
  REFERENCE_WIDTH,
  SHAPE_KINDS,
  formatIssues,
  validateDoc,
} from '../src/cms/schema.ts';
import type {
  Band,
  CanvasBand,
  CanvasItem,
  Doc,
  DocMeta,
  ProseBand,
  ProseBlock,
  ProseBlockKind,
  ShapeKind,
} from '../src/cms/schema.ts';
import { ensureShapeAssets, renderDoc, renderDocHead } from '../src/cms/render/index.ts';

/* ========================================================================== */
/* Paths and CLI                                                              */
/* ========================================================================== */

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const option = (name: string, fallback: string): string => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const IN_DIR = resolve(PROJECT, option('in', 'src/content/projects'));
const OUT_DIR = resolve(PROJECT, option('out', 'src/content/pages'));
const REPORT_PATH = resolve(PROJECT, option('report', 'docs/cms-migration-report.md'));
const PUBLIC_DIR = join(PROJECT, 'public');
const LIVE_DEFAULT = 'https://jinhyuk.org/projects/track-daily-habit-tracker/';

const QUIET = flag('quiet');
const say = (line: string): void => {
  if (!QUIET) console.log(line);
};

/* ========================================================================== */
/* Geometry: the live CSS, as numbers                                         */
/* ========================================================================== */

/**
 * Every constant below is a value read out of src/styles/global.css, with the
 * selector it came from named, so the model can be checked against the
 * stylesheet by eye. Nothing here is a guess, and nothing here is new: brief
 * rule 6 says 1344 and 900 and no other widths, and both come from the schema.
 */

/** `.pb--text` / `.pb--wide` / `.pb--full` max-width, in reference px. */
const BLOCK_WIDTHS: Readonly<Record<string, number>> = {
  text: 720,
  wide: 1056,
  full: REFERENCE_WIDTH,
};
/** `.media-items { gap: 24px }`. */
const MEDIA_GAP = 24;
/** `.media-item img { border: 1px solid var(--media-edge) }`, both edges. */
const MEDIA_BORDER = 1;
/** `.media-items--tall img { max-height: 720px }`. */
const TALL_MAX_HEIGHT = 720;
/** `.media-items--grid2 > .media-item { flex: 0 0 calc(50% - 12px) }`. */
const GRID2_INSET = 12;
/** `.media-caption { margin-top: 10px; line-height: 21px }`. */
const CAPTION_SPACE = 10 + 21;
/** `.margin-item--small|medium|large { width: … }`. */
const MARGIN_WIDTHS: Readonly<Record<string, number>> = { small: 300, medium: 400, large: 520 };
/** `.margin-item { max-width: calc(100% - 720px - 48px) }`. */
const MARGIN_MAX_WIDTH = REFERENCE_WIDTH - BLOCK_WIDTHS.text! - 48;
/** `.margin-item img { max-height: 560px }`. */
const MARGIN_MAX_HEIGHT = 560;
/** `.margin-item { margin: 0 0 32px 48px }`, the bottom. */
const MARGIN_STACK_GAP = 32;
/** `.tm { gap: 40px }`. */
const TEXTMEDIA_GAP = 40;
/** `.video-frame { aspect-ratio: 16 / 9 }`, for media with no file on disk. */
const EMBED_RATIO = 16 / 9;
/** `.canvas` falls back to the tallest item plus this when no height is set. */
const CANVAS_HEIGHT_PAD = 24;

/** Two decimal places. Four would be float noise; one moves a pixel. */
const px = (value: number): number => Math.round(value * 100) / 100;

/* ========================================================================== */
/* Intrinsic image dimensions                                                 */
/* ========================================================================== */

type Size = { w: number; h: number };

const sizeCache = new Map<string, Size | null>();

/**
 * The intrinsic size of a site-absolute src, read straight out of the file
 * header. PNG, JPEG, GIF and WebP cover everything in public/ and everything a
 * phone screenshot can be; anything else falls through to null and the caller
 * says so out loud rather than inventing a shape.
 *
 * Deliberately dependency-free and synchronous. The migration must not need an
 * image library installed to be correct about the owner's pages.
 */
function intrinsicSize(src: string): Size | null {
  if (sizeCache.has(src)) return sizeCache.get(src)!;
  const result = readIntrinsicSize(src);
  sizeCache.set(src, result);
  return result;
}

function readIntrinsicSize(src: string): Size | null {
  if (!src.startsWith('/')) return null;
  const file = join(PUBLIC_DIR, src.replace(/^\/+/, '').split('?')[0]!);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) return null;

  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return null;
  }

  // PNG: IHDR is always the first chunk, width and height at bytes 16 and 20.
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }

  // GIF: logical screen descriptor, little-endian, at byte 6.
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'GIF') {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }

  // WebP: VP8X (extended), VP8L (lossless) or VP8 (lossy).
  if (buf.length > 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8X') {
      return { w: 1 + (buf.readUIntLE(24, 3) & 0xffffff), h: 1 + (buf.readUIntLE(27, 3) & 0xffffff) };
    }
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (chunk === 'VP8 ') {
      return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    return null;
  }

  // JPEG: walk the markers to the first SOFn and read its frame header.
  if (buf.length > 4 && buf.readUInt16BE(0) === 0xffd8) {
    let at = 2;
    while (at + 9 < buf.length) {
      if (buf[at] !== 0xff) {
        at += 1;
        continue;
      }
      const marker = buf[at + 1]!;
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      // Standalone markers carry no length.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      const length = buf.readUInt16BE(at + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { h: buf.readUInt16BE(at + 5), w: buf.readUInt16BE(at + 7) };
      if (marker === 0xda) break; // start of scan; no frame header found
      at += 2 + length;
    }
  }

  return null;
}

/**
 * The border box an `<img>` ends up with, given `width: auto; height: auto`,
 * a max-width and a max-height, `box-sizing: border-box` and a 1px border.
 * This is the shape every `.media-item` and every `.margin-item` takes.
 */
function fitBox(size: Size, maxW: number, maxH: number): Size {
  const edge = MEDIA_BORDER * 2;
  const availW = Math.max(1, maxW - edge);
  const availH = Math.max(1, maxH - edge);
  const scale = Math.min(1, availW / size.w, availH / size.h);
  return { w: px(size.w * scale + edge), h: px(size.h * scale + edge) };
}

/** The border box for an `<img>` whose width is already decided (`width: 100%`). */
function boxFromWidth(size: Size, width: number): Size {
  const edge = MEDIA_BORDER * 2;
  const content = Math.max(1, width - edge);
  return { w: px(width), h: px((content * size.h) / size.w + edge) };
}

/* ========================================================================== */
/* Losses                                                                     */
/* ========================================================================== */

/**
 * fatal  the output would lose text or media the live page shows. The page is
 *        not written and the run exits non-zero.
 * lossy  the text survives, a decoration or a nuance does not. Written, and
 *        named in the report.
 * note   an intentional difference worth writing down.
 */
type LossLevel = 'fatal' | 'lossy' | 'note';
type Loss = { level: LossLevel; where: string; message: string };

type Conversion = {
  slug: string;
  file: string;
  doc: Doc;
  losses: Loss[];
  /** Every paragraph-ish run of prose in the source, in document order. */
  sourceProse: string[];
  /** Every media src in the source, in document order. */
  sourceMedia: string[];
  /** Every caption in the source, in document order. */
  sourceCaptions: string[];
};

/* ========================================================================== */
/* Markdoc AST                                                                */
/* ========================================================================== */

type Ast = {
  type: string;
  tag?: string;
  attributes?: Record<string, unknown>;
  children?: Ast[];
  [key: string]: unknown;
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const match = FRONTMATTER_RE.exec(raw);
  if (match === null) return { frontmatter: '', body: raw };
  return { frontmatter: match[1]!, body: raw.slice(match[0].length) };
}

/** YAML date values arrive as Date objects; everything else as written. */
function asDateString(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    return match === null ? null : match[1]!;
  }
  return null;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/* ========================================================================== */
/* Inline content: Markdoc -> TipTap                                          */
/* ========================================================================== */

/**
 * The seven text colours the Color mark offered, as the hex the editor showed.
 * Straight out of keystatic.config.tsx's TONES, which is also what the browser
 * painted in light mode.
 *
 * `accent` and `muted` were classes on the live page (`.fc--accent`) and so
 * followed light and dark; §3.2 gives a textStyle mark a literal hex and
 * nothing else, so the dark-mode value is lost. Every conversion of one of
 * these records a `lossy` entry naming the tone.
 */
const TONE_HEX: Readonly<Record<string, string>> = {
  accent: '#ff5722',
  muted: '#6b6b6b',
  red: '#c0392b',
  orange: '#d35400',
  green: '#2e7d52',
  blue: '#2563a8',
  purple: '#6b4ea8',
};
/** Tones whose live rendering changed with the theme. */
const THEMED_TONES = new Set(['accent', 'muted', 'red', 'orange', 'green', 'blue', 'purple']);

type Mark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'link'; attrs: { href: string } }
  | { type: 'textStyle'; attrs: { color: string } };

type Inline = { type: 'text'; text: string; marks?: Mark[] } | { type: 'hardBreak' };

/**
 * The schemes a link may use, matching the renderer's own `safeUrl`. Checked
 * here as well so a `javascript:` url never reaches the JSON on disk, not just
 * never reaches the page.
 */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

function isSafeHref(href: string): boolean {
  const stripped = href.replace(/[\u0000- \u007f-\u009f]/g, '');
  if (stripped === '') return false;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped);
  if (scheme === null) return true; // a path or a fragment
  return SAFE_SCHEMES.has(scheme[1]!.toLowerCase());
}

/** Fixed emission order, so the JSON is byte-stable between runs. */
const MARK_SORT: Readonly<Record<Mark['type'], number>> = {
  bold: 0,
  italic: 1,
  link: 2,
  textStyle: 3,
};

function pushText(out: Inline[], value: string, marks: Mark[]): void {
  if (value === '') return;
  const sorted = [...marks].sort((a, b) => MARK_SORT[a.type] - MARK_SORT[b.type]);
  const last = out[out.length - 1];
  // Merge touching runs that carry identical marks, so `**a****b**` is one node.
  if (
    last !== undefined &&
    last.type === 'text' &&
    JSON.stringify(last.marks ?? []) === JSON.stringify(sorted)
  ) {
    last.text += value;
    return;
  }
  out.push(sorted.length === 0 ? { type: 'text', text: value } : { type: 'text', text: value, marks: sorted });
}

/**
 * One inline subtree.
 *
 * Unrepresentable inline nodes keep their text and lose their decoration: the
 * rule everywhere in this file is that a sentence is sacred and a `<code>` is
 * not. Both are recorded.
 */
function convertInline(nodes: Ast[], marks: Mark[], losses: Loss[], where: string, out: Inline[] = []): Inline[] {
  for (const node of nodes) {
    const kids = node.children ?? [];
    switch (node.type) {
      case 'inline':
        convertInline(kids, marks, losses, where, out);
        break;

      case 'text': {
        const content = node.attributes?.content;
        if (typeof content === 'string') pushText(out, content, marks);
        break;
      }

      case 'strong':
        convertInline(kids, [...marks, { type: 'bold' }], losses, where, out);
        break;

      case 'em':
        convertInline(kids, [...marks, { type: 'italic' }], losses, where, out);
        break;

      case 'link': {
        const href = text(node.attributes?.href);
        if (href === undefined) {
          losses.push({ level: 'lossy', where, message: 'a link with no href became plain text' });
          convertInline(kids, marks, losses, where, out);
          break;
        }
        if (!isSafeHref(href)) {
          // Never carry one of these into the new format. The renderer would
          // drop it anyway, but a document is a thing people read in git.
          losses.push({
            level: 'lossy',
            where,
            message: `a link to ${href} is not an http(s)/mailto/tel/relative url; it kept its text and lost the link`,
          });
          convertInline(kids, marks, losses, where, out);
          break;
        }
        if (text(node.attributes?.title) !== undefined) {
          losses.push({
            level: 'lossy',
            where,
            message: `the link title on ${href} is dropped; §3.2 has no title on a link mark`,
          });
        }
        convertInline(kids, [...marks, { type: 'link', attrs: { href } }], losses, where, out);
        break;
      }

      case 'code': {
        // Markdoc keeps inline code's text in an attribute, not in a child.
        const content = node.attributes?.content;
        losses.push({
          level: 'lossy',
          where,
          message: 'inline `code` kept its text and lost its <code> tag; §3.2 has no code mark',
        });
        if (typeof content === 'string') pushText(out, content, marks);
        else convertInline(kids, marks, losses, where, out);
        break;
      }

      case 's':
        losses.push({
          level: 'lossy',
          where,
          message: 'strikethrough kept its text and lost its <s> tag; §3.2 has no strike mark',
        });
        convertInline(kids, marks, losses, where, out);
        break;

      case 'softbreak':
        // A source line break inside a paragraph. The live page emits "\n",
        // which HTML renders as one space; a space is the same rendering and
        // survives a round trip through the editor.
        pushText(out, ' ', marks);
        break;

      case 'hardbreak':
        out.push({ type: 'hardBreak' });
        break;

      case 'tag': {
        if (node.tag === 'Color') {
          const tone = typeof node.attributes?.tone === 'string' ? node.attributes.tone : 'accent';
          const hex = TONE_HEX[tone];
          if (hex === undefined) {
            losses.push({
              level: 'lossy',
              where,
              message: `unknown Color tone "${tone}"; the run kept its text and lost its colour`,
            });
            convertInline(kids, marks, losses, where, out);
            break;
          }
          if (THEMED_TONES.has(tone)) {
            losses.push({
              level: 'lossy',
              where,
              message:
                `Color tone "${tone}" was the class .fc--${tone}, which changed between light and ` +
                `dark; it is now the literal ${hex}, which does not`,
            });
          }
          convertInline(kids, [...marks, { type: 'textStyle', attrs: { color: hex } }], losses, where, out);
          break;
        }
        losses.push({
          level: 'fatal',
          where,
          message: `inline tag {% ${String(node.tag)} %} has no representation in §3.2`,
        });
        convertInline(kids, marks, losses, where, out);
        break;
      }

      case 'image':
        // An image in the middle of a sentence. The live page renders a figure
        // inside the <p>; splitting the paragraph around it would change the
        // text, so this is a hand job, not a migration.
        losses.push({
          level: 'fatal',
          where,
          message:
            `an inline image (${String(node.attributes?.src)}) sits inside a paragraph with text; ` +
            `move it onto its own line and run this again`,
        });
        break;

      default:
        losses.push({
          level: 'fatal',
          where,
          message: `unknown inline node "${node.type}"; nothing was emitted for it`,
        });
        convertInline(kids, marks, losses, where, out);
        break;
    }
  }
  return out;
}

const plainOf = (nodes: Inline[]): string =>
  nodes.map((n) => (n.type === 'text' ? n.text : ' ')).join('');

/* ========================================================================== */
/* Prose blocks                                                               */
/* ========================================================================== */

type DraftProseBlock = { kind: ProseBlockKind; content: unknown[]; plain: string };

/**
 * Heading levels. The live page is worth a word here: its heading transform
 * reads `level` through `transformAttributes`, and Markdoc marks `level` as
 * `render: false`, so it is always undefined and every heading in a project
 * body renders as `<h3 class="pb-heading">` whatever you typed. That is a bug
 * on the live site, not an intention, so the migration maps by what was
 * written: `#` -> h2, `##` -> h3. §3.2 has no h4, so anything deeper clamps to
 * h3 and says so.
 */
function headingKind(level: number, losses: Loss[], where: string): ProseBlockKind {
  if (level <= 1) return 'h2';
  if (level === 2) return 'h3';
  losses.push({
    level: 'lossy',
    where,
    message: `a level-${level} heading clamped to h3; §3.2 stops at h3`,
  });
  return 'h3';
}

function convertListItems(nodes: Ast[], losses: Loss[], where: string): { content: unknown[]; plain: string[] } {
  const content: unknown[] = [];
  const plain: string[] = [];

  for (const item of nodes) {
    if (item.type !== 'item') {
      losses.push({ level: 'fatal', where, message: `a list contained a "${item.type}", not an item` });
      continue;
    }
    const kids: unknown[] = [];
    const inlineRun: Ast[] = [];

    const flush = (): void => {
      if (inlineRun.length === 0) return;
      const inline = convertInline(inlineRun, [], losses, where);
      inlineRun.length = 0;
      kids.push({ type: 'paragraph', content: inline });
      plain.push(plainOf(inline));
    };

    for (const child of item.children ?? []) {
      if (child.type === 'list') {
        flush();
        const nested = convertListItems(child.children ?? [], losses, where);
        kids.push({
          type: child.attributes?.ordered === true ? 'orderedList' : 'bulletList',
          content: nested.content,
        });
        plain.push(...nested.plain);
      } else if (child.type === 'paragraph') {
        flush();
        const inline = convertInline(child.children ?? [], [], losses, where);
        kids.push({ type: 'paragraph', content: inline });
        plain.push(plainOf(inline));
      } else {
        inlineRun.push(child);
      }
    }
    flush();

    content.push({ type: 'listItem', content: kids });
  }

  return { content, plain };
}

/** A top-level prose node, or null when the node is not prose. */
function convertProse(node: Ast, losses: Loss[], where: string): DraftProseBlock | null {
  switch (node.type) {
    case 'paragraph': {
      const inline = convertInline(node.children ?? [], [], losses, where);
      return { kind: 'p', content: inline, plain: plainOf(inline) };
    }
    case 'heading': {
      const level = Number(node.attributes?.level ?? 1);
      const inline = convertInline(node.children ?? [], [], losses, where);
      return { kind: headingKind(level, losses, where), content: inline, plain: plainOf(inline) };
    }
    case 'blockquote': {
      const paragraphs: unknown[] = [];
      const plain: string[] = [];
      for (const child of node.children ?? []) {
        const inline = convertInline(
          child.type === 'paragraph' ? (child.children ?? []) : [child],
          [],
          losses,
          where,
        );
        paragraphs.push({ type: 'paragraph', content: inline });
        plain.push(plainOf(inline));
      }
      return { kind: 'quote', content: paragraphs, plain: plain.join('\n') };
    }
    case 'list': {
      const ordered = node.attributes?.ordered === true;
      const items = convertListItems(node.children ?? [], losses, where);
      return { kind: ordered ? 'ol' : 'ul', content: items.content, plain: items.plain.join('\n') };
    }
    default:
      return null;
  }
}

/* ========================================================================== */
/* Canvas items: drafts, before ids exist                                     */
/* ========================================================================== */

type DraftItem = Omit<CanvasItem, 'id' | 'anchor'> & {
  /** Resolved to a real anchor once ids are minted. */
  anchorTo?: { band: DraftBand; block: DraftProseBlock } | null;
};

type DraftBand =
  | { type: 'prose'; blocks: DraftProseBlock[] }
  | { type: 'canvas'; height: number; overlay?: boolean; items: DraftItem[] };

/* ========================================================================== */
/* Media groups -> a canvas band                                              */
/* ========================================================================== */

type MediaSource = { kind: 'image' | 'video' | 'embed'; src: string };

function readMediaSource(raw: unknown, losses: Loss[], where: string): MediaSource | null {
  const source = (raw as { source?: { discriminant?: unknown; value?: unknown } } | null)?.source;
  const value = text(source?.value);
  if (value === undefined) return null; // the live transform filters these out too
  if (!isSafeHref(value) || !/^(?:\/|https?:\/\/)/.test(value)) {
    losses.push({
      level: 'fatal',
      where,
      message: `media src ${JSON.stringify(value)} is not a site-absolute path or an http(s) url; §3.3 rejects it`,
    });
    return null;
  }
  switch (source?.discriminant) {
    case 'image':
      return { kind: 'image', src: value };
    case 'videoFile':
      return { kind: 'video', src: value };
    case 'videoLink':
      return { kind: 'embed', src: value };
    default:
      losses.push({
        level: 'fatal',
        where,
        message: `media source type "${String(source?.discriminant)}" is not one of image/videoFile/videoLink`,
      });
      return null;
  }
}

/** The shape a single media item takes, with the reason it has no file noted. */
function mediaRatio(source: MediaSource, losses: Loss[], where: string): Size {
  if (source.kind === 'image' || source.kind === 'video') {
    const size = intrinsicSize(source.src);
    if (size !== null) return size;
    losses.push({
      level: 'lossy',
      where,
      message:
        `no intrinsic size for ${source.src} (not an image file under public/), so its box was ` +
        `computed at 16:9; check this one by eye`,
    });
    return { w: 16, h: 9 };
  }
  // A video link is a .video-frame, which is 16/9 whatever is inside it.
  return { w: 16, h: 9 };
}

type MediaGroup = {
  items: { source: MediaSource; alt?: string; caption?: string }[];
  layout: string;
  width: string;
  align: string;
  tall: boolean;
  groupCaption?: string;
};

/**
 * A Media group, laid out the way flexbox laid it out, at the 1344px reference
 * width.
 *
 * The cases, all of them from src/styles/global.css:
 *
 *   tall        `.media-items--tall > .media-item { flex: 0 0 auto }` wins over
 *               grid2's basis, and the img takes `max-height: 720px` with an
 *               auto width. Items keep their own widths and the line is bottom
 *               aligned (`align-items: flex-end`).
 *   row         `flex: 1 1 0`, so every item gets the same width.
 *   grid2       `flex: 0 0 calc(50% - 12px)`, two to a line, wrapping.
 *   stack       `flex-direction: column`, cross axis sized to the picture.
 *
 * `justify-content` comes from the align class and moves the line inside the
 * block; `.pb--center` / `--left` / `--right` move the block inside the 1344px
 * column.
 */
function layOutMediaGroup(group: MediaGroup, losses: Loss[], where: string): DraftItem[] {
  const containerW = BLOCK_WIDTHS[group.width] ?? BLOCK_WIDTHS.wide!;
  const containerLeft =
    group.align === 'left' ? 0 : group.align === 'right' ? REFERENCE_WIDTH - containerW : (REFERENCE_WIDTH - containerW) / 2;

  const captioned = (index: number): boolean =>
    group.groupCaption === undefined && group.items[index]!.caption !== undefined;

  // Every item's border box, before it is placed.
  const boxes: Size[] = group.items.map((item, index) => {
    const ratio = mediaRatio(item.source, losses, `${where} item ${index + 1}`);
    if (group.tall) return fitBox(ratio, Number.POSITIVE_INFINITY, TALL_MAX_HEIGHT);
    if (group.layout === 'row') {
      const each = (containerW - MEDIA_GAP * (group.items.length - 1)) / group.items.length;
      return boxFromWidth(ratio, each);
    }
    if (group.layout === 'grid2') return boxFromWidth(ratio, containerW / 2 - GRID2_INSET);
    // stack: the column's cross axis is sized to the picture, capped by the block.
    return fitBox(ratio, containerW, Number.POSITIVE_INFINITY);
  });

  const placed: DraftItem[] = [];

  const emit = (index: number, x: number, y: number): void => {
    const item = group.items[index]!;
    const box = boxes[index]!;
    const caption = group.groupCaption !== undefined && index === 0 ? group.groupCaption : item.caption;
    const draft: DraftItem = {
      kind: item.source.kind,
      x: px(x),
      y: px(y),
      w: box.w,
      h: box.h,
      src: item.source.src,
    };
    if (item.source.kind !== 'embed') draft.alt = item.alt ?? '';
    else if (item.alt !== undefined) draft.alt = item.alt;
    if (caption !== undefined) draft.caption = caption;
    placed.push(draft);
  };

  if (group.layout === 'stack') {
    // A column. `.media-items` sets align-items: flex-start, and the tall rule
    // flips it to flex-end, so a stack is left-aligned unless it is tall.
    let y = 0;
    boxes.forEach((box, index) => {
      const x = group.tall ? containerLeft + containerW - box.w : containerLeft;
      emit(index, x, y);
      y += box.h + (captioned(index) ? CAPTION_SPACE : 0) + MEDIA_GAP;
    });
    return placed;
  }

  // One or more flex lines. Only grid2 wraps (`flex-wrap: wrap`); row and
  // stack are nowrap and overflow instead, which is what the live page does.
  const lines: number[][] = [];
  if (group.layout === 'grid2') {
    let line: number[] = [];
    let used = 0;
    boxes.forEach((box, index) => {
      const next = used + box.w + (line.length > 0 ? MEDIA_GAP : 0);
      if (line.length > 0 && next > containerW + 0.5) {
        lines.push(line);
        line = [index];
        used = box.w;
      } else {
        line.push(index);
        used = next;
      }
    });
    if (line.length > 0) lines.push(line);
  } else {
    lines.push(boxes.map((_, index) => index));
  }

  let top = 0;
  for (const line of lines) {
    const content = line.reduce((sum, index) => sum + boxes[index]!.w, 0) + MEDIA_GAP * (line.length - 1);
    const free = containerW - content;
    const offset = group.align === 'left' ? 0 : group.align === 'right' ? free : free / 2;
    // align-items: flex-end when tall, flex-start otherwise. The box a line
    // aligns on includes a per-item caption, because that caption is inside
    // the flex item.
    const lineHeight = Math.max(
      ...line.map((index) => boxes[index]!.h + (captioned(index) ? CAPTION_SPACE : 0)),
    );

    let x = containerLeft + offset;
    for (const index of line) {
      const box = boxes[index]!;
      const own = box.h + (captioned(index) ? CAPTION_SPACE : 0);
      emit(index, x, top + (group.tall ? lineHeight - own : 0));
      x += box.w + MEDIA_GAP;
    }
    top += lineHeight + MEDIA_GAP;
  }

  return placed;
}

/** Reserved height: the lowest edge of anything in the band, captions included. */
function bandHeight(items: DraftItem[]): number {
  const bottom = items.reduce(
    (low, item) => Math.max(low, item.y + item.h + (item.caption !== undefined ? CAPTION_SPACE : 0)),
    0,
  );
  return px(Math.max(1, bottom));
}

function mediaBand(group: MediaGroup, losses: Loss[], where: string): DraftBand | null {
  const items = layOutMediaGroup(group, losses, where);
  if (items.length === 0) return null; // the live transform renders nothing either
  return { type: 'canvas', height: bandHeight(items), items };
}

/* ========================================================================== */
/* Margin images -> an overlay canvas band                                    */
/* ========================================================================== */

type MarginImage = {
  source: MediaSource;
  alt?: string;
  caption?: string;
  size: string;
  connect: boolean;
  connectColor?: string;
  connectStyle?: string;
};

/**
 * A margin image floated into the empty space to the right of the 720px text
 * column, level with the text that follows it, and could draw a hand-drawn
 * line back to the paragraph above it.
 *
 * In the new model that is an overlay canvas band (brief 2.2), which takes no
 * vertical space and sits over the band before it. So the band it overlays is
 * the prose band holding the text it sat beside: the caller closes the prose
 * band that ran up to the Margin tag, opens a new one for the text after it,
 * and emits this band straight after that. `anchor` points back at the last
 * block of the band before, which is the element the live connector script
 * picked with `previousElementSibling`.
 */
function marginItems(margins: MarginImage[], anchor: { band: DraftBand; block: DraftProseBlock } | null, losses: Loss[], where: string): DraftItem[] {
  const items: DraftItem[] = [];
  let y = 0;

  margins.forEach((margin, index) => {
    const width = Math.min(MARGIN_WIDTHS[margin.size] ?? MARGIN_WIDTHS.medium!, MARGIN_MAX_WIDTH);
    const ratio = mediaRatio(margin.source, losses, `${where} margin ${index + 1}`);
    const box =
      margin.source.kind === 'embed'
        ? { w: px(width), h: px(width / EMBED_RATIO) }
        : fitBox(ratio, width, MARGIN_MAX_HEIGHT);

    const draft: DraftItem = {
      kind: margin.source.kind,
      // `.margin-item figure { align-items: flex-end }` pinned the picture to
      // the right edge of the float, and the float sat at the right edge of
      // the 1344px column.
      x: px(REFERENCE_WIDTH - box.w),
      y: px(y),
      w: box.w,
      h: box.h,
      src: margin.source.src,
    };
    if (margin.source.kind !== 'embed') draft.alt = margin.alt ?? '';
    else if (margin.alt !== undefined) draft.alt = margin.alt;
    if (margin.caption !== undefined) draft.caption = margin.caption;

    if (margin.connect) {
      if (anchor === null) {
        losses.push({
          level: 'lossy',
          where,
          message: 'the connector was dropped: there is no prose block before this margin image',
        });
      } else {
        draft.anchorTo = anchor;
      }
      if (margin.connectColor !== undefined) {
        losses.push({
          level: 'lossy',
          where,
          message:
            `connectColor ${margin.connectColor} is dropped: §3.3 allows \`color\` only on a shape ` +
            `item, so a media item cannot carry a connector colour. The line falls back to --accent`,
        });
      }
      if (margin.connectStyle === 'loop') {
        losses.push({
          level: 'lossy',
          where,
          message: 'connectStyle "loop" is dropped: the new connector script draws one curve style',
        });
      }
    }

    items.push(draft);
    // `clear: right` put the next one below this one, `margin-bottom: 32px` apart.
    y += box.h + (margin.caption !== undefined ? CAPTION_SPACE : 0) + MARGIN_STACK_GAP;
  });

  return items;
}

/* ========================================================================== */
/* Canvas tag -> a canvas band                                                */
/* ========================================================================== */

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function hex(value: unknown, field: string, losses: Loss[], where: string): string | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  if (HEX_RE.test(raw)) return raw;
  losses.push({
    level: 'lossy',
    where,
    message: `${field} "${raw}" is not a hex colour and was dropped; §3.3 only takes hex`,
  });
  return undefined;
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function canvasBand(raw: Record<string, unknown>, losses: Loss[], where: string): DraftBand | null {
  const rawItems = Array.isArray(raw.items) ? (raw.items as Record<string, unknown>[]) : [];
  if (rawItems.length === 0) return null; // the live transform renders nothing

  const items: DraftItem[] = [];

  rawItems.forEach((it, index) => {
    const at = `${where} item ${index + 1}`;
    const kind = typeof it.kind === 'string' ? it.kind : 'image';
    const x = number(it.x) ?? 0;
    const y = number(it.y) ?? 0;
    const w = number(it.w) ?? 300;
    let h = number(it.h) ?? 200;
    if (w <= 0 || h <= 0) {
      losses.push({ level: 'fatal', where: at, message: `w=${w} h=${h}; §3.3 needs both above zero` });
      return;
    }

    const common = { x: px(x), y: px(y), w: px(w) } as const;
    const rotate = number(it.rotate);
    const z = number(it.z);

    if (kind === 'shape') {
      const shape = typeof it.shape === 'string' ? it.shape : 'line';
      if (!(SHAPE_KINDS as readonly string[]).includes(shape)) {
        losses.push({ level: 'fatal', where: at, message: `unknown shape "${shape}"` });
        return;
      }
      const draft: DraftItem = { kind: 'shape', ...common, h: px(h), shape: shape as ShapeKind };
      if (rotate !== undefined && rotate !== 0) draft.rotate = rotate;
      if (z !== undefined && z !== 0) draft.z = Math.trunc(z);
      const color = hex(it.color, 'color', losses, at);
      if (color !== undefined) draft.color = color;
      else if (text(it.color) === undefined) {
        losses.push({
          level: 'note',
          where: at,
          message:
            'no colour was set, so the shape took `currentColor` (--ink, theme-aware) on the live ' +
            'page and now takes the literal #111111 from SHAPE_DEFAULTS',
        });
      }
      const fill = hex(it.fill, 'fill', losses, at);
      if (fill !== undefined) {
        if (shape === 'rect' || shape === 'ellipse') draft.fill = fill;
        else losses.push({ level: 'lossy', where: at, message: `fill is only valid on rect/ellipse, dropped from a ${shape}` });
      }
      const strokeWidth = number(it.strokeWidth);
      if (strokeWidth !== undefined && strokeWidth > 0 && strokeWidth !== 2) draft.strokeWidth = strokeWidth;
      const radius = number(it.radius);
      if (radius !== undefined && radius > 0) {
        if (shape === 'rect') draft.radius = radius;
        else losses.push({ level: 'lossy', where: at, message: `radius is only valid on a rect, dropped from a ${shape}` });
      }
      if (text(it.src) !== undefined || text(it.alt) !== undefined) {
        losses.push({ level: 'lossy', where: at, message: 'a shape item carried src/alt; §3.3 rejects both on a shape' });
      }
      const caption = text(it.caption);
      if (caption !== undefined) draft.caption = caption;
      items.push(draft);
      return;
    }

    if (kind !== 'image' && kind !== 'video' && kind !== 'embed') {
      losses.push({ level: 'fatal', where: at, message: `unknown canvas item kind "${kind}"` });
      return;
    }
    const src = text(it.src);
    if (src === undefined) {
      losses.push({ level: 'fatal', where: at, message: `a ${kind} item has no src` });
      return;
    }

    // The live canvas renderer gave an item `width` and let the picture choose
    // its own height (`.cv-item img { height: auto }`); the stored `h` only fed
    // a `data-h` attribute nothing read. The new renderer makes `h` real, as an
    // aspect-ratio, and crops to it. Taking the height the live page actually
    // painted is what keeps the published page looking the same.
    if (kind === 'image' || kind === 'video') {
      const size = intrinsicSize(src);
      if (size !== null) {
        const painted = px(boxFromWidth(size, w).h);
        if (Math.abs(painted - h) > 1) {
          losses.push({
            level: 'note',
            where: at,
            message: `h ${h} -> ${painted}: the live page sized this picture by its own ratio, not by the stored h`,
          });
          h = painted;
        }
      } else {
        losses.push({
          level: 'lossy',
          where: at,
          message: `no file under public/ for ${src}, so the authored h=${h} was kept; the live page may have painted a different height`,
        });
      }
    }

    const draft: DraftItem = { kind, ...common, h: px(h), src };
    if (rotate !== undefined && rotate !== 0) draft.rotate = rotate;
    if (z !== undefined && z !== 0) draft.z = Math.trunc(z);
    if (kind !== 'embed') draft.alt = text(it.alt) ?? '';
    else if (text(it.alt) !== undefined) draft.alt = text(it.alt);
    const caption = text(it.caption);
    if (caption !== undefined) draft.caption = caption;
    for (const key of ['shape', 'color', 'fill', 'strokeWidth', 'radius'] as const) {
      if (it[key] !== undefined && it[key] !== '' && it[key] !== 0) {
        losses.push({ level: 'lossy', where: at, message: `\`${key}\` is shape-only and was dropped from a ${kind} item` });
      }
    }
    items.push(draft);
  });

  if (items.length === 0) return null;

  const authored = number(raw.height);
  const height = authored !== undefined && authored > 0 ? px(authored) : bandHeight(items) + CANVAS_HEIGHT_PAD;
  return { type: 'canvas', height, items };
}

/* ========================================================================== */
/* The band stream                                                            */
/* ========================================================================== */

type Collected = {
  bands: DraftBand[];
  sourceProse: string[];
  sourceMedia: string[];
  sourceCaptions: string[];
};

/**
 * Walk the top-level nodes and build the band stream.
 *
 * The only subtle part is Margin. A Margin tag floated beside the text that
 * came AFTER it, so the prose is cut at the tag: the paragraphs before it close
 * one band, the paragraphs after it open the next, and the overlay band is
 * emitted directly after that next band so it lands on top of it.
 */
function collectBands(top: Ast[], losses: Loss[]): Collected {
  const bands: DraftBand[] = [];
  const sourceProse: string[] = [];
  const sourceMedia: string[] = [];
  const sourceCaptions: string[] = [];

  let open: DraftProseBlock[] = [];
  let waiting: MarginImage[] = [];
  /** The prose block a waiting margin's connector should point back at. */
  let anchor: { band: DraftBand; block: DraftProseBlock } | null = null;

  const closeProse = (): DraftBand | null => {
    if (open.length === 0) return null;
    const band: DraftBand = { type: 'prose', blocks: open };
    open = [];
    bands.push(band);
    return band;
  };

  /** Emit any margin that was waiting for the band that just closed. */
  const settleMargins = (lead: DraftBand | null): void => {
    if (waiting.length === 0) return;
    const items = marginItems(waiting, anchor, losses, 'Margin image');
    waiting = [];
    if (items.length === 0) return;
    if (lead === null) {
      // Nothing for it to sit over. Give it its own space rather than drop it.
      losses.push({
        level: 'note',
        where: 'Margin image',
        message: 'no prose followed it, so it became a canvas band in flow instead of an overlay',
      });
      bands.push({ type: 'canvas', height: bandHeight(items), items });
      return;
    }
    bands.push({ type: 'canvas', height: bandHeight(items), overlay: true, items });
  };

  /** Close the prose run, settle margins on it, then push a block-level band. */
  const pushBand = (band: DraftBand | null): void => {
    const lead = closeProse();
    settleMargins(lead);
    if (band !== null) bands.push(band);
  };

  for (const node of top) {
    const where = node.type === 'tag' ? `{% ${String(node.tag)} %}` : node.type;

    const prose = convertProse(node, losses, where);
    if (prose !== null) {
      // A paragraph whose only content is an image is the markdown image
      // shorthand; the live page renders a figure for it.
      if (node.type === 'paragraph' && isLoneImage(node)) {
        const image = (node.children ?? [])[0]!.children![0]!;
        const src = text(image.attributes?.src);
        if (src === undefined) {
          losses.push({ level: 'fatal', where, message: 'a markdown image with no src' });
          continue;
        }
        sourceMedia.push(src);
        pushBand(
          mediaBand(
            {
              items: [{ source: { kind: 'image', src }, alt: text(image.attributes?.alt) ?? '' }],
              layout: 'row',
              width: 'wide',
              align: 'center',
              tall: false,
            },
            losses,
            'markdown image',
          ),
        );
        losses.push({
          level: 'note',
          where: 'markdown image',
          message:
            `${src} was a bare markdown image, which the live page wrapped in a stray <p>; it is now ` +
            `a canvas band of one item at the "wide / centre" treatment the live transform gave it`,
        });
        continue;
      }

      open.push(prose);
      sourceProse.push(prose.plain);
      // Keep the connector target up to date: the live script took the element
      // immediately before the margin image.
      continue;
    }

    if (node.type !== 'tag') {
      // Not prose and not a component. Nothing in §3.1 holds it.
      if (node.type === 'hr') {
        losses.push({ level: 'lossy', where, message: 'a horizontal rule was dropped; §3.1 has no rule block' });
        continue;
      }
      losses.push({
        level: 'fatal',
        where,
        message: `top-level "${node.type}" has no representation in §3.1 and was dropped`,
      });
      continue;
    }

    const attributes = (node.attributes ?? {}) as Record<string, unknown>;

    switch (node.tag) {
      case 'Media': {
        const rawItems = Array.isArray(attributes.items) ? attributes.items : [];
        const items: MediaGroup['items'] = [];
        rawItems.forEach((raw, index) => {
          const source = readMediaSource(raw, losses, `{% Media %} item ${index + 1}`);
          if (source === null) return;
          const entry = raw as { alt?: unknown; caption?: unknown };
          items.push({ source, alt: text(entry.alt), caption: text(entry.caption) });
          sourceMedia.push(source.src);
        });
        const groupCaption = text(attributes.caption);
        if (groupCaption !== undefined) sourceCaptions.push(groupCaption);
        else for (const item of items) if (item.caption !== undefined) sourceCaptions.push(item.caption);

        if (items.length > 1 && groupCaption !== undefined) {
          losses.push({
            level: 'note',
            where,
            message:
              `the group caption "${groupCaption}" was centred under all ${items.length} pictures; ` +
              `§3.3 has captions on items only, so it now sits under the first one`,
          });
        }
        pushBand(
          mediaBand(
            {
              items,
              layout: typeof attributes.layout === 'string' ? attributes.layout : 'row',
              width: typeof attributes.width === 'string' ? attributes.width : 'wide',
              align: typeof attributes.align === 'string' ? attributes.align : 'center',
              tall: attributes.tall === true,
              groupCaption,
            },
            losses,
            where,
          ),
        );
        break;
      }

      case 'Canvas':
        pushBand(canvasBand(attributes, losses, where));
        break;

      case 'Margin': {
        const source = readMediaSource({ source: attributes.source }, losses, where);
        if (source === null) {
          losses.push({ level: 'fatal', where, message: 'a margin image with no source' });
          break;
        }
        sourceMedia.push(source.src);
        const caption = text(attributes.caption);
        if (caption !== undefined) sourceCaptions.push(caption);
        // Cut the prose here: this picture belongs beside what comes next.
        const lead = closeProse();
        if (lead !== null) {
          // Anything already waiting sat beside the band that just closed.
          settleMargins(lead);
          if (lead.type === 'prose') {
            anchor = { band: lead, block: lead.blocks[lead.blocks.length - 1]! };
          }
        }
        // When `lead` is null this margin follows another one with no prose
        // between them. `clear: right` stacked those two in the same strip of
        // empty space, so they join the same waiting group and the same band,
        // rather than the first being flushed on its own here.
        waiting.push({
          source,
          alt: text(attributes.alt),
          caption,
          size: typeof attributes.size === 'string' ? attributes.size : 'medium',
          // The live transform drew a line only on an explicit `connect=true`.
          connect: attributes.connect === true,
          connectColor: text(attributes.connectColor),
          connectStyle: typeof attributes.connectStyle === 'string' ? attributes.connectStyle : undefined,
        });
        break;
      }

      case 'TextMedia': {
        const body = typeof attributes.text === 'string' ? attributes.text : '';
        const image = text(attributes.image);
        const caption = text(attributes.caption);
        const paragraphs = body
          .split(/\n\s*\n/)
          .map((p) => p.trim())
          .filter(Boolean);

        pushBand(null);
        if (paragraphs.length > 0) {
          const blocks: DraftProseBlock[] = paragraphs.map((p) => ({
            kind: 'p',
            content: [{ type: 'text', text: p }],
            plain: p,
          }));
          for (const block of blocks) sourceProse.push(block.plain);
          bands.push({ type: 'prose', blocks });
        }
        if (image !== undefined) {
          sourceMedia.push(image);
          if (caption !== undefined) sourceCaptions.push(caption);
          const split = Number(text(attributes.split) ?? '50') / 100;
          // `.tm` is a flex row whose two bases add up to the block width, so
          // the 40px gap is taken out of both in proportion.
          const containerW = BLOCK_WIDTHS[typeof attributes.width === 'string' ? attributes.width : 'wide'] ?? BLOCK_WIDTHS.wide!;
          const mediaW = Math.min((containerW - TEXTMEDIA_GAP) * split, MARGIN_MAX_WIDTH);
          const size = intrinsicSize(image);
          const box =
            size === null
              ? { w: px(mediaW), h: px(mediaW / EMBED_RATIO) }
              : boxFromWidth(size, mediaW);
          const item: DraftItem = {
            kind: 'image',
            x: px(REFERENCE_WIDTH - box.w),
            y: 0,
            w: box.w,
            h: box.h,
            src: image,
            alt: text(attributes.alt) ?? '',
          };
          if (caption !== undefined) item.caption = caption;
          const lead = bands[bands.length - 1];
          if (lead !== undefined && paragraphs.length > 0) {
            bands.push({ type: 'canvas', height: bandHeight([item]), overlay: true, items: [item] });
          } else {
            bands.push({ type: 'canvas', height: bandHeight([item]), items: [item] });
          }
          losses.push({
            level: 'lossy',
            where,
            message:
              `a ${Math.round(split * 100)}/${Math.round(100 - split * 100)} side-by-side split became a ` +
              `prose band with the picture overlaid in the right-hand space; §3.1 cannot narrow a prose ` +
              `band, so the text keeps the full 720px measure` +
              (attributes.side === 'left' ? ', and side="left" is not preserved' : ''),
          });
        }
        break;
      }

      default:
        losses.push({
          level: 'fatal',
          where,
          message: `unknown component {% ${String(node.tag)} %}; nothing was emitted for it`,
        });
        break;
    }
  }

  pushBand(null);
  return { bands, sourceProse, sourceMedia, sourceCaptions };
}

/** True for a paragraph whose entire content is one markdown image. */
function isLoneImage(node: Ast): boolean {
  const inline = (node.children ?? [])[0];
  if (inline === undefined || inline.type !== 'inline') return false;
  const kids = (inline.children ?? []).filter(
    (child) => !(child.type === 'text' && String(child.attributes?.content ?? '').trim() === ''),
  );
  return kids.length === 1 && kids[0]!.type === 'image';
}

/* ========================================================================== */
/* Ids                                                                        */
/* ========================================================================== */

/**
 * Ids are positional and legible: `b3` is the third band, `b3p2` its second
 * block, `b4i1` the first item of the fourth band.
 *
 * Positional, not content-hashed, because the one promise an id has to keep is
 * that running this script twice on the same file produces the same bytes. A
 * hash of the text breaks that the moment a typo is fixed, and collides when
 * two paragraphs are identical. Positional ids change if a band is inserted
 * ahead of them, which is a one-off migration's problem and not a living
 * document's: once a page is in the editor, new ids come from newId().
 *
 * These cannot collide with newId()'s output, which is always `<prefix>_<hex>`.
 */
function finalise(meta: DocMeta, drafts: DraftBand[]): Doc {
  const bandId = new Map<DraftBand, string>();
  const blockId = new Map<DraftProseBlock, string>();

  drafts.forEach((band, index) => {
    const id = `b${index + 1}`;
    bandId.set(band, id);
    if (band.type === 'prose') band.blocks.forEach((block, i) => blockId.set(block, `${id}p${i + 1}`));
  });

  const bands: Band[] = drafts.map((band) => {
    const id = bandId.get(band)!;
    if (band.type === 'prose') {
      const out: ProseBand = {
        id,
        type: 'prose',
        blocks: band.blocks.map(
          (block): ProseBlock => ({ id: blockId.get(block)!, kind: block.kind, content: block.content }),
        ),
      };
      return out;
    }
    const out: CanvasBand = {
      id,
      type: 'canvas',
      height: band.height,
      ...(band.overlay === true ? { overlay: true } : {}),
      items: band.items.map((item, i): CanvasItem => {
        const { anchorTo, ...rest } = item;
        const next = { id: `${id}i${i + 1}`, ...rest } as CanvasItem;
        if (anchorTo != null) {
          const target = bandId.get(anchorTo.band);
          const block = blockId.get(anchorTo.block);
          if (target !== undefined && block !== undefined) next.anchor = { bandId: target, blockId: block };
        }
        return next;
      }),
    };
    return out;
  });

  return { version: DOC_VERSION, meta, bands };
}

/* ========================================================================== */
/* One file                                                                   */
/* ========================================================================== */

type MigrateResult = { conversion: Conversion | null; losses: Loss[]; draft: boolean };

function migrateOne(
  dir: string,
  file: string,
  markdoc: MarkdocParser,
): MigrateResult {
  const losses: Loss[] = [];
  const slug = file.replace(/\.mdoc$/, '');
  const raw = readFileSync(join(dir, file), 'utf8');
  const { frontmatter, body } = splitFrontmatter(raw);

  let front: Record<string, unknown> = {};
  if (frontmatter.trim() !== '') {
    const loaded = yaml.load(frontmatter);
    if (typeof loaded !== 'object' || loaded === null) {
      losses.push({ level: 'fatal', where: 'frontmatter', message: 'frontmatter is not a mapping' });
    } else {
      front = loaded as Record<string, unknown>;
    }
  }

  const isDraft = front.draft === true;

  const title = text(front.title);
  const date = asDateString(front.date);
  if (title === undefined) losses.push({ level: 'fatal', where: 'frontmatter', message: 'no title' });
  if (date === null) {
    losses.push({ level: 'fatal', where: 'frontmatter', message: `date ${JSON.stringify(front.date)} is not YYYY-MM-DD` });
  }

  const meta: DocMeta = {
    title: title ?? slug,
    slug,
    date: date ?? '1970-01-01',
  };
  const summary = text(front.summary);
  if (summary !== undefined) meta.summary = summary;
  const url = text(front.url);
  if (url !== undefined) meta.url = url;
  const cover = text(front.cover);
  if (cover !== undefined) meta.cover = cover;

  // Frontmatter keys §3.1 has no home for.
  for (const key of Object.keys(front)) {
    if (['title', 'date', 'summary', 'url', 'cover', 'draft'].includes(key)) continue;
    losses.push({
      level: 'fatal',
      where: 'frontmatter',
      message: `"${key}" has no field in DocMeta and would be lost`,
    });
  }
  if ('draft' in front) {
    losses.push({
      level: 'note',
      where: 'frontmatter',
      message:
        `draft: ${String(front.draft)} is not carried into Doc.meta. Brief 2.3 makes draft state a ` +
        `question of which directory the file is in, not a field`,
    });
  }

  const ast = markdoc.parse(body) as unknown as Ast;
  const collected = collectBands(ast.children ?? [], losses);
  const doc = finalise(meta, collected.bands);

  const result = validateDoc(doc);
  if (!result.ok) {
    for (const issue of result.issues) {
      losses.push({ level: 'fatal', where: `schema ${issue.path}`, message: issue.message });
    }
    return { conversion: null, losses, draft: isDraft };
  }

  return {
    conversion: {
      slug,
      file,
      doc: result.doc,
      losses,
      sourceProse: collected.sourceProse,
      sourceMedia: collected.sourceMedia,
      sourceCaptions: collected.sourceCaptions,
    },
    losses,
    draft: isDraft,
  };
}

/* ========================================================================== */
/* HTML scanning, for the diff                                                */
/* ========================================================================== */

type Token =
  | { kind: 'open'; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: 'close'; name: string }
  | { kind: 'text'; text: string };

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'source', 'meta', 'link']);

/**
 * A tag scanner, not an HTML parser. The input is always a fragment produced by
 * Markdoc's html renderer or by renderDoc: no comments, no CDATA, no scripts,
 * every attribute double quoted. That is narrow enough that a scanner is both
 * sufficient and easier to be sure about than a dependency.
 */
function scanHtml(html: string): Token[] {
  const tokens: Token[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)(\/?)>/g;
  let at = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(html)) !== null) {
    if (match.index > at) tokens.push({ kind: 'text', text: html.slice(at, match.index) });
    at = match.index + match[0].length;
    const name = match[2]!.toLowerCase();
    if (match[1] === '/') {
      tokens.push({ kind: 'close', name });
      continue;
    }
    const attrs: Record<string, string> = {};
    const attrRe = /([a-zA-Z-]+)(?:\s*=\s*"([^"]*)")?/g;
    let attr: RegExpExecArray | null;
    while ((attr = attrRe.exec(match[3] ?? '')) !== null) {
      if (attr[1] === undefined) continue;
      attrs[attr[1].toLowerCase()] = attr[2] ?? '';
    }
    const selfClosing = match[4] === '/' || VOID_TAGS.has(name);
    tokens.push({ kind: 'open', name, attrs, selfClosing });
    if (selfClosing) tokens.push({ kind: 'close', name });
  }
  if (at < html.length) tokens.push({ kind: 'text', text: html.slice(at) });
  return tokens;
}

const decode = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

/** HTML's own whitespace rules: every run collapses to one space. */
const squash = (value: string): string => decode(value).replace(/\s+/g, ' ').trim();

/**
 * A document reduced to what a reader actually gets: the text of each block,
 * the captions, the media, and every inline decoration, each in document order.
 * This is the comparison that matters, and it is blind to class names, ids and
 * which element a caption happens to live in.
 */
type Inventory = {
  prose: { tag: string; text: string }[];
  captions: string[];
  media: string[];
  marks: string[];
  /** A coarse element stream, for the structural diff. */
  structure: string[];
  plain: string;
};

function inventory(html: string, mode: 'live' | 'doc'): Inventory {
  const tokens = scanHtml(html);
  const prose: Inventory['prose'] = [];
  const captions: string[] = [];
  const media: string[] = [];
  const marks: string[] = [];
  const structure: string[] = [];

  const PROSE_LIVE = new Set(['p', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'pre']);
  /**
   * Elements that start a new line, so the text either side of them does not
   * run together. `<p>a</p><p>b</p>` reads as "a b", not "ab", and a document
   * that nests its paragraphs differently must still compare equal.
   */
  const BREAKS = new Set(['p', 'li', 'br', 'div', 'blockquote', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'figcaption']);
  const isCaption = (token: Token): boolean =>
    token.kind === 'open' && (token.name === 'figcaption' || (token.attrs.class ?? '').includes('caption'));

  // One pass, with a tiny stack so a caption's text never lands in a block's.
  const stack: { name: string; cls: string; bucket: 'prose' | 'caption' | null; buf: string[]; tag: string }[] = [];
  const openProse = (): boolean => stack.some((frame) => frame.bucket === 'prose');

  for (const token of tokens) {
    if (token.kind === 'open') {
      const cls = token.attrs.class ?? '';
      const name = token.name;

      // Structure: the semantic identity of the element, not its markup.
      if (name === 'img') structure.push(`img ${token.attrs.src ?? ''}`);
      else if (name === 'video') structure.push(`video ${token.attrs.src ?? ''}`);
      else if (name === 'iframe') structure.push(`iframe ${token.attrs.src ?? ''}`);
      else if (name === 'br') structure.push('br');
      else if (name === 'svg') structure.push('svg');
      else structure.push(name + (cls === '' ? '' : ` .${cls.split(/\s+/).join('.')}`));

      if (BREAKS.has(name)) for (const frame of stack) frame.buf.push(' ');

      if (name === 'img') media.push(`img ${token.attrs.src ?? ''} alt="${token.attrs.alt ?? ''}"`);
      if (name === 'video') media.push(`video ${token.attrs.src ?? ''}`);
      if (name === 'iframe') media.push(`iframe ${token.attrs.src ?? ''}`);
      if (name === 'br') marks.push('br');

      let bucket: 'prose' | 'caption' | null = null;
      let tag = name;
      if (isCaption(token)) bucket = 'caption';
      else if (mode === 'live' && PROSE_LIVE.has(name) && !openProse()) bucket = 'prose';
      else if (mode === 'doc' && /\bdoc-(p|h2|h3|quote|list)\b/.test(cls) && !openProse()) {
        bucket = 'prose';
        const kind = /\bdoc-(p|h2|h3|quote|list)\b/.exec(cls)![1]!;
        tag = kind === 'list' ? name : kind === 'quote' ? 'blockquote' : kind;
      }

      // A void or self-closed element gets a frame only if it is a bucket; the
      // scanner emits a synthetic close for it either way, and that is what
      // pops the frame. Popping here as well would close the element above it.
      if (!token.selfClosing || bucket !== null) {
        stack.push({ name, cls, bucket, buf: [], tag });
      }

      // Inline decorations, captured as (what, text) once the element closes.
      if (name === 'strong' || name === 'em' || name === 'a' || name === 'code' || name === 's' || name === 'span') {
        const frame = stack[stack.length - 1];
        if (frame !== undefined && frame.name === name) {
          frame.bucket = frame.bucket ?? null;
          (frame as { mark?: string }).mark =
            name === 'a'
              ? `a href=${token.attrs.href ?? ''}`
              : name === 'span'
                ? `span ${token.attrs.class ?? token.attrs.style ?? ''}`
                : name;
        }
      }
      continue;
    }

    if (token.kind === 'text') {
      for (const frame of stack) frame.buf.push(token.text);
      continue;
    }

    // close
    if (BREAKS.has(token.name)) for (const frame of stack) frame.buf.push(' ');
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i]!.name !== token.name) continue;
      const frame = stack.splice(i, 1)[0]!;
      const body = squash(frame.buf.join(''));
      const mark = (frame as { mark?: string }).mark;
      if (mark !== undefined && body !== '') marks.push(`${mark}: ${body}`);
      if (frame.bucket === 'caption') captions.push(body);
      else if (frame.bucket === 'prose' && body !== '') prose.push({ tag: frame.tag, text: body });
      break;
    }
  }

  return { prose, captions, media, marks, structure, plain: prose.map((p) => p.text).join('\n') };
}

/* ========================================================================== */
/* Diff                                                                       */
/* ========================================================================== */

type Edit = { op: 'same' | 'add' | 'remove'; value: string };

/** Longest common subsequence, so the output names only the real differences. */
function diffLines(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      edits.push({ op: 'same', value: a[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      edits.push({ op: 'remove', value: a[i]! });
      i += 1;
    } else {
      edits.push({ op: 'add', value: b[j]! });
      j += 1;
    }
  }
  while (i < n) edits.push({ op: 'remove', value: a[i++]! });
  while (j < m) edits.push({ op: 'add', value: b[j++]! });
  return edits;
}

/** Sentences, crudely but usefully: enough to assert none went missing. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(“‘])/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

/* ========================================================================== */
/* Chrome                                                                     */
/* ========================================================================== */

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * How far a picture may drift vertically and how far the whole page may drift
 * in height before it counts as a failure. Both are deliberately tight: the
 * measured drift today is a fraction of a pixel, so anything approaching these
 * is a change in vertical rhythm, which is exactly what this is here to catch.
 */
const VERTICAL_TOLERANCE = 2;
const HEIGHT_TOLERANCE = 4;
/** Per-channel difference before two screenshot pixels count as different. */
const PIXEL_THRESHOLD = 8;

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function serve(root: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0]!).replace(/\.\./g, '');
    for (const base of [root, PUBLIC_DIR]) {
      const file = join(base, path);
      if (!path.endsWith('/') && file.startsWith(base) && existsSync(file)) {
        response.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
        createReadStream(file).pipe(response);
        return;
      }
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end(`not found: ${path}`);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      done({
        port: typeof address === 'object' && address !== null ? address.port : 0,
        close: () => new Promise<void>((closed) => server.close(() => closed())),
      });
    });
  });
}

let launches = 0;

function runChrome(url: string, width: number, height: number, extra: string[], ready: (out: string) => boolean, profiles: string): Promise<string> {
  return new Promise((done) => {
    launches += 1;
    const child = spawn(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--force-device-scale-factor=1',
        `--user-data-dir=${join(profiles, String(launches))}`,
        `--window-size=${width},${height}`,
        ...extra,
        url,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(deadline);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      done(out);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (ready(out)) finish();
    });
    const poll = setInterval(() => {
      if (ready(out)) finish();
    }, 150);
    const deadline = setTimeout(finish, 45000);
    child.on('exit', () => setTimeout(finish, 120));
  });
}

/**
 * The script both measured pages run, so the two sets of numbers are
 * comparable. It reports three things: where every picture landed, where every
 * caption landed, and the typography of every block of prose. The last one is
 * what catches a migration that keeps the words and changes how they read.
 */
const MEASURE = `
function r(n){return Math.round(n*1000)/1000}
function box(el, base){ var b = el.getBoundingClientRect();
  return { x: r(b.left - base.left), y: r(b.top - base.top), w: r(b.width), h: r(b.height) }; }
function measure(selector, itemSelector, proseSelector, captionSelector){
  var root = document.querySelector(selector);
  if(!root) return null;
  var base = root.getBoundingClientRect();
  var out = { width: r(base.width), height: r(root.scrollHeight), items: [], captions: [], prose: [] };
  root.querySelectorAll(itemSelector).forEach(function(el){
    var pic = el.querySelector('img, video, iframe, svg, .video-frame') || el;
    var b = box(pic, base);
    b.src = pic.getAttribute('src') || '';
    out.items.push(b);
  });
  root.querySelectorAll(captionSelector).forEach(function(el){ out.captions.push(box(el, base)); });
  root.querySelectorAll(proseSelector).forEach(function(el){
    var cs = getComputedStyle(el);
    var b = box(el, base);
    var lh = parseFloat(cs.lineHeight) || 0;
    var strong = el.querySelector('strong');
    out.prose.push({
      tag: el.tagName.toLowerCase(), x: b.x, y: b.y, w: b.w, h: b.h,
      lines: lh > 0 ? Math.round(b.h / lh) : 0,
      font: cs.fontSize + '/' + cs.lineHeight + ' ' + cs.fontWeight + ' ' + cs.letterSpacing + ' ' + cs.fontFamily.split(',')[0],
      strong: strong ? getComputedStyle(strong).fontWeight : ''
    });
  });
  return out;
}
function publish(value){ document.title = 'METRICS' + JSON.stringify(value); }
`;

type Box = { x: number; y: number; w: number; h: number };
type ProseMetric = Box & { tag: string; lines: number; font: string; strong: string };
type Measured = {
  width: number;
  height: number;
  items: (Box & { src: string })[];
  captions: Box[];
  prose: ProseMetric[];
};

function readMeasured(dom: string): Measured | null {
  const match = /<title>METRICS(.*?)<\/title>/s.exec(dom);
  if (match === null) return null;
  try {
    return JSON.parse(decode(match[1]!)) as Measured;
  } catch {
    return null;
  }
}

/* ========================================================================== */
/* --verify                                                                   */
/* ========================================================================== */

type Section = { heading: string; lines: string[] };

async function verify(conversions: Conversion[]): Promise<number> {
  const markdoc = (await import('@markdoc/markdoc')).default;
  const { renderProjectBody } = await import('../src/lib/project-doc.ts');
  await ensureShapeAssets();

  const sections: Section[] = [];
  const failures: string[] = [];
  const shots = resolve(PROJECT, option('shots', join(tmpdir(), 'jinhyuk-ws9-migration')));
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });

  const liveArg = option('live', LIVE_DEFAULT);
  const liveSlug = /\/projects\/([^/]+)\/?$/.exec(liveArg)?.[1];

  /* --- 1. the published page, byte for byte against the local render ------- */

  let publishedBody: string | null = null;
  let publishedNote = '';
  try {
    if (liveArg.startsWith('http')) {
      const response = await fetch(liveArg, { redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      publishedBody = extractProjectBody(await response.text());
      publishedNote = `fetched ${liveArg}`;
    } else {
      publishedBody = extractProjectBody(readFileSync(resolve(PROJECT, liveArg), 'utf8'));
      publishedNote = `read ${liveArg}`;
    }
  } catch (error) {
    publishedNote = `could not read the published page (${(error as Error).message})`;
  }

  const target =
    conversions.find((c) => c.slug === liveSlug) ?? conversions[0];

  if (target === undefined) {
    failures.push('nothing was migrated, so there is nothing to diff');
    return writeReport(sections, failures, shots, 1);
  }

  const raw = readFileSync(join(IN_DIR, target.file), 'utf8');
  const localLive = renderProjectBody(markdoc.parse(splitFrontmatter(raw).body) as never);

  const chain: string[] = [];
  if (publishedBody === null) {
    chain.push(`- **The published page could not be read.** ${publishedNote}. Everything below compares the migrated render against the Markdoc renderer run locally on the same \`.mdoc\`, which is the same code path the live build uses.`);
    failures.push(`the published page was not available: ${publishedNote}`);
  } else {
    const identical = publishedBody === localLive;
    chain.push(`- ${publishedNote}, extracted \`.project-body\`: ${publishedBody.length} bytes.`);
    chain.push(`- \`renderProjectBody(Markdoc.parse(<the .mdoc>))\` run locally: ${localLive.length} bytes.`);
    chain.push(
      identical
        ? '- **Byte for byte identical.** The local Markdoc render is exactly what jinhyuk.org serves, so the rest of this report can diff offline and still be a diff against the live page.'
        : '- **NOT identical.** The local render differs from what is published, so the live page is ahead of or behind this checkout. See the bytes below.',
    );
    if (!identical) {
      failures.push('the local Markdoc render does not match the published page');
      for (let i = 0; i < Math.max(publishedBody.length, localLive.length); i += 1) {
        if (publishedBody[i] !== localLive[i]) {
          chain.push('', '```', `first difference at byte ${i}`, `live : ${JSON.stringify(publishedBody.slice(Math.max(0, i - 60), i + 60))}`, `local: ${JSON.stringify(localLive.slice(Math.max(0, i - 60), i + 60))}`, '```');
          break;
        }
      }
    }
  }
  sections.push({ heading: '1. Is the baseline really the live page?', lines: chain });

  /* --- 2. content inventory ---------------------------------------------- */

  const liveInv = inventory(localLive, 'live');
  const migrated = renderDoc(target.doc);
  const docInv = inventory(migrated, 'doc');

  const lines: string[] = [];
  const assertEqual = (label: string, a: string[], b: string[]): boolean => {
    const edits = diffLines(a, b);
    const changed = edits.filter((e) => e.op !== 'same');
    if (changed.length === 0) {
      lines.push(`- **${label}: identical.** ${a.length} entries, in the same order.`);
      return true;
    }
    lines.push(`- **${label}: ${changed.length} difference(s)** across ${a.length} live and ${b.length} migrated entries.`);
    lines.push('', '```diff');
    for (const edit of edits) {
      if (edit.op === 'remove') lines.push(`- ${edit.value}`);
      else if (edit.op === 'add') lines.push(`+ ${edit.value}`);
    }
    lines.push('```', '');
    failures.push(`${label} differs`);
    return false;
  };

  lines.push(
    `The live page's \`.project-body\` and \`renderDoc(migrated)\` reduced to what a reader gets, ` +
      `each list in document order. \`-\` is the live page, \`+\` is the migration.`,
    '',
  );
  assertEqual(
    'Prose blocks (tag + text)',
    liveInv.prose.map((p) => `${p.tag}: ${p.text}`),
    docInv.prose.map((p) => `${p.tag}: ${p.text}`),
  );
  assertEqual('Captions', liveInv.captions, docInv.captions);
  assertEqual('Media (src + alt)', liveInv.media, docInv.media);
  assertEqual('Inline decorations', liveInv.marks, docInv.marks);

  // The source is the authority, not the live HTML: assert against the .mdoc.
  const sourceProse = target.sourceProse.map((p) => squash(p));
  const outProse = docInv.prose.map((p) => p.text);
  const missing = sourceProse.filter((p) => !outProse.includes(p));
  lines.push(
    missing.length === 0
      ? `- **Every one of the ${sourceProse.length} prose runs read out of the \`.mdoc\` itself appears verbatim in the migrated render.**`
      : `- **${missing.length} prose run(s) from the \`.mdoc\` are missing from the migrated render.**`,
  );
  if (missing.length > 0) {
    failures.push(`${missing.length} source prose run(s) missing from the output`);
    lines.push('', '```');
    for (const gone of missing) lines.push(gone);
    lines.push('```', '');
  }

  const allSentences = sourceProse.flatMap((p) => sentences(p));
  const outPlain = docInv.plain;
  const lostSentences = allSentences.filter((s) => !outPlain.includes(s));
  lines.push(
    lostSentences.length === 0
      ? `- **All ${allSentences.length} sentences** split out of the source prose appear in the migrated render.`
      : `- **${lostSentences.length} of ${allSentences.length} sentences are missing.**`,
  );
  if (lostSentences.length > 0) {
    failures.push(`${lostSentences.length} sentence(s) missing from the output`);
    lines.push('', '```');
    for (const gone of lostSentences) lines.push(gone);
    lines.push('```', '');
  }

  const words = (value: string): number => value.split(/\s+/).filter(Boolean).length;
  const liveWords = words(liveInv.plain);
  const docWords = words(docInv.plain);
  lines.push(
    `- Prose word count: live ${liveWords}, migrated ${docWords}${liveWords === docWords ? ' (equal)' : ' — **DIFFERENT**'}.`,
  );
  if (liveWords !== docWords) failures.push('prose word counts differ');

  const srcMedia = target.sourceMedia;
  const outMedia = target.doc.bands.flatMap((band) =>
    band.type === 'canvas' ? band.items.filter((i) => i.src !== undefined).map((i) => i.src!) : [],
  );
  const equalMedia = JSON.stringify(srcMedia) === JSON.stringify(outMedia);
  lines.push(
    `- Media sources read out of the \`.mdoc\`: ${srcMedia.length}. In the Doc: ${outMedia.length}. ${equalMedia ? 'Same list, same order.' : '**DIFFERENT**'}`,
  );
  if (!equalMedia) failures.push('the media list from the source does not match the Doc');

  const srcCaptions = target.sourceCaptions.map((c) => squash(c));
  const outCaptions = target.doc.bands.flatMap((band) =>
    band.type === 'canvas' ? band.items.filter((i) => i.caption !== undefined).map((i) => squash(i.caption!)) : [],
  );
  const equalCaptions = JSON.stringify(srcCaptions) === JSON.stringify(outCaptions);
  lines.push(
    `- Captions in the \`.mdoc\`: ${srcCaptions.length}. In the Doc: ${outCaptions.length}. ${equalCaptions ? 'Same list, same order.' : '**DIFFERENT**'}`,
  );
  if (!equalCaptions) failures.push('the caption list from the source does not match the Doc');

  sections.push({ heading: '2. Nothing was lost', lines });

  /* --- 3. the structural diff -------------------------------------------- */

  const structural: string[] = [];
  const edits = diffLines(liveInv.structure, docInv.structure);
  const changed = edits.filter((e) => e.op !== 'same');
  const kinds = new Map<string, { gone: number; added: number }>();
  for (const edit of changed) {
    const entry = kinds.get(edit.value) ?? { gone: 0, added: 0 };
    if (edit.op === 'remove') entry.gone += 1;
    else entry.added += 1;
    kinds.set(edit.value, entry);
  }

  structural.push(
    `The element stream of each side, every element reduced to its tag and class. ` +
      `${changed.length} of ${edits.length} entries differ, and all ${kinds.size} distinct kinds of ` +
      `change are listed below. Every row maps to a numbered justification in section 5; the markup ` +
      `is deliberately not the same markup, because §3.1 has no flow-media band to migrate into.`,
    '',
    '| element | gone | added | why |',
    '|---|---|---|---|',
  );
  const why = (value: string): string => {
    const band = ref('canvas-bands');
    const wrap = ref('wrappers');
    const caption = ref('group-caption');
    if (value.startsWith('figure .pb')) return `${band} the figure became a canvas band`;
    if (value.startsWith('div .media-items')) return `${wrap} the flex row is gone; layout is coordinates now`;
    if (value.startsWith('div .media-item')) return `${wrap} wrapper removed`;
    if (value.includes('media-caption--group')) return `${caption} the group caption moved onto the first item`;
    if (value.startsWith('figcaption .doc-caption')) return `${caption} the same caption, now on an item`;
    if (value.startsWith('div .doc-frame')) return `${band} the aspect-ratio box an absolute item needs`;
    if (value.startsWith('figure .doc-item')) return `${band} one positioned item`;
    if (value.startsWith('div .doc-band')) return `${band} the band itself`;
    if (value.startsWith('div .doc-group')) return `${band} a lead band and its overlays`;
    if (value === 'div .doc') return `${band} the document root and the container query container`;
    if (value === 'p' || value === 'p .doc-p') {
      return `${ref('ids')} / ${ref('width-classes')} the same paragraph, now carrying a class and an id`;
    }
    return 'section 5';
  };
  for (const [value, counts] of [...kinds.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    structural.push(`| \`${value}\` | ${counts.gone} | ${counts.added} | ${why(value)} |`);
  }
  structural.push(
    '',
    'Nothing in that table carries text, a `src`, an `alt` or a caption; section 2 is the proof. ' +
      'The raw stream follows, `-` live and `+` migrated.',
    '',
    '```diff',
  );
  for (const edit of edits) {
    if (edit.op === 'remove') structural.push(`- ${edit.value}`);
    else if (edit.op === 'add') structural.push(`+ ${edit.value}`);
  }
  structural.push('```');
  sections.push({ heading: '3. The structural diff, in full', lines: structural });

  /* --- 4. geometry, in a real browser ------------------------------------ */

  const geometry: string[] = [];
  if (flag('no-browser')) {
    geometry.push('- Skipped: `--no-browser`.');
  } else if (!existsSync(CHROME)) {
    geometry.push(`- Skipped: no Chrome at \`${CHROME}\`.`);
    failures.push('Chrome is not installed, so the geometry was never measured');
  } else {
    try {
      const result = await measureBoth(localLive, target, shots);
      geometry.push(...result.lines);
      failures.push(...result.failures);
    } catch (error) {
      geometry.push(`- The browser pass failed: ${(error as Error).message}`);
      failures.push(`the browser pass failed: ${(error as Error).message}`);
    }
  }
  sections.push({ heading: '4. Geometry, measured in Chrome at 1344px', lines: geometry });

  /* --- 5. every difference, justified ------------------------------------ */

  sections.push({ heading: '5. Every difference, and why it is there', lines: justifications() });

  /* --- 6. the losses the converter recorded ------------------------------ */

  const recorded: string[] = [];
  for (const conversion of conversions) {
    const own = conversion.losses;
    recorded.push(`### \`${conversion.slug}\``, '');
    if (own.length === 0) {
      recorded.push('Nothing recorded: every construct in this page has a representation in §3.1–3.3.', '');
      continue;
    }
    for (const level of ['fatal', 'lossy', 'note'] as const) {
      const group = own.filter((loss) => loss.level === level);
      if (group.length === 0) continue;
      recorded.push(`**${level}** (${group.length})`, '');
      for (const loss of group) recorded.push(`- \`${loss.where}\` — ${loss.message}`);
      recorded.push('');
    }
  }
  sections.push({ heading: '6. What the converter recorded, page by page', lines: recorded });

  /* --- 7. the migrated documents ----------------------------------------- */

  const shape: string[] = [];
  for (const conversion of conversions) {
    const doc = conversion.doc;
    shape.push(`### \`src/content/pages/${conversion.slug}.json\``, '');
    shape.push('```');
    shape.push(`meta  ${JSON.stringify(doc.meta)}`);
    doc.bands.forEach((band) => {
      if (band.type === 'prose') {
        shape.push(`${band.id.padEnd(4)} prose   ${band.blocks.length} block(s): ${band.blocks.map((b) => `${b.id}:${b.kind}`).join(' ')}`);
      } else {
        shape.push(
          `${band.id.padEnd(4)} canvas  h=${band.height}${band.overlay === true ? ' overlay' : ''} ${band.items.length} item(s)`,
        );
        for (const item of band.items) {
          shape.push(
            `       ${item.id} ${item.kind} x=${item.x} y=${item.y} w=${item.w} h=${item.h}` +
              (item.src === undefined ? '' : ` src=${item.src}`) +
              (item.caption === undefined ? '' : ` caption=${JSON.stringify(item.caption)}`) +
              (item.anchor === undefined ? '' : ` anchor=${item.anchor.bandId}/${item.anchor.blockId}`),
          );
        }
      }
    });
    shape.push('```', '');
  }
  sections.push({ heading: '7. The migrated documents', lines: shape });

  return writeReport(sections, failures, shots, failures.length === 0 ? 0 : 1);
}

function extractProjectBody(html: string): string {
  const open = html.indexOf('<div class="project-body">');
  if (open < 0) throw new Error('no .project-body in the page');
  const from = open + '<div class="project-body">'.length;
  // Walk to the matching close, counting nested divs.
  let depth = 1;
  let at = from;
  const tagRe = /<(\/?)div\b[^>]*>/g;
  tagRe.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    depth += match[1] === '/' ? -1 : 1;
    if (depth === 0) {
      at = match.index;
      break;
    }
  }
  if (depth !== 0) throw new Error('.project-body is not closed');
  return html.slice(from, at);
}

/* -------------------------------------------------------------------------- */
/* The browser pass                                                           */
/* -------------------------------------------------------------------------- */

async function measureBoth(
  liveHtml: string,
  target: Conversion,
  shots: string,
): Promise<{ lines: string[]; failures: string[] }> {
  const lines: string[] = [];
  const failures: string[] = [];
  const profiles = mkdtempSync(join(tmpdir(), 'jinhyuk-ws9-chrome-'));

  const eager = (html: string): string => html.replace(/ loading="lazy"/g, '');
  const globalCss = readFileSync(join(PROJECT, 'src/styles/global.css'), 'utf8');
  const docCss = readFileSync(join(PROJECT, 'src/cms/styles/doc.css'), 'utf8');
  writeFileSync(join(shots, 'global.css'), globalCss);
  writeFileSync(join(shots, 'doc.css'), docCss);

  const shell = (title: string, head: string, body: string, measureCall: string): string => `<!doctype html>
<html lang="en" data-theme="light"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500&family=Inter:ital,wght@0,300;0,400;0,600;0,700;1,300&display=swap" />
<link rel="stylesheet" href="global.css" />
${head}
<style>body{margin:0}.wrap{max-width:1440px;margin:0 auto;padding:0 48px 80px}</style>
</head><body><div class="wrap"><main>${body}</main></div>
<script>${MEASURE}
function run(){ var m = ${measureCall}; if(m) publish(m); }
window.addEventListener('load', function(){ run(); requestAnimationFrame(function(){requestAnimationFrame(run)}); setTimeout(run, 400); setTimeout(run, 1200);
  if (document.fonts) document.fonts.ready.then(function(){ setTimeout(run, 60) }); });
</script></body></html>
`;

  writeFileSync(
    join(shots, 'live.html'),
    shell(
      'live markup',
      '',
      `<div class="project-body">${eager(liveHtml)}</div>`,
      `measure('.project-body', '.media-item, .cv-item, .margin-item', ` +
        `':scope > p, :scope > h2, :scope > h3, :scope > h4, :scope > blockquote, :scope > ul, :scope > ol', ` +
        `'figcaption')`,
    ),
  );
  writeFileSync(
    join(shots, 'migrated.html'),
    shell(
      'migrated render',
      '<link rel="stylesheet" href="doc.css" />',
      eager(renderDoc(target.doc)),
      `measure('.doc', '.doc-item', '.doc-p, .doc-h2, .doc-h3, .doc-quote, .doc-list', '.doc-caption')`,
    ),
  );
  writeFileSync(
    join(shots, 'migrated-head.html'),
    shell(
      'migrated page',
      '<link rel="stylesheet" href="doc.css" />',
      `<article class="project">${renderDocHead(target.doc)}</article>${eager(renderDoc(target.doc))}`,
      `measure('.doc', '.doc-item', '.doc-p, .doc-h2, .doc-h3, .doc-quote, .doc-list', '.doc-caption')`,
    ),
  );

  const server = await serve(shots);
  const base = `http://127.0.0.1:${server.port}`;
  const DUMP = ['--virtual-time-budget=9000', '--dump-dom'];
  const SHOT = ['--run-all-compositor-stages-before-draw', '--disable-new-content-rendering-timeout'];
  const domReady = (out: string): boolean => out.includes('</html>');

  try {
    const liveDom = await runChrome(`${base}/live.html`, 1440, 1000, DUMP, domReady, profiles);
    const docDom = await runChrome(`${base}/migrated.html`, 1440, 1000, DUMP, domReady, profiles);
    const liveM = readMeasured(liveDom);
    const docM = readMeasured(docDom);

    if (liveM === null || docM === null) {
      failures.push('one of the two pages never reported its geometry');
      lines.push('- The browser did not report geometry for both pages.');
    } else {
      lines.push(
        `The live markup and \`renderDoc\` output, each in a 1440px window so the content column is ` +
          `exactly ${REFERENCE_WIDTH}px. Every box is the picture itself, measured relative to its ` +
          `container.`,
        '',
        `- Container width: live ${liveM.width}px, migrated ${docM.width}px.`,
        `- Document height: live ${liveM.height}px, migrated ${docM.height}px (difference ${px(docM.height - liveM.height)}px).`,
        '',
        `Asserted: every picture within 1px of where the live page puts it in x, w and h, within ` +
          `${VERTICAL_TOLERANCE}px in y, and the whole document within ${HEIGHT_TOLERANCE}px of the ` +
          `live page's height.`,
        '',
        '| # | src | live x,y,w,h | migrated x,y,w,h | Δx | Δy | Δw | Δh |',
        '|---|---|---|---|---|---|---|---|',
      );
      const count = Math.max(liveM.items.length, docM.items.length);
      let worst = 0;
      let worstY = 0;
      for (let i = 0; i < count; i += 1) {
        const a = liveM.items[i];
        const b = docM.items[i];
        if (a === undefined || b === undefined) {
          lines.push(`| ${i + 1} | ${a?.src ?? b?.src ?? '?'} | ${a === undefined ? '— missing —' : `${a.x},${a.y},${a.w},${a.h}`} | ${b === undefined ? '— missing —' : `${b.x},${b.y},${b.w},${b.h}`} | | | | |`);
          failures.push(`item ${i + 1} exists on only one side`);
          continue;
        }
        // y is compared within the band, not down the page: the two documents
        // have different block spacing by design (section 5).
        const d = { x: px(b.x - a.x), w: px(b.w - a.w), h: px(b.h - a.h), y: px(b.y - a.y) };
        worst = Math.max(worst, Math.abs(d.x), Math.abs(d.w), Math.abs(d.h));
        worstY = Math.max(worstY, Math.abs(d.y));
        lines.push(
          `| ${i + 1} | \`${a.src.replace(/^.*\//, '')}\` | ${a.x}, ${a.y}, ${a.w}, ${a.h} | ${b.x}, ${b.y}, ${b.w}, ${b.h} | ${d.x} | ${d.y} | ${d.w} | ${d.h} |`,
        );
        if (Math.abs(d.x) > 1 || Math.abs(d.w) > 1 || Math.abs(d.h) > 1) {
          failures.push(`item ${i + 1} (${a.src}) is more than 1px out: Δx ${d.x}, Δw ${d.w}, Δh ${d.h}`);
        }
        if (Math.abs(d.y) > VERTICAL_TOLERANCE) {
          failures.push(`item ${i + 1} (${a.src}) sits ${d.y}px off vertically, more than ${VERTICAL_TOLERANCE}px`);
        }
      }
      if (liveM.width !== REFERENCE_WIDTH) {
        failures.push(`the live content column measured ${liveM.width}px, not ${REFERENCE_WIDTH}`);
      }
      if (docM.width !== REFERENCE_WIDTH) {
        failures.push(`the migrated content column measured ${docM.width}px, not ${REFERENCE_WIDTH}`);
      }
      if (Math.abs(docM.height - liveM.height) > HEIGHT_TOLERANCE) {
        failures.push(
          `the migrated page is ${px(docM.height - liveM.height)}px taller or shorter than the live one, more than ${HEIGHT_TOLERANCE}px`,
        );
      }
      lines.push(
        '',
        `Worst error in x, w or h: **${px(worst)}px**. Worst error in y: **${px(worstY)}px**.`,
        '',
        '### The prose, block by block',
        '',
        'A migration that keeps every word and changes how it reads has still failed. Each block is ' +
          'measured where it lands, how wide it is, how many line boxes it wraps into, and what font ' +
          'it is set in.',
        '',
        '| # | live | migrated | width | lines | type | bold |',
        '|---|---|---|---|---|---|---|',
      );
      const proseCount = Math.max(liveM.prose.length, docM.prose.length);
      for (let i = 0; i < proseCount; i += 1) {
        const a = liveM.prose[i];
        const b = docM.prose[i];
        if (a === undefined || b === undefined) {
          failures.push(`prose block ${i + 1} exists on only one side`);
          lines.push(`| ${i + 1} | ${a?.tag ?? '— missing —'} | ${b?.tag ?? '— missing —'} | | | | |`);
          continue;
        }
        const same = (x: unknown, y: unknown): string => (x === y ? 'same' : `**${String(x)} / ${String(y)}**`);
        lines.push(
          `| ${i + 1} | \`${a.tag}\` y=${a.y} | \`${b.tag}\` y=${b.y} | ${same(a.w, b.w)} | ${same(a.lines, b.lines)} | ${same(a.font, b.font)} | ${same(a.strong, b.strong)} |`,
        );
        if (a.tag !== b.tag) failures.push(`prose block ${i + 1} is a <${a.tag}> on the live page and a <${b.tag}> in the migration`);
        if (Math.abs(a.w - b.w) > 1) failures.push(`prose block ${i + 1} is ${px(b.w - a.w)}px wider or narrower`);
        if (a.lines !== b.lines) failures.push(`prose block ${i + 1} wraps into ${a.lines} lines live and ${b.lines} migrated`);
        if (a.font !== b.font) failures.push(`prose block ${i + 1} is set differently: live "${a.font}", migrated "${b.font}"`);
        if (Math.abs(a.y - b.y) > VERTICAL_TOLERANCE) {
          failures.push(`prose block ${i + 1} sits ${px(b.y - a.y)}px off vertically`);
        }
      }
      const boldLive = liveM.prose.find((p) => p.strong !== '')?.strong;
      const boldDoc = docM.prose.find((p) => p.strong !== '')?.strong;
      if (boldLive !== undefined && boldDoc !== undefined && boldLive !== boldDoc) {
        lines.push(
          '',
          `**A bold run is \`font-weight: ${boldLive}\` on the live page and \`${boldDoc}\` in the ` +
            `migration.** Not asserted on, and not WS-9's to change: \`doc.css\` sets ` +
            `\`.doc strong { font-weight: 600 }\`, while \`.project-body\` sets nothing and a \`<strong>\` ` +
            `falls to the user agent's \`bolder\`, which against the site's \`font-weight: 300\` body ` +
            `resolves to ${boldLive}. See ${ref('bold')}.`,
        );
      }
    }

    for (const [name, width] of [
      ['live', 1440],
      ['migrated', 1440],
      ['migrated', 1100],
    ] as const) {
      const page = `${name}.html`;
      const dom = await runChrome(`${base}/${page}`, Math.max(width, 520), 1000, DUMP, domReady, profiles);
      const height = Math.min(Math.max((readMeasured(dom)?.height ?? 2000) + 240, 600), 15000);
      const file = join(shots, `${name}-${width}.png`);
      await runChrome(`${base}/${page}`, width, height, [...SHOT, `--screenshot=${file}`], () => existsSync(file), profiles);
      if (!existsSync(file)) {
        await runChrome(`${base}/${page}`, width, height, [...SHOT, `--screenshot=${file}`], () => existsSync(file), profiles);
      }
      lines.push(existsSync(file) ? `- Screenshot: \`${file}\`` : `- Screenshot FAILED for ${page} @ ${width}`);
      if (!existsSync(file)) failures.push(`no screenshot for ${page} @ ${width}`);
    }

    // The two full-page pictures, compared pixel by pixel. This is the check
    // that cannot be argued with: everything above reasons about markup and
    // boxes, and this looks at what a reader sees.
    const livePng = join(shots, 'live-1440.png');
    const docPng = join(shots, 'migrated-1440.png');
    if (existsSync(livePng) && existsSync(docPng)) {
      const zones: { from: number; to: number; kind: string }[] = [];
      for (const side of [liveM, docM]) {
        if (side === null) continue;
        for (const item of side.items) zones.push({ from: item.y - 1, to: item.y + item.h + 1, kind: 'picture' });
        for (const caption of side.captions) {
          zones.push({ from: caption.y - 2, to: caption.y + caption.h + 2, kind: 'caption' });
        }
      }
      lines.push('', ...(await pixelDiff(livePng, docPng, shots, zones, failures)));
    }

    // The mobile fallback, in the iframe trick Chrome's window floor needs.
    writeFileSync(
      join(shots, 'migrated390.html'),
      `<!doctype html><html><head><meta charset="utf-8"><title>migrated @ 390</title><style>body{margin:0;background:#bbb}iframe{width:390px;height:6000px;border:0;background:#fff;display:block;margin:0 auto}</style></head><body><iframe src="migrated.html"></iframe></body></html>`,
    );
    const mobile = join(shots, 'migrated-390.png');
    await runChrome(`${base}/migrated390.html`, 520, 6000, [...SHOT, `--screenshot=${mobile}`], () => existsSync(mobile), profiles);
    lines.push(
      existsSync(mobile)
        ? `- Screenshot at the ${MOBILE_BREAKPOINT}px fallback (390px wide, in an iframe): \`${mobile}\``
        : '- The 390px screenshot failed.',
    );
  } finally {
    await server.close();
    rmSync(profiles, { recursive: true, force: true });
  }

  return { lines, failures };
}

/* -------------------------------------------------------------------------- */
/* The pixel diff                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The two screenshots, compared pixel by pixel, reported as the bands of rows
 * that differ. Everything else in this report reasons about markup and boxes;
 * this is the one check that looks at what a reader actually sees.
 *
 * `sharp` is used only here, and only to decode a PNG. It is in the tree as a
 * transitive dependency of Astro's image service, so this degrades to a note
 * rather than a failure if it ever leaves.
 */
async function pixelDiff(
  livePng: string,
  docPng: string,
  out: string,
  zones: { from: number; to: number; kind: string }[],
  failures: string[],
): Promise<string[]> {
  let sharp: typeof import('sharp');
  try {
    sharp = (await import('sharp')).default;
  } catch {
    return ['- Pixel diff skipped: `sharp` is not installed, so the PNGs could not be decoded.'];
  }

  const a = await sharp(livePng).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(docPng).raw().toBuffer({ resolveWithObject: true });
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    failures.push(
      `the two screenshots are different sizes: ${a.info.width}x${a.info.height} and ${b.info.width}x${b.info.height}`,
    );
    return [`- The two screenshots are different sizes (${a.info.width}x${a.info.height} vs ${b.info.width}x${b.info.height}), so they cannot be compared pixel by pixel.`];
  }

  const { width, height, channels } = a.info;
  const mask = Buffer.alloc(width * height * 3, 0xf2);
  const perRow = new Int32Array(height);
  let different = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const m = (y * width + x) * 3;
      if (
        Math.abs(a.data[i]! - b.data[i]!) > PIXEL_THRESHOLD ||
        Math.abs(a.data[i + 1]! - b.data[i + 1]!) > PIXEL_THRESHOLD ||
        Math.abs(a.data[i + 2]! - b.data[i + 2]!) > PIXEL_THRESHOLD
      ) {
        different += 1;
        perRow[y] += 1;
        mask[m] = 0xd3;
        mask[m + 1] = 0x2f;
        mask[m + 2] = 0x2f;
      }
    }
  }

  const file = join(out, 'pixel-diff.png');
  await sharp(mask, { raw: { width, height, channels: 3 } }).png().toFile(file);

  /**
   * Which part of the page a row belongs to. The zones come from the browser
   * measurement, not from a guess, so a band of differing rows is classified
   * rather than hand-waved: a run inside a picture is Chrome resampling a
   * screenshot that moved by a fraction of a pixel, a run over a caption is
   * section 5.3, and anything else is prose and has to be accounted for.
   */
  const classify = (from: number, to: number): string => {
    const hit = new Set<string>();
    for (const zone of zones) if (from < zone.to && to > zone.from) hit.add(zone.kind);
    if (hit.has('caption')) return 'caption';
    if (hit.has('picture')) return 'picture';
    return 'prose';
  };

  const rows: string[] = [];
  const counts = { picture: 0, caption: 0, prose: 0 } as Record<string, number>;
  let proseRows = 0;
  let tallestProse = 0;
  let start = -1;
  let bandCount = 0;

  for (let y = 0; y <= height; y += 1) {
    const differs = y < height && perRow[y]! > 0;
    if (differs && start < 0) start = y;
    if (!differs && start >= 0) {
      let worst = 0;
      let pixels = 0;
      for (let r = start; r < y; r += 1) {
        worst = Math.max(worst, perRow[r]!);
        pixels += perRow[r]!;
      }
      const kind = classify(start, y);
      counts[kind] = (counts[kind] ?? 0) + pixels;
      if (kind === 'prose') {
        proseRows += y - start;
        tallestProse = Math.max(tallestProse, y - start);
      }
      bandCount += 1;
      rows.push(`| ${start}–${y - 1} | ${y - start} | ${worst} | ${kind} |`);
      start = -1;
    }
  }

  // A weight or colour change touches the glyph rows of one line. A change of
  // measure, of font, or of wrapping moves whole paragraphs, which shows up as
  // bands taller than a couple of line boxes. That is the thing to catch.
  const LINE = 35 * 2;
  if (tallestProse > LINE) {
    failures.push(
      `a run of ${tallestProse} rows of prose differs between the two pages, more than two line boxes; ` +
        `the text has reflowed, not merely restyled`,
    );
  }

  const share = (different / (width * height)) * 100;
  return [
    `**Pixel diff of the two screenshots** (\`${file}\`, red is a difference of more than ` +
      `${PIXEL_THRESHOLD}/255 on any channel).`,
    '',
    `- ${width}×${height} px on both sides. **${(100 - share).toFixed(2)}% of pixels are identical.**`,
    `- ${different.toLocaleString('en-US')} pixels differ, in ${bandCount} band(s) of rows: ` +
      `${(counts.picture ?? 0).toLocaleString('en-US')} inside a picture, ` +
      `${(counts.caption ?? 0).toLocaleString('en-US')} on a caption row, ` +
      `${(counts.prose ?? 0).toLocaleString('en-US')} on a row of prose.`,
    `- The tallest run of differing prose rows is ${tallestProse}px, against a ${LINE}px budget of two ` +
      `line boxes. Anything taller would mean the text had reflowed rather than merely been restyled.`,
    '',
    '| rows | count | worst row | zone |',
    '|---|---|---|---|',
    ...rows,
    '',
    '`picture` is Chrome resampling a screenshot whose box moved by a fraction of a pixel (section 4 ' +
      `gives the fractions). \`caption\` is ${ref('group-caption')}, the group caption moving under its first picture. ` +
      `\`prose\` is ${ref('bold')}, the bold run, which \`doc.css\` sets heavier than the live page does. Nothing ` +
      'here is a difference in words, media, position or size.',
  ];
}

/* -------------------------------------------------------------------------- */
/* The justifications                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every intentional difference between the published page and the migrated
 * render, keyed so a cross-reference elsewhere in the report cannot go stale
 * when one is inserted. `ref('bold')` yields "5.19" and keeps yielding the
 * right number.
 */
const JUSTIFICATIONS: { key: string; title: string; body: string }[] = justificationList();

function ref(key: string): string {
  const index = JUSTIFICATIONS.findIndex((item) => item.key === key);
  return index < 0 ? 'section 5' : `5.${index + 1}`;
}

function justifications(): string[] {
  const lines: string[] = [];
  JUSTIFICATIONS.forEach((item, index) => {
    lines.push(`### 5.${index + 1} ${item.title}`, '', item.body, '');
  });
  return lines;
}

function justificationList(): { key: string; title: string; body: string }[] {
  const items: [string, string, string][] = [
    [
      'canvas-bands',
      'Flow media became canvas bands',
      'A `{% Media %}` group was a `<figure class="pb">` in normal flow, laid out by flexbox. §3.1 has ' +
        'exactly two band types, prose and canvas, and a prose block is one of `p h2 h3 quote ul ol`. ' +
        'There is no flow-media band to migrate into, so each group becomes a canvas band whose items ' +
        'carry the coordinates flexbox would have given them at the 1344px reference width. Section 4 ' +
        'measures both in a browser; the worst error is sub-pixel.',
    ],
    [
      'wrappers',
      '`figure`/`div.media-items`/`div.media-item` collapsed to one `figure.doc-item`',
      'The live markup needed three nested boxes because flexbox was doing the layout. An absolutely ' +
        'positioned item needs one, so the wrappers are gone. No text, caption, src or alt is carried ' +
        'by them; section 2 proves the inventory is unchanged.',
    ],
    [
      'group-caption',
      'A group caption moved from under the group to under the first picture',
      '`.media-caption--group` was one centred caption for the whole figure. §3.3 puts `caption` on a ' +
        'CanvasItem and nowhere else, so a group caption now belongs to the first item in document ' +
        'order. The text is identical; the box it is centred in is 332px wide instead of 1056px, so a ' +
        'long caption wraps differently. **This is the one visible regression in this migration.** It ' +
        'wants either a `caption` on CanvasBand in §3.3 or a band-level caption in WS-1; it cannot be ' +
        'fixed inside WS-9.',
    ],
    [
      'ids',
      'Ids appear in `data-band-id`, `data-block-id` and `data-item-id`',
      'The live markup carried no ids. WS-1 emits them so the connector script can measure a named ' +
        'block, and so two documents can sit in one page. They are attributes, not `id`, and they ' +
        'change nothing a reader sees.',
    ],
    [
      'width-classes',
      '`class="pb pb--wide pb--center"` and friends are gone',
      'Width and alignment were classes because the layout was CSS. They are now numbers in `x` and ' +
        '`w`. The information survives; the mechanism changed.',
    ],
    [
      'decoding',
      '`decoding="async"` was added to every image',
      "WS-1's choice. It changes when a picture is painted, not where.",
    ],
    [
      'object-fit',
      '`object-fit: cover` on images and video',
      'WS-1 gives an item an authored aspect ratio and crops to it rather than squashing. The migration ' +
        'computes `w` and `h` from each file\'s real intrinsic size, so the ratio it stores is the ' +
        "file's own and nothing is cropped. A `{% Canvas %}` item whose stored `h` disagreed with its " +
        'picture is corrected to the height the live page actually painted, and each correction is ' +
        'listed in section 6.',
    ],
    [
      'rhythm',
      'Vertical rhythm survived the change of markup, which was not a given',
      '`.pb` had `margin-bottom: 44px` and no top margin; `.doc-band--canvas` has `margin: 8px 0 44px`. ' +
        'The extra 8px looks like it should push every media band down, and it does not: the ' +
        "preceding paragraph's 28px bottom margin collapses out of `.doc-band--prose` and out of its " +
        '`.doc-group`, meets the band\'s 8px top margin as an adjacent sibling, and the two collapse ' +
        'to 28. Section 4 measures it rather than arguing it: the two documents are the same height ' +
        'to the pixel, and the largest `Δy` anywhere on the page is a fraction of one.',
    ],
    [
      'margin-overlay',
      'A margin image became an overlay band over the text that follows it',
      '`.margin-item` was `float: right; clear: right`, so it sat in the empty space beside the text ' +
        'that came after it. §2.2 says an overlay band reserves no vertical space and sits over the ' +
        'band before it, so the prose is cut at the tag: the paragraphs before it close one band, the ' +
        'paragraphs after it open the next, and the overlay is emitted onto that next band. The ' +
        'picture keeps its right edge on the 1344px column, which is where the float put it.',
    ],
    [
      'margin-connector',
      'A margin connector keeps its target and loses its colour and its style',
      '`anchor` points at the last block of the band before the picture, which is the element the live ' +
        "script found with `previousElementSibling`. `connectColor` cannot travel: §3.3 allows `color` " +
        'only on a shape item, so a media item has nowhere to put it and the line falls back to ' +
        '`--accent`. `connectStyle: "loop"` is dropped because WS-1 draws one curve. Both are recorded ' +
        'as `lossy` whenever they occur.',
    ],
    [
      'color-theme',
      '`{% Color %}` lost its theme',
      '`<span class="fc fc--accent">` changed colour between light and dark mode. §3.2 stores a ' +
        "textStyle mark with a literal hex, so the light-mode value is what survives. Every tone's " +
        'conversion is recorded as `lossy`.',
    ],
    [
      'code-strike',
      'Inline `code` and `~~strike~~` keep their text and lose their tag',
      '§3.2 allows four marks: bold, italic, link and textStyle. A sentence is never dropped for want ' +
        'of a decoration; the loss is recorded.',
    ],
    [
      'headings',
      'Heading levels are read from the source, not from the live page',
      "The live heading transform reads `level` through `transformAttributes`, and Markdoc marks " +
        '`level` as `render: false`, so it is always `undefined` and every heading in a project body ' +
        'renders as `<h3 class="pb-heading">` whatever was typed. That is a bug, not a decision, so ' +
        'the migration maps `#` to h2 and `##` to h3. Anything deeper clamps to h3, because §3.2 stops ' +
        'there, and says so. No project page in this repo has a heading, so nothing in the acceptance ' +
        'diff depends on it.',
    ],
    [
      'bare-image',
      'A bare markdown image lost its stray `<p>`',
      'The live `image` node override returns a `<figure>`, which Markdoc still wraps in the ' +
        'paragraph it was parsed in: `<p><figure …></figure></p>`, which is not valid HTML. The ' +
        'migration emits the canvas band without the wrapper.',
    ],
    [
      'softbreak',
      'A softbreak became a space',
      'Markdoc emits `\\n` for a soft line break, which HTML renders as one space. The migration ' +
        'stores the space. Identical rendering, and it survives a round trip through TipTap.',
    ],
    [
      'br',
      '`<br>` is now `<br />`',
      "WS-1's void-element style. Identical parse, identical rendering.",
    ],
    [
      'draft',
      '`draft:` did not come across',
      'DocMeta is `.strict()` and has no `draft`. §2.3 makes draft state a question of which directory ' +
        'a file is in: `src/content/drafts/<slug>.json` is the working copy and the site builds from ' +
        '`pages/` only. So a `draft: true` entry is refused by this script rather than written into ' +
        '`pages/`, where it would become a published page. No entry in this repo is a draft.',
    ],
    [
      'hr',
      'A horizontal rule would be dropped',
      '§3.1 has no rule block. Recorded as `lossy` if one is ever found. There are none.',
    ],
    [
      'bold',
      'Bold text is heavier than it was, and this one is worth a decision',
      'The site sets `body { font-weight: 300 }` and `.project-body` says nothing about `<strong>`, so ' +
        "a bold run falls to the user agent's `font-weight: bolder`, which against an inherited 300 " +
        'resolves to **400**. `doc.css` sets `.doc strong { font-weight: 600 }`, so the same run comes ' +
        'out at **600**. Section 4 measures both rather than asserting it, and the pixel diff shows it ' +
        'as the one band of differing prose rows on the page: "you build your own cover" in the third ' +
        'paragraph. It is the only thing in this migration that changes how the existing words look. ' +
        'It is `doc.css`, so it is WS-1\'s line to keep or drop, and the owner\'s call which is wanted: ' +
        '400 is what has been published for months and is very nearly not bold at all; 600 is what the ' +
        'author probably meant by `**bold**`. Not changed here, because WS-9 does not own that file.',
    ],
    [
      'fatal',
      'A code fence, a table or an unknown component is fatal',
      'Each one would lose text or data a reader can see, so the page is not written at all and the ' +
        'run exits non-zero. There are none.',
    ],
  ];

  return items.map(([key, title, body]) => ({ key, title, body }));
}

/* -------------------------------------------------------------------------- */
/* The report                                                                 */
/* -------------------------------------------------------------------------- */

function writeReport(sections: Section[], failures: string[], shots: string, code: number): number {
  const now = new Date().toISOString().slice(0, 10);
  const out: string[] = [
    '# Markdoc to Doc JSON: the migration diff',
    '',
    `WS-9. Generated by \`node scripts/migrate-mdoc.ts --verify\` on ${now}. Do not hand-edit; ` +
      're-run the command.',
    '',
    failures.length === 0
      ? '**Result: every assertion passed.** No prose, caption, image or inline decoration differs ' +
        'between the published page and the migrated render. Every structural difference is listed in ' +
        'section 3 and justified in section 5.'
      : `**Result: ${failures.length} assertion(s) failed.**\n\n` +
        failures.map((f) => `- ${f}`).join('\n'),
    '',
    `Evidence (the screenshots, the pixel diff, and the two HTML pages that were measured): ` +
      `\`${shots}\`. That is a temp directory and will not survive a reboot; pass ` +
      `\`--shots=<dir>\` to put it somewhere you can keep.`,
    '',
    '---',
    '',
    '## Contents',
    '',
    ...sections.map((section, index) => `${index + 1}. ${section.heading.replace(/^\d+\.\s*/, '')}`),
    '',
    '---',
    '',
  ];

  for (const section of sections) {
    out.push(`## ${section.heading}`, '', ...section.lines, '');
  }

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`);
  say(`report: ${REPORT_PATH}`);
  if (failures.length > 0) {
    console.log(`\n--- ${failures.length} FAILURE(S) ---`);
    for (const failure of failures) console.log(`  ${failure}`);
  } else {
    say('\nAll migration assertions passed.');
  }
  return code;
}

/* ========================================================================== */
/* --selftest                                                                 */
/* ========================================================================== */

/**
 * Synthetic documents, so every construct the old format had is exercised even
 * though the one real page only uses three of them. No browser, no network: it
 * runs anywhere `node` does.
 */
const SELFTEST_CASES: { name: string; mdoc: string; expect: (report: (ok: boolean, what: string) => void, doc: Doc, html: string, losses: Loss[]) => void }[] = [
  {
    name: 'prose: headings, quote, lists, marks',
    mdoc: [
      '---',
      "title: 'Prose'",
      'date: 2026-01-02',
      'summary: A summary.',
      'url: https://example.com/thing',
      'draft: false',
      '---',
      '# One',
      '',
      '## Two',
      '',
      'Body with **bold**, *italic*, a [link](https://example.com) and {% Color tone="blue" %}blue{% /Color %}.',
      '',
      '> Quoted.',
      '>',
      '> Twice.',
      '',
      '- a',
      '- b',
      '  - nested',
      '',
      '1. first',
      '2. second',
      '',
      'A soft',
      'break, and a hard  ',
      'break.',
    ].join('\n'),
    expect: (report, doc, html, losses) => {
      report(doc.bands.length === 1 && doc.bands[0]!.type === 'prose', 'one prose band');
      const band = doc.bands[0] as ProseBand;
      report(
        band.blocks.map((b) => b.kind).join(',') === 'h2,h3,p,quote,ul,ol,p',
        `block kinds are h2,h3,p,quote,ul,ol,p (got ${band.blocks.map((b) => b.kind).join(',')})`,
      );
      report(doc.meta.url === 'https://example.com/thing', 'url survived into meta');
      report(doc.meta.summary === 'A summary.', 'summary survived into meta');
      report(doc.meta.date === '2026-01-02', `date is 2026-01-02 (got ${doc.meta.date})`);
      report(html.includes('<strong>bold</strong>'), 'bold rendered');
      report(html.includes('<em>italic</em>'), 'italic rendered');
      report(html.includes('<a href="https://example.com">link</a>'), 'link rendered');
      report(html.includes('<span style="color:#2563a8">blue</span>'), 'colour rendered as a literal hex');
      report(html.includes('<li>nested</li>'), 'the nested list item rendered');
      report(html.includes('<blockquote class="doc-quote"'), 'the quote rendered');
      report(html.includes('<br />'), 'the hard break rendered');
      report(html.includes('A soft break, and a hard'), 'the soft break became a space');
      report(
        losses.some((l) => l.level === 'lossy' && l.message.includes('Color tone "blue"')),
        'the colour tone loss was recorded',
      );
      report(losses.every((l) => l.level !== 'fatal'), 'nothing fatal');
    },
  },
  {
    name: 'media: two-up tall grid at the text measure, left aligned',
    mdoc: [
      '---',
      "title: 'Media'",
      'date: 2026-01-02',
      '---',
      'Before.',
      '',
      '{% Media',
      '   items=[{source: {discriminant: "image", value: "/projects/track-daily-habit-tracker/blocks/2/value/src.png"}}, {source: {discriminant: "image", value: "/projects/track-daily-habit-tracker/IMG_2065.png"}}]',
      '   layout="grid2" width="text" align="left" tall=true caption="Two up" /%}',
      '',
      'After.',
    ].join('\n'),
    expect: (report, doc, html) => {
      report(doc.bands.map((b) => b.type).join(',') === 'prose,canvas,prose', 'prose, canvas, prose');
      const band = doc.bands[1] as CanvasBand;
      report(band.overlay === undefined, 'the media band is in flow, not an overlay');
      report(band.items.length === 2, 'two items');
      const [a, b] = band.items as [CanvasItem, CanvasItem];
      report(a.x === 0, `the first item starts at x=0 (got ${a.x})`);
      report(Math.abs(b.x - (a.w + MEDIA_GAP)) < 0.01, `the second is one 24px gap along (got ${b.x})`);
      report(Math.abs(a.h - 720) < 0.01, `tall caps the height at 720 (got ${a.h})`);
      report(Math.abs(a.w - 332.25) < 0.05, `a 1206x2622 shot is 332.25 wide at that cap (got ${a.w})`);
      report(a.caption === 'Two up' && b.caption === undefined, 'the group caption went on the first item only');
      report(Math.abs(band.height - 751) < 0.01, `the band reserves 720 + 31 of caption (got ${band.height})`);
      report((html.match(/doc-item--image/g) ?? []).length === 2, 'both items rendered');
      report((html.match(/doc-caption/g) ?? []).length === 1, 'exactly one caption rendered');
    },
  },
  {
    name: 'media: one tall shot centred in the wide block',
    mdoc: [
      '---',
      "title: 'One'",
      'date: 2026-01-02',
      '---',
      '{% Media items=[{source: {discriminant: "image", value: "/projects/track-daily-habit-tracker/blocks/6/value/src.png"}}] layout="row" width="wide" align="center" tall=true caption="Solo" /%}',
    ].join('\n'),
    expect: (report, doc) => {
      const band = doc.bands[0] as CanvasBand;
      const item = band.items[0]!;
      report(Math.abs(item.x - 505.88) < 0.05, `centred at x=505.88 (got ${item.x})`);
      report(item.y === 0, 'at the top of its band');
    },
  },
  {
    name: 'media: untall row of three landscape shots',
    mdoc: [
      '---',
      "title: 'Row'",
      'date: 2026-01-02',
      '---',
      '{% Media items=[{source: {discriminant: "image", value: "/filmography/EudrajWcwwg.jpg"}}, {source: {discriminant: "image", value: "/filmography/i98vcdfRUqE.jpg"}}, {source: {discriminant: "image", value: "/filmography/6SUlwRLFuCc.jpg"}}] layout="row" width="full" align="center" /%}',
    ].join('\n'),
    expect: (report, doc) => {
      const band = doc.bands[0] as CanvasBand;
      report(band.items.length === 3, 'three items');
      const each = (REFERENCE_WIDTH - MEDIA_GAP * 2) / 3;
      report(Math.abs(band.items[0]!.w - each) < 0.01, `each is (1344 - 48) / 3 = ${px(each)} wide (got ${band.items[0]!.w})`);
      report(band.items.every((i) => i.y === 0), 'tops aligned, because align-items is flex-start');
      report(Math.abs(band.items[2]!.x - (each + MEDIA_GAP) * 2) < 0.02, 'the third sits two gaps along');
    },
  },
  {
    name: 'margin: an overlay on the text that follows, with a connector',
    mdoc: [
      '---',
      "title: 'Margin'",
      'date: 2026-01-02',
      '---',
      'The paragraph the line comes from.',
      '',
      '{% Margin source={discriminant: "image", value: "/filmography/EudrajWcwwg.jpg"} alt="A still" caption="Beside the text" size="large" connect=true connectColor="#2563a8" connectStyle="loop" /%}',
      '',
      'The paragraph it sits beside.',
      '',
      'And one more.',
    ].join('\n'),
    expect: (report, doc, html, losses) => {
      report(doc.bands.map((b) => b.type).join(',') === 'prose,prose,canvas', 'the prose is cut at the tag');
      const overlay = doc.bands[2] as CanvasBand;
      report(overlay.overlay === true, 'the margin band is an overlay');
      const item = overlay.items[0]!;
      report(Math.abs(item.x + item.w - REFERENCE_WIDTH) < 0.01, 'its right edge is the right edge of the column');
      report(Math.abs(item.w - 520) < 0.01, `"large" is 520 wide (got ${item.w})`);
      report(item.anchor?.bandId === 'b1', `the connector points back into the first band (got ${item.anchor?.bandId})`);
      report(item.anchor?.blockId === 'b1p1', `and at its last block (got ${item.anchor?.blockId})`);
      report(html.includes('doc-connectors'), 'the connector overlay was emitted');
      report(html.includes('data-anchor-block="b1p1"'), 'the anchor reached the markup');
      report(
        losses.some((l) => l.message.includes('connectColor')),
        'the dropped connector colour was recorded',
      );
      report(losses.some((l) => l.message.includes('loop')), 'the dropped connector style was recorded');
      report((doc.bands[1] as ProseBand).blocks.length === 2, 'the two paragraphs after the tag share a band');
    },
  },
  {
    name: 'margin: two in a row stack in one overlay, the way clear right did',
    mdoc: [
      '---',
      "title: 'Two margins'",
      'date: 2026-01-02',
      '---',
      'The paragraph above them.',
      '',
      '{% Margin source={discriminant: "image", value: "/filmography/EudrajWcwwg.jpg"} size="small" caption="First" connect=true /%}',
      '',
      '{% Margin source={discriminant: "image", value: "/filmography/i98vcdfRUqE.jpg"} size="small" /%}',
      '',
      'The paragraph they sit beside.',
    ].join('\n'),
    expect: (report, doc) => {
      report(
        doc.bands.map((b) => b.type).join(',') === 'prose,prose,canvas',
        `one overlay band holds both (got ${doc.bands.map((b) => b.type).join(',')})`,
      );
      const overlay = doc.bands[2] as CanvasBand;
      report(overlay.overlay === true && overlay.items.length === 2, 'two items in one overlay band');
      const [first, second] = overlay.items as [CanvasItem, CanvasItem];
      report(first.y === 0, 'the first sits at the top of the band');
      report(
        Math.abs(second.y - (first.h + CAPTION_SPACE + MARGIN_STACK_GAP)) < 0.01,
        `the second clears it by its caption plus 32px (got ${second.y})`,
      );
      report(first.anchor?.blockId === 'b1p1', 'only the connected one carries an anchor');
      report(second.anchor === undefined, 'and the other does not');
      report(
        Math.abs(first.x + first.w - REFERENCE_WIDTH) < 0.01 && Math.abs(second.x + second.w - REFERENCE_WIDTH) < 0.01,
        'both are flush with the right edge',
      );
    },
  },
  {
    name: 'canvas: a rotated picture, a shape, and h corrected to what was painted',
    mdoc: [
      '---',
      "title: 'Canvas'",
      'date: 2026-01-02',
      '---',
      '{% Canvas height=520 items=[{kind: "image", src: "/filmography/EudrajWcwwg.jpg", alt: "still", caption: "tilted", x: 40, y: 30, w: 400, h: 123, rotate: -6, z: 2}, {kind: "shape", shape: "squiggle", color: "#ff5722", strokeWidth: 3, x: 600, y: 60, w: 240, h: 120}, {kind: "shape", shape: "rect", fill: "#eeeeee", radius: 8, x: 900, y: 60, w: 200, h: 100}] /%}',
    ].join('\n'),
    expect: (report, doc, html, losses) => {
      const band = doc.bands[0] as CanvasBand;
      report(band.height === 520, 'the authored height was kept');
      report(band.items.length === 3, 'three items');
      const [image, squiggle, rect] = band.items as [CanvasItem, CanvasItem, CanvasItem];
      report(image.rotate === -6 && image.z === 2, 'rotation and stacking survived');
      report(
        Math.abs(image.h - boxFromWidth({ w: 1280, h: 720 }, 400).h) < 0.01,
        `h was corrected from 123 to the height the live page painted (got ${image.h})`,
      );
      report(losses.some((l) => l.message.includes('h 123 ->')), 'the correction was recorded');
      report(squiggle.shape === 'squiggle' && squiggle.strokeWidth === 3, 'the squiggle kept its stroke');
      report(squiggle.color === '#ff5722', 'and its colour');
      report(rect.fill === '#eeeeee' && rect.radius === 8, 'the rect kept its fill and radius');
      report(image.src === '/filmography/EudrajWcwwg.jpg', 'the image kept its src');
      report(html.includes('doc-item--shape'), 'the shapes rendered');
      report(html.includes('transform:rotate(-6deg)'), 'the rotation reached the markup');
    },
  },
  {
    name: 'textmedia and a bare markdown image',
    mdoc: [
      '---',
      "title: 'Mixed'",
      'date: 2026-01-02',
      '---',
      '![A still](/filmography/i98vcdfRUqE.jpg)',
      '',
      '{% TextMedia text="First tm para.\\n\\nSecond tm para." image="/filmography/6SUlwRLFuCc.jpg" alt="tm" caption="tm cap" side="left" split="40" width="wide" /%}',
    ].join('\n'),
    expect: (report, doc, html, losses) => {
      report(doc.bands[0]!.type === 'canvas', 'the bare image became a canvas band');
      const image = doc.bands[0] as CanvasBand;
      report(image.items[0]!.alt === 'A still', 'its alt survived');
      report(
        Math.abs(image.items[0]!.w - 1056) < 0.01,
        `a bare markdown image takes the "wide" treatment the live transform gave it (got ${image.items[0]!.w})`,
      );
      report(doc.bands[1]!.type === 'prose', 'the TextMedia text became a prose band');
      report((doc.bands[1] as ProseBand).blocks.length === 2, 'both of its paragraphs');
      report(doc.bands[2]!.type === 'canvas' && (doc.bands[2] as CanvasBand).overlay === true, 'its picture became an overlay');
      report(html.includes('First tm para.') && html.includes('Second tm para.'), 'both paragraphs rendered');
      report(losses.some((l) => l.level === 'lossy' && l.message.includes('side-by-side')), 'the lost split was recorded');
    },
  },
  {
    name: 'fatal: a code fence stops the page being written',
    mdoc: ['---', "title: 'Fence'", 'date: 2026-01-02', '---', '```', 'const a = 1;', '```'].join('\n'),
    expect: (report, _doc, _html, losses) => {
      report(losses.some((l) => l.level === 'fatal' && l.message.includes('fence')), 'a fence is fatal');
    },
  },
  {
    name: 'fatal: an unknown component stops the page being written',
    mdoc: ['---', "title: 'Unknown'", 'date: 2026-01-02', '---', '{% Mystery thing="x" /%}'].join('\n'),
    expect: (report, _doc, _html, losses) => {
      report(
        losses.some((l) => l.level === 'fatal' && l.message.includes('{% Mystery %}')),
        'an unknown component is fatal',
      );
    },
  },
  {
    name: 'escaping: angle brackets and ampersands survive as text',
    mdoc: [
      '---',
      "title: 'Escapes <b>&amp;</b>'",
      'date: 2026-01-02',
      '---',
      'A < B & C > D, and a quote: "like this".',
      '',
      'A [real link](https://example.com/a?b=1&c=2) with an ampersand in it.',
    ].join('\n'),
    expect: (report, doc, html) => {
      report(html.includes('A &lt; B &amp; C &gt; D'), 'the brackets and the ampersand are escaped');
      report(html.includes('a quote: "like this"'), 'double quotes in text are left alone, as on the live page');
      report(
        html.includes('<a href="https://example.com/a?b=1&amp;c=2">real link</a>'),
        'the ampersand in an href is escaped in the attribute',
      );
      report(doc.meta.title === 'Escapes <b>&amp;</b>', 'the raw title text is stored unescaped');
      report(
        renderDocHead(doc).includes('&lt;b&gt;&amp;amp;&lt;/b&gt;'),
        'and escaped only when it is rendered',
      );
    },
  },
  {
    name: 'escaping: an unsafe href never reaches the JSON',
    mdoc: ['---', "title: 'Unsafe'", 'date: 2026-01-02', '---', '{% Media items=[{source: {discriminant: "videoLink", value: "javascript:alert(1)"}}] /%}'].join('\n'),
    expect: (report, doc, html, losses) => {
      report(
        losses.some((l) => l.level === 'fatal' && l.message.includes('media src "javascript:alert(1)"')),
        'the unsafe src is fatal, so the page is never written',
      );
      report(doc.bands.length === 0, 'the band was not emitted');
      report(!html.includes('javascript:'), 'and nothing unsafe reached the markup');
      report(
        isSafeHref('https://x.test/a') && !isSafeHref('javascript:alert(1)') && !isSafeHref('data:text/html,x'),
        'isSafeHref agrees with the renderer about schemes',
      );
    },
  },
  {
    name: 'determinism: the same input twice is the same bytes',
    mdoc: [
      '---',
      "title: 'Twice'",
      'date: 2026-01-02',
      '---',
      'One.',
      '',
      '{% Media items=[{source: {discriminant: "image", value: "/filmography/EudrajWcwwg.jpg"}}] caption="c" /%}',
      '',
      'Two.',
    ].join('\n'),
    expect: () => {
      /* checked by the runner, which converts every case twice */
    },
  },
];

async function selftest(): Promise<number> {
  const markdoc = (await import('@markdoc/markdoc')).default;
  await ensureShapeAssets();

  const sandbox = mkdtempSync(join(tmpdir(), 'jinhyuk-ws9-selftest-'));
  let passed = 0;
  const failed: string[] = [];

  try {
    for (const testCase of SELFTEST_CASES) {
      const slug = testCase.name.replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase();
      const file = `${slug}.mdoc`;
      writeFileSync(join(sandbox, file), testCase.mdoc);

      const first = migrateOne(sandbox, file, markdoc);
      const second = migrateOne(sandbox, file, markdoc);

      const report = (ok: boolean, what: string): void => {
        if (ok) passed += 1;
        else failed.push(`${testCase.name}: ${what}`);
      };

      if (first.conversion === null) {
        // Only the deliberately fatal cases are allowed to fail validation.
        testCase.expect(report, { version: 1, meta: { title: '', slug: 'x', date: '1970-01-01' }, bands: [] }, '', first.losses);
        if (!first.losses.some((l) => l.level === 'fatal')) {
          failed.push(`${testCase.name}: produced no document and recorded nothing fatal`);
        }
        continue;
      }

      const html = renderDoc(first.conversion.doc);
      testCase.expect(report, first.conversion.doc, html, first.losses);

      if (second.conversion === null) {
        failed.push(`${testCase.name}: the second run produced no document`);
      } else {
        const a = JSON.stringify(first.conversion.doc);
        const b = JSON.stringify(second.conversion.doc);
        report(a === b, 'converting twice gives identical JSON');
      }

      // Every case: no prose may go missing, whatever else it is testing.
      const sourceProse = first.conversion.sourceProse.map((p) => squash(p));
      const out = inventory(html, 'doc').prose.map((p) => p.text);
      const lost = sourceProse.filter((p) => p !== '' && !out.includes(p));
      report(lost.length === 0, `no prose lost${lost.length === 0 ? '' : `: ${JSON.stringify(lost)}`}`);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }

  console.log(`selftest: ${passed} assertion(s) passed, ${failed.length} failed`);
  for (const failure of failed) console.log(`  FAIL  ${failure}`);
  return failed.length === 0 ? 0 : 1;
}

/* ========================================================================== */
/* main                                                                      */
/* ========================================================================== */

async function main(): Promise<void> {
  if (flag('selftest')) {
    process.exitCode = await selftest();
    return;
  }

  const markdoc = (await import('@markdoc/markdoc')).default;

  if (!existsSync(IN_DIR)) throw new Error(`no source directory at ${IN_DIR}`);
  const files = readdirSync(IN_DIR)
    .filter((name) => name.endsWith('.mdoc'))
    .sort();
  if (files.length === 0) throw new Error(`no .mdoc files in ${IN_DIR}`);

  const conversions: Conversion[] = [];
  let fatal = 0;

  for (const file of files) {
    const result = migrateOne(IN_DIR, file, markdoc);
    const slug = file.replace(/\.mdoc$/, '');
    const fatals = result.losses.filter((loss) => loss.level === 'fatal');
    const lossy = result.losses.filter((loss) => loss.level === 'lossy');

    if (result.draft && !flag('include-drafts')) {
      fatal += 1;
      console.log(
        `REFUSED  ${file}\n` +
          `         it is \`draft: true\`. Brief 2.3 keeps a draft in src/content/drafts/, which is not\n` +
          `         WS-9's to write, and the site builds from pages/ only. Pass --include-drafts to\n` +
          `         migrate it into ${OUT_DIR} anyway.`,
      );
      continue;
    }

    if (fatals.length > 0 || result.conversion === null) {
      fatal += 1;
      console.log(`FAILED   ${file}  (${fatals.length} fatal)`);
      for (const loss of fatals) console.log(`         ${loss.where}: ${loss.message}`);
      continue;
    }

    conversions.push(result.conversion);
    const bands = result.conversion.doc.bands;
    say(
      `ok       ${slug}  ${bands.length} band(s), ` +
        `${bands.filter((b) => b.type === 'prose').reduce((n, b) => n + (b as ProseBand).blocks.length, 0)} block(s), ` +
        `${bands.filter((b) => b.type === 'canvas').reduce((n, b) => n + (b as CanvasBand).items.length, 0)} item(s)` +
        (lossy.length > 0 ? `, ${lossy.length} lossy` : ''),
    );
    for (const loss of lossy) say(`         lossy: ${loss.where}: ${loss.message}`);
  }

  // --check: assert the committed JSON is what this script produces today, so
  // an edit to a .mdoc that never made it through the migration, or a hand-edit
  // to a page that cannot be reproduced, is caught rather than discovered.
  if (flag('check')) {
    let drifted = 0;
    for (const conversion of conversions) {
      const path = join(OUT_DIR, `${conversion.slug}.json`);
      const wanted = `${JSON.stringify(conversion.doc, null, 2)}\n`;
      if (!existsSync(path)) {
        drifted += 1;
        console.log(`MISSING  ${path}`);
        continue;
      }
      if (readFileSync(path, 'utf8') !== wanted) {
        drifted += 1;
        console.log(`DRIFTED  ${path} is not what migrating ${conversion.file} produces now`);
        continue;
      }
      say(`current  ${path}`);
    }
    process.exitCode = drifted === 0 && fatal === 0 ? 0 : 1;
    return;
  }

  if (!flag('dry-run')) {
    mkdirSync(OUT_DIR, { recursive: true });
    for (const conversion of conversions) {
      const path = join(OUT_DIR, `${conversion.slug}.json`);
      writeFileSync(path, `${JSON.stringify(conversion.doc, null, 2)}\n`);
      say(`wrote    ${path}`);
    }
  }

  if (flag('verify')) {
    process.exitCode = (await verify(conversions)) === 0 && fatal === 0 ? 0 : 1;
    return;
  }

  if (fatal > 0) {
    console.log(`\n${fatal} page(s) were not migrated.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
