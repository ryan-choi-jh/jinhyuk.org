/**
 * src/cms/app/shell/toolbar.tsx
 *
 * WS-3. Save, Publish, Preview, undo and redo, the zoom control, and the
 * dirty indicator.
 *
 * Save writes the draft (docs/cms-rebuild.md 2.3), which is never on the live
 * site. Publish copies the draft over the published file, and because of that
 * the store saves first if there is anything unsaved; publishing a stale draft
 * would silently drop the last edit. Preview does the same, for the same
 * reason: the preview reads the draft.
 */

import type { ChangeEvent } from 'react';

import type { DocStore, DocStoreState } from '../state/store.ts';
import type { Zoom } from './page-surface.tsx';
import type { EditorShellSlots } from './slots.ts';

export const ZOOM_CHOICES: { value: string; label: string; zoom: Zoom }[] = [
  { value: 'fit', label: 'Fit', zoom: 'fit' },
  { value: '0.5', label: '50%', zoom: 0.5 },
  { value: '0.75', label: '75%', zoom: 0.75 },
  { value: '1', label: '100%', zoom: 1 },
];

export type ToolbarProps = {
  store: DocStore;
  state: DocStoreState;
  zoom: Zoom;
  onZoomChange: (zoom: Zoom) => void;
  onPreview: () => void;
  slots: EditorShellSlots;
};

export function Toolbar({ store, state, zoom, onZoomChange, onPreview, slots }: ToolbarProps) {
  const busy = state.phase !== 'idle';

  return (
    <div className="cms-toolbar" data-testid="toolbar">
      <span className="cms-toolbar__title">
        <span className="cms-toolbar__name" data-testid="toolbar-title">
          {state.doc.meta.title}
        </span>
        <span className="cms-toolbar__slug">/{state.slug}</span>
      </span>

      <span className={state.dirty ? 'cms-dirty cms-dirty--dirty' : 'cms-dirty'} data-testid="dirty">
        <span className="cms-dirty__dot" />
        {state.dirty ? 'Unsaved changes' : savedLabel(state)}
      </span>

      <span className="cms-toolbar__spacer" />

      <span className="cms-toolbar__group">
        <button
          type="button"
          className="cms-btn cms-btn--icon"
          title={state.undoLabel === null ? 'Nothing to undo' : `Undo ${state.undoLabel}`}
          aria-label="Undo"
          disabled={!state.canUndo}
          data-testid="undo"
          onClick={() => store.undo()}
        >
          ↺
        </button>
        <button
          type="button"
          className="cms-btn cms-btn--icon"
          title={state.redoLabel === null ? 'Nothing to redo' : `Redo ${state.redoLabel}`}
          aria-label="Redo"
          disabled={!state.canRedo}
          data-testid="redo"
          onClick={() => store.redo()}
        >
          ↻
        </button>
      </span>

      <span className="cms-toolbar__sep" />

      <label className="cms-zoom">
        Zoom
        <select
          className="cms-select"
          value={zoomValue(zoom)}
          data-testid="zoom"
          onChange={(event: ChangeEvent<HTMLSelectElement>) => {
            const choice = ZOOM_CHOICES.find((candidate) => candidate.value === event.target.value);
            if (choice !== undefined) onZoomChange(choice.zoom);
          }}
        >
          {ZOOM_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>

      <span className="cms-toolbar__sep" />

      {slots.renderToolbarExtra !== undefined && slots.renderToolbarExtra({ store, state })}

      <span className="cms-toolbar__group">
        <button
          type="button"
          className="cms-btn"
          data-testid="preview"
          disabled={busy}
          title="Save the draft and open the preview"
          onClick={onPreview}
        >
          Preview
        </button>
        <button
          type="button"
          className="cms-btn"
          data-testid="save"
          disabled={busy || !state.dirty}
          title="Save draft (⌘S). Saved, but not on the live site until you publish."
          onClick={() => void store.save()}
        >
          {state.phase === 'saving' ? 'Saving…' : 'Save draft'}
        </button>
        <button
          type="button"
          className="cms-btn cms-btn--primary"
          data-testid="publish"
          disabled={busy}
          title="Copy the draft over the published page"
          onClick={() => void store.publish()}
        >
          {state.phase === 'publishing' ? 'Publishing…' : 'Publish'}
        </button>
      </span>
    </div>
  );
}

function zoomValue(zoom: Zoom): string {
  return zoom === 'fit' ? 'fit' : String(zoom);
}

function savedLabel(state: DocStoreState): string {
  if (state.lastSavedAt === null) return 'No unsaved changes';
  const seconds = Math.max(0, Math.round((Date.now() - state.lastSavedAt) / 1000));
  if (seconds < 5) return 'Draft saved just now';
  if (seconds < 90) return `Draft saved ${seconds}s ago`;
  return `Draft saved ${Math.round(seconds / 60)}m ago`;
}
