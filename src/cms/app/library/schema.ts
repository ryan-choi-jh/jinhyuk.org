/**
 * src/cms/app/library/schema.ts
 *
 * The component library's CATALOGUE schema. Not the document schema.
 *
 * `src/cms/schema.ts` says what a page is. This says what is in the drawer you
 * pull things out of to build one. They meet in exactly one place: an entry in
 * here can be turned into a `CanvasItem` (see ./insert.ts), which is the thing
 * `src/cms/schema.ts` validates. Nothing in this file is imported by anyone
 * outside `src/cms/app/library/`, and this file does not import
 * `src/cms/schema.ts` directly; ./shape-adapter.ts is the only seam.
 *
 * Two kinds of thing live in one catalogue, because the owner asked for one
 * drawer, not two:
 *
 *   kind: 'asset'   a file. An illustration drawn in Paper and exported, a
 *                   photo, a screenshot. It has a `src`, and an intrinsic
 *                   pixel size that the editor needs in order to place it at
 *                   a sane fraction of the page instead of at 2688px wide.
 *
 *   kind: 'shape'   not a file. A call into WS-6's parametric generator:
 *                   a generator name plus the parameters to call it with.
 *                   Generated at insert time, never stored.
 *
 * Both are `.strict()`, the same rule the document schema follows: an unknown
 * key is an error, not something silently dropped, so a typo in a hand-curated
 * category never quietly disappears.
 *
 * ---------------------------------------------------------------------------
 * Why there is a `preview` and why it is an object
 *
 * Several of the assets on this site are 1200-2700px on their long edge, and
 * one of them is a 1206x2622 phone screenshot. Putting that in an 84px grid
 * tile means the browser downloads 1.8MB to draw a thumbnail, fourteen times
 * over. So an entry may carry a `preview`: a small derivative written by
 * `scripts/import-assets.ts`.
 *
 * It is an object, `{ src, w, h }`, not a bare string, because the grid needs
 * the thumbnail's own aspect ratio to lay a tile out before the image has
 * loaded. Knowing only the path means every tile reflows on load.
 *
 * ---------------------------------------------------------------------------
 * Why a shape's default seed is an id and not a number
 *
 * `ShapeSpec.seed` is a number, but `CanvasItem` has no seed field: the wobble
 * is derived from the item's id (`seedFromId`). An entry therefore stores
 * `seedId`, the item id whose hash produces the drawing shown in the grid.
 * Insert the entry and that id goes onto the page with it, so the catalogue
 * thumbnail and the published squiggle are the same drawing. See the long note
 * at the foot of ./shape-adapter.ts.
 */

import { z } from 'zod';

import { SHAPE_GENERATORS } from './shape-adapter.ts';
import type { ShapeKind } from './shape-adapter.ts';

/** Catalogue format version. Bumping this is a migration, not a patch. */
export const CATALOGUE_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** Site-absolute path or an absolute http(s) URL. Same rule as `SrcSchema`. */
const SRC_RE = /^(?:\/\S*|https?:\/\/\S+)$/;

/**
 * Entry id. Same alphabet as the document schema's `IdSchema`, because a
 * shape entry's `seedId` becomes a real `CanvasItem.id` on insert and would
 * otherwise fail validation on the way to disk.
 */
export const EntryIdSchema = z
  .string()
  .regex(ID_RE, 'id must be 1-64 characters from A-Z a-z 0-9 _ -');

export const CatalogueSrcSchema = z
  .string()
  .regex(SRC_RE, 'src must be a site-absolute path like "/library/hero.webp" or an http(s) URL');

export const CatalogueHexSchema = z
  .string()
  .regex(HEX_RE, 'colour must be hex, e.g. #ff5722 or #ff5722cc');

/**
 * A category. Lowercase kebab-case and open-ended: the owner invents these as
 * he imports, and the browser builds its filter row from whatever it finds
 * rather than from a fixed enum, so a new category needs no code change.
 */
export const CategorySchema = z
  .string()
  .regex(SLUG_RE, 'category must be lowercase kebab-case, e.g. "film-still"')
  .max(40, 'category must be 40 characters or fewer');

/** A search tag. Same shape as a category, for the same reason. */
export const TagSchema = z
  .string()
  .regex(SLUG_RE, 'tag must be lowercase kebab-case, e.g. "hand-drawn"')
  .max(40, 'tag must be 40 characters or fewer');

export const PreviewSchema = z
  .object({
    src: CatalogueSrcSchema,
    /** The thumbnail's own size, so a tile can be laid out before it loads. */
    w: z.number().int().positive(),
    h: z.number().int().positive(),
  })
  .strict();

export type Preview = z.infer<typeof PreviewSchema>;

/* -------------------------------------------------------------------------- */
/* Shared fields                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The three hand-curated fields are `name`, `category` and `tags`. The import
 * script is forbidden from overwriting them on an entry that already exists;
 * that promise is the reason they are grouped and commented here.
 */
const SHARED_FIELDS = {
  id: EntryIdSchema,
  /** Hand-curated. What the owner calls this thing. */
  name: z.string().min(1, 'name must not be empty').max(120),
  /** Hand-curated. */
  category: CategorySchema,
  /** Hand-curated. Searched alongside the name. */
  tags: z.array(TagSchema).max(24, 'at most 24 tags'),
  /** Hand-curated. A sentence for the detail panel; never shown in the grid. */
  note: z.string().max(400).optional(),
} as const;

/* -------------------------------------------------------------------------- */
/* Assets                                                                      */
/* -------------------------------------------------------------------------- */

/** Formats that become a `video` canvas item rather than an `image` one. */
export const VIDEO_FORMATS = ['mp4', 'webm', 'mov', 'm4v'] as const;

export const AssetEntrySchema = z
  .object({
    ...SHARED_FIELDS,
    kind: z.literal('asset'),
    /** Where the file is served from. */
    src: CatalogueSrcSchema,
    /** Intrinsic pixel size, measured from the file, never guessed. */
    width: z.number().int().positive('width must be greater than 0'),
    height: z.number().int().positive('height must be greater than 0'),
    /**
     * The file has an alpha channel, so the grid draws it on a chequerboard
     * instead of on a flat panel, where a transparent PNG is invisible.
     * Absent means "not known to be transparent".
     */
    transparent: z.boolean().optional(),
    /** Lowercase, from the bytes: 'png', 'jpeg', 'webp', 'svg'. */
    format: z.string().regex(/^[a-z0-9]{1,8}$/, 'format must be a short lowercase token').optional(),
    /** Size on disk, so the detail panel can warn about a 1.8MB tile. */
    bytes: z.number().int().nonnegative().optional(),
    /** Small derivative for the grid. See the header note. */
    preview: PreviewSchema.optional(),
  })
  .strict();

export type AssetEntry = z.infer<typeof AssetEntrySchema>;

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The zod-side mirror of WS-6's `SHAPE_KINDS`. It has to be a literal tuple
 * because `z.enum` needs one, so it cannot simply be the imported array.
 * `generatorsAgree()` is the runtime check that the mirror has not drifted,
 * and the harness asserts it.
 */
export const GENERATOR_NAMES = ['line', 'rect', 'ellipse', 'squiggle', 'arrow'] as const;

/**
 * Compile-time half of the same check. If WS-6 renames a kind this line stops
 * compiling; if WS-6 adds one, `generatorsAgree()` returns false at runtime
 * and the harness fails on it.
 */
const _generatorNamesAreShapeKinds: readonly ShapeKind[] = GENERATOR_NAMES;
void _generatorNamesAreShapeKinds;

export const GeneratorSchema = z.enum(GENERATOR_NAMES);

/** True when this file's generator list still matches WS-6's. */
export function generatorsAgree(): boolean {
  const mine = [...GENERATOR_NAMES].sort().join(',');
  const theirs = [...SHAPE_GENERATORS].sort().join(',');
  return mine === theirs;
}

/**
 * The parameters the generator is called with. Everything that affects the
 * drawing is explicit, exactly as `ShapeSpec` is, so a preset is a complete
 * description and not a partial one with hidden fallbacks.
 */
export const ShapeDefaultsSchema = z
  .object({
    /** Reference px. The box the shape is drawn into on insert. */
    width: z.number().finite().positive('width must be greater than 0'),
    height: z.number().finite().positive('height must be greater than 0'),
    color: CatalogueHexSchema,
    strokeWidth: z.number().finite().positive('strokeWidth must be greater than 0'),
    /** rect and ellipse only. Absent means no fill; there is no "none". */
    fill: CatalogueHexSchema.optional(),
    /** rect only. Corner radius in reference px. */
    radius: z.number().finite().nonnegative().optional(),
    /**
     * The item id whose hash seeds this preset's wobble. Absent means the
     * browser rolls a fresh one. See the header note.
     */
    seedId: EntryIdSchema.optional(),
  })
  .strict();

export type ShapeDefaults = z.infer<typeof ShapeDefaultsSchema>;

/**
 * The plain object, with no refinement attached. Kept separate because
 * `z.discriminatedUnion` only accepts ZodObjects: hang a `.superRefine` on
 * this one and the union below throws when the module is evaluated rather
 * than when something is parsed.
 */
const ShapeEntryObject = z
  .object({
    ...SHARED_FIELDS,
    kind: z.literal('shape'),
    generator: GeneratorSchema,
    defaults: ShapeDefaultsSchema,
    /**
     * Unused in practice, since a shape draws its own preview from `defaults`
     * at whatever size the tile is, but allowed, so a shape whose generator is
     * one day too slow to redraw live can carry a still.
     */
    preview: PreviewSchema.optional(),
  })
  .strict();

export type ShapeEntry = z.infer<typeof ShapeEntryObject>;

/**
 * `fill` and `radius` mean nothing on a line, an arrow or a squiggle, and
 * `CanvasItemSchema` rejects them there too. Catching it in the catalogue
 * means a bad preset fails where it was written rather than three steps
 * later, when the page refuses to save.
 */
function checkShapeFields(
  entry: ShapeEntry,
  ctx: z.RefinementCtx,
  base: (string | number)[] = [],
): void {
  const reject = (key: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...base, 'defaults', key], message });

  if (entry.defaults.fill !== undefined && entry.generator !== 'rect' && entry.generator !== 'ellipse') {
    reject('fill', '`fill` is only valid on a rect or an ellipse');
  }
  if (entry.defaults.radius !== undefined && entry.generator !== 'rect') {
    reject('radius', '`radius` is only valid on a rect');
  }
}

export const ShapeEntrySchema = ShapeEntryObject.superRefine((entry, ctx) => {
  checkShapeFields(entry, ctx);
});

/* -------------------------------------------------------------------------- */
/* The catalogue                                                               */
/* -------------------------------------------------------------------------- */

export type LibraryEntry = AssetEntry | ShapeEntry;

/**
 * Discriminated on `kind`, so a malformed asset reports "src: required"
 * instead of a wall of union candidates. The shape branch's extra rules are
 * applied to the union rather than to the branch, for the reason above.
 */
export const LibraryEntrySchema = z
  .discriminatedUnion('kind', [AssetEntrySchema, ShapeEntryObject])
  .superRefine((entry, ctx) => {
    if (entry.kind === 'shape') checkShapeFields(entry, ctx);
  });

export const LibraryCatalogueSchema = z
  .object({
    version: z.literal(CATALOGUE_VERSION),
    entries: z.array(LibraryEntrySchema),
  })
  .strict()
  .superRefine((catalogue, ctx) => {
    const seen = new Map<string, number>();
    catalogue.entries.forEach((entry, index) => {
      const prior = seen.get(entry.id);
      if (prior !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entries', index, 'id'],
          message: `duplicate entry id "${entry.id}" (already used at entries.${prior})`,
        });
        return;
      }
      seen.set(entry.id, index);
    });
  });

export type LibraryCatalogue = z.infer<typeof LibraryCatalogueSchema>;

/* -------------------------------------------------------------------------- */
/* Guards and validation                                                       */
/* -------------------------------------------------------------------------- */

export function isAssetEntry(entry: LibraryEntry): entry is AssetEntry {
  return entry.kind === 'asset';
}

export function isShapeEntry(entry: LibraryEntry): entry is ShapeEntry {
  return entry.kind === 'shape';
}

/**
 * Validate one entry on its own. The browser and the import script both want
 * this rather than all-or-nothing: one malformed entry in a hand-edited file
 * should grey out one tile, not empty the drawer.
 */
export function parseEntry(
  value: unknown,
): { ok: true; entry: LibraryEntry } | { ok: false; errors: string[] } {
  const kind = (value as { kind?: unknown } | null)?.kind;
  const schema = kind === 'shape' ? ShapeEntrySchema : AssetEntrySchema;
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, entry: result.data as LibraryEntry };
  return { ok: false, errors: formatIssues(result.error) };
}

/** Validate a whole catalogue file. */
export function parseCatalogue(
  value: unknown,
): { ok: true; catalogue: LibraryCatalogue } | { ok: false; errors: string[] } {
  const result = LibraryCatalogueSchema.safeParse(value);
  if (result.success) return { ok: true, catalogue: result.data };
  return { ok: false, errors: formatIssues(result.error) };
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length === 0 ? '(root)' : issue.path.join('.');
    return `${where}: ${issue.message}`;
  });
}

/** An empty but valid catalogue, for a first run of the import script. */
export function emptyCatalogue(): LibraryCatalogue {
  return { version: CATALOGUE_VERSION, entries: [] };
}
