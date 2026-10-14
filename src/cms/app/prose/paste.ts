/**
 * src/cms/app/prose/paste.ts
 *
 * Pasting a whole essay in.
 *
 * ---------------------------------------------------------------------------
 * WHY IT ONLY EVER TOOK ONE PARAGRAPH
 * ---------------------------------------------------------------------------
 *
 * One ProseBlock is one top-level ProseMirror node. The editor for a `p`
 * block has a document whose content expression is literally `paragraph`:
 * exactly one, no more. That is deliberate and load-bearing — it is what
 * stops Enter from making a second paragraph inside one block, Backspace
 * from deleting the block, and a stray paste from smuggling a heading into
 * the middle of a paragraph.
 *
 * It also means ProseMirror has nowhere to put the second paragraph of a
 * paste. Given twenty paragraphs it keeps what fits and drops the rest, so
 * moving an essay across from Notion meant pasting it a paragraph at a time,
 * which is exactly as tedious as it sounds.
 *
 * The block shape is not the thing to change. What was missing is the step
 * ABOVE the editor: a paste of several blocks is a change to the BAND, not
 * to the block, so it has to be read before the editor sees it, turned into
 * blocks, and handed to the band.
 *
 * ---------------------------------------------------------------------------
 * HOW
 * ---------------------------------------------------------------------------
 *
 * 1. Read `text/html` off the clipboard (every editor worth pasting from
 *    writes it: Notion, Docs, Word, a web page). Fall back to `text/plain`.
 * 2. Parse it with a schema that is the block schema with the one-node
 *    restriction lifted, and nothing else changed. Same nodes, same marks,
 *    same link sanitising, same colour canonicalisation — so what survives a
 *    paste is exactly what survives typing, and no second definition of
 *    "what a document may contain" exists to drift from the first.
 * 3. Map each top-level node to a ProseBlock kind.
 *
 * WHAT IS DROPPED, AND WHY THAT IS THE RIGHT ANSWER. Images, tables, code
 * blocks, nested lists, dividers, embeds: the document model has no place
 * for any of them inside a prose band (media lives on a canvas band), so the
 * schema drops them. Pasting is not the place to invent storage. The count
 * is reported back so the paste can say what it left behind rather than
 * quietly losing it.
 *
 * ONE BLOCK IN, NOTHING TAKEN OVER. A paste that comes to a single block is
 * left entirely to ProseMirror, which already handles it correctly and knows
 * where the caret is. This module only exists for the multi-block case.
 */

import { getSchema } from '@tiptap/core';
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model';
import type { Schema } from '@tiptap/pm/model';

import type { ProseBlockKind } from '../../schema.ts';
import { normalizeProseContent } from './block.ts';
import type { ProseNode } from './block.ts';
import { pasteExtensions } from './extensions.ts';

/** A block the paste wants to create. No id: the caller mints those. */
export type PastedBlock = { kind: ProseBlockKind; content: ProseNode[] };

/** What a paste came to, with what it could not bring. */
export type PasteResult = {
  blocks: PastedBlock[];
  /**
   * Top-level things the schema refused: images, tables, code blocks and so
   * on. Counted rather than named, because the count is what decides whether
   * to say anything and the names would be a list of CSS-era trivia.
   */
  dropped: number;
};

/* -------------------------------------------------------------------------- */
/* The paste schema                                                            */
/* -------------------------------------------------------------------------- */

let cached: Schema | null = null;

/** The paste schema, built once. */
export function pasteSchema(): Schema {
  if (cached === null) cached = getSchema(pasteExtensions()) as Schema;
  return cached;
}

/* -------------------------------------------------------------------------- */
/* Mapping a parsed document onto blocks                                       */
/* -------------------------------------------------------------------------- */

/**
 * Which ProseBlock kind a top-level node becomes.
 *
 * `null` means "the document model has no block for this", and the node is
 * counted as dropped. A heading of any level lands on h2 or h3 because those
 * are the only two the document has: an h1 is the page title, which is a
 * field and not a block.
 */
function kindOf(node: { type: string; attrs?: Record<string, unknown> }): ProseBlockKind | null {
  switch (node.type) {
    case 'paragraph':
      return 'p';
    case 'heading': {
      const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 2;
      return level <= 2 ? 'h2' : 'h3';
    }
    case 'blockquote':
      return 'quote';
    case 'bulletList':
      return 'ul';
    case 'orderedList':
      return 'ol';
    default:
      return null;
  }
}

/** True when a block would come out with no text in it at all. */
function isEmptyBlock(block: PastedBlock): boolean {
  const text = JSON.stringify(block.content);
  return block.content.length === 0 || !/"text"\s*:\s*"[^"]/.test(text);
}

/**
 * A parsed ProseMirror document, as blocks.
 *
 * Pure: takes the JSON and returns data, so it is tested under bare node
 * with no DOM. `blocksFromHtml` is the three lines that need a browser.
 *
 * EMPTY BLOCKS ARE DROPPED. Every rich text editor emits trailing and
 * separating empty paragraphs — Notion especially — and twenty blank blocks
 * interleaved with the real ones is not what anybody meant by "paste my
 * essay". A blank line between paragraphs is spacing, and spacing in this
 * document model is the `space` field, not an empty block.
 */
export function blocksFromParsedDoc(json: unknown): PasteResult {
  const doc = json as { content?: { type: string; attrs?: Record<string, unknown>; content?: unknown }[] };
  const nodes = Array.isArray(doc?.content) ? doc.content : [];
  const blocks: PastedBlock[] = [];
  let dropped = 0;

  for (const node of nodes) {
    const kind = kindOf(node);
    if (kind === null) {
      dropped += 1;
      continue;
    }
    const content = normalizeProseContent(kind, node.content ?? []);
    const block = { kind, content };
    if (isEmptyBlock(block)) continue;
    blocks.push(block);
  }

  return { blocks, dropped };
}

/* -------------------------------------------------------------------------- */
/* The two clipboard flavours                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The things a prose band has no block for. Media lives on a canvas band,
 * and the rest the document simply does not have.
 *
 * `img` rather than `figure`, so a figure wrapping an image counts once.
 * Inline `code` is not here: it is a few words inside a paragraph that come
 * through as plain text, which is a formatting loss and not a missing thing.
 */
const DROPPED_BY_THE_MODEL = 'img, table, pre, hr, iframe, video, audio, embed, object, svg, canvas';

/**
 * Clipboard HTML, as blocks. Needs a DOM; everything it then does does not.
 *
 * The html goes through the browser's own parser, which is the only thing
 * that reliably copes with what real editors put on a clipboard (unclosed
 * tags, Word's conditional comments, Notion's wrapper divs).
 */
export function blocksFromHtml(html: string): PasteResult {
  if (typeof window === 'undefined' || typeof window.DOMParser !== 'function') {
    return { blocks: [], dropped: 0 };
  }
  const dom = new window.DOMParser().parseFromString(html, 'text/html');
  // Counted HERE, off the DOM, and not from what comes back parsed.
  //
  // An element the schema has no rule for does not arrive as an unknown
  // node to be rejected later: ProseMirror's parser steps straight over it,
  // so by the time there is a document to inspect the image is not missing,
  // it was never there. Asking the DOM what was in the paste is the only
  // place the answer still exists.
  const dropped = dom.body.querySelectorAll(DROPPED_BY_THE_MODEL).length;
  const parsed = ProseMirrorDOMParser.fromSchema(pasteSchema()).parse(dom.body);
  const result = blocksFromParsedDoc(parsed.toJSON());
  return { blocks: result.blocks, dropped: result.dropped + dropped };
}

/**
 * Clipboard text, as blocks: one paragraph per non-blank line.
 *
 * Plain text has no soft wrapping — a line IS a paragraph — so this does not
 * need to guess at blank-line grouping. Used only when there is no HTML on
 * the clipboard, which in practice means a terminal, a code editor or a
 * plain-text note.
 */
export function blocksFromText(text: string): PasteResult {
  const blocks = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => ({ kind: 'p' as ProseBlockKind, content: [{ type: 'text', text: line }] }));
  return { blocks, dropped: 0 };
}

/**
 * What is on the clipboard, as blocks, HTML first.
 *
 * Returns no blocks when there is nothing worth taking over for, which the
 * caller reads as "let ProseMirror paste this the way it always has".
 */
export function blocksFromClipboard(data: DataTransfer | null): PasteResult {
  if (data === null) return { blocks: [], dropped: 0 };
  const html = data.getData('text/html');
  if (html.trim() !== '') {
    const fromHtml = blocksFromHtml(html);
    if (fromHtml.blocks.length > 0 || fromHtml.dropped > 0) return fromHtml;
  }
  return blocksFromText(data.getData('text/plain'));
}
