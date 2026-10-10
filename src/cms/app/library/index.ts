/**
 * src/cms/app/library/index.ts
 *
 * The component library's public surface. Anything mounting the library
 * imports from here and from nowhere else inside this directory.
 *
 *   import { LibraryBrowser } from '../library/index.ts';
 *
 *   <LibraryBrowser
 *     onInsert={(item) => addItemToBand(bandId, item)}
 *     origin={{ y: 40 }}
 *     onClose={() => setLibraryOpen(false)}
 *   />
 *
 * `onInsert` receives a complete `CanvasItem`, already valid against
 * `CanvasItemSchema`. Two rules for the host:
 *
 *  1. Do not change a shape item's `id`. The hand-drawn wobble is
 *     `seedFromId(id)`, so a new id is a different drawing and the squiggle
 *     that was chosen in the picker is not the one that lands on the page.
 *  2. `z` is yours. The library never sets it unless asked to.
 *
 * Everything below `LibraryBrowser` is exported because the import script, the
 * harness and anyone wanting to build a different front end on the same
 * catalogue all need it. The catalogue schema lives in ./schema.ts and is
 * separate from `src/cms/schema.ts`, which this directory does not edit.
 */

/* The component. */
export { LibraryBrowser, default } from './LibraryBrowser.tsx';
export type { LibraryBrowserProps } from './LibraryBrowser.tsx';

/* The catalogue schema and its types. */
export {
  AssetEntrySchema,
  CATALOGUE_VERSION,
  CategorySchema,
  CatalogueHexSchema,
  CatalogueSrcSchema,
  EntryIdSchema,
  GENERATOR_NAMES,
  GeneratorSchema,
  LibraryCatalogueSchema,
  LibraryEntrySchema,
  PreviewSchema,
  ShapeDefaultsSchema,
  ShapeEntrySchema,
  TagSchema,
  VIDEO_FORMATS,
  emptyCatalogue,
  generatorsAgree,
  isAssetEntry,
  isShapeEntry,
  parseCatalogue,
  parseEntry,
} from './schema.ts';
export type {
  AssetEntry,
  LibraryCatalogue,
  LibraryEntry,
  Preview,
  ShapeDefaults,
  ShapeEntry,
} from './schema.ts';

/* Loading, searching and the small facts the grid needs. */
export {
  categoriesOf,
  filterEntries,
  formatBytes,
  humanise,
  loadCatalogue,
  matchesText,
  mergeShapes,
  previewAspect,
  previewSrcFor,
  searchTextFor,
  tokenise,
} from './catalogue.ts';
export type { CategoryCount, KindFilter, LoadedCatalogue, Query } from './catalogue.ts';

/* Entry to CanvasItem. */
export {
  MAX_INSERT_HEIGHT,
  MIN_INSERT_WIDTH,
  WIDTH_FRACTIONS,
  assetInsertSize,
  canvasItemFromEntry,
  canvasKindForAsset,
  insertGeometry,
  insertSizeFor,
  widthFractionFor,
} from './insert.ts';
export type { Geometry, InsertOptions, Origin, Size } from './insert.ts';

/* The generated shapes, and the controls' bounds. */
export { BUILT_IN_SHAPE_ENTRIES, STROKE_MAX, STROKE_MIN, STROKE_STEP, SWATCHES } from './shapes.ts';
export type { Swatch } from './shapes.ts';

/* The seam onto WS-6 and WS-0. Exported so a host can draw a preview itself. */
export {
  DEFAULT_SHAPE_COLOR,
  DEFAULT_SHAPE_STROKE,
  REF_WIDTH,
  SHAPE_GENERATORS,
  checkCanvasItem,
  drawShape,
  freshSeedBase,
  idForSeedStep,
  seedFromId,
  seedLabel,
} from './shape-adapter.ts';
export type { CanvasItem, ShapeKind, ShapeSpec } from './shape-adapter.ts';

/* Styles, for a host that wants to inject them itself. */
export { LIBRARY_CSS, LIBRARY_STYLE_ID, STAGE_ASPECT, TILE_ASPECT, useLibraryStyles } from './styles.ts';

/* The seed catalogue, which is what `<LibraryBrowser>` uses by default. */
export { default as SEED_CATALOGUE } from './catalogue.seed.json';
