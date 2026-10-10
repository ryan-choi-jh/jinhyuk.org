/**
 * src/cms/app/integration/doc-edits.ts
 *
 * WS-8. The two document edits that belong to the wiring rather than to any
 * one workstream, as pure `Doc -> Doc` functions so they can be committed
 * through `store.update()` as a single undo step and asserted under bare node.
 *
 * Why these are here and not in WS-3's doc-ops:
 *
 *  - `replaceProseBlock`. WS-5's `<ProseEditor>` emits a WHOLE ProseBlock,
 *    because its toolbar owns block kind and kind lives on the block. WS-3's
 *    slot takes `content` only and owns kind through `store.setBlockKind`,
 *    which converts the content with WS-3's converter. Calling both would be
 *    two history entries and two conversions of the same text, and the second
 *    one would overwrite the first. One function that writes the block WS-5
 *    actually produced is the honest wiring, and WS-3 says so in its notes:
 *    "override the shell's converter with store.update".
 *
 *  - `addCanvasItemAt`. WS-3's `store.addCanvasItem` appends and selects, which
 *    is right, but the asset picker and the drop handler both need the band's
 *    current items to compute `z` and a free position first. Doing that inside
 *    the recipe means the numbers come from the document the edit is applied
 *    to, not from a React render that may be one state behind.
 */

import { isCanvasBand, isProseBand } from '../../schema.ts';
import type { CanvasBand, CanvasItem, Doc, ProseBlock } from '../../schema.ts';

/** Same band, new blocks array; the rest of the document is untouched. */
export function replaceProseBlock(doc: Doc, bandId: string, block: ProseBlock): Doc {
  const index = doc.bands.findIndex((band) => band.id === bandId);
  if (index < 0) return doc;
  const band = doc.bands[index];
  if (band === undefined || !isProseBand(band)) return doc;
  const blockIndex = band.blocks.findIndex((candidate) => candidate.id === block.id);
  if (blockIndex < 0) return doc;
  const current = band.blocks[blockIndex] as ProseBlock;
  if (current.kind === block.kind && current.content === block.content) return doc;

  const blocks = [...band.blocks];
  // The id is the document's, never the editor's: a component cannot rename a
  // block by emitting a different one.
  blocks[blockIndex] = { id: current.id, kind: block.kind, content: block.content };
  const bands = [...doc.bands];
  bands[index] = { ...band, blocks };
  return { ...doc, bands };
}

/**
 * Append an item built from the band as it exists in `doc`. The builder gets
 * the real band, so `nextZ` and any placement maths see the items that are
 * actually there.
 */
export function addCanvasItemAt(
  doc: Doc,
  bandId: string,
  build: (band: CanvasBand) => CanvasItem | null,
): Doc {
  const index = doc.bands.findIndex((band) => band.id === bandId);
  if (index < 0) return doc;
  const band = doc.bands[index];
  if (band === undefined || !isCanvasBand(band)) return doc;
  const item = build(band);
  if (item === null) return doc;
  const bands = [...doc.bands];
  bands[index] = { ...band, items: [...band.items, item] };
  return { ...doc, bands };
}

/** Append several items in one step, each built against the growing band. */
export function addCanvasItemsAt(
  doc: Doc,
  bandId: string,
  builders: readonly ((band: CanvasBand) => CanvasItem | null)[],
): Doc {
  let next = doc;
  for (const build of builders) next = addCanvasItemAt(next, bandId, build);
  return next;
}

/** The first canvas band in the document, or null. Used to pick a default target. */
export function firstCanvasBand(doc: Doc): CanvasBand | null {
  for (const band of doc.bands) if (isCanvasBand(band)) return band;
  return null;
}

export function canvasBandById(doc: Doc, bandId: string | null): CanvasBand | null {
  if (bandId === null) return null;
  const band = doc.bands.find((candidate) => candidate.id === bandId);
  if (band === undefined || !isCanvasBand(band)) return null;
  return band;
}

/**
 * A blank, valid document for a slug that has no page yet, so `/cms/<slug>`
 * can be an editor instead of an error. The ids come from the caller because
 * the route builds this server side and `newId` is random: generating it twice
 * (once in SSR, once on hydration) would otherwise produce two different
 * documents.
 */
export function blankDoc(options: {
  slug: string;
  title: string;
  date: string;
  bandId: string;
  blockId: string;
}): Doc {
  return {
    version: 1,
    meta: { title: options.title, slug: options.slug, date: options.date },
    bands: [
      {
        id: options.bandId,
        type: 'prose',
        blocks: [{ id: options.blockId, kind: 'p', content: [] }],
      },
    ],
  };
}

/** `my-new-page` -> `My new page`. Only ever a first guess at a title. */
export function titleFromSlug(slug: string): string {
  const words = slug.split('-').filter((part) => part !== '');
  if (words.length === 0) return 'Untitled';
  const [first, ...rest] = words;
  const head = (first as string).charAt(0).toUpperCase() + (first as string).slice(1);
  return [head, ...rest].join(' ');
}
