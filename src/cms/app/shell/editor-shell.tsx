/**
 * src/cms/app/shell/editor-shell.tsx
 *
 * WS-3. The frame: band outline on the left, the page in the middle, the
 * inspector on the right, a toolbar above and a status line below.
 *
 * Desktop only, deliberately (docs/cms-rebuild.md 1). Below
 * `MOBILE_BREAKPOINT` the editor is replaced by a short note saying so; that
 * is pure CSS in `./styles.ts`, so there is no viewport listener and nothing
 * to get out of sync. 900px is the one breakpoint this project has.
 *
 * It renders slots for canvas and prose editing and implements neither. WS-4
 * and WS-5 own those; WS-8 passes them in as `renderCanvasBand` and
 * `renderProseBlock` without editing anything in this directory.
 */

import { useCallback, useEffect, useState } from 'react';

import { MOBILE_BREAKPOINT } from '../../schema.ts';
import { describeSelection } from '../state/selection.ts';
import type { DocStore } from '../state/store.ts';
import { DocStoreProvider, useDocStore } from '../state/use-doc-store.ts';
import { BandOutline } from './band-outline.tsx';
import { Inspector } from './inspector.tsx';
import { PageSurface } from './page-surface.tsx';
import type { Zoom } from './page-surface.tsx';
import type { EditorShellSlots } from './slots.ts';
import { useShellStyles } from './styles.ts';
import { useTypeScale } from './use-type-scale.ts';
import { Toolbar } from './toolbar.tsx';
import { useShortcuts } from './use-shortcuts.ts';
import { useLocalDraft } from './use-local-draft.ts';
import { useUnsavedChangesGuard } from './use-unsaved-changes.ts';

export type PreviewContext = {
  slug: string;
  /** Whether there were unsaved changes before the shell saved them. */
  wasDirty: boolean;
  /** Where the shell would have opened, from `previewUrl`. */
  url: string;
};

export type EditorShellProps = EditorShellSlots & {
  store: DocStore;
  /**
   * Map a document `src` onto something loadable here. Identity by default.
   * The harness points it at the local `public/` tree so the page draws real
   * images with no server.
   */
  resolveMediaSrc?: (src: string) => string;
  /** Where Preview goes. WS-7 owns the route; this is only how it is addressed. */
  previewUrl?: (slug: string) => string;
  /** Replace what Preview does. Default: save the draft, then open `previewUrl` in a new tab. */
  onPreview?: (context: PreviewContext) => void;
  /** ⌘Z, ⇧⌘Z, ⌘S. Default on. */
  keyboardShortcuts?: boolean;
  /** beforeunload and link interception while dirty. Default on. */
  guardUnsavedChanges?: boolean;
  /** Ask the API who is signed in, once, on mount. Default on. */
  checkAuthOnMount?: boolean;
  initialZoom?: Zoom;
  className?: string;
};

export function defaultPreviewUrl(slug: string): string {
  return `/preview/${slug}?draft=1`;
}

const identity = (src: string): string => src;

export function EditorShell({
  store,
  resolveMediaSrc = identity,
  previewUrl = defaultPreviewUrl,
  onPreview,
  keyboardShortcuts = true,
  guardUnsavedChanges = true,
  checkAuthOnMount = true,
  initialZoom = 'fit',
  className,
  ...slots
}: EditorShellProps) {
  useShellStyles();
  // The body size the CMS is set to, applied to the page in the middle pane.
  // Live: moving the stepper in the Body size panel repaints the surface,
  // which is the preview. See ./use-type-scale.ts.
  useTypeScale();
  const state = useDocStore(store);
  const [zoom, setZoom] = useState<Zoom>(initialZoom);

  useShortcuts(store, keyboardShortcuts);
  useUnsavedChangesGuard(state.dirty, guardUnsavedChanges);

  /* A crash copy in this browser, offered back once. The guard above warns
     on the way out, which cannot help if the process dies. */
  const localDraft = useLocalDraft(store, guardUnsavedChanges);

  useEffect(() => {
    if (checkAuthOnMount) void store.refreshAuth();
  }, [store, checkAuthOnMount]);

  /**
   * `onPhone` asks for the preview at a phone width.
   *
   * It has to be the PREVIEW and cannot be the surface. The mobile rules are
   * viewport media queries — `@media (max-width: 900px)` in doc.css and in
   * global.css — and a viewport is a window or an iframe, not a scaled div.
   * Narrowing the surface would change the measure and change nothing else,
   * which is a worse lie than not offering it: the canvas would stay
   * absolutely positioned where a phone stacks it, and the type would stay
   * at 17.5 where a phone steps to 14. The preview renders in a real iframe
   * and therefore gets it right.
   */
  const handlePreview = useCallback((width?: number) => {
    const wasDirty = state.dirty;
    const base = previewUrl(state.slug);
    const url =
      width === undefined ? base : `${base}${base.includes('?') ? '&' : '?'}w=${width}`;
    void (async () => {
      // The preview reads the draft, so an unsaved edit would simply not be in
      // it. Save first rather than show something stale.
      const ok = await store.saveIfDirty();
      if (!ok) return;
      if (onPreview !== undefined) {
        onPreview({ slug: state.slug, wasDirty, url });
        return;
      }
      if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
    })();
  }, [onPreview, previewUrl, state.dirty, state.slug, store]);

  return (
    <DocStoreProvider value={store}>
      <div className={className === undefined ? 'cms-root' : `cms-root ${className}`} data-testid="cms-root">
        <Toolbar
          store={store}
          state={state}
          zoom={zoom}
          onZoomChange={setZoom}
          onPreview={handlePreview}
          slots={slots}
        />

        {localDraft.found !== null && (
          <div className="cms-recovered" data-testid="local-draft" role="status">
            <span>
              This browser has unsaved changes to this page from{' '}
              <strong>{localDraft.age}</strong>. They were never sent anywhere.
            </span>
            <span className="cms-recovered__actions">
              <button
                type="button"
                className="cms-btn cms-btn--primary cms-btn--tiny"
                data-testid="local-draft-restore"
                onClick={localDraft.restore}
              >
                Restore them
              </button>
              <button
                type="button"
                className="cms-btn cms-btn--tiny"
                data-testid="local-draft-dismiss"
                onClick={localDraft.dismiss}
              >
                Discard
              </button>
            </span>
          </div>
        )}

        <div className="cms-panes">
          <section className="cms-pane cms-pane--left" aria-label="Band outline">
            <header className="cms-pane__head">
              Bands
              <span style={{ marginLeft: 'auto', fontWeight: 400, letterSpacing: 0 }}>
                {state.doc.bands.length}
              </span>
            </header>
            <div className="cms-pane__body">
              <BandOutline store={store} doc={state.doc} selection={state.selection} />
            </div>
          </section>

          <section className="cms-pane cms-pane--centre" aria-label="Page">
            <PageSurface
              store={store}
              doc={state.doc}
              selection={state.selection}
              zoom={zoom}
              slots={slots}
              resolveMediaSrc={resolveMediaSrc}
            />
          </section>

          <section className="cms-pane cms-pane--right" aria-label="Inspector">
            <header className="cms-pane__head">Inspector</header>
            <div className="cms-pane__body">
              <Inspector store={store} state={state} slots={slots} />
            </div>
          </section>
        </div>

        <div
          className={`cms-status${state.notice === null ? '' : ` cms-status--${state.notice.kind}`}`}
          data-testid="status"
        >
          <span className="cms-status__msg" data-testid="status-message">
            {state.notice === null ? describeSelection(state.doc, state.selection) : state.notice.message}
          </span>
          {state.notice !== null && state.notice.undoable && state.canUndo && (
            <button
              type="button"
              className="cms-btn cms-btn--tiny"
              data-testid="status-undo"
              onClick={() => store.undo()}
            >
              Undo
            </button>
          )}
          {state.notice !== null && (
            <button
              type="button"
              className="cms-btn cms-btn--quiet cms-btn--tiny"
              data-testid="status-dismiss"
              onClick={() => store.dismissNotice()}
            >
              Dismiss
            </button>
          )}
          <span className="cms-status__meta">
            {state.phase === 'idle' ? '' : `${state.phase}… · `}
            {state.lastCommit === null ? 'no commit yet' : `commit ${state.lastCommit.slice(0, 7)}`}
          </span>
        </div>

        <div className="cms-narrow" data-testid="narrow-notice">
          <h1>The editor needs a wider window.</h1>
          <p>
            It is a desktop tool: a {MOBILE_BREAKPOINT}px window cannot hold three panes and a page at
            once. The site it edits works on a phone; this does not.
          </p>
        </div>
      </div>
    </DocStoreProvider>
  );
}
