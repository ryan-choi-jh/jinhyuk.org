/**
 * src/cms/app/records/PhotoGrid.tsx
 *
 * WS-E. The album's photos: a grid of tiles that can be dragged into order,
 * each with its own alt text, caption, cover star and delete button, plus the
 * tiles for files that are still uploading.
 *
 * Why pointer events and not HTML5 drag-and-drop for the reorder: the same
 * reason WS-4's canvas uses them. `dragstart`/`dragover` carry a drag image
 * the browser owns, fire at the browser's own cadence, and cannot be driven
 * reliably from the DevTools protocol — so the reorder would be the one
 * interaction nobody could prove. Pointer events are ordinary mouse input.
 *
 * How the reorder stays steady: the tile rectangles are measured ONCE, when
 * the drag begins. The grid's cells do not move during a drag — the photos
 * move between them — so the cell under the cursor is found against that
 * captured geometry rather than against a layout that is being reordered
 * underneath the pointer. A scroll mid-drag would stale it; the grid is one
 * screen of tiles and a drag lasts half a second.
 */

import { useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { Photo } from '../../schema.ts';

import { reorderPhotos } from './album-edits.ts';
import { UNKNOWN_PROGRESS, visibleTasks } from './uploads.ts';
import type { UploadTask } from './uploads.ts';

/** Pixels the pointer must travel before a press becomes a drag, not a click. */
const DRAG_THRESHOLD = 4;

type Cell = { x: number; y: number; w: number; h: number };

type DragState = {
  pointerId: number;
  photoId: string;
  from: number;
  to: number;
  /** Where in the tile it was grabbed, so it does not jump to the cursor. */
  grabX: number;
  grabY: number;
  pointerX: number;
  pointerY: number;
  cells: Cell[];
  active: boolean;
};

export type PhotoGridProps = {
  photos: readonly Photo[];
  /** The photo being shown as the cover, chosen or fallen back to. */
  coverId: string | null;
  /** True when `cover` is written down rather than following the first photo. */
  pinnedCover: boolean;
  tasks: readonly UploadTask[];
  disabled?: boolean;
  resolveMediaSrc: (src: string) => string;

  onReorder: (from: number, to: number) => void;
  onMoveBy: (photoId: string, delta: number) => void;
  onToggleCover: (photoId: string) => void;
  onRemove: (photoId: string) => void;
  onAlt: (photoId: string, value: string) => void;
  onCaption: (photoId: string, value: string) => void;
  onRetry: (key: string) => void;
  onDismiss: (key: string) => void;
};

export function PhotoGrid({
  photos,
  coverId,
  pinnedCover,
  tasks,
  disabled = false,
  resolveMediaSrc,
  onReorder,
  onMoveBy,
  onToggleCover,
  onRemove,
  onAlt,
  onCaption,
  onRetry,
  onDismiss,
}: PhotoGridProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const tilesRef = useRef(new Map<string, HTMLDivElement>());
  const gridRef = useRef<HTMLDivElement | null>(null);
  /** The drag, readable synchronously inside an event handler. */
  const dragRef = useRef<DragState | null>(null);

  const putDrag = useCallback((next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const setTile = useCallback((id: string, element: HTMLDivElement | null) => {
    if (element === null) tilesRef.current.delete(id);
    else tilesRef.current.set(id, element);
  }, []);

  /** The cells, in the order the photos are in right now. */
  const measure = useCallback((): Cell[] => {
    return photos.map((photo) => {
      const element = tilesRef.current.get(photo.id);
      if (element === undefined) return { x: 0, y: 0, w: 0, h: 0 };
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    });
  }, [photos]);

  const nearestCell = (cells: readonly Cell[], x: number, y: number, fallback: number): number => {
    let best = fallback;
    let bestDistance = Number.POSITIVE_INFINITY;
    cells.forEach((cell, index) => {
      if (cell.w === 0 && cell.h === 0) return;
      const dx = cell.x + cell.w / 2 - x;
      const dy = cell.y + cell.h / 2 - y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>, photo: Photo, index: number) => {
    if (disabled || event.button !== 0) return;
    // The star and the delete button live on top of the thumbnail. A press on
    // one of them is a click, not a drag, and must not be swallowed: pointer
    // capture would retarget the click to this div and the button would never
    // fire.
    const target = event.target;
    if (target instanceof Element && target.closest('button, input, textarea, a, label') !== null) {
      return;
    }
    const cells = measure();
    const own = cells[index] ?? { x: event.clientX, y: event.clientY, w: 0, h: 0 };
    putDrag({
      pointerId: event.pointerId,
      photoId: photo.id,
      from: index,
      to: index,
      grabX: event.clientX - own.x,
      grabY: event.clientY - own.y,
      pointerX: event.clientX,
      pointerY: event.clientY,
      cells,
      active: false,
    });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    const own = current.cells[current.from] ?? { x: 0, y: 0, w: 0, h: 0 };
    const movedFar =
      Math.abs(event.clientX - own.x - current.grabX) > DRAG_THRESHOLD ||
      Math.abs(event.clientY - own.y - current.grabY) > DRAG_THRESHOLD;

    if (!current.active && !movedFar) {
      putDrag({ ...current, pointerX: event.clientX, pointerY: event.clientY });
      return;
    }
    if (!current.active) {
      // Capture only once this really is a drag, so a plain click on a tile
      // keeps reaching the thing that was clicked.
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const to = nearestCell(current.cells, event.clientX, event.clientY, current.to);
    putDrag({ ...current, active: true, to, pointerX: event.clientX, pointerY: event.clientY });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    putDrag(null);
    if (current.active && current.to !== current.from) onReorder(current.from, current.to);
  };

  const display =
    drag !== null && drag.active ? reorderPhotos(photos, drag.from, drag.to) : [...photos];

  const draggedStyle = (index: number): { transform: string; transition: string } | undefined => {
    if (drag === null || !drag.active) return undefined;
    const cell = drag.cells[index];
    if (cell === undefined) return undefined;
    const x = drag.pointerX - drag.grabX - cell.x;
    const y = drag.pointerY - drag.grabY - cell.y;
    return { transform: `translate(${Math.round(x)}px, ${Math.round(y)}px)`, transition: 'none' };
  };

  const pending = visibleTasks(tasks);

  return (
    <div className="cms-rec__grid" ref={gridRef} data-testid="photo-grid" data-count={photos.length}>
      {display.map((photo, index) => {
        const dragging = drag !== null && drag.active && drag.photoId === photo.id;
        const cover = coverId === photo.id;
        return (
          <div
            key={photo.id}
            ref={(element) => setTile(photo.id, element)}
            className="cms-rec__tile"
            data-testid={`photo-tile-${photo.id}`}
            data-index={index}
            data-photo-id={photo.id}
            data-cover={String(cover)}
            data-dragging={String(dragging)}
            data-shifted={drag !== null && drag.active && !dragging ? 'true' : 'false'}
            style={dragging ? draggedStyle(index) : undefined}
          >
            <div
              className="cms-rec__thumb"
              data-testid={`photo-thumb-${photo.id}`}
              onPointerDown={(event) => onPointerDown(event, photo, index)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              title="Drag to reorder"
            >
              <img src={resolveMediaSrc(photo.src)} alt="" draggable={false} />
              <span className="cms-rec__num">{index + 1}</span>
              <div className="cms-rec__tile-acts">
                <button
                  type="button"
                  className="cms-rec__btn cms-rec__btn--micro cms-rec__btn--star"
                  data-testid={`photo-cover-${photo.id}`}
                  data-on={String(cover)}
                  disabled={disabled}
                  title={
                    cover && pinnedCover
                      ? 'The cover. Click to follow the first photo instead.'
                      : 'Make this the cover'
                  }
                  aria-label={cover ? 'Cover photo' : 'Make this the cover'}
                  onClick={() => onToggleCover(photo.id)}
                >
                  ★
                </button>
                <button
                  type="button"
                  className="cms-rec__btn cms-rec__btn--micro cms-rec__btn--danger"
                  data-testid={`photo-remove-${photo.id}`}
                  disabled={disabled}
                  title="Delete this photo"
                  aria-label="Delete this photo"
                  onClick={() => onRemove(photo.id)}
                >
                  ×
                </button>
              </div>
              {cover ? (
                <span className="cms-rec__cover-tag" data-testid={`photo-cover-tag-${photo.id}`}>
                  {pinnedCover ? 'Cover' : 'Cover · first'}
                </span>
              ) : null}
            </div>

            <div className="cms-rec__tile-foot">
              <input
                className="cms-rec__input"
                data-testid={`photo-alt-${photo.id}`}
                type="text"
                value={photo.alt ?? ''}
                placeholder="Alt text"
                disabled={disabled}
                aria-label="Alt text"
                onChange={(event) => onAlt(photo.id, event.target.value)}
              />
              <input
                className="cms-rec__input"
                data-testid={`photo-caption-${photo.id}`}
                type="text"
                value={photo.caption ?? ''}
                placeholder="Caption"
                disabled={disabled}
                aria-label="Caption"
                onChange={(event) => onCaption(photo.id, event.target.value)}
              />
              <div className="cms-rec__tile-meta">
                <span className="cms-rec__row">
                  <button
                    type="button"
                    className="cms-rec__btn cms-rec__btn--micro cms-rec__btn--quiet"
                    data-testid={`photo-left-${photo.id}`}
                    disabled={disabled || index === 0}
                    title="Move earlier"
                    aria-label="Move earlier"
                    onClick={() => onMoveBy(photo.id, -1)}
                  >
                    ◀
                  </button>
                  <button
                    type="button"
                    className="cms-rec__btn cms-rec__btn--micro cms-rec__btn--quiet"
                    data-testid={`photo-right-${photo.id}`}
                    disabled={disabled || index === display.length - 1}
                    title="Move later"
                    aria-label="Move later"
                    onClick={() => onMoveBy(photo.id, 1)}
                  >
                    ▶
                  </button>
                </span>
                <span className="cms-rec__dims" data-testid={`photo-dims-${photo.id}`}>
                  {photo.w === undefined || photo.h === undefined ? 'no size' : `${photo.w}×${photo.h}`}
                </span>
              </div>
            </div>
          </div>
        );
      })}

      {pending.map((task) => (
        <div
          key={task.key}
          className={
            task.status === 'failed'
              ? 'cms-rec__tile cms-rec__tile--task cms-rec__task--failed'
              : 'cms-rec__tile cms-rec__tile--task'
          }
          data-testid={`upload-task-${task.key}`}
          data-status={task.status}
        >
          <div className="cms-rec__task">
            <div className="cms-rec__task-name" title={task.name}>
              {task.name}
            </div>
            <div
              className={
                task.progress === UNKNOWN_PROGRESS ? 'cms-rec__bar cms-rec__bar--waiting' : 'cms-rec__bar'
              }
            >
              <div
                className="cms-rec__bar-fill"
                data-testid={`upload-bar-${task.key}`}
                style={{
                  width: `${Math.round(
                    (task.progress === UNKNOWN_PROGRESS
                      ? task.status === 'queued'
                        ? 0.04
                        : 0.1
                      : task.progress) * 100,
                  )}%`,
                }}
              />
            </div>
            <div className="cms-rec__task-state">
              {task.status === 'queued'
                ? 'waiting'
                : task.status === 'uploading'
                  ? task.progress === UNKNOWN_PROGRESS
                    ? 'uploading'
                    : `${Math.round(task.progress * 100)}%`
                  : 'failed'}
            </div>
            {task.status === 'failed' ? (
              <>
                <div className="cms-rec__task-err">{task.error ?? 'upload failed'}</div>
                <div className="cms-rec__row">
                  <button
                    type="button"
                    className="cms-rec__btn cms-rec__btn--tiny"
                    data-testid={`upload-retry-${task.key}`}
                    onClick={() => onRetry(task.key)}
                  >
                    Try again
                  </button>
                  <button
                    type="button"
                    className="cms-rec__btn cms-rec__btn--tiny cms-rec__btn--quiet"
                    data-testid={`upload-dismiss-${task.key}`}
                    onClick={() => onDismiss(task.key)}
                  >
                    Dismiss
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export default PhotoGrid;
