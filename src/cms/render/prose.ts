/**
 * src/cms/render/prose.ts
 *
 * WS-1. A small serialiser for the TipTap JSON in ProseBlock.content.
 *
 * Deliberately NOT @tiptap/html: that pulls ProseMirror, and a schema, into the
 * static build and the SSR bundle to turn about forty nodes into about forty
 * tags. The shapes it has to handle are fixed by docs/cms-contracts.md 2.3 and
 * listed in PROSE_BLOCK_KINDS and PROSE_MARKS, so a switch statement is both
 * smaller and easier to be sure about.
 *
 * `content` is typed `unknown[]` on purpose (the schema does not police TipTap's
 * internals), so everything here is defensive: an unrecognised node contributes
 * nothing, and a recognised node with a missing field degrades instead of
 * throwing. A renderer that throws on one bad paragraph takes the whole site
 * build down with it.
 *
 * No DOM, no React, no Astro.
 */

import { HexColorSchema, PROSE_MARKS } from '../schema.ts';
import type { ProseBand, ProseBlock, ProseBlockKind, ProseMarkType } from '../schema.ts';
import { attr, escapeText, joinParts, safeUrl } from './escape.ts';

/* -------------------------------------------------------------------------- */
/* Shapes we can recognise in the JSON                                        */
/* -------------------------------------------------------------------------- */

type Node = { type?: unknown; text?: unknown; marks?: unknown; attrs?: unknown; content?: unknown };

function asNode(value: unknown): Node | null {
  return typeof value === 'object' && value !== null ? (value as Node) : null;
}

function nodeType(node: Node): string {
  return typeof node.type === 'string' ? node.type : '';
}

function childrenOf(node: Node): unknown[] {
  return Array.isArray(node.content) ? node.content : [];
}

function attrsOf(node: Node | { attrs?: unknown }): Record<string, unknown> {
  const { attrs } = node;
  return typeof attrs === 'object' && attrs !== null ? (attrs as Record<string, unknown>) : {};
}

/* -------------------------------------------------------------------------- */
/* Marks                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Nesting order, outermost first. Fixed so the same marks always produce the
 * same bytes: TipTap does not guarantee the order of a node's `marks` array,
 * and WS-9's migration diff compares output byte for byte.
 *
 * Link outermost means the whole styled run is clickable. textStyle next means
 * the colour wins over the link colour, which is what someone colouring a word
 * meant.
 */
const MARK_ORDER: readonly ProseMarkType[] = ['link', 'textStyle', 'bold', 'italic'];

const ALLOWED_MARKS = new Set<string>(PROSE_MARKS);

type Mark = { type: ProseMarkType; attrs: Record<string, unknown> };

function collectMarks(node: Node): Mark[] {
  if (!Array.isArray(node.marks)) return [];
  const found = new Map<ProseMarkType, Mark>();
  for (const raw of node.marks) {
    const mark = asNode(raw);
    if (mark === null) continue;
    const type = nodeType(mark);
    // Anything outside PROSE_MARKS (underline, strike, code, or whatever a
    // paste smuggled in) is ignored, but its text is still rendered. Losing a
    // decoration is recoverable; losing a sentence is not.
    if (!ALLOWED_MARKS.has(type)) continue;
    found.set(type as ProseMarkType, { type: type as ProseMarkType, attrs: attrsOf(mark) });
  }
  return MARK_ORDER.filter((type) => found.has(type)).map((type) => found.get(type)!);
}

/** The open and close tags for one mark, or null when it cannot be rendered. */
function markTags(mark: Mark): { open: string; close: string } | null {
  switch (mark.type) {
    case 'bold':
      return { open: '<strong>', close: '</strong>' };

    case 'italic':
      return { open: '<em>', close: '</em>' };

    case 'link': {
      const href = safeUrl(mark.attrs.href);
      // A link with no usable href is not a link. Keep the text, drop the tag.
      if (href === null) return null;
      const target = typeof mark.attrs.target === 'string' ? mark.attrs.target : undefined;
      // Never hand a new browsing context the opener. TipTap usually stores
      // this itself; this is the belt to its braces.
      const rel =
        typeof mark.attrs.rel === 'string' && mark.attrs.rel !== ''
          ? mark.attrs.rel
          : target === '_blank'
            ? 'noopener noreferrer'
            : undefined;
      return {
        open: `<a${attr('href', href)}${attr('target', target)}${attr('rel', rel)}>`,
        close: '</a>',
      };
    }

    case 'textStyle': {
      const { color } = mark.attrs;
      // Only a hex colour, checked against the schema's own rule rather than a
      // second regex, so a pasted `color: url(...)` cannot reach the style
      // attribute.
      if (typeof color !== 'string' || !HexColorSchema.safeParse(color).success) return null;
      return { open: `<span style="color:${color}">`, close: '</span>' };
    }

    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Inline content                                                             */
/* -------------------------------------------------------------------------- */

/** Inline nodes -> HTML. Used for p, h2, h3 and for the paragraphs inside a
 *  quote or a list item. */
export function renderInline(nodes: unknown[]): string {
  let out = '';
  for (const raw of nodes) {
    const node = asNode(raw);
    if (node === null) continue;

    switch (nodeType(node)) {
      case 'text': {
        if (typeof node.text !== 'string' || node.text === '') break;
        let html = escapeText(node.text);
        // Innermost mark first, so MARK_ORDER[0] ends up outermost.
        for (const mark of collectMarks(node).reverse()) {
          const tags = markTags(mark);
          if (tags !== null) html = `${tags.open}${html}${tags.close}`;
        }
        out += html;
        break;
      }

      case 'hardBreak':
        out += '<br />';
        break;

      default:
        // An unknown inline node might still be carrying text (a mention, an
        // emoji node, a future inline kind). Salvage whatever is in it rather
        // than dropping the sentence it sits in.
        if (typeof node.text === 'string') out += escapeText(node.text);
        else if (Array.isArray(node.content)) out += renderInline(node.content);
        break;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Block content                                                              */
/* -------------------------------------------------------------------------- */

/** The paragraphs inside a blockquote. Anything that is not a paragraph is
 *  treated as inline content and wrapped in one, so no text is lost. */
function renderQuoteBody(nodes: unknown[]): string {
  const parts: string[] = [];
  const loose: unknown[] = [];

  const flush = () => {
    if (loose.length === 0) return;
    const inner = renderInline(loose);
    loose.length = 0;
    if (inner !== '') parts.push(`<p>${inner}</p>`);
  };

  for (const raw of nodes) {
    const node = asNode(raw);
    if (node === null) continue;
    if (nodeType(node) === 'paragraph') {
      flush();
      parts.push(`<p>${renderInline(childrenOf(node))}</p>`);
    } else {
      loose.push(raw);
    }
  }
  flush();

  return parts.length > 0 ? parts.join('') : '<p></p>';
}

/** One list item: `[{ paragraph }]` in the common case, with nested lists and
 *  multiple paragraphs handled because TipTap can produce them. */
function renderListItem(node: Node): string {
  const children = childrenOf(node);
  const paragraphs: unknown[] = [];
  const blocks: string[] = [];

  for (const raw of children) {
    const child = asNode(raw);
    if (child === null) continue;
    const type = nodeType(child);
    if (type === 'bulletList') blocks.push(`<ul>${renderListItems(childrenOf(child))}</ul>`);
    else if (type === 'orderedList') blocks.push(`<ol>${renderListItems(childrenOf(child))}</ol>`);
    else paragraphs.push(raw);
  }

  // A single paragraph renders bare, matching the site's `article li`: an
  // extra <p> inside every <li> would add a paragraph margin to every bullet.
  let lead = '';
  if (paragraphs.length === 1) {
    const only = asNode(paragraphs[0]);
    lead = only !== null && nodeType(only) === 'paragraph'
      ? renderInline(childrenOf(only))
      : renderInline(paragraphs);
  } else if (paragraphs.length > 1) {
    lead = paragraphs
      .map((raw) => {
        const child = asNode(raw);
        if (child === null) return '';
        return `<p>${nodeType(child) === 'paragraph' ? renderInline(childrenOf(child)) : renderInline([raw])}</p>`;
      })
      .join('');
  }

  return `<li>${lead}${blocks.join('')}</li>`;
}

/** The items of a ul or ol. A non-listItem child is wrapped in one rather than
 *  dropped. */
function renderListItems(nodes: unknown[]): string {
  const parts: string[] = [];
  for (const raw of nodes) {
    const node = asNode(raw);
    if (node === null) continue;
    if (nodeType(node) === 'listItem') parts.push(renderListItem(node));
    else parts.push(`<li>${renderInline([raw])}</li>`);
  }
  return parts.join('');
}

/** Element name and class for each block kind. One table, so the CSS selectors
 *  and the markup cannot drift. */
const BLOCK_SHELL: Readonly<Record<ProseBlockKind, { tag: string; className: string }>> = {
  p: { tag: 'p', className: 'doc-p' },
  h2: { tag: 'h2', className: 'doc-h2' },
  h3: { tag: 'h3', className: 'doc-h3' },
  quote: { tag: 'blockquote', className: 'doc-quote' },
  ul: { tag: 'ul', className: 'doc-list doc-list--ul' },
  ol: { tag: 'ol', className: 'doc-list doc-list--ol' },
};

/**
 * One prose block.
 *
 * `data-block-id` is the hook the connector script measures against: an
 * anchored canvas item names a block id, and this is where that id lands in the
 * DOM. It is an attribute rather than `id` so two documents (the preview beside
 * the editor, say) can sit in one page without colliding.
 */
export function renderProseBlock(block: ProseBlock): string {
  const shell = BLOCK_SHELL[block.kind];
  const content = block.content;

  let inner: string;
  switch (block.kind) {
    case 'quote':
      inner = renderQuoteBody(content);
      break;
    case 'ul':
    case 'ol':
      inner = renderListItems(content);
      break;
    default:
      inner = renderInline(content);
      break;
  }

  return `<${shell.tag} class="${shell.className}"${attr('data-block-id', block.id)}>${inner}</${shell.tag}>`;
}

/** One prose band: blocks in document order, in normal flow (brief 2.2). */
export function renderProseBand(band: ProseBand): string {
  const blocks = joinParts(band.blocks.map(renderProseBlock));
  return `<div class="doc-band doc-band--prose"${attr('data-band-id', band.id)}>${blocks}</div>`;
}
