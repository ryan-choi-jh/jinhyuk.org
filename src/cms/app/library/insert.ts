/**
 * src/cms/app/library/insert.ts
 *
 * Catalogue entry -> `CanvasItem`. The one place the library touches the
 * document model.
 *
 * ---------------------------------------------------------------------------
 * Why an asset never comes in at its native size
 *
 * The reference width is 1344px. The assets on this site are 1200, 1280, 1206
 * and 2688px wide. Inserting `hero.webp` at 2688 means an item twice as wide
 * as the page, anchored off-canvas, and a resize handle somewhere past the
 * right edge of the screen. So the native size is used for one thing only,
 * the aspect ratio, and the width comes from a fraction of the reference
 * width chosen by that ratio:
 *
 *   panoramic   w/h >= 2.4     0.62 of 1344   a banner wants the page
 *   landscape   w/h >= 1.25    0.46           a photo beside a paragraph
 *   square      w/h >= 0.8     0.34
 *   portrait    w/h >= 0.5     0.28
 *   tall        otherwise      0.22           a phone screenshot
 *
 * Two clamps on top of that, both of which matter in practice:
 *
 *   - never upscale. A 64px icon comes in at 64px, not blown up to 457.
 *   - never taller than MAX_INSERT_HEIGHT. A 1206x2622 phone screenshot at
 *     0.22 would still be 643px tall, taller than most bands; it lands at
 *     285x620 instead.
 *
 * The owner can then drag it to whatever he wants. The point is that the first
 * thing he sees is placeable, not that it is final.
 */

import {
  DEFAULT_SHAPE_COLOR,
  DEFAULT_SHAPE_STROKE,
  REF_WIDTH,
  idForSeedStep,
  newId,
} from './shape-adapter.ts';
import type { CanvasItem } from './shape-adapter.ts';
import { VIDEO_FORMATS, isAssetEntry } from './schema.ts';
import type { AssetEntry, LibraryEntry, ShapeDefaults, ShapeEntry } from './schema.ts';

/** Nothing comes in taller than this, in reference px. */
export const MAX_INSERT_HEIGHT = 620;

/** Nothing comes in narrower than this, so a stray 3px asset is still grabbable. */
export const MIN_INSERT_WIDTH = 24;

/** Fraction of the reference width, by aspect ratio. See the header note. */
export const WIDTH_FRACTIONS: readonly { minAspect: number; fraction: number; label: string }[] = [
  { minAspect: 2.4, fraction: 0.62, label: 'panoramic' },
  { minAspect: 1.25, fraction: 0.46, label: 'landscape' },
  { minAspect: 0.8, fraction: 0.34, label: 'square' },
  { minAspect: 0.5, fraction: 0.28, label: 'portrait' },
  { minAspect: 0, fraction: 0.22, label: 'tall' },
];

export type Size = { w: number; h: number };
export type Geometry = { x: number; y: number; w: number; h: number };

export function widthFractionFor(aspect: number): { fraction: number; label: string } {
  const bucket =
    WIDTH_FRACTIONS.find((candidate) => aspect >= candidate.minAspect) ??
    WIDTH_FRACTIONS[WIDTH_FRACTIONS.length - 1];
  return { fraction: bucket.fraction, label: bucket.label };
}

/**
 * Default insert size for a stored asset, preserving its aspect ratio.
 * Pure arithmetic over the intrinsic size; nothing here touches the DOM, so
 * the number is the same before the file has loaded.
 */
export function assetInsertSize(
  nativeWidth: number,
  nativeHeight: number,
  refWidth: number = REF_WIDTH,
): Size {
  const safeW = Math.max(1, nativeWidth);
  const safeH = Math.max(1, nativeHeight);
  const aspect = safeW / safeH;
  const { fraction } = widthFractionFor(aspect);

  // Fraction of the page, but never bigger than the file really is.
  let w = Math.min(fraction * refWidth, safeW);
  let h = w / aspect;

  if (h > MAX_INSERT_HEIGHT) {
    h = MAX_INSERT_HEIGHT;
    w = h * aspect;
  }
  if (w > refWidth) {
    w = refWidth;
    h = w / aspect;
  }
  if (w < MIN_INSERT_WIDTH) {
    w = Math.min(MIN_INSERT_WIDTH, refWidth);
    h = w / aspect;
  }

  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

/** Default insert size for any entry. A shape's is its preset's own box. */
export function insertSizeFor(entry: LibraryEntry, refWidth: number = REF_WIDTH): Size {
  if (isAssetEntry(entry)) return assetInsertSize(entry.width, entry.height, refWidth);
  return {
    w: Math.max(1, Math.round(entry.defaults.width)),
    h: Math.max(1, Math.round(entry.defaults.height)),
  };
}

/* -------------------------------------------------------------------------- */
/* Placement                                                                   */
/* -------------------------------------------------------------------------- */

export type Origin = { x?: number; y?: number };

/**
 * Where the item lands. Centred across the reference width and at the top of
 * the band unless the host says otherwise, because the host is the only thing
 * that knows what else is already on that canvas.
 */
export function insertGeometry(
  entry: LibraryEntry,
  options: { refWidth?: number; origin?: Origin; size?: Size } = {},
): Geometry {
  const refWidth = options.refWidth ?? REF_WIDTH;
  const size = options.size ?? insertSizeFor(entry, refWidth);
  return {
    x: options.origin?.x ?? Math.round((refWidth - size.w) / 2),
    y: options.origin?.y ?? 0,
    w: size.w,
    h: size.h,
  };
}

/* -------------------------------------------------------------------------- */
/* The conversion                                                              */
/* -------------------------------------------------------------------------- */

/** A stored video becomes a `video` item; everything else an `image` item. */
export function canvasKindForAsset(entry: AssetEntry): 'image' | 'video' {
  const format = (entry.format ?? entry.src.split('.').pop() ?? '').toLowerCase();
  return (VIDEO_FORMATS as readonly string[]).includes(format) ? 'video' : 'image';
}

export type InsertOptions = {
  /**
   * The item's id. For a SHAPE this is load-bearing: the wobble is
   * `seedFromId(id)`, so passing the id whose drawing was previewed is what
   * makes the inserted squiggle the one on screen. The browser always passes
   * it. Omitted, a fresh id is rolled and the drawing will differ.
   */
  id?: string;
  refWidth?: number;
  origin?: Origin;
  size?: Size;
  z?: number;
  /** Live overrides from the detail panel's controls. Shapes only. */
  shape?: Partial<Pick<ShapeDefaults, 'color' | 'strokeWidth' | 'fill' | 'radius'>>;
  /** Overrides the alt text an image would otherwise take from the entry name. */
  alt?: string;
};

/**
 * The function the browser hands to `onInsert`. Returns a complete
 * `CanvasItem`, valid against `CanvasItemSchema`: no editor-only keys, no
 * undefined-valued keys (the schema is `.strict()`, so a present-but-undefined
 * `fill` on a squiggle is a validation error, not a no-op).
 */
export function canvasItemFromEntry(entry: LibraryEntry, options: InsertOptions = {}): CanvasItem {
  const geometry = insertGeometry(entry, {
    refWidth: options.refWidth,
    origin: options.origin,
    size: options.size,
  });

  if (isAssetEntry(entry)) {
    const item: CanvasItem = {
      id: options.id ?? newId('i'),
      kind: canvasKindForAsset(entry),
      ...geometry,
      src: entry.src,
    };
    const alt = options.alt ?? entry.name;
    if (alt !== '') item.alt = alt;
    if (options.z !== undefined) item.z = options.z;
    return item;
  }

  return shapeItem(entry, geometry, options);
}

function shapeItem(entry: ShapeEntry, geometry: Geometry, options: InsertOptions): CanvasItem {
  const overrides = options.shape ?? {};
  const item: CanvasItem = {
    id: options.id ?? entry.defaults.seedId ?? newId('i'),
    kind: 'shape',
    ...geometry,
    shape: entry.generator,
    color: overrides.color ?? entry.defaults.color ?? DEFAULT_SHAPE_COLOR,
    strokeWidth: overrides.strokeWidth ?? entry.defaults.strokeWidth ?? DEFAULT_SHAPE_STROKE,
  };

  const fill = overrides.fill ?? entry.defaults.fill;
  if (fill !== undefined && (entry.generator === 'rect' || entry.generator === 'ellipse')) {
    item.fill = fill;
  }
  const radius = overrides.radius ?? entry.defaults.radius;
  if (radius !== undefined && entry.generator === 'rect') {
    item.radius = radius;
  }
  if (options.z !== undefined) item.z = options.z;
  return item;
}

/* -------------------------------------------------------------------------- */
/* Seed stepping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The id sequence the seed control walks. Re-exported from the adapter so a
 * caller never has to know that a seed is really an id.
 */
export { idForSeedStep };
