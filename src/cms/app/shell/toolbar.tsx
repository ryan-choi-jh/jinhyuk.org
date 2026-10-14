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
import { countLabel, publishEach, usePublishQueue } from './publish-queue.ts';
import type { PendingItem } from './publish-queue.ts';
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
      {/* The title only. The slug used to sit beside it and was the thing
          that broke this bar: it has no sensible shrink point, so at any
          real width it wrapped to three lines and pushed the title out of
          view entirely. It is also redundant — the shell's breadcrumbs
          above say `/ Essays / Chasing the Workaround`, and the inspector
          has the slug itself with a Rename beside it. */}
      <span className="cms-toolbar__title" title={`/${state.slug}`}>
        <span className="cms-toolbar__name" data-testid="toolbar-title">
          {state.doc.meta.title}
        </span>
      </span>

      <span
        className={state.dirty ? 'cms-dirty cms-dirty--dirty' : 'cms-dirty'}
        data-testid="dirty"
        title={savedTitle(state)}
      >
        <span className="cms-dirty__dot" />
        {/* The words go first when the bar is tight; the dot and the
            tooltip carry the state on their own. */}
        <span className="cms-dirty__text">{state.dirty ? 'Unsaved' : savedLabel(state)}</span>
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
        <span className="cms-zoom__label">Zoom</span>
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

  // Shaped like the Zoom control beside it: a small label and a narrow
  // select. The options used to read "Theme: system", which made the select
  // 202px wide — the widest thing in the bar — and squeezed the buttons
  // either side of it until they overlapped.
  return (
    <label className="cms-zoom" title="Draw the page in light or dark. The site's own tokens, so this is what a reader sees.">
      <span className="cms-zoom__label">Theme</span>
      <select
        className="cms-select"
        data-testid="surface-theme"
        value={theme}
        onChange={(event: ChangeEvent<HTMLSelectElement>) =>
          setTheme(event.target.value as SurfaceTheme)
        }
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
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

  const queue = usePublishQueue();
  const [pending, setPending] = useState<PendingItem[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * What is waiting, read when the panel opens.
   *
   * Not held in state between openings: a draft saved in another tab is
   * waiting too, and a cached list would describe the moment the editor
   * booted. The open entry is ticked and nothing else is, because the thing
   * in front of you is what Publish has always meant and the rest is an
   * offer, not a default.
   */
  const show = async (): Promise<void> => {
    setProblem(null);
    setOpen(true);
    if (queue === null) return;
    setPending(null);
    try {
      const items = await queue.list();
      setPending(items);
      setPicked(new Set(items.filter((item) => item.current).map((item) => item.id)));
    } catch (error) {
      setPending([]);
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  /** The old behaviour, for a toolbar with no queue behind it. */
  const publishThisPage = (): void => {
    setOpen(false);
    void store.publish();
  };

  const chosen = (pending ?? []).filter((item) => picked.has(item.id));

  const go = async (): Promise<void> => {
    if (queue === null) {
      publishThisPage();
      return;
    }
    if (chosen.length === 0) return;
    setRunning(true);
    setProblem(null);
    /*
     * The open page goes through the DOCUMENT store's own publish, not the
     * queue's. Both reach the same endpoint, but the doc store is the thing
     * holding this page's draft state and its blob shas, and publishing
     * around it would leave the toolbar still saying "draft saved" over a
     * page that is live.
     */
    const toRun = chosen.map((item) =>
      item.current
        ? {
            ...item,
            publish: async (): Promise<void> => {
              const ok = await store.publish();
              if (!ok) throw new Error('see the message below');
            },
          }
        : item,
    );
    const { done, failed } = await publishEach(toRun);
    setRunning(false);
    if (failed === null) {
      setOpen(false);
      store.notify(
        'success',
        done.length === 1
          ? `Published ${done[0]?.label}.`
          : `Published ${countLabel(done.length)}.`,
      );
      return;
    }
    // Stopped partway: say exactly how far it got, because the difference
    // between "nothing happened" and "two of four are live" decides what to
    // do next.
    setProblem(
      `${done.length === 0 ? 'Nothing was published. ' : `${countLabel(done.length)} went live, then `}` +
        `${failed.item.label} failed: ${failed.message}`,
    );
    const items = await queue.list().catch(() => null);
    if (items !== null) {
      setPending(items);
      setPicked(new Set(items.map((item) => item.id).filter((id) => picked.has(id))));
    }
  };

  const groups = [...new Set((pending ?? []).map((item) => item.group))];
  const nothingPending = pending !== null && pending.length === 0;

  return (
    <span className="cms-publish">
      {open && (
        <div className="cms-preflight" data-testid="preflight" role="group" aria-label="Before publishing">
          <div className="cms-preflight__head">
            {queue === null ? 'Before publishing' : 'Choose what goes live'}
          </div>

          {findings.length > 0 && (
            <ul className="cms-preflight__list">
              {findings.map((finding, index) => (
                <li key={index} data-level={finding.level}>
                  {finding.message}
                </li>
              ))}
            </ul>
          )}

          {queue !== null && pending === null && (
            <div className="cms-preflight__note" data-testid="preflight-loading">
              Looking for anything saved but not live…
            </div>
          )}

          {nothingPending && (
            <div className="cms-preflight__note" data-testid="preflight-empty">
              Nothing is waiting. Everything saved is already on the site.
            </div>
          )}

          {queue !== null && pending !== null && pending.length > 0 && (
            <div className="cms-pending" data-testid="pending">
              {groups.map((group) => (
                <div className="cms-pending__group" key={group}>
                  <div className="cms-pending__group-head">{group}</div>
                  {(pending ?? [])
                    .filter((item) => item.group === group)
                    .map((item) => (
                      <label className="cms-pending__row" key={item.id}>
                        <input
                          type="checkbox"
                          data-testid={`pending-${item.id}`}
                          checked={picked.has(item.id)}
                          disabled={running}
                          onChange={() =>
                            setPicked((before) => {
                              const next = new Set(before);
                              if (next.has(item.id)) next.delete(item.id);
                              else next.add(item.id);
                              return next;
                            })
                          }
                        />
                        <span className="cms-pending__label">
                          {item.label}
                          {item.current ? <span className="cms-pending__here"> open now</span> : null}
                        </span>
                        <span className="cms-pending__detail">{item.detail}</span>
                      </label>
                    ))}
                </div>
              ))}
              <div className="cms-pending__foot">
                Unticked drafts stay drafts. Nothing is deleted.
              </div>
            </div>
          )}

          {problem !== null && (
            <div className="cms-preflight__problem" data-testid="preflight-problem">
              {problem}
            </div>
          )}

          <div className="cms-preflight__actions">
            <button
              type="button"
              className="cms-btn cms-btn--primary cms-btn--tiny"
              data-testid="preflight-go"
              disabled={running || (queue !== null && chosen.length === 0)}
              onClick={() => void go()}
            >
              {running
                ? 'Publishing…'
                : queue === null
                  ? 'Publish anyway'
                  : chosen.length === 0
                    ? 'Nothing ticked'
                    : `Publish ${countLabel(chosen.length)}`}
            </button>
            <button
              type="button"
              className="cms-btn cms-btn--tiny"
              data-testid="preflight-cancel"
              disabled={running}
              onClick={() => setOpen(false)}
            >
              Cancel
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
          queue === null
            ? summary === null
              ? 'Copy the draft over the published page'
              : `Copy the draft over the published page. ${summary}.`
            : 'See everything saved but not live, and choose what goes on the site'
        }
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          // With no queue behind it this is still phase 1's button: publish
          // the open page, asking first only if there is something to say.
          if (queue === null && summary === null) publishThisPage();
          else void show();
        }}
      >
        {state.phase === 'publishing' || running ? 'Publishing…' : 'Publish'}
        {summary === null || open ? '' : ' ⚠'}
      </button>
    </span>
  );
}

function zoomValue(zoom: Zoom): string {
  return zoom === 'fit' ? 'fit' : String(zoom);
}

/**
 * Short, because this sits between the title and the controls and is the
 * least important thing in the bar. It was "No unsaved changes" and "Draft
 * saved 3m ago", which at a real pane width got clipped to "No unsaved
 * char" — worse than saying less. The dot beside it already carries the
 * state; the words only date it. The full phrasing is the `title`.
 */
function savedLabel(state: DocStoreState): string {
  if (state.lastSavedAt === null) return 'Saved';
  const seconds = Math.max(0, Math.round((Date.now() - state.lastSavedAt) / 1000));
  if (seconds < 5) return 'Saved just now';
  if (seconds < 90) return `Saved ${seconds}s ago`;
  return `Saved ${Math.round(seconds / 60)}m ago`;
}

/** The same thing at length, for the tooltip. */
function savedTitle(state: DocStoreState): string {
  if (state.dirty) return 'This page has changes that are not saved yet. ⌘S saves a draft.';
  if (state.lastSavedAt === null) return 'Nothing to save: no changes since this page was opened.';
  return 'The draft is saved. It is not on the live site until you publish.';
}
