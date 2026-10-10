/**
 * src/cms/app/prose/block.ts
 *
 * WS-5. The boundary between a stored ProseBlock (docs/cms-rebuild.md 3.2) and
 * a TipTap editor document. Pure data: no React, no TipTap, no DOM, so it runs
 * under bare `node` and WS-9's migration can reuse it.
 *
 * Three jobs:
 *
 *  1. docFromBlock / blockFromDoc    the round trip from docs/cms-contracts.md 2.3
 *  2. normalizeProseContent          coerce anything into the exact 3.2 shape
 *  3. convertBlockKind               p <-> h2 <-> h3 <-> quote <-> ul <-> ol
 *
 * All three go through one function, paragraphGroups(), which reduces any
 * content to a list of inline runs. That is why conversion is total: every
 * kind can be expressed as "a list of paragraphs' worth of inline content",
 * and every kind can be rebuilt from one.
 *
 * NORMALISATION IS A FIXED POINT OF THE EDITOR'S OWN SERIALISATION.
 * normalizeProseContent(kind, editor.getJSON()…) applied twice equals applied
 * once, and applied to what ProseMirror emits it changes nothing. That is what
 * makes the round trip lossless rather than merely "close". Three places where
 * that costs real work:
 *
 *  - ProseMirror fills in every registered attr, so a link comes back as
 *    { href, target, rel, class: null, title: null }. Only href/target/rel are
 *    stored (docs/cms-contracts.md 2.3 says to read those three and ignore the
 *    rest), and null-valued attrs are dropped.
 *  - ProseMirror merges adjacent text nodes carrying identical marks, and
 *    refuses empty text nodes outright. So do we.
 *  - ProseMirror emits marks in schema rank order, not authoring order, so
 *    marks are sorted into MARK_ORDER.
 */

import { PROSE_HEADING_LEVEL, PROSE_MARKS, PROSE_NODE_TYPE } from '../../schema.ts';
import type { ProseBlock, ProseBlockKind } from '../../schema.ts';
import { canonicalColorValue } from './palette.ts';

/* -------------------------------------------------------------------------- */
/* TipTap JSON, as much of it as this contract allows                          */
/* -------------------------------------------------------------------------- */

export type ProseMark = { type: string; attrs?: Record<string, unknown> };

export type ProseNode = {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: ProseMark[];
  content?: ProseNode[];
  text?: string;
};

/** What TipTap is given and what it gives back: one top node inside a doc. */
export type ProseEditorDoc = { type: 'doc'; content: ProseNode[] };

/**
 * The order ProseMirror serialises marks in: schema rank, which is extension
 * priority (Link 1000, TextStyle 101, Bold and Italic 100, Bold registered
 * first). Sorting into this order is what keeps `normalize` a fixed point.
 *
 * src/cms/app/prose/verify.ts asserts this matches the real schema for every
 * block kind, so a TipTap upgrade that reshuffles priorities fails loudly
 * instead of quietly reordering every mark in every document.
 */
export const MARK_ORDER: readonly string[] = ['link', 'textStyle', 'bold', 'italic'];

/* -------------------------------------------------------------------------- */
/* Tiny helpers                                                                */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNode(value: unknown): ProseNode | null {
  const record = asRecord(value);
  if (record === null || typeof record.type !== 'string') return null;
  return record as ProseNode;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * JSON with object keys sorted, so two structurally identical documents
 * stringify identically whatever order their keys were written in. The
 * fixtures themselves are inconsistent about it ({type,text} in one run,
 * {type,marks,text} in the next), so a byte comparison of raw JSON would
 * report a loss that is not there.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** Deep, key-order-insensitive equality of two prose content arrays. */
export function sameProseContent(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/* -------------------------------------------------------------------------- */
/* Links                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Allowlist, not denylist. A stored href ends up in an `href` attribute on the
 * published page, so the only things that pass are the four schemes the site
 * actually uses, a site-absolute path, and a fragment.
 *
 * A bare `example.com` does not pass; the link control prefixes `https://`
 * before storing, so the author never sees the difference.
 */
export function isSafeHref(href: unknown): href is string {
  if (typeof href !== 'string') return false;
  const value = href.trim();
  if (value === '' || value.length > 2048) return false;
  if (/[\s<>"']/.test(value)) return false;
  if (value.startsWith('#') || value.startsWith('/')) return true;
  return /^(?:https?|mailto|tel):/i.test(value);
}

/* -------------------------------------------------------------------------- */
/* Marks                                                                       */
/* -------------------------------------------------------------------------- */

function normalizeMark(raw: unknown): ProseMark | null {
  const record = asRecord(raw);
  if (record === null || typeof record.type !== 'string') return null;
  const type = record.type;
  if (!(PROSE_MARKS as readonly string[]).includes(type)) return null;
  const attrs = asRecord(record.attrs) ?? {};

  if (type === 'bold' || type === 'italic') return { type };

  if (type === 'link') {
    const href = typeof attrs.href === 'string' ? attrs.href.trim() : '';
    if (!isSafeHref(href)) return null;
    const out: Record<string, unknown> = { href };
    if (typeof attrs.target === 'string' && attrs.target !== '') out.target = attrs.target;
    if (typeof attrs.rel === 'string' && attrs.rel !== '') out.rel = attrs.rel;
    return { type, attrs: out };
  }

  // textStyle. The colour mark, and the only textStyle attr this contract
  // stores. A textStyle with no usable colour carries no information, so it is
  // dropped rather than stored as `{ color: null }`.
  const color = canonicalColorValue(attrs.color);
  if (color === null) return null;
  return { type, attrs: { color } };
}

export function normalizeMarks(raw: unknown): ProseMark[] {
  const seen = new Set<string>();
  const marks: ProseMark[] = [];
  for (const candidate of asArray(raw)) {
    const mark = normalizeMark(candidate);
    if (mark === null || seen.has(mark.type)) continue;
    seen.add(mark.type);
    marks.push(mark);
  }
  marks.sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
  return marks;
}

/* -------------------------------------------------------------------------- */
/* Inline runs                                                                 */
/* -------------------------------------------------------------------------- */

function normalizeTextNode(raw: unknown): ProseNode | null {
  const node = asNode(raw);
  if (node === null || node.type !== 'text') return null;
  const text = typeof node.text === 'string' ? node.text : '';
  // ProseMirror throws on an empty text node, so one can never be stored.
  if (text === '') return null;
  const marks = normalizeMarks(node.marks);
  return marks.length === 0 ? { type: 'text', text } : { type: 'text', marks, text };
}

/** ProseMirror joins adjacent text nodes with identical marks. Match it. */
function mergeAdjacentText(nodes: ProseNode[]): ProseNode[] {
  const out: ProseNode[] = [];
  for (const node of nodes) {
    const previous = out[out.length - 1];
    if (
      previous !== undefined &&
      previous.type === 'text' &&
      node.type === 'text' &&
      canonicalJson(previous.marks ?? []) === canonicalJson(node.marks ?? [])
    ) {
      out[out.length - 1] = { ...previous, text: `${previous.text ?? ''}${node.text ?? ''}` };
      continue;
    }
    out.push(node);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* paragraphGroups: the one reduction every path goes through                  */
/* -------------------------------------------------------------------------- */

const BLOCK_CONTAINERS = new Set(['blockquote', 'bulletList', 'orderedList', 'listItem']);

/**
 * Any content array -> a list of inline runs, one per paragraph's worth of
 * text. Containers (quote, list, listItem) contribute their descendants'
 * runs in document order, which is what makes "list -> paragraph" and
 * "paragraph -> list" both well defined. Nested lists are flattened: the 3.2
 * shape has no nesting, so an accidental Tab or a pasted nested list becomes
 * sibling items rather than content WS-1 has never seen.
 */
export function paragraphGroups(content: unknown): ProseNode[][] {
  const groups: ProseNode[][] = [];
  let open: ProseNode[] | null = null;

  const pushInline = (node: ProseNode): void => {
    if (open === null) {
      open = [];
      groups.push(open);
    }
    open.push(node);
  };

  for (const raw of asArray(content)) {
    const node = asNode(raw);
    if (node === null) continue;

    if (node.type === 'text') {
      const text = normalizeTextNode(node);
      if (text !== null) pushInline(text);
      continue;
    }

    // Anything that is not text closes the run being collected.
    open = null;

    if (BLOCK_CONTAINERS.has(node.type)) {
      groups.push(...paragraphGroups(node.content));
    } else {
      // paragraph, heading, or anything unexpected with inline children.
      const inner = paragraphGroups(node.content);
      if (inner.length === 0) groups.push([]);
      else groups.push(...inner);
    }
  }

  return groups.map(mergeAdjacentText);
}

/** All runs into one, separated by a single space where one is needed. */
function joinGroups(groups: ProseNode[][]): ProseNode[] {
  const filled = groups.filter((group) => group.length > 0);
  if (filled.length === 0) return [];
  const out: ProseNode[] = [];
  for (const group of filled) {
    const previous = out[out.length - 1];
    const needsSpace =
      previous !== undefined && !/\s$/.test(previous.text ?? '') && !/^\s/.test(group[0].text ?? '');
    if (needsSpace) out.push({ type: 'text', text: ' ' });
    out.push(...group);
  }
  return mergeAdjacentText(out);
}

function paragraphNode(inline: ProseNode[]): ProseNode {
  return inline.length === 0 ? { type: 'paragraph' } : { type: 'paragraph', content: inline };
}

function listItemNode(inline: ProseNode[]): ProseNode {
  return { type: 'listItem', content: [paragraphNode(inline)] };
}

/** Inline runs -> the exact 3.2 content shape for one block kind. */
export function contentForKind(kind: ProseBlockKind, groups: ProseNode[][]): ProseNode[] {
  if (kind === 'p' || kind === 'h2' || kind === 'h3') return joinGroups(groups);
  // A blockquote and a list must hold at least one child to be a legal
  // ProseMirror node, so an empty one holds one empty paragraph.
  const atLeastOne = groups.length === 0 ? [[]] : groups;
  if (kind === 'quote') return atLeastOne.map(paragraphNode);
  return atLeastOne.map(listItemNode);
}

/* -------------------------------------------------------------------------- */
/* The public surface                                                          */
/* -------------------------------------------------------------------------- */

/** Coerce any content into the exact docs/cms-rebuild.md 3.2 shape for `kind`. */
export function normalizeProseContent(kind: ProseBlockKind, content: unknown): ProseNode[] {
  return contentForKind(kind, paragraphGroups(content));
}

export function normalizeProseBlock(block: ProseBlock): ProseBlock {
  return { ...block, content: normalizeProseContent(block.kind, block.content) };
}

/** The top node's attrs. Heading level comes from `kind`, never from content. */
export function topNodeAttrsFor(kind: ProseBlockKind): Record<string, unknown> | undefined {
  if (kind === 'h2' || kind === 'h3') return { level: PROSE_HEADING_LEVEL[kind] };
  return undefined;
}

/** block -> editor. docs/cms-contracts.md 2.3. */
export function docFromBlock(block: ProseBlock): ProseEditorDoc {
  const top: ProseNode = { type: PROSE_NODE_TYPE[block.kind] };
  const attrs = topNodeAttrsFor(block.kind);
  if (attrs !== undefined) top.attrs = attrs;
  const content = normalizeProseContent(block.kind, block.content);
  if (content.length > 0) top.content = content;
  return { type: 'doc', content: [top] };
}

/** The top node type an editor document carries, for assertions. */
export function topNodeTypeOf(editorDoc: unknown): string | null {
  const top = asNode(asNode(editorDoc)?.content?.[0]);
  return top === null ? null : top.type;
}

/** editor -> block. `id` and `kind` come from the block, never from the editor. */
export function blockFromDoc(block: ProseBlock, editorDoc: unknown): ProseBlock {
  const top = asNode(asNode(editorDoc)?.content?.[0]);
  return { ...block, content: normalizeProseContent(block.kind, top?.content ?? []) };
}

/** Change a block's kind, carrying its words across. Total: every pair works. */
export function convertBlockKind(block: ProseBlock, kind: ProseBlockKind): ProseBlock {
  if (kind === block.kind) return normalizeProseBlock(block);
  return { ...block, kind, content: contentForKind(kind, paragraphGroups(block.content)) };
}

/** The canonical empty content for a kind. */
export function emptyContentFor(kind: ProseBlockKind): ProseNode[] {
  return contentForKind(kind, []);
}

/* -------------------------------------------------------------------------- */
/* Read-only inspection, for the toolbar and for tests                         */
/* -------------------------------------------------------------------------- */

export function collectProseText(content: unknown): string {
  return paragraphGroups(content)
    .map((group) => group.map((node) => node.text ?? '').join(''))
    .filter((line) => line !== '')
    .join('\n');
}

/** Every distinct mark in a content array, canonicalised and deduplicated. */
export function collectProseMarks(content: unknown): ProseMark[] {
  const seen = new Map<string, ProseMark>();
  const walk = (nodes: unknown): void => {
    for (const raw of asArray(nodes)) {
      const node = asNode(raw);
      if (node === null) continue;
      for (const mark of normalizeMarks(node.marks)) seen.set(canonicalJson(mark), mark);
      walk(node.content);
    }
  };
  walk(content);
  return [...seen.values()];
}

/** Every colour used in a content array, in document order. */
export function collectProseColors(content: unknown): string[] {
  const colors: string[] = [];
  for (const mark of collectProseMarks(content)) {
    if (mark.type !== 'textStyle') continue;
    const color = mark.attrs?.color;
    if (typeof color === 'string' && !colors.includes(color)) colors.push(color);
  }
  return colors;
}
