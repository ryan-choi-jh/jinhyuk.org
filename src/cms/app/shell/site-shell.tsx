/**
 * src/cms/app/shell/site-shell.tsx
 *
 * WS-D. The navigation shell: the section sidebar, the entry list, and the
 * editor region that dispatches to the right editor.
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ brand · crumbs                                   auth   │
 *   ├──────────┬──────────────┬───────────────────────────────┤
 *   │ sections │ entries      │ EditorShell  (home/projects/  │
 *   │          │              │               essays)         │
 *   │          │              │ RecordView   (filmography/    │
 *   │          │              │               photography)    │
 *   ├──────────┴──────────────┴───────────────────────────────┤
 *   │ status                                                  │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Four things it is responsible for, and nothing else.
 *
 * 1. DISPATCH. `section.storage` says which editor an entry opens in, so the
 *    choice is a two-armed switch on WS-A's registry, not a list of section
 *    names. The document arm mounts phase 1's `<EditorShell>` unchanged, with
 *    phase 1's slots passed straight through. The record arm mounts
 *    `<RecordView>`, which mounts WS-E's editor in its slot.
 *
 * 2. THE SINGLETON. Home has one entry, so it has no entry list: the list
 *    column is not rendered and the editor is what you land on. That decision
 *    is `resolveRoute`'s, in `../state/route.ts`, and this file only draws the
 *    result.
 *
 * 3. ONE UNSAVED-CHANGES GUARD. WS-3's `useUnsavedChangesGuard` already covers
 *    closing the tab and clicking a link; it is installed here, over whichever
 *    editor is open, and injected into the site store so moving between
 *    sections asks the same question with the same wording. The nested
 *    `<EditorShell>` is told not to install its own, or a link click would
 *    prompt twice.
 *
 * 4. LAYOUT. `.cms-root--embedded` is the one override: the document editor
 *    sizes itself to the viewport because it used to be the whole page.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { MOBILE_BREAKPOINT } from '../../schema.ts';
import { SECTIONS, isRecordSection } from '../../sections.ts';
import type { RecordSectionDef, SectionDef } from '../../sections.ts';
import type { EditorBinding, SiteStore, SiteStoreState } from '../state/site-store.ts';
import { SiteStoreProvider, useSiteStoreState } from '../state/use-site-store.ts';
import { EditorShell } from './editor-shell.tsx';
import type { PreviewContext } from './editor-shell.tsx';
import { EntryList } from './entry-list.tsx';
import type { Zoom } from './page-surface.tsx';
import { RecordView } from './record-view.tsx';
import type { RecordPreviewContext } from './record-view.tsx';
import { SectionSidebar } from './section-sidebar.tsx';
import type { SiteShellSlots } from './site-slots.ts';
import { useSiteStyles } from './site-styles.ts';
import { useUnsavedChangesGuard } from './use-unsaved-changes.ts';

export type SiteShellProps = SiteShellSlots & {
  store: SiteStore;
  /** Map a stored `src` onto something loadable here. Identity by default. */
  resolveMediaSrc?: (src: string) => string;
  /** Where Preview goes for a document. Passed through to `<EditorShell>`. */
  previewUrl?: (slug: string) => string;
  onPreview?: (context: PreviewContext) => void;
  /** Where Preview goes for a record collection or an album page. */
  recordPreviewUrl?: (section: RecordSectionDef, entryKey: string | null) => string;
  onRecordPreview?: (context: RecordPreviewContext) => void;
  /** beforeunload, link interception, and the navigation guard. Default on. */
  guardUnsavedChanges?: boolean;
  /** ⌘Z, ⇧⌘Z, ⌘S, in whichever editor is open. Default on. */
  keyboardShortcuts?: boolean;
  initialZoom?: Zoom;
  className?: string;
};

const identity = (src: string): string => src;

/**
 * `dirty`, from whichever store the open editor is bound to. The site store
 * holds the binding but not the editor's state, so this subscribes to the
 * editor's own store — the one place the two layers have to meet.
 */
function useEditorDirty(editor: EditorBinding | null): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => (editor === null ? () => {} : editor.store.subscribe(onChange)),
    [editor],
  );
  const read = useCallback(() => (editor === null ? false : editor.store.getState().dirty), [editor]);
  return useSyncExternalStore(subscribe, read, read);
}

export function SiteShell({
  store,
  resolveMediaSrc = identity,
  previewUrl,
  onPreview,
  recordPreviewUrl,
  onRecordPreview,
  guardUnsavedChanges = true,
  keyboardShortcuts = true,
  initialZoom = 'fit',
  className,
  ...slots
}: SiteShellProps) {
  useSiteStyles();
  const state = useSiteStoreState(store);
  const { resolved, editor } = state;
  const section = resolved.section;

  const dirty = useEditorDirty(editor);
  const guard = useUnsavedChangesGuard(dirty, guardUnsavedChanges);

  useEffect(() => store.start(), [store]);

  // One prompt, one wording, for the tab, a link and a section change.
  useEffect(() => {
    store.setConfirmDiscard(guard.confirmDiscard);
  }, [store, guard.confirmDiscard]);

  const entries = section === null ? [] : store.entriesOf(section.id);
  const openTitle =
    resolved.entryKey === null
      ? null
      : entries.find((entry) => entry.key === resolved.entryKey)?.title ?? resolved.entryKey;

  const showList = section !== null && section.shape === 'collection';

  return (
    <SiteStoreProvider value={store}>
      <div
        className={className === undefined ? 'cms-site' : `cms-site ${className}`}
        data-testid="cms-site"
        data-view={resolved.view}
        data-section={section === null ? '' : section.id}
        data-entry={resolved.entryKey ?? ''}
        data-editor={editor === null ? 'none' : editor.kind}
      >
        <div className="cms-site__bar">
          <button
            type="button"
            className="cms-site__brand"
            data-testid="site-brand"
            title="Every section"
            onClick={() => store.openOverview()}
          >
            jinhyuk.org
          </button>

          <span className="cms-site__crumbs" data-testid="site-crumbs">
            {section !== null && (
              <>
                <span aria-hidden="true">/</span>
                <button
                  type="button"
                  className={`cms-site__crumb${resolved.view === 'list' ? ' cms-site__crumb--current' : ''}`}
                  data-testid="crumb-section"
                  disabled={resolved.view === 'list'}
                  onClick={() => store.openSection(section.id)}
                >
                  {section.label}
                </button>
              </>
            )}
            {openTitle !== null && (
              <>
                <span aria-hidden="true">/</span>
                <span className="cms-site__crumb cms-site__crumb--current" data-testid="crumb-entry">
                  {openTitle}
                </span>
              </>
            )}
          </span>

          <span className="cms-site__spacer" />

          <span
            className={`cms-site__auth${state.auth !== null && !state.auth.signedIn ? ' cms-site__auth--out' : ''}`}
            data-testid="site-auth"
          >
            {state.auth === null
              ? '…'
              : state.auth.signedIn
                ? `signed in${state.auth.login === undefined ? '' : ` as ${state.auth.login}`}`
                : 'signed out'}
          </span>
        </div>

        <div className={`cms-site__body${showList ? '' : ' cms-site__body--nolist'}`}>
          <section className="cms-site__col cms-site__col--nav" aria-label="Sections">
            <header className="cms-site__head">
              Site
              <span className="cms-site__head-count">{SECTIONS.length}</span>
            </header>
            <div className="cms-site__scroll">
              <SectionSidebar
                store={store}
                sections={state.sections}
                current={section === null ? null : section.id}
              />
            </div>
          </section>

          {showList && section !== null && (
            <section className="cms-site__col cms-site__col--list" aria-label={`${section.label} entries`}>
              <header className="cms-site__head">
                {section.label}
                <span className="cms-site__head-count">{entries.length}</span>
              </header>
              <div className="cms-site__scroll">
                <EntryList
                  store={store}
                  section={section}
                  entries={entries}
                  loading={state.loading[section.id] === true}
                  currentKey={resolved.entryKey}
                  resolveMediaSrc={resolveMediaSrc}
                />
              </div>
            </section>
          )}

          <section className="cms-site__col cms-site__col--main" aria-label="Editor">
            <div className="cms-site__editor" data-testid="editor-region">
              {resolved.view === 'overview' && <Overview store={store} state={state} />}

              {resolved.view === 'list' && section !== null && (
                <div className="cms-site__empty" data-testid="editor-none">
                  <h2>{section.label}</h2>
                  <p>
                    {entries.length === 0
                      ? `Nothing here yet. “New ${
                          isRecordSection(section) ? section.records.noun : section.noun
                        }” starts one.`
                      : `Choose one of the ${entries.length} on the left to edit it.`}
                  </p>
                </div>
              )}

              {resolved.view === 'entry' && editor === null && (
                <div className="cms-site__empty" data-testid="editor-loading">
                  <h2>{state.phase === 'loading' ? 'Opening…' : 'Nothing open'}</h2>
                  <p>
                    {state.notice === null
                      ? 'Reading it from the repository.'
                      : state.notice.message}
                  </p>
                </div>
              )}

              {resolved.view === 'entry' &&
                editor !== null &&
                (editor.kind === 'document' ? (
                  <EditorShell
                    key={`${editor.section.id}:${editor.entryKey ?? ''}`}
                    store={editor.store}
                    className="cms-root--embedded"
                    resolveMediaSrc={resolveMediaSrc}
                    {...(previewUrl === undefined ? {} : { previewUrl })}
                    {...(onPreview === undefined ? {} : { onPreview })}
                    keyboardShortcuts={keyboardShortcuts}
                    // The site shell owns the guard; two would prompt twice.
                    guardUnsavedChanges={false}
                    initialZoom={initialZoom}
                    {...slots}
                  />
                ) : (
                  <RecordView
                    key={editor.section.id}
                    store={editor.store}
                    section={editor.section}
                    entryKey={editor.entryKey}
                    slots={slots}
                    resolveMediaSrc={resolveMediaSrc}
                    {...(recordPreviewUrl === undefined ? {} : { previewUrl: recordPreviewUrl })}
                    {...(onRecordPreview === undefined ? {} : { onPreview: onRecordPreview })}
                    keyboardShortcuts={keyboardShortcuts}
                  />
                ))}
            </div>
          </section>
        </div>

        <div
          className={`cms-site__status${state.notice === null ? '' : ` cms-site__status--${state.notice.kind}`}`}
          data-testid="site-status"
        >
          <span className="cms-site__status-msg" data-testid="site-status-message">
            {state.notice === null ? describeRoute(section, openTitle) : state.notice.message}
          </span>
          {state.notice !== null && (
            <button
              type="button"
              className="cms-btn cms-btn--quiet cms-btn--tiny"
              data-testid="site-status-dismiss"
              onClick={() => store.dismissNotice()}
            >
              Dismiss
            </button>
          )}
          <span className="cms-site__status-meta">
            {state.phase === 'idle' ? '' : `${state.phase}… · `}
            {dirty ? 'unsaved changes' : 'saved'}
          </span>
        </div>

        <div className="cms-site__narrow" data-testid="site-narrow">
          <h1>The editor needs a wider window.</h1>
          <p>
            It is a desktop tool: a {MOBILE_BREAKPOINT}px window cannot hold the site, a section and
            a page at once. The site it edits works on a phone; this does not.
          </p>
        </div>
      </div>
    </SiteStoreProvider>
  );
}

/* -------------------------------------------------------------------------- */
/* The overview                                                                */
/* -------------------------------------------------------------------------- */

function describeRoute(section: SectionDef | null, openTitle: string | null): string {
  if (section === null) return 'Every section of the site.';
  if (openTitle !== null) return `${section.label} · ${openTitle}`;
  return `${section.label} · ${section.indexUrl}`;
}

function Overview({
  store,
  state,
}: {
  store: SiteStore;
  state: SiteStoreState;
}) {
  const byId = new Map(state.sections.map((summary) => [summary.id, summary]));

  return (
    <div className="cms-overview" data-testid="overview">
      <h1>Jin Hyuk.org CMS</h1>
      <p>
        All edits are saved as draft then published to the site. Everything written as JSON
      </p>
      <div className="cms-overview__grid">
        {SECTIONS.map((section) => {
          const summary = byId.get(section.id);
          const noun = isRecordSection(section) ? section.records.noun : section.noun;
          const count = section.shape === 'singleton' ? 1 : (summary?.count ?? 0);
          return (
            <button
              type="button"
              key={section.id}
              className="cms-overview__card"
              data-testid={`overview-card-${section.id}`}
              onClick={() => store.openSection(section.id)}
            >
              <span className="cms-overview__card-title">
                {section.label}
                {summary?.hasDraft === true && <span className="cms-nav__dot" title="Unpublished draft" />}
              </span>
              <span className="cms-overview__card-meta">
                {count} {count === 1 ? noun : `${noun}s`} · {section.storage} · {section.indexUrl}
              </span>
              <span className="cms-overview__card-path">{section.contentPath}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
