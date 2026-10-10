/**
 * src/cms/app/shell/record-view.tsx
 *
 * WS-D. The frame around one record: a toolbar with the same Save, Publish,
 * Preview, undo, redo and dirty indicator the document editor has, the slot
 * where WS-E's editor mounts, and a status line.
 *
 * It is deliberately the same chrome, with the same class names and the same
 * `data-testid`s, as `./toolbar.tsx` and `./editor-shell.tsx`: moving between
 * an essay and a film should not feel like moving between two applications,
 * and a driver should not need to know which editor is open to press Save.
 * Only one editor is ever mounted, so the ids cannot collide.
 *
 * What it does not do is anything about the fields. A film is not a page
 * (docs/cms-sections.md 2), so there is no page surface, no band outline and
 * no inspector here — the record editor is the whole middle.
 */

import { useCallback } from 'react';

import { siteUrlFor } from '../../sections.ts';
import type { RecordSectionDef } from '../../sections.ts';
import { recordEntryKey } from '../state/record-store.ts';
import type { RecordStore } from '../state/record-store.ts';
import { RecordStoreProvider, useRecordStore } from '../state/use-site-store.ts';
import { RecordStub } from './record-stub.tsx';
import type { RecordEditorSlotProps, SiteShellSlots } from './site-slots.ts';
import { useShortcuts } from './use-shortcuts.ts';

export type RecordPreviewContext = {
  section: RecordSectionDef;
  entryKey: string | null;
  wasDirty: boolean;
  url: string;
};

export type RecordViewProps = {
  store: RecordStore;
  section: RecordSectionDef;
  /** The entry the route asked for. The store is the authority on what is open. */
  entryKey: string | null;
  slots: SiteShellSlots;
  resolveMediaSrc?: (src: string) => string;
  /** Where Preview goes. WS-H owns the route; this is only how it is addressed. */
  previewUrl?: (section: RecordSectionDef, entryKey: string | null) => string;
  onPreview?: (context: RecordPreviewContext) => void;
  keyboardShortcuts?: boolean;
};

const identity = (src: string): string => src;

/**
 * Where a record's page is previewed.
 *
 * A film has no page of its own, so it previews the section index it plays on;
 * an album has `/photography/<slug>/`, which is new site surface in phase 2
 * (docs/cms-sections.md 3.4). `siteUrlFor` is what knows the difference, so
 * this is one rule. WS-H owns the preview route itself; override this prop
 * when it lands if the shape differs.
 */
export function defaultRecordPreviewUrl(
  section: RecordSectionDef,
  entryKey: string | null,
): string {
  const page = entryKey === null ? null : siteUrlFor(section, entryKey);
  return `/preview${page ?? section.indexUrl}?draft=1`;
}

export function RecordView({
  store,
  section,
  entryKey,
  slots,
  resolveMediaSrc = identity,
  previewUrl = defaultRecordPreviewUrl,
  onPreview,
  keyboardShortcuts = true,
}: RecordViewProps) {
  const state = useRecordStore(store);
  const records = section.records;
  const busy = state.phase !== 'idle';

  useShortcuts(store, keyboardShortcuts);

  const entry = state.openId === null ? null : state.entries.find((candidate) => candidate.id === state.openId) ?? null;
  const openKey = entry === null ? entryKey : recordEntryKey(records, entry);

  const handlePreview = useCallback(() => {
    const wasDirty = state.dirty;
    const url = previewUrl(section, openKey);
    void (async () => {
      // The preview reads the draft, so an unsaved edit would simply not be in
      // it. Save first rather than show something stale.
      const ok = await store.saveIfDirty();
      if (!ok) return;
      if (onPreview !== undefined) {
        onPreview({ section, entryKey: openKey, wasDirty, url });
        return;
      }
      if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
    })();
  }, [onPreview, openKey, previewUrl, section, state.dirty, store]);

  const slotProps: RecordEditorSlotProps | null =
    entry === null || openKey === null
      ? null
      : {
          store,
          state,
          section,
          records,
          fields: records.fields,
          entry,
          entryIndex: state.entries.findIndex((candidate) => candidate.id === entry.id),
          entryKey: openKey,
          file: state.file,
          dirty: state.dirty,
          onPatch: (patch, options) => {
            store.patchEntry(entry.id, patch, options);
          },
          onReplace: (next, options) => {
            store.replaceEntry(entry.id, next, options);
          },
          uploadMedia: (file: File) => store.uploadMedia(file, openKey),
          resolveMediaSrc,
        };

  return (
    <div className="cms-rec" data-testid="record-view" data-section={section.id}>
      <div className="cms-toolbar" data-testid="toolbar">
        <span className="cms-toolbar__title">
          <span className="cms-toolbar__name" data-testid="toolbar-title">
            {entry === null ? section.label : entry.title}
          </span>
          <span className="cms-toolbar__slug">
            {openKey === null ? section.indexUrl : `${section.indexUrl}${openKey}`}
          </span>
        </span>

        <span className={state.dirty ? 'cms-dirty cms-dirty--dirty' : 'cms-dirty'} data-testid="dirty">
          <span className="cms-dirty__dot" />
          {state.dirty ? 'Unsaved changes' : state.hasDraft ? 'Draft saved' : 'No unsaved changes'}
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

        {slots.renderRecordToolbarExtra !== undefined &&
          slots.renderRecordToolbarExtra({ store, state })}

        <span className="cms-toolbar__group">
          <button
            type="button"
            className="cms-btn"
            data-testid="preview"
            disabled={busy}
            title="Save the collection and open the preview"
            onClick={handlePreview}
          >
            Preview
          </button>
          <button
            type="button"
            className="cms-btn"
            data-testid="save"
            disabled={busy || !state.dirty}
            title={`Save the whole ${section.label.toLowerCase()} collection as a draft (⌘S). Not on the live site.`}
            onClick={() => void store.save()}
          >
            {state.phase === 'saving' ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="cms-btn cms-btn--primary"
            data-testid="publish"
            disabled={busy}
            title="Copy the draft collection over the published one"
            onClick={() => void store.publish()}
          >
            {state.phase === 'publishing' ? 'Publishing…' : 'Publish'}
          </button>
        </span>
      </div>

      <div className="cms-rec__body">
        <div className="cms-rec__inner">
          {slotProps === null ? (
            <div className="cms-site__empty" data-testid="record-none">
              <h2>Nothing open</h2>
              <p>
                Choose a {records.noun} on the left, or add one. The collection holds{' '}
                {state.summaries.length}.
              </p>
            </div>
          ) : (
            <RecordStoreProvider value={store}>
              {slots.renderRecordEditor === undefined ? (
                <RecordStub {...slotProps} />
              ) : (
                slots.renderRecordEditor(slotProps)
              )}
            </RecordStoreProvider>
          )}
        </div>
      </div>

      <div
        className={`cms-status${state.notice === null ? '' : ` cms-status--${state.notice.kind}`}`}
        data-testid="status"
      >
        <span className="cms-status__msg" data-testid="status-message">
          {state.notice === null
            ? `${section.label} · ${state.summaries.length} ${records.noun}${
                state.summaries.length === 1 ? '' : 's'
              }${state.issues.length === 0 ? '' : ` · ${state.issues.length} validation problem(s)`}`
            : state.notice.message}
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
    </div>
  );
}
