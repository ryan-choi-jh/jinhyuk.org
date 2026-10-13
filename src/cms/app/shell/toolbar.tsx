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

import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';

import { preflight, preflightSummary } from '../../preflight.ts';
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
  onPreview: (width?: number) => void;
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

      <ThemeControl />

      <span className="cms-toolbar__sep" />

      {slots.renderToolbarExtra !== undefined && slots.renderToolbarExtra({ store, state })}

      <span className="cms-toolbar__group">
        <button
          type="button"
          className="cms-btn"
          data-testid="preview"
          disabled={busy}
          title="Save the draft and open the preview"
          onClick={() => onPreview()}
        >
          Preview
        </button>
        <button
          type="button"
          className="cms-btn"
          data-testid="preview-phone"
          disabled={busy}
          title="Save the draft and open the preview at 390px. A real iframe, because the mobile rules are viewport media queries and a narrowed surface cannot fire them."
          onClick={() => onPreview(390)}
        >
          Phone
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
        <PublishButton store={store} state={state} busy={busy} />
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Which theme the page is drawn in                                            */
/* -------------------------------------------------------------------------- */

const THEME_KEY = 'jinhyuk-cms.surface-theme.v1';

/**
 * Light, dark, or whatever this machine prefers.
 *
 * The surface's ground is `var(--paper)` and every colour in the drawn page
 * comes from the same tokens the site uses, and those tokens flip on
 * `:root[data-theme]` — so this sets the attribute on <html>, exactly as the
 * site's own pre-paint script does, and the page in the middle pane becomes
 * the dark page. The editor's own chrome is on a separate `--cms-*` scale
 * and does not move.
 *
 * It matters because a colour chosen in the CMS could be unreadable on the
 * dark site and there was no way to find out without leaving for Preview,
 * and nothing ever made anyone leave.
 *
 * Remembered per browser, because it is a view setting and not content. A
 * failed read or write is not worth a word: the worst case is the control
 * starting at "system" next time.
 */
type SurfaceTheme = 'system' | 'light' | 'dark';

function readTheme(): SurfaceTheme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    /* a private window, or storage turned off */
  }
  return 'system';
}

function ThemeControl() {
  const [theme, setTheme] = useState<SurfaceTheme>('system');

  // After mount, never during render: there is no localStorage on the server
  // and the first client render has to match the markup.
  useEffect(() => setTheme(readTheme()), []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const prefersDark =
      typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
    // `system` resolves to an explicit value here rather than removing the
    // attribute, because global.css only defines the dark branch under
    // `[data-theme='dark']`; the site's own inline script resolves it the
    // same way, for the same reason.
    root.setAttribute('data-theme', theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* nothing to do about it, and nothing worth saying */
    }
  }, [theme]);

  return (
    <select
      className="cms-select"
      data-testid="surface-theme"
      value={theme}
      title="Draw the page in light or dark. The site's own tokens, so this is what a reader sees."
      onChange={(event: ChangeEvent<HTMLSelectElement>) =>
        setTheme(event.target.value as SurfaceTheme)
      }
    >
      <option value="system">Theme: system</option>
      <option value="light">Theme: light</option>
      <option value="dark">Theme: dark</option>
    </select>
  );
}

/**
 * Publish, with the checklist in front of it.
 *
 * The schema says whether a document can be DRAWN. It says nothing about
 * whether a page is finished, and the gap between those two is where seven
 * images ended up on the live site with no alt text while the field sat in
 * the inspector with nothing ever mentioning it.
 *
 * WARNINGS, NEVER A BLOCK. Every item is something a person might do
 * deliberately, and an editor that refuses to publish over a decorative
 * image is one people learn to fight. So: first press opens the list,
 * second press publishes. A page with nothing to say publishes on the first
 * press, because a confirmation step that always says "all clear" is a step
 * people stop reading.
 */
function PublishButton({
  store,
  state,
  busy,
}: {
  store: DocStore;
  state: DocStoreState;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const findings = preflight(state.doc);
  const summary = preflightSummary(findings);

  const go = (): void => {
    setOpen(false);
    void store.publish();
  };

  return (
    <span className="cms-publish">
      {open && (
        <div className="cms-preflight" data-testid="preflight" role="group" aria-label="Before publishing">
          <div className="cms-preflight__head">Before publishing</div>
          <ul className="cms-preflight__list">
            {findings.map((finding, index) => (
              <li key={index} data-level={finding.level}>
                {finding.message}
              </li>
            ))}
          </ul>
          <div className="cms-preflight__actions">
            <button type="button" className="cms-btn cms-btn--primary cms-btn--tiny" data-testid="preflight-go" onClick={go}>
              Publish anyway
            </button>
            <button type="button" className="cms-btn cms-btn--tiny" data-testid="preflight-cancel" onClick={() => setOpen(false)}>
              Let me fix them
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        className="cms-btn cms-btn--primary"
        data-testid="publish"
        disabled={busy}
        title={
          summary === null
            ? 'Copy the draft over the published page'
            : `Copy the draft over the published page. ${summary}.`
        }
        onClick={() => {
          // Nothing to say, or the list is already open: just publish.
          if (summary === null || open) go();
          else setOpen(true);
        }}
      >
        {state.phase === 'publishing' ? 'Publishing…' : 'Publish'}
        {summary === null || open ? '' : ' ⚠'}
      </button>
    </span>
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
