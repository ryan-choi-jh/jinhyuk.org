/**
 * src/cms/app/state/doc-ops.ts
 *
 * WS-3. Pure, immutable document operations. Every one takes a `Doc` and
 * returns a new `Doc`, sharing everything it did not touch. No React, no DOM,
 * no store: this file is testable under bare `node`, which is what
 * `./verify-state.ts` does.
 *
 * Two invariants this file is responsible for, both from
 * docs/cms-contracts.md 2.2:
 *
 *  - rule 10, the first band cannot be an overlay. Reordering or deleting can
 *    float an overlay band to position 0, so `normalizeDoc()` strips the flag
 *    and every structural op runs through it.
 *  - rules 6 and 7, a shape item may not carry media keys and `fill`/`radius`
 *    are only legal on particular shapes. Changing a shape's kind in the
 *    inspector runs through `sanitizeShapeKeys()`.
 *
 * Anything that returns an unchanged document returns the SAME object, by
 * reference. The store leans on that for dirty tracking.
 */

import { newId } from '../../schema.ts';
import type {
  Band,
  CanvasBand,
  CanvasItem,
  Doc,
  DocMeta,
  ProseBand,
  ProseBlock,
  ProseBlockKind,
} from '../../schema.ts';

/* -------------------------------------------------------------------------- */
/* Equality                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Structural equality, key order independent. Used for dirty tracking, so an
 * edit that happens to restore the saved value reports clean instead of
 * leaving a permanent dot on the Save button.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}

export function docsEqual(a: Doc, b: Doc): boolean {
  return deepEqual(a, b);
}

/** Structured deep clone, so a document handed to an API client cannot be mutated under it. */
export function cloneDoc(doc: Doc): Doc {
  return JSON.parse(JSON.stringify(doc)) as Doc;
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

/** Drop a key without leaving `undefined` behind, so JSON output stays clean. */
function omit<T extends object, K extends keyof T>(value: T, key: K): T {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return value;
  const next = { ...value };
  delete next[key];
  return next;
}

/**
 * docs/cms-contracts.md 2.2 rule 10. The first band cannot be an overlay;
 * there is nothing for it to sit over. Returns the same object when the
 * document is already fine.
 */
export function normalizeDoc(doc: Doc): Doc {
  const first = doc.bands[0];
  if (first === undefined || first.type !== 'canvas' || first.overlay !== true) return doc;
  const bands = [...doc.bands];
  bands[0] = omit(first, 'overlay');
  return { ...doc, bands };
}

/**
 * docs/cms-contracts.md 2.2 rules 6 and 7. `fill` is only valid on a rect or
 * ellipse, `radius` only on a rect, and a shape may not carry `src`/`alt`.
 */
export function sanitizeShapeKeys(item: CanvasItem): CanvasItem {
  if (item.kind !== 'shape') return item;
  let next = item;
  if (next.fill !== undefined && next.shape !== 'rect' && next.shape !== 'ellipse') {
    next = omit(next, 'fill');
  }
  if (next.radius !== undefined && next.shape !== 'rect') next = omit(next, 'radius');
  if (next.src !== undefined) next = omit(next, 'src');
  if (next.alt !== undefined) next = omit(next, 'alt');
  return next;
}

/* -------------------------------------------------------------------------- */
/* Band lookup                                                                 */
/* -------------------------------------------------------------------------- */

export function bandIndexOf(doc: Doc, bandId: string): number {
  return doc.bands.findIndex((band) => band.id === bandId);
}

export function findBand(doc: Doc, bandId: string): Band | null {
  return doc.bands.find((band) => band.id === bandId) ?? null;
}

/** Replace one band in place. Returns the same document if the band is missing. */
function withBand(doc: Doc, bandId: string, replace: (band: Band) => Band): Doc {
  const index = bandIndexOf(doc, bandId);
  if (index < 0) return doc;
  const current = doc.bands[index] as Band;
  const next = replace(current);
  if (next === current) return doc;
  const bands = [...doc.bands];
  bands[index] = next;
  return { ...doc, bands };
}

/* -------------------------------------------------------------------------- */
/* Band factories                                                              */
/* -------------------------------------------------------------------------- */

/** Height a fresh canvas band reserves, in reference px. */
export const NEW_CANVAS_HEIGHT = 360;

export function createProseBlock(kind: ProseBlockKind = 'p', content: unknown[] = []): ProseBlock {
  return { id: newId('p'), kind, content };
}

export function createProseBand(): ProseBand {
  return { id: newId('b'), type: 'prose', blocks: [createProseBlock('p')] };
}

export function createCanvasBand(height: number = NEW_CANVAS_HEIGHT): CanvasBand {
  return { id: newId('b'), type: 'canvas', height, items: [] };
}

export function createBand(type: Band['type']): Band {
  return type === 'prose' ? createProseBand() : createCanvasBand();
}

/* -------------------------------------------------------------------------- */
/* Bands: insert, delete, reorder                                              */
/* -------------------------------------------------------------------------- */

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return length;
  return Math.max(0, Math.min(Math.trunc(index), length));
}

/** Insert at `index`; `index === bands.length` appends. */
export function insertBand(doc: Doc, index: number, band: Band): Doc {
  const at = clampIndex(index, doc.bands.length);
  const bands = [...doc.bands];
  bands.splice(at, 0, band);
  return normalizeDoc({ ...doc, bands });
}

export function removeBand(doc: Doc, bandId: string): Doc {
  const index = bandIndexOf(doc, bandId);
  if (index < 0) return doc;
  const bands = [...doc.bands];
  bands.splice(index, 1);
  return normalizeDoc({ ...doc, bands });
}

/**
 * Move a band to `toIndex`, where `toIndex` is its index in the array AFTER
 * removal. Drag-and-drop usually computes a gap in the pre-move list instead;
 * run that through `dropIndexToTargetIndex()` first.
 */
export function moveBand(doc: Doc, bandId: string, toIndex: number): Doc {
  const from = bandIndexOf(doc, bandId);
  if (from < 0) return doc;
  const bands = [...doc.bands];
  const [band] = bands.splice(from, 1);
  if (band === undefined) return doc;
  const to = clampIndex(toIndex, bands.length);
  if (to === from) return doc;
  bands.splice(to, 0, band);
  return normalizeDoc({ ...doc, bands });
}

/**
 * A drop indicator sits in a gap of the list as it is drawn, so `dropIndex` is
 * "insert before row dropIndex". Once the dragged row is pulled out, every gap
 * after it shifts down by one.
 */
export function dropIndexToTargetIndex(fromIndex: number, dropIndex: number): number {
  return dropIndex > fromIndex ? dropIndex - 1 : dropIndex;
}

/* -------------------------------------------------------------------------- */
/* Canvas bands                                                                */
/* -------------------------------------------------------------------------- */

export function setBandHeight(doc: Doc, bandId: string, height: number): Doc {
  if (!Number.isFinite(height) || height <= 0) return doc;
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'canvas' || band.height === height) return band;
    return { ...band, height };
  });
}

/**
 * Set or clear `overlay`. Refused on band 0 (rule 10). Clearing removes the
 * key rather than writing `false`, which keeps the JSON minimal.
 */
export function setBandOverlay(doc: Doc, bandId: string, overlay: boolean): Doc {
  const index = bandIndexOf(doc, bandId);
  if (index < 0) return doc;
  if (overlay && index === 0) return doc;
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'canvas') return band;
    if (overlay) return band.overlay === true ? band : { ...band, overlay: true };
    return band.overlay === undefined ? band : omit(band, 'overlay');
  });
}

/** Wholesale replacement of a canvas band's items. This is what WS-4's `onChange` feeds. */
export function setCanvasItems(doc: Doc, bandId: string, items: CanvasItem[]): Doc {
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'canvas') return band;
    if (deepEqual(band.items, items)) return band;
    return { ...band, items };
  });
}

export function addCanvasItem(doc: Doc, bandId: string, item: CanvasItem): Doc {
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'canvas') return band;
    return { ...band, items: [...band.items, sanitizeShapeKeys(item)] };
  });
}

export function updateCanvasItem(
  doc: Doc,
  bandId: string,
  itemId: string,
  patch: Partial<CanvasItem>,
): Doc {
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'canvas') return band;
    const index = band.items.findIndex((item) => item.id === itemId);
    if (index < 0) return band;
    const current = band.items[index] as CanvasItem;
    const merged = sanitizeShapeKeys(stripUndefined({ ...current, ...patch, id: current.id }) as CanvasItem);
    if (deepEqual(current, merged)) return band;
    const items = [...band.items];
    items[index] = merged;
    return { ...band, items };
  });
}

export function removeCanvasItem(doc: Doc, bandId: string, itemId: string): Doc {
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'canvas') return band;
    const items = band.items.filter((item) => item.id !== itemId);
    if (items.length === band.items.length) return band;
    return { ...band, items };
  });
}

/* -------------------------------------------------------------------------- */
/* Prose bands                                                                 */
/* -------------------------------------------------------------------------- */

/** Replace a block's TipTap content array. This is what WS-5's `onChange` feeds. */
export function setBlockContent(doc: Doc, bandId: string, blockId: string, content: unknown[]): Doc {
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'prose') return band;
    const index = band.blocks.findIndex((block) => block.id === blockId);
    if (index < 0) return band;
    const current = band.blocks[index] as ProseBlock;
    if (deepEqual(current.content, content)) return band;
    const blocks = [...band.blocks];
    blocks[index] = { ...current, content };
    return { ...band, blocks };
  });
}

export function setBlockKind(doc: Doc, bandId: string, blockId: string, kind: ProseBlockKind): Doc {
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'prose') return band;
    const index = band.blocks.findIndex((block) => block.id === blockId);
    if (index < 0) return band;
    const current = band.blocks[index] as ProseBlock;
    if (current.kind === kind) return band;
    const blocks = [...band.blocks];
    blocks[index] = { ...current, kind, content: convertProseContent(current.kind, kind, current.content) };
    return { ...band, blocks };
  });
}

export function insertProseBlock(
  doc: Doc,
  bandId: string,
  index: number,
  kind: ProseBlockKind = 'p',
): Doc {
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'prose') return band;
    const blocks = [...band.blocks];
    blocks.splice(clampIndex(index, blocks.length), 0, createProseBlock(kind));
    return { ...band, blocks };
  });
}

export function removeProseBlock(doc: Doc, bandId: string, blockId: string): Doc {
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'prose') return band;
    const blocks = band.blocks.filter((block) => block.id !== blockId);
    if (blocks.length === band.blocks.length) return band;
    return { ...band, blocks };
  });
}

export function moveProseBlock(doc: Doc, bandId: string, blockId: string, toIndex: number): Doc {
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'prose') return band;
    const from = band.blocks.findIndex((block) => block.id === blockId);
    if (from < 0) return band;
    const blocks = [...band.blocks];
    const [block] = blocks.splice(from, 1);
    if (block === undefined) return band;
    const to = clampIndex(toIndex, blocks.length);
    if (to === from) return band;
    blocks.splice(to, 0, block);
    return { ...band, blocks };
  });
}

/* -------------------------------------------------------------------------- */
/* Prose content conversion                                                    */
/* -------------------------------------------------------------------------- */

type TipTapNode = { type?: string; content?: unknown[]; text?: string; marks?: unknown[] };

/**
 * `ProseBlock.content` has a different shape per kind (docs/cms-contracts.md
 * 2.3): inline nodes for p/h2/h3, paragraph nodes for quote, listItem nodes
 * for ul/ol. Switching kind in the inspector therefore has to reshape the
 * content, or WS-1 renders a paragraph where it expected a list item.
 *
 * Lossy on purpose, and only in one direction: several lines collapsing into
 * one paragraph are joined with a space. Marks are preserved untouched. WS-5
 * owns prose editing; this exists so the shell's kind switcher cannot write a
 * shape WS-1 does not expect.
 */
export function convertProseContent(
  from: ProseBlockKind,
  to: ProseBlockKind,
  content: unknown[],
): unknown[] {
  if (shapeGroup(from) === shapeGroup(to)) return content;
  const lines = extractLines(from, content);
  return wrapLines(to, lines);
}

type ShapeGroup = 'inline' | 'paragraphs' | 'listItems';

function shapeGroup(kind: ProseBlockKind): ShapeGroup {
  if (kind === 'quote') return 'paragraphs';
  if (kind === 'ul' || kind === 'ol') return 'listItems';
  return 'inline';
}

/** Pull the inline runs out of any content shape, one array per logical line. */
function extractLines(from: ProseBlockKind, content: unknown[]): unknown[][] {
  const group = shapeGroup(from);
  if (group === 'inline') return content.length > 0 ? [content] : [];

  const lines: unknown[][] = [];
  const visit = (nodes: unknown[]): void => {
    for (const raw of nodes) {
      const node = raw as TipTapNode;
      if (node === null || typeof node !== 'object') continue;
      if (node.type === 'paragraph') {
        lines.push(Array.isArray(node.content) ? node.content : []);
        continue;
      }
      if (Array.isArray(node.content)) {
        visit(node.content);
        continue;
      }
      // A bare inline node where a block was expected: treat it as its own line.
      lines.push([node]);
    }
  };
  visit(content);
  return lines.filter((line) => line.length > 0);
}

function wrapLines(to: ProseBlockKind, lines: unknown[][]): unknown[] {
  const group = shapeGroup(to);
  if (group === 'inline') {
    const flat: unknown[] = [];
    lines.forEach((line, index) => {
      if (index > 0) flat.push({ type: 'text', text: ' ' });
      flat.push(...line);
    });
    return flat;
  }
  if (group === 'paragraphs') {
    return lines.map((line) => ({ type: 'paragraph', content: line }));
  }
  return lines.map((line) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: line }],
  }));
}

/**
 * Plain text of a block, for outline rows and inspector previews. Not a
 * renderer: WS-1 owns how prose actually looks.
 */
export function blockPlainText(block: ProseBlock): string {
  const out: string[] = [];
  const visit = (nodes: unknown[]): void => {
    for (const raw of nodes) {
      const node = raw as TipTapNode;
      if (node === null || typeof node !== 'object') continue;
      if (typeof node.text === 'string') out.push(node.text);
      if (Array.isArray(node.content)) visit(node.content);
    }
  };
  visit(block.content);
  return out.join('').replace(/\s+/g, ' ').trim();
}

/* -------------------------------------------------------------------------- */
/* Meta                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Patch `doc.meta`. An empty string on an optional field removes the key,
 * because `""` is not a valid `url` or `cover` and a strict schema has no
 * place to put it.
 */
export function updateMeta(doc: Doc, patch: Partial<DocMeta>): Doc {
  const OPTIONAL = ['summary', 'url', 'cover'] as const;
  let meta: DocMeta = { ...doc.meta, ...patch };
  for (const key of OPTIONAL) {
    if (meta[key] === '' || meta[key] === undefined) meta = omit(meta, key);
  }
  if (deepEqual(meta, doc.meta)) return doc;
  return { ...doc, meta };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/** How many things a band holds, for the outline's secondary line. */
export function bandChildCount(band: Band): number {
  return band.type === 'prose' ? band.blocks.length : band.items.length;
}

/** Vertical space a band reserves, in reference px. Overlay bands reserve none (2.2). */
export function bandReservedHeight(band: Band): number | null {
  if (band.type !== 'canvas') return null;
  return band.overlay === true ? 0 : band.height;
}

/**
 * Remove keys whose value is `undefined`. A patch that clears an optional
 * field (`{ rotate: undefined }`) must delete the key rather than store the
 * hole, so the JSON on disk stays minimal and a strict schema stays happy.
 */
function stripUndefined<T extends object>(value: T): T {
  let next: T | null = null;
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] !== undefined) continue;
    if (next === null) next = { ...value };
    delete next[key];
  }
  return next ?? value;
}
