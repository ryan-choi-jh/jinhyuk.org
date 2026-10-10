/**
 * src/cms/app/library/shapes.ts
 *
 * The generated half of the library: the five parametric annotation shapes,
 * as catalogue entries.
 *
 * These are defined in code rather than in catalogue.seed.json because they
 * are not data. A generator name and the parameters it takes are code-level
 * facts about `src/cms/assets/shapes.ts`; writing them into a JSON file would
 * mean a renamed generator shows up as a broken tile instead of as a compile
 * error. The catalogue JSON may still carry shape entries, a preset such as
 * "the orange squiggle I always use", and those are merged over these by id.
 *
 * The consequence worth knowing: the shape half of the drawer cannot be broken
 * by a bad hand-edit of the JSON, and `scripts/import-assets.ts` never has to
 * touch a shape entry.
 *
 * Sizes are in reference px against the 1344px content width. They are the
 * sizes these drawings actually want, not round numbers: a squiggle under a
 * line of text is wide and shallow, a rect drawn round a photo is not.
 */

import { DEFAULT_SHAPE_COLOR, DEFAULT_SHAPE_STROKE } from './shape-adapter.ts';
import type { ShapeEntry } from './schema.ts';

/**
 * Swatches the shape controls offer. Copied from the site's own custom
 * properties rather than read from CSS, because `generateShape` needs a hex
 * literal in an SVG attribute and `var(--ink)` resolves to nothing there.
 */
export type Swatch = { name: string; value: string };

export const SWATCHES: readonly Swatch[] = [
  { name: 'ink', value: '#111111' },
  { name: 'muted', value: '#6b6b6b' },
  { name: 'rule', value: '#e4e4e4' },
  { name: 'accent', value: '#ff5722' },
  { name: 'amber', value: '#f5a623' },
  { name: 'violet', value: '#a68fd8' },
  { name: 'blue', value: '#6aa3e0' },
  { name: 'green', value: '#5cb98a' },
];

/** Bounds the stroke-width control allows. Wider than this is a blob. */
export const STROKE_MIN = 0.5;
export const STROKE_MAX = 14;
export const STROKE_STEP = 0.5;

/**
 * The five generators, as entries. `seedId` is fixed so the grid tile for
 * "Squiggle" is the same drawing every time the library opens; the detail
 * panel's seed control steps away from it.
 */
export const BUILT_IN_SHAPE_ENTRIES: readonly ShapeEntry[] = [
  {
    id: 'shape_squiggle',
    kind: 'shape',
    name: 'Squiggle',
    category: 'annotation',
    tags: ['squiggle', 'scribble', 'underline', 'hand-drawn', 'loop'],
    note: 'One continuous looping pen line that crosses back over itself. Wide and shallow, for running under a line of text.',
    generator: 'squiggle',
    defaults: {
      width: 340,
      height: 72,
      color: DEFAULT_SHAPE_COLOR,
      strokeWidth: DEFAULT_SHAPE_STROKE,
      seedId: 'i_lib_squiggle',
    },
  },
  {
    id: 'shape_arrow',
    kind: 'shape',
    name: 'Arrow',
    category: 'annotation',
    tags: ['arrow', 'pointer', 'hand-drawn', 'callout'],
    note: 'A bowed shaft with a two-stroke head. The bow grows with the box height, so a tall box gives a swoop and a flat one gives a straight shot.',
    generator: 'arrow',
    defaults: {
      width: 260,
      height: 120,
      color: DEFAULT_SHAPE_COLOR,
      strokeWidth: DEFAULT_SHAPE_STROKE,
      seedId: 'i_lib_arrow',
    },
  },
  {
    id: 'shape_line',
    kind: 'shape',
    name: 'Line',
    category: 'annotation',
    tags: ['line', 'rule', 'underline', 'divider', 'hand-drawn'],
    note: 'A pen line across the box. Flat box, level rule; tall box, diagonal; no threshold in between, so resizing never makes it jump.',
    generator: 'line',
    defaults: {
      width: 420,
      height: 12,
      color: DEFAULT_SHAPE_COLOR,
      strokeWidth: DEFAULT_SHAPE_STROKE,
      seedId: 'i_lib_line',
    },
  },
  {
    id: 'shape_rect',
    kind: 'shape',
    name: 'Box',
    category: 'frame',
    tags: ['rect', 'rectangle', 'box', 'frame', 'circle-it', 'hand-drawn'],
    note: 'One continuous stroke round the box that overshoots past where it started. Drawn round a photo, not as a border.',
    generator: 'rect',
    defaults: {
      width: 360,
      height: 240,
      color: DEFAULT_SHAPE_COLOR,
      strokeWidth: DEFAULT_SHAPE_STROKE,
      seedId: 'i_lib_rect',
    },
  },
  {
    id: 'shape_ellipse',
    kind: 'shape',
    name: 'Ring',
    category: 'frame',
    tags: ['ellipse', 'circle', 'ring', 'frame', 'circle-it', 'hand-drawn'],
    note: 'One loop round with the radius wavering, over-closing past its start so the two ends cross. For circling a word.',
    generator: 'ellipse',
    defaults: {
      width: 320,
      height: 180,
      color: DEFAULT_SHAPE_COLOR,
      strokeWidth: DEFAULT_SHAPE_STROKE,
      seedId: 'i_lib_ellipse',
    },
  },
];
