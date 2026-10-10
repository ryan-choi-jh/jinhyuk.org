/**
 * src/cms/render/with-shape-assets.ts
 *
 * WS-1. One import line that points the renderer at WS-6's real shape
 * generator, synchronously, for a consumer that cannot await at start-up:
 *
 *   import './with-shape-assets.ts';   // or '../cms/render/with-shape-assets.ts'
 *   import { renderDoc } from '../cms/render/index.ts';
 *
 * Import it for the side effect, once, before the first renderDoc(). After
 * that every shape item is drawn by src/cms/assets/shapes.ts instead of the
 * built-in fallback.
 *
 * This is the only file in the renderer that imports another workstream's
 * code, and it is deliberately the only one: nothing else here fails to build
 * if WS-6's module moves or breaks. index.ts, prose.ts, canvas.ts and
 * shapes.ts depend on src/cms/schema.ts and on nothing else.
 *
 * The async equivalent, which also works when the module is absent, is
 * `await ensureShapeAssets()` from ./shapes.ts.
 */

import { generateShape } from '../assets/shapes.ts';
import { setShapeGenerator } from './shapes.ts';

setShapeGenerator(generateShape);
