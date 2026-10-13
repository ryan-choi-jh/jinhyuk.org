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
// The one kind converter. It is pure data (schema and palette only, no TipTap
// and no React), so this file still runs under bare `node`.
import { convertBlockKind } from '../prose/block.ts';
import type {
  Band,
  CanvasBand,
  CanvasItem,
  Doc,
  DocMeta,
  ProseBand,
  ProseBlock,
  ProseBlockKind,
  CalloutTone,
  BlockSpace,
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

/** A caption's own height below the item: doc.css's 10px margin + 21px line. */
export const CAPTION_SPACE = 31;

/**
 * How tall the band would be if it ended at its lowest item: the largest
 * `y + h` across them, rounded up to a whole pixel. Null when there is nothing
 * on it, because a canvas with no items has no content to fit and collapsing
 * it to zero would make it unclickable.
 *
 * NOT applied automatically when an item is resized, though that is the first
 * thing anyone expects. The space under the lowest item is often deliberate:
 * this site's own hero band is 824px against content ending at 789, and
 * global.css leans on exactly that 35px of bleed so the illustration's pencil
 * is complete. Shrinking it silently on an unrelated edit would change the
 * published page without anyone asking. So this is what the Fit button
 * offers, and the number is shown before you press it.
 */
/** Away with float noise, well below anything a pixel can show. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * How far down the page an item actually reaches.
 *
 * Not `y + h`, which is only true of an upright item. A rotated one turns
 * about the middle of its box (`transform-origin: center center` in doc.css),
 * so its real extent is the rotated bounding box: a 400 by 100 picture turned
 * 90 degrees occupies 400px of vertical space, not 100. Fit used to measure
 * the un-rotated box and crop it.
 */
function itemBottom(item: CanvasItem): number {
  const turn = item.rotate ?? 0;
  if (turn === 0) return item.y + item.h;
  const radians = (turn * Math.PI) / 180;
  const spans = Math.abs(item.w * Math.sin(radians)) + Math.abs(item.h * Math.cos(radians));
  // The box turns about its own centre, so half of the rotated span sits
  // either side of it.
  //
  // Rounded, because the caller takes a ceiling of this and sin/cos do not
  // return exact zeros: at 180 degrees `Math.sin(Math.PI)` is 1.22e-16, which
  // turns a height of exactly 200 into 200.00000000000003 and then into 201.
  // Six decimals is far finer than a pixel and coarse enough to swallow that.
  return round(item.y + item.h / 2 + spans / 2);
}

export function canvasContentHeight(band: CanvasBand): number | null {
  if (band.items.length === 0) return null;
  let bottom = -Infinity;
  for (const item of band.items) {
    // A caption hangs BELOW the item's box — 10px of margin and a 21px line
    // in doc.css — so an item that has one needs that much more room or the
    // words land on whatever follows the band. One line's worth; a longer
    // caption is what `padBottom` is for.
    const caption = item.caption !== undefined && item.caption !== '' ? CAPTION_SPACE : 0;
    bottom = Math.max(bottom, itemBottom(item) + caption);
  }
  // An empty band has no content to fit, and is handled above. A band whose
  // items have all been dragged above its own top has content; it is just all
  // in negative space. Reporting null there made Fit look broken. One pixel
  // is the smallest height a band can have and still be a band.
  const fitted = Math.ceil(bottom + (band.padBottom ?? 0));
  return Math.max(1, fitted);
}

/**
 * Which canvas band this one would fold into, or null when there is none.
 *
 * An OVERLAY folds into the band it overlays — the nearest plain band above
 * it — because that is already its coordinate origin: an overlay is drawn
 * from the top of its host, so its items keep their x and y exactly.
 *
 * A PLAIN canvas folds into a plain canvas directly above it, and its items
 * move down by that band's height, which is where they already appear on the
 * page. Anything else returns null rather than guessing: folding across a
 * paragraph would move pictures above text they belong under.
 */
export function mergeTargetFor(doc: Doc, bandId: string): CanvasBand | null {
  const index = bandIndexOf(doc, bandId);
  if (index <= 0) return null;
  const band = doc.bands[index];
  if (band === undefined || band.type !== 'canvas') return null;

  if (band.overlay === true) {
    for (let i = index - 1; i >= 0; i--) {
      const candidate = doc.bands[i];
      if (candidate === undefined) return null;
      if (candidate.type !== 'canvas') return null;
      if (candidate.overlay !== true) return candidate;
    }
    return null;
  }

  const previous = doc.bands[index - 1];
  if (previous === undefined || previous.type !== 'canvas' || previous.overlay === true) return null;
  return previous;
}

/**
 * Fold a canvas band's items into the one above and remove it.
 *
 * The reason this exists: three bands each holding one picture can look like
 * a single row on the page, and the only way to get a picture out of one and
 * into another used to be uploading it again. Nothing is re-uploaded here —
 * the items move, `src` and all.
 */
export function mergeCanvasBandUp(doc: Doc, bandId: string): Doc {
  const target = mergeTargetFor(doc, bandId);
  if (target === null) return doc;
  const index = bandIndexOf(doc, bandId);
  const band = doc.bands[index] as CanvasBand;

  // An overlay already shares its host's origin; a plain band sits below the
  // one above it, so its items move down by that band's height to stay where
  // they are on the page.
  const shift = band.overlay === true ? 0 : target.height;
  const moved = band.items.map((item) => (shift === 0 ? item : { ...item, y: item.y + shift }));

  const bands = doc.bands
    .map((candidate) =>
      candidate.id === target.id
        ? fitted({ ...target, items: [...target.items, ...moved] })
        : candidate,
    )
    .filter((candidate) => candidate.id !== bandId);

  return { ...doc, bands };
}

/**
 * Clear space under the lowest item. Zero removes the key rather than
 * writing 0, which keeps the JSON minimal, exactly as `overlay` does.
 */
export function setBandPadBottom(doc: Doc, bandId: string, padBottom: number): Doc {
  if (!Number.isFinite(padBottom) || padBottom < 0) return doc;
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'canvas') return band;
    const next = padBottom === 0 ? omit(band, 'padBottom') : { ...band, padBottom };
    return fitted(next as CanvasBand);
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

/**
 * The band with its height following its contents.
 *
 * Applied after every change to a canvas band's items, so shrinking a picture
 * takes the empty space with it instead of leaving a hole, which is what
 * anyone moving things on a canvas expects and what the owner asked for.
 *
 * An EMPTY band is left alone. `canvasContentHeight` returns null there, and
 * collapsing a canvas with nothing on it to zero would leave nothing to drop
 * anything onto — so a band you have sized by hand before filling it keeps
 * that size until it has something to measure.
 *
 * The one band on this site that carried deliberate empty space, the
 * homepage hero, no longer does: its 35px tail was the flat export's bleed,
 * and it moved to `.intro`'s padding in global.css where page spacing
 * belongs. Nothing else relies on a canvas being taller than its contents.
 */
function fitted(band: CanvasBand): CanvasBand {
  const height = canvasContentHeight(band);
  if (height === null || height === band.height) return band;
  return { ...band, height };
}

/** Wholesale replacement of a canvas band's items. This is what WS-4's `onChange` feeds. */
export function setCanvasItems(doc: Doc, bandId: string, items: CanvasItem[]): Doc {
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'canvas') return band;
    if (deepEqual(band.items, items)) return band;
    return fitted({ ...band, items });
  });
}

export function addCanvasItem(doc: Doc, bandId: string, item: CanvasItem): Doc {
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'canvas') return band;
    return fitted({ ...band, items: [...band.items, sanitizeShapeKeys(item)] });
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
    return fitted({ ...band, items });
  });
}

export function removeCanvasItem(doc: Doc, bandId: string, itemId: string): Doc {
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'canvas') return band;
    const items = band.items.filter((item) => item.id !== itemId);
    if (items.length === band.items.length) return band;
    return fitted({ ...band, items });
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
    // WS-5's converter, not a second one of our own. There used to be two
    // implementations of "change a block's kind" — this file's for the
    // outline and the inspector, `block.ts`'s for the floating toolbar — and
    // they disagreed: given a run carrying a mark the contract forbids (an
    // `underline` from a paste), the toolbar stripped it and this path wrote
    // it into the document. One user-visible action, one converter.
    const converted = convertBlockKind(current, kind);
    // `tone` only means something on a callout, and the schema now says so.
    // Recolouring a callout and then making it a paragraph used to leave the
    // colour behind in the file.
    if (converted.tone !== undefined && kind !== 'callout') delete converted.tone;
    blocks[index] = converted;
    return { ...band, blocks };
  });
}

/**
 * A callout's colour. The default is stored as nothing, like every other
 * optional field, so a callout nobody has recoloured carries no tone at all.
 */
export function setBlockTone(
  doc: Doc,
  bandId: string,
  blockId: string,
  tone: CalloutTone | undefined,
): Doc {
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'prose') return band;
    const index = band.blocks.findIndex((block) => block.id === blockId);
    if (index < 0) return band;
    const current = band.blocks[index] as ProseBlock;
    if (current.tone === tone) return band;
    const blocks = [...band.blocks];
    const next: ProseBlock = { ...current, tone };
    if (tone === undefined) delete next.tone;
    blocks[index] = next;
    return { ...band, blocks };
  });
}

/**
 * How much room a block asks for above itself. `undefined` removes the key,
 * like every other optional field, so a block nobody has spaced carries
 * nothing.
 *
 * Legal on every kind, unlike `tone`: any block can want air above it.
 */
export function setBlockSpace(
  doc: Doc,
  bandId: string,
  blockId: string,
  space: BlockSpace | undefined,
): Doc {
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'prose') return band;
    const index = band.blocks.findIndex((block) => block.id === blockId);
    if (index < 0) return band;
    const current = band.blocks[index] as ProseBlock;
    if (current.space === space) return band;
    const blocks = [...band.blocks];
    const next: ProseBlock = { ...current, space };
    if (space === undefined) delete next.space;
    blocks[index] = next;
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

/**
 * Cut one block into two at the caret: the original keeps `head`, and `tail`
 * (already built by the caller, so the caller knows its id and can put the
 * caret in it) goes in directly after.
 *
 * The ORIGINAL block keeps its id and the head of the text. That is what makes
 * a split safe for connectors: an anchor stores a blockId (AnchorSchema), so
 * anything pointing at this paragraph still points at a paragraph that exists,
 * rather than being left dangling by an edit the author would never connect to
 * a vanished line.
 */
export function splitProseBlock(
  doc: Doc,
  bandId: string,
  blockId: string,
  head: unknown[],
  tail: ProseBlock,
  /** The head's kind, when the split changes it. Defaults to unchanged. */
  headKind?: ProseBlockKind,
): Doc {
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'prose') return band;
    const index = band.blocks.findIndex((block) => block.id === blockId);
    if (index < 0) return band;
    const current = band.blocks[index] as ProseBlock;
    const blocks = [...band.blocks];
    blocks.splice(
      index,
      1,
      { ...current, kind: headKind ?? current.kind, content: head },
      tail,
    );
    return { ...band, blocks };
  });
}

/**
 * One block becomes several, in document order, in one edit.
 *
 * The general case `splitProseBlock` is the two-block special case of.
 * Breaking a list open at an empty bullet needs three: the items above, a
 * paragraph, the items below. Doing that as three edits would be three undo
 * steps and would pass through states the schema would reject (a list block
 * with no items).
 *
 * An empty `blocks` removes the block, which is what "split a one-item list
 * at its only item" would mean; callers that do not want that check first.
 */
export function replaceProseBlockWith(
  doc: Doc,
  bandId: string,
  blockId: string,
  blocks: ProseBlock[],
): Doc {
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'prose') return band;
    const index = band.blocks.findIndex((block) => block.id === blockId);
    if (index < 0) return band;
    const next = [...band.blocks];
    next.splice(index, 1, ...blocks);
    return { ...band, blocks: next };
  });
}

/**
 * The inverse: put `content` into the block before `blockId` and delete
 * `blockId`. The caller joins the text (it also needs the join offset, to put
 * the caret on the seam), so this only moves blocks around.
 */
export function mergeProseBlockUp(
  doc: Doc,
  bandId: string,
  blockId: string,
  content: unknown[],
): Doc {
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'prose') return band;
    const index = band.blocks.findIndex((block) => block.id === blockId);
    if (index < 1) return band;
    const previous = band.blocks[index - 1] as ProseBlock;
    const blocks = [...band.blocks];
    blocks.splice(index, 1);
    blocks[index - 1] = { ...previous, content };
    return { ...band, blocks };
  });
}

/**
 * Every block in a band with no text in it.
 *
 * An empty row is a full line in the editor and nothing at all on the page,
 * so a document that has been written by pressing Enter for air is carrying
 * rows that do not exist for the reader. This is what the band's "remove
 * empty rows" offers to clear, and it is also how the offer knows whether
 * there is anything to clear.
 *
 * A list or a quote with no text still counts: an empty bullet renders as an
 * empty bullet, which is worse than nothing.
 */
export function emptyProseBlocks(band: ProseBand): ProseBlock[] {
  return band.blocks.filter((block) => blockPlainText(block) === '');
}

/**
 * Drop them. Never the last one: a prose band with no blocks at all has
 * nothing to type into and no way back, so the final empty row stays and
 * becomes the place the cursor goes.
 */
export function removeEmptyProseBlocks(doc: Doc, bandId: string): Doc {
  return withBand(doc, bandId, (band) => {
    if (band.type !== 'prose') return band;
    const blocks = band.blocks.filter((block) => blockPlainText(block) !== '');
    if (blocks.length === band.blocks.length) return band;
    if (blocks.length === 0) return { ...band, blocks: [band.blocks[0] as ProseBlock] };
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

/**
 * There is no converter here any more.
 *
 * `ProseBlock.content` has a different shape per kind (docs/cms-contracts.md
 * 2.3): inline nodes for p/h2/h3/callout, paragraph nodes for a quote,
 * listItem nodes for a list. So switching kind has to reshape the content,
 * and this file used to do that itself, for the outline and the inspector,
 * while WS-5's floating toolbar used `convertBlockKind` in
 * `../prose/block.ts`.
 *
 * Two implementations of one user-visible action, and they disagreed. Given a
 * run carrying a mark the contract forbids — an `underline` that a paste can
 * produce — the toolbar stripped it and this one wrote it into the document.
 * Invisible, because the renderer ignores unknown marks and the next edit in
 * TipTap normalises it away, and still exactly the kind of content the
 * normalisation discipline exists to prevent.
 *
 * `setBlockKind` above now calls `convertBlockKind`. That function is pure
 * data too — it imports the schema and the palette, no TipTap and no React —
 * so there is no cycle and nothing was given up by deleting this one.
 */

type TipTapNode = { type?: string; content?: unknown[]; text?: string; marks?: unknown[] };

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
  const OPTIONAL = ['summary', 'url', 'urlLabel', 'cover'] as const;
  let meta: DocMeta = { ...doc.meta, ...patch };
  for (const key of OPTIONAL) {
    if (meta[key] === '' || meta[key] === undefined) meta = omit(meta, key);
  }
  // `hidden: false` is the default and is stored as nothing, like every
  // other optional field, so a page nobody has hidden carries no key.
  if (meta.hidden === false) meta = omit(meta, 'hidden');
  // A label for a link that is not there is not a label. Clearing the URL used
  // to leave `urlLabel` behind in the file, invisible (the renderer drops the
  // whole row with the link) and waiting to reappear under a different URL
  // typed months later.
  if (meta.url === undefined) meta = omit(meta, 'urlLabel');
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
