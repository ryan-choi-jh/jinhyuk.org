/**
 * src/cms/app/shell/band-outline.tsx
 *
 * WS-3. The left pane. A page is a vertical stack of bands
 * (docs/cms-rebuild.md 2.2), and this is that stack as a list: reorder by
 * dragging the grip, insert a prose or canvas band in any gap, delete with
 * undo, and expand a band to select one prose block or one canvas item.
 *
 * Reordering is done with pointer events rather than HTML5 drag-and-drop.
 * Two reasons: the drop indicator is ours to draw, and synthesised input can
 * drive it, which is what `harness/drive.mjs` does to prove the reorder works.
 */

import { useEffect, useRef, useState } from 'react';

import type { Band, Doc } from '../../schema.ts';
import { bandChildCount, blockPlainText, dropIndexToTargetIndex } from '../state/doc-ops.ts';
import { isBandSelected, isBlockSelected, isItemSelected } from '../state/selection.ts';
import type { Selection } from '../state/selection.ts';
import type { DocStore } from '../state/store.ts';

export type BandOutlineProps = {
  store: DocStore;
  doc: Doc;
  selection: Selection;
};

type DragState = { bandId: string; fromIndex: number; dropIndex: number };

export function BandOutline({ store, doc, selection }: BandOutlineProps) {
  const rows = useRef(new Map<string, HTMLDivElement>());
  const dragRef = useRef<{ bandId: string; fromIndex: number } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());

  // Keep the selected band open, so clicking a block in the page reveals it here.
  const selectedBandId = selection.kind === 'none' ? null : selection.bandId;
  useEffect(() => {
    if (selectedBandId === null) return;
    setExpanded((current) => {
      if (current.has(selectedBandId)) return current;
      const next = new Set(current);
      next.add(selectedBandId);
      return next;
    });
  }, [selectedBandId]);

  function computeDropIndex(clientY: number): number {
    for (let index = 0; index < doc.bands.length; index += 1) {
      const band = doc.bands[index] as Band;
      const element = rows.current.get(band.id);
      if (element === undefined) continue;
      const rect = element.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return index;
    }
    return doc.bands.length;
  }

  function startDrag(event: { clientY: number; preventDefault(): void }, band: Band, index: number): void {
    event.preventDefault();
    dragRef.current = { bandId: band.id, fromIndex: index };
    setDrag({ bandId: band.id, fromIndex: index, dropIndex: index });

    const onMove = (moveEvent: MouseEvent): void => {
      const active = dragRef.current;
      if (active === null) return;
      setDrag({ ...active, dropIndex: computeDropIndex(moveEvent.clientY) });
    };

    const onUp = (upEvent: MouseEvent): void => {
      const active = dragRef.current;
      dragRef.current = null;
      detach();
      setDrag(null);
      if (active === null) return;
      const target = dropIndexToTargetIndex(active.fromIndex, computeDropIndex(upEvent.clientY));
      if (target !== active.fromIndex) store.moveBand(active.bandId, target);
    };

    // Both event families, because synthesised input in a headless browser is
    // not guaranteed to produce the pointer ones.
    const detach = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function toggleExpanded(bandId: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(bandId)) next.delete(bandId);
      else next.add(bandId);
      return next;
    });
  }

  const gap = (index: number) => (
    <Gap
      key={`gap-${index}`}
      index={index}
      active={drag !== null && drag.dropIndex === index && drag.fromIndex !== index}
      onInsert={(type) => store.insertBand(type, index)}
    />
  );

  return (
    <div className="cms-outline" data-testid="band-outline">
      {gap(0)}
      {doc.bands.map((band, index) => {
        const selected = isBandSelected(selection, band.id);
        const isOverlay = band.type === 'canvas' && band.overlay === true;
        const open = expanded.has(band.id);
        return (
          <div key={band.id}>
            <div
              ref={(element) => {
                if (element === null) rows.current.delete(band.id);
                else rows.current.set(band.id, element);
              }}
              className={[
                'cms-band',
                selected ? 'cms-band--selected' : '',
                drag !== null && drag.bandId === band.id ? 'cms-band--dragging' : '',
                isOverlay ? 'cms-band--overlay' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              data-band-id={band.id}
              data-band-index={index}
            >
              <button
                type="button"
                className="cms-band__grip"
                title="Drag to reorder"
                aria-label={`Reorder band ${index + 1}`}
                data-testid={`band-grip-${band.id}`}
                onPointerDown={(event) => startDrag(event, band, index)}
                onMouseDown={(event) => {
                  // Only when the pointer event did not already start it.
                  if (dragRef.current === null) startDrag(event, band, index);
                }}
              >
                ⠿
              </button>

              <button
                type="button"
                className="cms-band__main"
                data-testid={`band-row-${band.id}`}
                onClick={() => store.selectBand(band.id)}
                onDoubleClick={() => toggleExpanded(band.id)}
              >
                <span className="cms-band__line1">
                  <span className="cms-band__index">{index + 1}</span>
                  <span className="cms-band__kind">{band.type === 'prose' ? 'Text' : 'Canvas'}</span>
                  {isOverlay && <span className="cms-band__tag cms-band__tag--overlay">overlay</span>}
                </span>
                <span className="cms-band__line2">{summarise(band)}</span>
              </button>

              <span className="cms-band__actions">
                <button
                  type="button"
                  className="cms-btn cms-btn--quiet cms-btn--micro"
                  title={open ? 'Collapse' : 'Expand'}
                  aria-expanded={open}
                  data-testid={`band-expand-${band.id}`}
                  onClick={() => toggleExpanded(band.id)}
                >
                  {open ? '▾' : '▸'}
                </button>
                <button
                  type="button"
                  className="cms-btn cms-btn--quiet cms-btn--micro"
                  title="Move up"
                  disabled={index === 0}
                  data-testid={`band-up-${band.id}`}
                  onClick={() => store.moveBand(band.id, index - 1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="cms-btn cms-btn--quiet cms-btn--micro"
                  title="Move down"
                  disabled={index === doc.bands.length - 1}
                  data-testid={`band-down-${band.id}`}
                  onClick={() => store.moveBand(band.id, index + 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="cms-btn cms-btn--quiet cms-btn--micro cms-btn--danger"
                  title="Delete band (undoable)"
                  data-testid={`band-delete-${band.id}`}
                  onClick={() => store.deleteBand(band.id)}
                >
                  ✕
                </button>
              </span>
            </div>

            {open && <Children store={store} band={band} selection={selection} />}
            {gap(index + 1)}
          </div>
        );
      })}

      {doc.bands.length === 0 && <p className="cms-hint" style={{ padding: '6px 12px' }}>No bands yet.</p>}
    </div>
  );
}

function Gap({
  index,
  active,
  onInsert,
}: {
  index: number;
  active: boolean;
  onInsert: (type: Band['type']) => void;
}) {
  return (
    <div
      className={active ? 'cms-outline__gap cms-outline__gap--active' : 'cms-outline__gap'}
      data-testid={`band-gap-${index}`}
    >
      <div className="cms-outline__gap-line" />
      <div className="cms-outline__insert">
        <button type="button" data-testid={`insert-prose-${index}`} onClick={() => onInsert('prose')}>
          + text
        </button>
        <button type="button" data-testid={`insert-canvas-${index}`} onClick={() => onInsert('canvas')}>
          + canvas
        </button>
      </div>
    </div>
  );
}

function Children({ store, band, selection }: { store: DocStore; band: Band; selection: Selection }) {
  if (band.type === 'prose') {
    return (
      <div className="cms-children">
        {band.blocks.map((block) => {
          const text = blockPlainText(block);
          return (
            <button
              key={block.id}
              type="button"
              className={
                isBlockSelected(selection, band.id, block.id) ? 'cms-child cms-child--selected' : 'cms-child'
              }
              data-testid={`outline-block-${block.id}`}
              onClick={() => store.selectBlock(band.id, block.id)}
            >
              <span className="cms-child__kind">{block.kind}</span>
              <span className={text === '' ? 'cms-child__text cms-child__text--empty' : 'cms-child__text'}>
                {text === '' ? 'empty' : text}
              </span>
            </button>
          );
        })}
        {band.blocks.length === 0 && <span className="cms-hint">no blocks</span>}
      </div>
    );
  }

  return (
    <div className="cms-children">
      {band.items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={
            isItemSelected(selection, band.id, item.id) ? 'cms-child cms-child--selected' : 'cms-child'
          }
          data-testid={`outline-item-${item.id}`}
          onClick={() => store.selectItems(band.id, [item.id])}
        >
          <span className="cms-child__kind">{item.kind === 'shape' ? (item.shape ?? 'shape') : item.kind}</span>
          <span className="cms-child__text">
            {item.kind === 'shape'
              ? `${Math.round(item.w)}×${Math.round(item.h)}`
              : (item.alt ?? item.src ?? '').slice(0, 64)}
          </span>
        </button>
      ))}
      {band.items.length === 0 && <span className="cms-hint">no items</span>}
    </div>
  );
}

function summarise(band: Band): string {
  const count = bandChildCount(band);
  if (band.type === 'prose') {
    const first = band.blocks.find((block) => blockPlainText(block) !== '');
    const text = first === undefined ? '' : blockPlainText(first);
    return `${count} block${count === 1 ? '' : 's'}${text === '' ? '' : ` · ${text}`}`;
  }
  return `${count} item${count === 1 ? '' : 's'} · ${Math.round(band.height)}px tall`;
}
