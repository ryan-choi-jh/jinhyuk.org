/**
 * src/cms/app/canvas/CanvasEditor.tsx
 *
 * WS-4. Direct manipulation of one canvas band's items.
 *
 * Scope, from docs/cms-rebuild.md section 4: pure interaction. This component
 * fetches nothing, knows nothing about bands beyond the `items` array and the
 * `height` of the box they live in, and does not style the page. Presentation
 * of a published page is WS-1's.
 *
 * THE SCALE. The stage is laid out at REFERENCE_WIDTH (1344) reference px and
 * then visually scaled by `scale` so it fits the window. This component applies
 * that transform itself, so a parent must pass the number and must NOT also
 * scale it. Every pointer number crosses into reference space exactly once,
 * through geometry.clientToRef, which divides by the scale. Nothing else in the
 * interaction path knows the scale exists, except the snap radius and the
 * on-screen size of the handles, both of which are screen-px quantities
 * divided by it on purpose.
 *
 * Shapes are drawn by WS-6's generator, passed in as `renderShape`. Without it
 * a documented stand-in draws them (./shape-fallback.ts) so this component can
 * be built and verified alone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import { REFERENCE_WIDTH } from '../../schema.ts';
import type { CanvasItem } from '../../schema.ts';
import {
  CORNERS,
  aabbOf,
  boxOf,
  clientToRef,
  resizeCursor,
  safeScale,
  screenLengthToRef,
  unionRect,
} from './geometry.ts';
import type { CornerId, Point, Rect } from './geometry.ts';
import { DEFAULT_SNAP_THRESHOLD } from './snap.ts';
import type { SnapGuide } from './snap.ts';
import {
  beginMarquee,
  beginMove,
  beginResize,
  beginRotate,
  updateMarquee,
  updateMove,
  updateResize,
  updateRotate,
} from './interaction.ts';
import type { Gesture, MarqueeGesture, Modifiers } from './interaction.ts';
import { deleteItems, nudgeItems, reorderZ, stackingOrder } from './items.ts';
import type { ZOrderOp } from './items.ts';
import { fallbackShapeSvg } from './shape-fallback.ts';

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type ChangeReason = 'move' | 'resize' | 'rotate' | 'nudge' | 'delete' | 'z-order';

export type ChangeMeta = {
  /**
   * True for the frames inside a drag. A caller keeping an undo stack should
   * coalesce transient changes and push one entry when the matching
   * `transient: false` change arrives at the end of the gesture.
   */
  transient: boolean;
  reason: ChangeReason;
};

export type CanvasEditorProps = {
  /** The band's items. Document order is never changed; stacking is `z` only. */
  items: CanvasItem[];
  /** Called with the next items array. Second argument is advisory. */
  onChange: (items: CanvasItem[], meta: ChangeMeta) => void;
  /** The band's coordinate box height, in reference px. */
  height: number;
  /**
   * Display scale. The stage is REFERENCE_WIDTH wide and is transformed by
   * this, so 1 means actual size. Pointer deltas are divided by it.
   */
  scale?: number;
  /**
   * Whether this component applies the scale as a CSS transform of its own.
   *
   * Leave it true and the parent passes the number and nothing else; that is
   * the simple case. Set it false when an ancestor already scales the whole
   * page (so the stage is not scaled twice) and keep passing the SAME number,
   * because the pointer maths still needs it.
   */
  applyTransform?: boolean;
  /** Controlled selection. Omit for internal selection state. */
  selection?: string[];
  onSelectionChange?: (ids: string[]) => void;
  /** WS-6's generator: `(item) => generateShape(shapeSpecFromItem(item)!)`. */
  renderShape?: (item: CanvasItem) => string | null;
  /** Snap radius in SCREEN px, so it feels the same at any scale. */
  snapThreshold?: number;
  snapEnabled?: boolean;
  /** Suppress every mutation. Selection still works. */
  readOnly?: boolean;
  className?: string;
};

/* -------------------------------------------------------------------------- */
/* Chrome sizing, all in SCREEN px and divided by the scale before use         */
/* -------------------------------------------------------------------------- */

const HANDLE_SIZE = 9;
const ROTATE_HANDLE_SIZE = 11;
const ROTATE_HANDLE_OFFSET = 26;
const MARQUEE_START_SLOP = 3;
const NUDGE_SMALL = 1;
const NUDGE_LARGE = 10;

const SELECTION_COLOUR = '#2b7cff';
const GUIDE_COLOUR = '#ff2d6f';

const CSS = `
.cv-root { position: relative; isolation: isolate; }
.cv-root:focus { outline: none; }
.cv-root:focus-visible .cv-stage { box-shadow: 0 0 0 calc(var(--cv-hair) * 2) rgba(43,124,255,.45); }
.cv-stage {
  position: absolute; top: 0; left: 0; transform-origin: 0 0;
  touch-action: none; user-select: none; -webkit-user-select: none;
  background: #fff;
  /* No ring by default. Drawn on every band it reads as a divider rule across
     the page, and the published page has no such rule. It is an affordance for
     finding the edge of a canvas, so it appears when you are working in one. */
  box-shadow: none;
}
.cv-root:hover .cv-stage,
.cv-root:focus-within .cv-stage { box-shadow: 0 0 0 var(--cv-hair) rgba(0,0,0,.14); }
.cv-item { position: absolute; cursor: move; }
/* Mirrors .doc-caption in src/cms/styles/doc.css so what shows here is what
   the page prints. It sits below the item's box, which is what the published
   <figcaption> does inside its <figure>. */
.cv-caption {
  position: absolute; top: 100%; left: 0; right: 0;
  margin-top: 10px;
  font: 300 14px/21px var(--cv-caption-font, Inter, ui-sans-serif, system-ui, sans-serif);
  letter-spacing: 0;
  color: #6b6b6b;
  pointer-events: none;
}
.cv-item > * { pointer-events: none; }
.cv-item img, .cv-item video { display: block; width: 100%; height: 100%; object-fit: cover; }
.cv-item svg { display: block; width: 100%; height: 100%; overflow: visible; }
.cv-embed {
  width: 100%; height: 100%; box-sizing: border-box; overflow: hidden;
  display: flex; align-items: center; justify-content: center; text-align: center;
  border: var(--cv-hair) dashed rgba(0,0,0,.35); background: rgba(0,0,0,.03);
  font: 500 13px/1.3 ui-sans-serif, system-ui, sans-serif; color: rgba(0,0,0,.55);
  padding: 4px; word-break: break-all;
}
.cv-hover { position: absolute; pointer-events: none; box-shadow: 0 0 0 var(--cv-hair) rgba(43,124,255,.5) inset; }
.cv-outline {
  position: absolute; pointer-events: none;
  box-shadow: 0 0 0 calc(var(--cv-hair) * 1.5) ${SELECTION_COLOUR} inset;
}
.cv-handle {
  position: absolute; box-sizing: border-box;
  width: var(--cv-handle); height: var(--cv-handle);
  margin-left: calc(var(--cv-handle) / -2); margin-top: calc(var(--cv-handle) / -2);
  background: #fff; border: calc(var(--cv-hair) * 1.5) solid ${SELECTION_COLOUR};
  border-radius: calc(var(--cv-hair) * 2);
  pointer-events: auto;
}
.cv-rotate {
  position: absolute; box-sizing: border-box;
  width: var(--cv-rotate); height: var(--cv-rotate);
  margin-left: calc(var(--cv-rotate) / -2); margin-top: calc(var(--cv-rotate) / -2);
  background: #fff; border: calc(var(--cv-hair) * 1.5) solid ${SELECTION_COLOUR};
  border-radius: 50%; cursor: grab; pointer-events: auto;
}
.cv-rotate-stem {
  position: absolute; width: var(--cv-hair); background: ${SELECTION_COLOUR};
  pointer-events: none;
}
.cv-union { position: absolute; pointer-events: none; border: var(--cv-hair) dashed ${SELECTION_COLOUR}; }
.cv-marquee {
  position: absolute; pointer-events: none;
  border: var(--cv-hair) solid ${SELECTION_COLOUR}; background: rgba(43,124,255,.12);
}
.cv-guide { position: absolute; pointer-events: none; background: ${GUIDE_COLOUR}; }
.cv-toolbar {
  position: absolute; display: flex; gap: 2px; align-items: center;
  width: max-content; white-space: nowrap; pointer-events: auto;
  background: #141414; border-radius: 7px; padding: 3px;
  box-shadow: 0 6px 18px rgba(0,0,0,.28);
  font: 500 12px/1 ui-sans-serif, system-ui, sans-serif;
}
.cv-toolbar button {
  all: unset; cursor: pointer; color: #f4f4f4; padding: 5px 7px; border-radius: 5px;
  font: inherit; min-width: 20px; text-align: center;
}
.cv-toolbar button:hover { background: rgba(255,255,255,.16); }
.cv-toolbar .cv-sep { width: 1px; height: 16px; background: rgba(255,255,255,.2); margin: 0 2px; }
.cv-toolbar .cv-count { color: rgba(255,255,255,.55); padding: 0 5px; }
`;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

type ActiveGesture = {
  gesture: Gesture;
  reason: ChangeReason;
  latest: CanvasItem[] | null;
  changed: boolean;
  startedAt: Point;
  passedSlop: boolean;
};

function modifiersOf(event: { shiftKey: boolean; altKey: boolean }): Modifiers {
  return { shift: event.shiftKey, alt: event.altKey };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function itemStyle(item: CanvasItem, zIndex: number): CSSProperties {
  const style: CSSProperties = {
    left: item.x,
    top: item.y,
    width: item.w,
    height: item.h,
    zIndex,
  };
  const rotate = item.rotate ?? 0;
  if (rotate !== 0) style.transform = `rotate(${rotate}deg)`;
  return style;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export function CanvasEditor({
  items,
  onChange,
  height,
  scale: rawScale = 1,
  applyTransform = true,
  selection,
  onSelectionChange,
  renderShape,
  snapThreshold = DEFAULT_SNAP_THRESHOLD,
  snapEnabled = true,
  readOnly = false,
  className,
}: CanvasEditorProps) {
  const scale = safeScale(rawScale);
  const stageWidth = REFERENCE_WIDTH;
  const stageHeight = Math.max(1, height);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<ActiveGesture | null>(null);
  const detachRef = useRef<(() => void) | null>(null);

  const [internalSelection, setInternalSelection] = useState<string[]>([]);
  const [preview, setPreview] = useState<CanvasItem[] | null>(null);
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const shown = preview ?? items;
  const selectedIds = useMemo(() => {
    const live = new Set(shown.map((item) => item.id));
    return (selection ?? internalSelection).filter((id) => live.has(id));
  }, [selection, internalSelection, shown]);

  // Refs so the window-level pointer handlers never read a stale render.
  const live = useRef({ items: shown, selectedIds, scale, snapThreshold, snapEnabled, readOnly, onChange });
  live.current = { items: shown, selectedIds, scale, snapThreshold, snapEnabled, readOnly, onChange };

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const order = useMemo(() => {
    const ranked = stackingOrder(shown);
    return new Map(ranked.map((id, index) => [id, index + 1]));
  }, [shown]);

  const setSelection = useCallback(
    (ids: string[]) => {
      if (sameIds(ids, live.current.selectedIds)) return;
      if (selection === undefined) setInternalSelection(ids);
      onSelectionChange?.(ids);
    },
    [selection, onSelectionChange],
  );

  const emit = useCallback((next: CanvasItem[], meta: ChangeMeta) => {
    live.current.onChange(next, meta);
  }, []);

  /** A pointer event -> stage reference px. The only crossing point. */
  const toRef = useCallback((event: { clientX: number; clientY: number }): Point => {
    const node = stageRef.current;
    if (node === null) return { x: 0, y: 0 };
    return clientToRef(event.clientX, event.clientY, node.getBoundingClientRect(), live.current.scale);
  }, []);

  const refThreshold = useCallback((): number => {
    if (!live.current.snapEnabled) return 0;
    return screenLengthToRef(live.current.snapThreshold, live.current.scale);
  }, []);

  const detach = useCallback(() => {
    detachRef.current?.();
    detachRef.current = null;
  }, []);

  useEffect(() => detach, [detach]);

  /* ---------------------------------------------------------------------- */
  /* Gesture plumbing                                                        */
  /* ---------------------------------------------------------------------- */

  const runUpdate = useCallback(
    (event: PointerEvent) => {
      const active = gestureRef.current;
      if (active === null) return;
      const pointer = toRef(event);
      const mods = modifiersOf(event);

      if (!active.passedSlop) {
        const moved =
          Math.abs(event.clientX - active.startedAt.x) > MARQUEE_START_SLOP ||
          Math.abs(event.clientY - active.startedAt.y) > MARQUEE_START_SLOP;
        if (!moved && active.gesture.kind === 'marquee') return;
        active.passedSlop = true;
      }

      if (active.gesture.kind === 'marquee') {
        const result = updateMarquee(active.gesture, pointer);
        setMarquee(result.rect);
        setSelection(result.ids);
        return;
      }

      const update =
        active.gesture.kind === 'move'
          ? updateMove(active.gesture, pointer, { ...mods, refThreshold: refThreshold() })
          : active.gesture.kind === 'resize'
            ? updateResize(active.gesture, pointer, { ...mods, refThreshold: refThreshold() })
            : updateRotate(active.gesture, pointer, mods);

      setGuides(update.guides);
      setPreview(update.items);
      if (update.changed) {
        active.changed = true;
        active.latest = update.items;
        emit(update.items, { transient: true, reason: active.reason });
      }
    },
    [emit, refThreshold, setSelection, toRef],
  );

  const finish = useCallback(() => {
    const active = gestureRef.current;
    gestureRef.current = null;
    detach();
    setDragging(false);
    setGuides([]);
    setMarquee(null);
    setPreview(null);
    if (active === null) return;
    if (active.changed && active.latest !== null) {
      emit(active.latest, { transient: false, reason: active.reason });
    }
  }, [detach, emit]);

  /**
   * Abandon an in-flight gesture and put the items back exactly as they were
   * when it began. Escape during a drag, which is the thing people reach for
   * when they realise they grabbed the wrong item.
   */
  const cancel = useCallback(() => {
    const active = gestureRef.current;
    if (active === null) return false;
    gestureRef.current = null;
    detach();
    setDragging(false);
    setGuides([]);
    setMarquee(null);
    setPreview(null);
    if (active.gesture.kind === 'marquee') {
      // A marquee changes nothing but the selection, so that is what it undoes.
      setSelection([...active.gesture.baseIds]);
    } else if (active.changed) {
      emit(active.gesture.startItems as CanvasItem[], { transient: false, reason: active.reason });
    }
    return true;
  }, [detach, emit, setSelection]);

  const start = useCallback(
    (gesture: Gesture, reason: ChangeReason, event: ReactPointerEvent) => {
      detach();
      setDragging(true);
      gestureRef.current = {
        gesture,
        reason,
        latest: null,
        changed: false,
        startedAt: { x: event.clientX, y: event.clientY },
        passedSlop: gesture.kind !== 'marquee',
      };

      const onMove = (nativeEvent: PointerEvent) => runUpdate(nativeEvent);
      const onUp = () => finish();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      detachRef.current = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
    },
    [detach, finish, runUpdate],
  );

  /* ---------------------------------------------------------------------- */
  /* Pointer entry points                                                    */
  /* ---------------------------------------------------------------------- */

  const onStagePointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      rootRef.current?.focus({ preventScroll: true });
      const additive = event.shiftKey;
      if (!additive) setSelection([]);
      const gesture: MarqueeGesture = beginMarquee(
        live.current.items,
        toRef(event),
        additive ? live.current.selectedIds : [],
      );
      start(gesture, 'move', event);
    },
    [setSelection, start, toRef],
  );

  const onItemPointerDown = useCallback(
    (event: ReactPointerEvent, id: string) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      rootRef.current?.focus({ preventScroll: true });

      const current = live.current.selectedIds;

      // Shift-click toggles membership and deliberately does not start a move,
      // so building a selection cannot nudge anything by accident.
      if (event.shiftKey) {
        const next = current.includes(id) ? current.filter((other) => other !== id) : [...current, id];
        setSelection(next);
        return;
      }

      const ids = current.includes(id) ? current : [id];
      if (!current.includes(id)) setSelection(ids);
      if (live.current.readOnly) return;
      start(beginMove(live.current.items, ids, toRef(event), { width: stageWidth, height: stageHeight }), 'move', event);
    },
    [setSelection, stageHeight, stageWidth, start, toRef],
  );

  const onHandlePointerDown = useCallback(
    (event: ReactPointerEvent, id: string, corner: CornerId) => {
      if (event.button !== 0 || live.current.readOnly) return;
      event.preventDefault();
      event.stopPropagation();
      rootRef.current?.focus({ preventScroll: true });
      const gesture = beginResize(live.current.items, id, corner, { width: stageWidth, height: stageHeight });
      if (gesture === null) return;
      start(gesture, 'resize', event);
    },
    [stageHeight, stageWidth, start],
  );

  const onRotatePointerDown = useCallback(
    (event: ReactPointerEvent, id: string) => {
      if (event.button !== 0 || live.current.readOnly) return;
      event.preventDefault();
      event.stopPropagation();
      rootRef.current?.focus({ preventScroll: true });
      const gesture = beginRotate(live.current.items, id, toRef(event));
      if (gesture === null) return;
      start(gesture, 'rotate', event);
    },
    [start, toRef],
  );

  /* ---------------------------------------------------------------------- */
  /* Commands (keyboard and toolbar share these)                             */
  /* ---------------------------------------------------------------------- */

  const nudge = useCallback(
    (dx: number, dy: number) => {
      if (readOnly) return;
      const next = nudgeItems(live.current.items, live.current.selectedIds, dx, dy);
      if (next !== live.current.items) emit(next, { transient: false, reason: 'nudge' });
    },
    [emit, readOnly],
  );

  const removeSelection = useCallback(() => {
    if (readOnly) return;
    const ids = live.current.selectedIds;
    const next = deleteItems(live.current.items, ids);
    if (next !== live.current.items) {
      setSelection([]);
      emit(next, { transient: false, reason: 'delete' });
    }
  }, [emit, readOnly, setSelection]);

  const restack = useCallback(
    (op: ZOrderOp) => {
      if (readOnly) return;
      const next = reorderZ(live.current.items, live.current.selectedIds, op);
      if (next !== live.current.items) emit(next, { transient: false, reason: 'z-order' });
    },
    [emit, readOnly],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      const step = event.shiftKey ? NUDGE_LARGE : NUDGE_SMALL;
      const accel = event.metaKey || event.ctrlKey;

      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          nudge(-step, 0);
          return;
        case 'ArrowRight':
          event.preventDefault();
          nudge(step, 0);
          return;
        case 'ArrowUp':
          event.preventDefault();
          nudge(0, -step);
          return;
        case 'ArrowDown':
          event.preventDefault();
          nudge(0, step);
          return;
        case 'Backspace':
        case 'Delete':
          event.preventDefault();
          removeSelection();
          return;
        case 'Escape':
          event.preventDefault();
          // Escape abandons a drag first, and only clears the selection when
          // there is no drag to abandon.
          if (!cancel()) setSelection([]);
          return;
        case ']':
          event.preventDefault();
          restack(accel ? 'front' : 'forward');
          return;
        case '[':
          event.preventDefault();
          restack(accel ? 'back' : 'backward');
          return;
        case '}':
          event.preventDefault();
          restack('front');
          return;
        case '{':
          event.preventDefault();
          restack('back');
          return;
        case 'a':
        case 'A':
          if (accel) {
            event.preventDefault();
            setSelection(live.current.items.map((item) => item.id));
          }
          return;
        default:
      }
    },
    [cancel, nudge, removeSelection, restack, setSelection],
  );

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  const hair = 1 / scale;
  const rootStyle: CSSProperties & Record<string, string | number> = {
    width: applyTransform ? stageWidth * scale : stageWidth,
    height: applyTransform ? stageHeight * scale : stageHeight,
    '--cv-hair': `${hair}px`,
    '--cv-handle': `${screenLengthToRef(HANDLE_SIZE, scale)}px`,
    '--cv-rotate': `${screenLengthToRef(ROTATE_HANDLE_SIZE, scale)}px`,
  };

  const single = selectedIds.length === 1 ? shown.find((item) => item.id === selectedIds[0]) : undefined;
  const selectedItems = shown.filter((item) => selectedSet.has(item.id));
  const union = unionRect(selectedItems.map((item) => aabbOf(boxOf(item))));
  const rotateOffset = screenLengthToRef(ROTATE_HANDLE_OFFSET, scale);
  const toolbarGap = screenLengthToRef(10, scale);

  const drawShape = renderShape ?? fallbackShapeSvg;

  return (
    <div
      ref={rootRef}
      className={className === undefined ? 'cv-root' : `cv-root ${className}`}
      style={rootStyle}
      tabIndex={0}
      role="application"
      aria-label="Canvas band"
      onKeyDown={onKeyDown}
      data-cv-scale={scale}
    >
      <style>{CSS}</style>
      <div
        ref={stageRef}
        className="cv-stage"
        style={{
          width: stageWidth,
          height: stageHeight,
          ...(applyTransform ? { transform: `scale(${scale})` } : {}),
        }}
        onPointerDown={onStagePointerDown}
        data-cv-stage=""
      >
        {shown.map((item) => {
          const html = item.kind === 'shape' ? drawShape(item) : null;
          return (
            <div
              key={item.id}
              className="cv-item"
              style={itemStyle(item, order.get(item.id) ?? 1)}
              data-cv-item={item.id}
              onPointerDown={(event) => onItemPointerDown(event, item.id)}
              onPointerEnter={() => setHoverId(item.id)}
              onPointerLeave={() => setHoverId((current) => (current === item.id ? null : current))}
            >
              {item.kind === 'image' && item.src !== undefined ? (
                <img src={item.src} alt={item.alt ?? ''} draggable={false} />
              ) : null}
              {item.kind === 'video' && item.src !== undefined ? (
                <video src={item.src} muted playsInline preload="metadata" />
              ) : null}
              {item.kind === 'embed' ? <div className="cv-embed">{item.src ?? 'embed'}</div> : null}
              {html !== null && html !== undefined ? (
                <div style={{ width: '100%', height: '100%' }} dangerouslySetInnerHTML={{ __html: html }} />
              ) : null}
              {item.caption !== undefined && item.caption !== '' ? (
                <div className="cv-caption">{item.caption}</div>
              ) : null}
            </div>
          );
        })}

        {hoverId !== null && !selectedSet.has(hoverId)
          ? (() => {
              const item = shown.find((candidate) => candidate.id === hoverId);
              if (item === undefined) return null;
              return <div className="cv-hover" style={{ ...itemStyle(item, 1_000_000), zIndex: 1_000_000 }} />;
            })()
          : null}

        {selectedItems.map((item) => (
          <div
            key={`sel-${item.id}`}
            className="cv-outline"
            style={{ ...itemStyle(item, 1_000_001), zIndex: 1_000_001 }}
          />
        ))}

        {selectedIds.length > 1 && union !== null ? (
          <div
            className="cv-union"
            style={{ left: union.x, top: union.y, width: union.w, height: union.h, zIndex: 1_000_002 }}
          />
        ) : null}

        {single !== undefined && !readOnly ? (
          <div
            style={{ ...itemStyle(single, 1_000_003), zIndex: 1_000_003, position: 'absolute', pointerEvents: 'none' }}
          >
            <div
              className="cv-rotate-stem"
              style={{ left: '50%', top: -rotateOffset, height: rotateOffset, marginLeft: -hair / 2 }}
            />
            <div
              className="cv-rotate"
              style={{ left: '50%', top: -rotateOffset, cursor: 'grab' }}
              role="button"
              aria-label="Rotate item"
              onPointerDown={(event) => onRotatePointerDown(event, single.id)}
            />
            {CORNERS.map(({ id, sx, sy }) => (
              <div
                key={id}
                className="cv-handle"
                style={{
                  left: sx === -1 ? 0 : '100%',
                  top: sy === -1 ? 0 : '100%',
                  cursor: resizeCursor(id, single.rotate ?? 0),
                }}
                role="button"
                aria-label={`Resize from ${id}`}
                data-cv-handle={id}
                onPointerDown={(event) => onHandlePointerDown(event, single.id, id)}
              />
            ))}
          </div>
        ) : null}

        {guides.map((guide, index) => (
          <div
            key={`${guide.axis}-${guide.value}-${guide.kind}-${index}`}
            className="cv-guide"
            data-cv-guide={`${guide.axis}:${guide.value}:${guide.kind}`}
            style={
              guide.axis === 'x'
                ? {
                    left: guide.value - hair / 2,
                    top: guide.min,
                    width: hair,
                    height: Math.max(guide.max - guide.min, hair),
                    zIndex: 1_000_010,
                  }
                : {
                    left: guide.min,
                    top: guide.value - hair / 2,
                    height: hair,
                    width: Math.max(guide.max - guide.min, hair),
                    zIndex: 1_000_010,
                  }
            }
          />
        ))}

        {marquee !== null ? (
          <div
            className="cv-marquee"
            style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h, zIndex: 1_000_011 }}
          />
        ) : null}

        {union !== null && !readOnly && !dragging ? (
          <div
            style={{
              position: 'absolute',
              left: union.x,
              top: union.y,
              width: 0,
              height: 0,
              zIndex: 1_000_012,
            }}
          >
            <div
              className="cv-toolbar"
              style={
                // Below the selection, so it can never sit on top of the
                // rotate handle. Above only when there is no room below.
                (union.y + union.h) * scale > stageHeight * scale - 46
                  ? {
                      left: 0,
                      bottom: toolbarGap,
                      transform: `scale(${1 / scale})`,
                      transformOrigin: 'left bottom',
                    }
                  : {
                      left: 0,
                      top: union.h + toolbarGap,
                      transform: `scale(${1 / scale})`,
                      transformOrigin: 'left top',
                    }
              }
              onPointerDown={(event) => event.stopPropagation()}
            >
              <span className="cv-count">{selectedIds.length} selected</span>
              <span className="cv-sep" />
              <button type="button" title="Bring to front (cmd+])" onClick={() => restack('front')}>
                Front
              </button>
              <button type="button" title="Bring forward (])" onClick={() => restack('forward')}>
                Fwd
              </button>
              <button type="button" title="Send backward ([)" onClick={() => restack('backward')}>
                Bwd
              </button>
              <button type="button" title="Send to back (cmd+[)" onClick={() => restack('back')}>
                Back
              </button>
              <span className="cv-sep" />
              <button type="button" title="Delete selection (delete)" onClick={() => removeSelection()}>
                Delete
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default CanvasEditor;
