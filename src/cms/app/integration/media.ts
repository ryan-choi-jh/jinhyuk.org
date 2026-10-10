/**
 * src/cms/app/integration/media.ts
 *
 * WS-8. The arithmetic between "a file landed on a canvas" and "a CanvasItem
 * sits where it was dropped at a sane size".
 *
 * Pure: no React, no DOM, no fetch, so `../integration/verify.ts` can assert
 * exact numbers under bare node. The only thing it knows about the outside
 * world is the shape of what WS-2's media endpoint returns: `src`, and the
 * intrinsic `w`/`h` the brief (3.5) requires precisely so an item can be
 * placed before the browser has loaded the file.
 */

import { REFERENCE_WIDTH, newId } from '../../schema.ts';
import type { CanvasBand, CanvasItem, Doc } from '../../schema.ts';

/* -------------------------------------------------------------------------- */
/* What kind of item a file becomes                                            */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors ALLOWED_MEDIA in src/cms/server/config.ts, split by the CanvasItem
 * kind each extension becomes. Restated rather than imported: config.ts reads
 * `process.env` at call time and belongs to the server half, and this module
 * is bundled into the browser.
 */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg'] as const;
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm'] as const;

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toLowerCase();
}

/** `null` means "the media endpoint would refuse this", so do not upload it. */
export function itemKindForFile(filename: string, mime = ''): 'image' | 'video' | null {
  const extension = extensionOf(filename);
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(extension)) return 'image';
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(extension)) return 'video';
  // A paste or a drag from another browser tab can arrive with a type and no
  // usable name. The extension is what the server keys off, so a typed file
  // with no extension is still rejected here rather than 400-ing there.
  if (extension === '' && mime.startsWith('image/')) return null;
  return null;
}

export function unsupportedFileMessage(filename: string): string {
  const extension = extensionOf(filename);
  const shown = extension === '' ? 'no extension' : `.${extension}`;
  return `${filename} (${shown}) is not a kind of file this CMS stores. Images: ${IMAGE_EXTENSIONS.join(', ')}. Video: ${VIDEO_EXTENSIONS.join(', ')}.`;
}

/* -------------------------------------------------------------------------- */
/* Sizing and placement                                                        */
/* -------------------------------------------------------------------------- */

export type Size = { w: number; h: number };
export type Stage = { width: number; height: number };
export type Point = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };

/**
 * How wide a dropped image is allowed to be, as a fraction of the reference
 * width. 0.42 of 1344 is 564px: big enough to read, narrow enough that two
 * can sit side by side, which is the layout this CMS exists to make.
 */
export const DROP_WIDTH_FRACTION = 0.42;
/** Vertical breathing room kept inside the band, in reference px. */
export const DROP_HEIGHT_MARGIN = 24;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), Math.max(low, high));

/**
 * Scale an intrinsic size down to fit the band, keeping the aspect ratio.
 * Never scales up: a 60x60 icon stays 60x60 rather than being blown up to
 * 564px wide, which is never what dropping a small file means.
 */
export function fitMedia(intrinsic: Size, stage: Stage): Size {
  const w = Math.max(1, intrinsic.w);
  const h = Math.max(1, intrinsic.h);
  const maxW = Math.max(1, Math.round(stage.width * DROP_WIDTH_FRACTION));
  const maxH = Math.max(1, stage.height - DROP_HEIGHT_MARGIN);
  const factor = Math.min(1, maxW / w, maxH / h);
  return { w: Math.max(1, Math.round(w * factor)), h: Math.max(1, Math.round(h * factor)) };
}

/**
 * Centre a box on a point and keep it inside the stage. Geometry is whole
 * reference px (3.3), and `x`/`y` may be negative in the schema but an item
 * the author just dropped should land where they can see it, so this clamps.
 */
export function placeBox(size: Size, stage: Stage, at: Point): Box {
  return {
    x: Math.round(clamp(at.x - size.w / 2, 0, stage.width - size.w)),
    y: Math.round(clamp(at.y - size.h / 2, 0, stage.height - size.h)),
    w: size.w,
    h: size.h,
  };
}

/** Where an asset goes when there is no drop point: the middle, then stepped. */
export const CASCADE_STEP = 28;

export function placeCentred(size: Size, stage: Stage, step = 0): Box {
  const offset = (step % 6) * CASCADE_STEP;
  return placeBox(size, stage, {
    x: stage.width / 2 + offset,
    y: stage.height / 2 + offset,
  });
}

/* -------------------------------------------------------------------------- */
/* Items                                                                       */
/* -------------------------------------------------------------------------- */

/** One above the top of the band, so a new item is never buried. */
export function nextZ(items: readonly CanvasItem[]): number {
  let top = -1;
  for (const item of items) if (item.z !== undefined && item.z > top) top = item.z;
  return top + 1;
}

/** Every id in the document: bands, prose blocks and canvas items. */
export function takenIds(doc: Doc): Set<string> {
  const taken = new Set<string>();
  for (const band of doc.bands) {
    taken.add(band.id);
    if (band.type === 'prose') for (const block of band.blocks) taken.add(block.id);
    else for (const item of band.items) taken.add(item.id);
  }
  return taken;
}

/** `newId` is random, but ids must be unique document-wide (contracts 2.2.3). */
export function freshItemId(doc: Doc): string {
  const taken = takenIds(doc);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const id = newId('i');
    if (!taken.has(id)) return id;
  }
  // 50 collisions on a 40-bit random suffix does not happen; throwing is
  // better than returning a duplicate that makes the document unsaveable.
  throw new Error('could not mint a unique canvas item id');
}

export type UploadedMedia = {
  src: string;
  w: number;
  h: number;
  /** WS-2 says where the numbers came from; 'fallback' means it guessed. */
  dimensions?: 'intrinsic' | 'declared' | 'fallback';
};

/**
 * The whole drop path, as one pure function: an upload result plus where the
 * pointer was becomes a CanvasItem that passes `validateDoc`.
 */
export function mediaItem(
  id: string,
  kind: 'image' | 'video',
  upload: UploadedMedia,
  band: Pick<CanvasBand, 'items' | 'height'>,
  at: Point | null,
  step = 0,
): CanvasItem {
  const stage: Stage = { width: REFERENCE_WIDTH, height: band.height };
  const size = fitMedia({ w: upload.w, h: upload.h }, stage);
  const box = at === null ? placeCentred(size, stage, step) : placeBox(size, stage, at);
  return {
    id,
    kind,
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    z: nextZ(band.items),
    src: upload.src,
  };
}

/* -------------------------------------------------------------------------- */
/* Showing media that is in git but not in this deployment                     */
/* -------------------------------------------------------------------------- */

export const RAW_BASE = 'https://raw.githubusercontent.com';

/**
 * The editor runs on Vercel from a build of the repo; the media it uploads is
 * committed to a branch and is not in that build's `public/`, and is not on
 * GitHub Pages until the site rebuilds. So `/media/...` 404s for exactly the
 * file the author just added. WS-7's preview solves this by pointing media at
 * raw.githubusercontent on the branch being edited; this is the same trick,
 * narrowed to `/media/` so it cannot touch anything else.
 *
 * Returns identity when the repo and branch are unknown, which is what makes
 * it safe to call before `authStatus()` has answered.
 */
export function makeMediaResolver(
  repo: string | null | undefined,
  branch: string | null | undefined,
  rawBase = RAW_BASE,
): (src: string) => string {
  if (repo === null || repo === undefined || repo === '') return (src) => src;
  if (branch === null || branch === undefined || branch === '') return (src) => src;
  const prefix = `${rawBase}/${repo}/${branch}/public`;
  return (src) => (src.startsWith('/media/') ? `${prefix}${src}` : src);
}

/**
 * WS-4's `<CanvasEditor>` renders `item.src` straight into an `<img>`; it does
 * not take `resolveMediaSrc` (WS-3's slot contract hands one over, but the
 * component has no prop for it). Rather than reach into WS-4, the items are
 * projected on the way in and un-projected on the way out: the component only
 * ever writes geometry, so restoring every `src` from the item with the same
 * id is exact.
 */
export function projectItemSrc(
  items: readonly CanvasItem[],
  resolve: (src: string) => string,
): CanvasItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.src === undefined) return item;
    const resolved = resolve(item.src);
    if (resolved === item.src) return item;
    changed = true;
    return { ...item, src: resolved };
  });
  return changed ? next : (items as CanvasItem[]);
}

export function restoreItemSrc(
  items: readonly CanvasItem[],
  originals: readonly CanvasItem[],
): CanvasItem[] {
  const bySource = new Map<string, string | undefined>();
  for (const item of originals) bySource.set(item.id, item.src);
  let changed = false;
  const next = items.map((item) => {
    if (!bySource.has(item.id)) return item;
    const original = bySource.get(item.id);
    if (original === item.src) return item;
    changed = true;
    if (original === undefined) {
      const { src: _dropped, ...rest } = item;
      return rest as CanvasItem;
    }
    return { ...item, src: original };
  });
  return changed ? next : (items as CanvasItem[]);
}
