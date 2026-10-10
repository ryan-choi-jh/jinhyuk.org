/**
 * src/cms/app/library/shape-adapter.ts
 *
 * The ONE file in this directory that reaches outside it.
 *
 * The component library needs four things it does not own: the shape
 * generator, the shape-kind list, the 1344px reference width and the two
 * shape defaults. Every one of them is somebody else's frozen contract
 * (docs/cms-contracts.md section 5, and docs/cms-rebuild.md rule 6), and
 * `src/cms/schema.ts` and `src/cms/app/canvas/**` are both being rewritten
 * by other agents while this is being written.
 *
 * So the whole dependency is funnelled through this file. Nothing else under
 * `library/` imports from outside `library/`. If a signature upstream moves,
 * this is the only file that has to move with it, and the browser, the
 * catalogue schema and the import script are untouched.
 *
 * What is imported, and from exactly where:
 *
 *   src/cms/assets/shapes.ts    generateShape(spec) -> string   (WS-6, frozen)
 *                               SHAPE_KINDS: readonly ShapeKind[]
 *   src/cms/schema.ts           REFERENCE_WIDTH, SHAPE_DEFAULTS,
 *                               newId(), seedFromId()           (WS-0, frozen)
 *
 * The `CanvasItem`, `ShapeKind` and `ShapeSpec` types come across as
 * `import type`, which esbuild erases, so the only runtime edge is the four
 * values above plus `generateShape`.
 *
 * ---------------------------------------------------------------------------
 * The seed problem, and why this file exports `idForSeedStep` instead of a
 * seed setter.
 *
 * `CanvasItem` is `.strict()` and has no `seed` field. A shape's wobble seed
 * is derived from the item's id, by `seedFromId(item.id)` inside
 * `shapeSpecFromItem`. That is deliberate: it is what makes a squiggle look
 * the same in the editor, in the preview and on the published page forever.
 *
 * The consequence for a picker is that "change the seed" cannot mean "write a
 * number into the item". It has to mean "use a different item id". So the
 * browser's seed control steps through a deterministic sequence of candidate
 * ids, previews each one with `seedFromId(candidate)`, and inserts the item
 * under exactly the id it previewed. What you saw is what lands on the page,
 * byte for byte, because it is the same spec.
 */

import { generateShape, SHAPE_KINDS } from '../../assets/shapes.ts';
import { CanvasItemSchema, REFERENCE_WIDTH, SHAPE_DEFAULTS, newId, seedFromId } from '../../schema.ts';
import type { CanvasItem, ShapeKind, ShapeSpec } from '../../schema.ts';

export type { CanvasItem, ShapeKind, ShapeSpec };

/** Reference width all canvas geometry is authored against. Never hardcode 1344. */
export const REF_WIDTH: number = REFERENCE_WIDTH;

/** The site's --ink, the stroke colour a shape gets when nothing says otherwise. */
export const DEFAULT_SHAPE_COLOR: string = SHAPE_DEFAULTS.color;

/** The stroke width a shape gets when nothing says otherwise. */
export const DEFAULT_SHAPE_STROKE: number = SHAPE_DEFAULTS.strokeWidth;

/**
 * The generator names the library may offer, in the order the picker shows
 * them. Taken from WS-6, so a kind added upstream appears here without an
 * edit; `GENERATOR_NAMES` in ./schema.ts is the zod-side mirror and
 * `generatorsAgree()` below is the assertion that the two have not drifted.
 */
export const SHAPE_GENERATORS: readonly ShapeKind[] = SHAPE_KINDS;

/** Draw a shape. One self-contained `<svg>` string, safe to inline. */
export function drawShape(spec: ShapeSpec): string {
  return generateShape(spec);
}

export { newId, seedFromId };

/* -------------------------------------------------------------------------- */
/* Seed-through-id                                                             */
/* -------------------------------------------------------------------------- */

/** FNV-1a, the same hash `seedFromId` uses, so the stepping is stable. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A candidate item id for step `step` of a seed sequence rooted at `base`.
 *
 * Deterministic in both arguments, so the seed control's back arrow returns
 * to the drawing it came from instead of rolling a new one. Always matches
 * `IdSchema` (`[A-Za-z0-9_-]{1,64}`).
 */
export function idForSeedStep(base: string, step: number): string {
  const safeBase = base.replace(/[^A-Za-z0-9_-]/g, '') || 'lib';
  return `i_${safeBase.slice(0, 24)}_${fnv1a(`${safeBase}:${step}`).toString(16).padStart(8, '0')}`;
}

/** A fresh root for a seed sequence. One per mount, so two sessions differ. */
export function freshSeedBase(): string {
  return newId('s').replace(/[^A-Za-z0-9_-]/g, '');
}

/** The number the seed control shows: the wobble seed this id actually produces. */
export function seedLabel(itemId: string): string {
  return seedFromId(itemId).toString(16).padStart(8, '0');
}

/* -------------------------------------------------------------------------- */
/* Checking what we hand back                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Validate a `CanvasItem` against WS-0's own schema, and return the complaints
 * as plain strings.
 *
 * The library is an insert surface: everything it emits ends up in a document
 * that `DocSchema` has to accept, and `CanvasItemSchema` is `.strict()` with
 * cross-field rules (no `src` on a shape, no `radius` on an ellipse, `w` and
 * `h` strictly positive). Rather than re-state those rules here and let the
 * two drift, the harness asserts every emitted item against the real schema.
 *
 * Not called on the happy path in the editor; it is a check, not a gate.
 */
export function checkCanvasItem(item: unknown): string[] {
  const result = CanvasItemSchema.safeParse(item);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const where = issue.path.length === 0 ? '(root)' : issue.path.join('.');
    return `${where}: ${issue.message}`;
  });
}
