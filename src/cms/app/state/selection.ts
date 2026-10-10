/**
 * src/cms/app/state/selection.ts
 *
 * WS-3. The selection model. It can address exactly three things, which is
 * what the brief asks for (section 4, WS-3): a band, a prose block, or a
 * canvas item.
 *
 * Selection is editor state, never document state. docs/cms-contracts.md 2.2
 * rule 1: every schema object is strict, so a stray `selected` key in a Doc is
 * a validation error. Keep it here.
 */

import type { Band, CanvasBand, CanvasItem, Doc, ProseBand, ProseBlock } from '../../schema.ts';

/* -------------------------------------------------------------------------- */
/* Shape                                                                       */
/* -------------------------------------------------------------------------- */

export type Selection =
  | { kind: 'none' }
  | { kind: 'band'; bandId: string }
  | { kind: 'block'; bandId: string; blockId: string }
  /**
   * One or more canvas items inside one band. An array because WS-4 does
   * multi-select; a single item is an array of one. Items from two different
   * bands are never selected at once.
   */
  | { kind: 'item'; bandId: string; itemIds: string[] };

export const NO_SELECTION: Selection = { kind: 'none' };

export function selectBand(bandId: string): Selection {
  return { kind: 'band', bandId };
}

export function selectBlock(bandId: string, blockId: string): Selection {
  return { kind: 'block', bandId, blockId };
}

export function selectItems(bandId: string, itemIds: readonly string[]): Selection {
  if (itemIds.length === 0) return { kind: 'band', bandId };
  return { kind: 'item', bandId, itemIds: [...itemIds] };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/** The band a selection lives in, whatever it points at. */
export function selectionBandId(selection: Selection): string | null {
  return selection.kind === 'none' ? null : selection.bandId;
}

/** First selected canvas item, which is the one the inspector edits. */
export function primaryItemId(selection: Selection): string | null {
  return selection.kind === 'item' ? (selection.itemIds[0] ?? null) : null;
}

export function isBandSelected(selection: Selection, bandId: string): boolean {
  return selection.kind !== 'none' && selection.bandId === bandId;
}

export function isBlockSelected(selection: Selection, bandId: string, blockId: string): boolean {
  return selection.kind === 'block' && selection.bandId === bandId && selection.blockId === blockId;
}

export function isItemSelected(selection: Selection, bandId: string, itemId: string): boolean {
  return selection.kind === 'item' && selection.bandId === bandId && selection.itemIds.includes(itemId);
}

/** Item ids selected inside `bandId`, which is what the canvas slot needs. */
export function selectedItemIds(selection: Selection, bandId: string): readonly string[] {
  if (selection.kind !== 'item' || selection.bandId !== bandId) return EMPTY_IDS;
  return selection.itemIds;
}

const EMPTY_IDS: readonly string[] = Object.freeze([]);

export function sameSelection(a: Selection, b: Selection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'none' || b.kind === 'none') return true;
  if (a.bandId !== b.bandId) return false;
  if (a.kind === 'block' && b.kind === 'block') return a.blockId === b.blockId;
  if (a.kind === 'item' && b.kind === 'item') {
    return a.itemIds.length === b.itemIds.length && a.itemIds.every((id, i) => id === b.itemIds[i]);
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Resolving against a document                                                */
/* -------------------------------------------------------------------------- */

export type ResolvedSelection =
  | { kind: 'none' }
  | { kind: 'band'; band: Band; bandIndex: number }
  | { kind: 'block'; band: ProseBand; bandIndex: number; block: ProseBlock; blockIndex: number }
  | { kind: 'item'; band: CanvasBand; bandIndex: number; items: CanvasItem[]; primary: CanvasItem };

/**
 * Look the selection up in a document. Returns `{ kind: 'none' }` when it
 * points at something that no longer exists, so a caller never has to guard a
 * stale id itself.
 */
export function resolveSelection(doc: Doc, selection: Selection): ResolvedSelection {
  if (selection.kind === 'none') return { kind: 'none' };

  const bandIndex = doc.bands.findIndex((band) => band.id === selection.bandId);
  if (bandIndex < 0) return { kind: 'none' };
  const band = doc.bands[bandIndex] as Band;

  if (selection.kind === 'band') return { kind: 'band', band, bandIndex };

  if (selection.kind === 'block') {
    if (band.type !== 'prose') return { kind: 'none' };
    const blockIndex = band.blocks.findIndex((block) => block.id === selection.blockId);
    if (blockIndex < 0) return { kind: 'band', band, bandIndex };
    return { kind: 'block', band, bandIndex, block: band.blocks[blockIndex] as ProseBlock, blockIndex };
  }

  if (band.type !== 'canvas') return { kind: 'none' };
  const items = selection.itemIds
    .map((id) => band.items.find((item) => item.id === id))
    .filter((item): item is CanvasItem => item !== undefined);
  if (items.length === 0) return { kind: 'band', band, bandIndex };
  return { kind: 'item', band, bandIndex, items, primary: items[0] as CanvasItem };
}

/**
 * Drop the parts of a selection that no longer exist. Run after every document
 * change: deleting a band must not leave the inspector pointing into a hole.
 * Returns the same object when nothing changed, so it is cheap to call.
 */
export function pruneSelection(doc: Doc, selection: Selection): Selection {
  if (selection.kind === 'none') return selection;

  const band = doc.bands.find((candidate) => candidate.id === selection.bandId);
  if (band === undefined) return NO_SELECTION;

  if (selection.kind === 'band') return selection;

  if (selection.kind === 'block') {
    if (band.type !== 'prose') return selectBand(band.id);
    const exists = band.blocks.some((block) => block.id === selection.blockId);
    return exists ? selection : selectBand(band.id);
  }

  if (band.type !== 'canvas') return selectBand(band.id);
  const kept = selection.itemIds.filter((id) => band.items.some((item) => item.id === id));
  if (kept.length === selection.itemIds.length) return selection;
  if (kept.length === 0) return selectBand(band.id);
  return { kind: 'item', bandId: selection.bandId, itemIds: kept };
}

/** Short human label, for the inspector header and the outline status line. */
export function describeSelection(doc: Doc, selection: Selection): string {
  const resolved = resolveSelection(doc, selection);
  switch (resolved.kind) {
    case 'none':
      return 'Page';
    case 'band':
      return `Band ${resolved.bandIndex + 1} · ${resolved.band.type}`;
    case 'block':
      return `Band ${resolved.bandIndex + 1} · block ${resolved.blockIndex + 1} · ${resolved.block.kind}`;
    case 'item': {
      if (resolved.items.length > 1) return `Band ${resolved.bandIndex + 1} · ${resolved.items.length} items`;
      const item = resolved.primary;
      const what = item.kind === 'shape' ? (item.shape ?? 'shape') : item.kind;
      return `Band ${resolved.bandIndex + 1} · ${what}`;
    }
  }
}
