/**
 * src/cms/app/canvas/index.ts
 *
 * WS-4's public surface. WS-8 imports from here and from nowhere else inside
 * this directory.
 *
 *   import { CanvasEditor } from '../canvas/index.ts';
 *   <CanvasEditor
 *     items={band.items}
 *     height={band.height}
 *     scale={stageScale}
 *     onChange={(items, meta) => ...}
 *     renderShape={(item) => {
 *       const spec = shapeSpecFromItem(item);        // WS-6
 *       return spec === null ? null : generateShape(spec);
 *     }}
 *   />
 */

export { CanvasEditor, default } from './CanvasEditor.tsx';
export type { CanvasEditorProps, ChangeMeta, ChangeReason } from './CanvasEditor.tsx';

export {
  CORNERS,
  MIN_ITEM_SIZE,
  REFERENCE_WIDTH,
  ROTATE_SNAP_DEGREES,
  aabbOf,
  angleBetween,
  boxCorners,
  boxOf,
  centreOf,
  clientToRef,
  cornerSigns,
  lockAxis,
  moveBox,
  normaliseAngle,
  rectFromPoints,
  rectsIntersect,
  resizeBox,
  resizeCursor,
  rotateBoxTo,
  rotateVector,
  roundResizedBox,
  safeScale,
  screenLengthToRef,
  screenToRef,
  topEdgeMidpoint,
  unionRect,
} from './geometry.ts';
export type { Box, CornerId, Point, Rect, StageRect } from './geometry.ts';

export {
  DEFAULT_SNAP_THRESHOLD,
  collectSnapTargets,
  snapPoint,
  snapRect,
} from './snap.ts';
export type { SnapAxis, SnapGuide, SnapKind, SnapResult, SnapTarget, StageSize } from './snap.ts';

export {
  NO_MODIFIERS,
  beginMarquee,
  beginMove,
  beginResize,
  beginRotate,
  updateMarquee,
  updateMove,
  updateResize,
  updateRotate,
} from './interaction.ts';
export type {
  Gesture,
  GestureUpdate,
  MarqueeGesture,
  MarqueeUpdate,
  Modifiers,
  MoveGesture,
  ResizeGesture,
  RotateGesture,
  UpdateOptions,
} from './interaction.ts';

export {
  deleteItems,
  nudgeItems,
  patchItems,
  reorderZ,
  roundRect,
  stackingOrder,
  topMostFirst,
  withGeometry,
  withRotation,
} from './items.ts';
export type { ZOrderOp } from './items.ts';

export { fallbackShapeSvg, shapeSpecFor } from './shape-fallback.ts';
