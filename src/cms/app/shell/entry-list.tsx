/**
 * src/cms/app/shell/entry-list.tsx
 *
 * WS-D. One section's entries: title, date, draft badge, and a thumbnail for
 * the sections that have one. Create, duplicate, delete, and reorder where the
 * section is ordered.
 *
 * Which of those four a section gets is `store.can(section)`, not a comparison
 * against a section name:
 *
 *  - a singleton has no list at all, so this component is never rendered for
 *    one (the shell goes straight into the editor);
 *  - a record collection can be reordered, because the order of the array in
 *    its one JSON file *is* the order on the site, and delete there is a local,
 *    undoable edit;
 *  - a document collection cannot be reordered, because the site orders those
 *    by date, and delete there needs an endpoint the API table does not have
 *    (docs/cms-contracts.md 11) — so the button is disabled and says why
 *    rather than silently missing.
 */

import { isRecordSection } from '../../sections.ts';
import type { SectionDef } from '../../sections.ts';
import type { EntrySummary } from '../state/site-api.ts';
import type { SiteStore } from '../state/site-store.ts';

export type EntryListProps = {
  store: SiteStore;
  /** A collection. A singleton has no entry list. */
  section: SectionDef;
  entries: EntrySummary[];
  loading: boolean;
  /** The entry that is open, or null while only the list is showing. */
  currentKey: string | null;
  /** Map a stored `src` onto something loadable here. Identity by default. */
  resolveMediaSrc?: (src: string) => string;
};

const identity = (src: string): string => src;

/** Only the record sections carry thumbnails in their list rows. */
function wantsThumb(section: SectionDef): boolean {
  return isRecordSection(section);
}

function ask(message: string): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm(message);
}

export function EntryList({
  store,
  section,
  entries,
  loading,
  currentKey,
  resolveMediaSrc = identity,
}: EntryListProps) {
  const can = store.can(section.id);
  const noun = isRecordSection(section) ? section.records.noun : section.noun;
  const showThumb = wantsThumb(section);

  return (
    <div className="cms-list" data-testid="entry-list" data-section={section.id}>
      {loading && entries.length === 0 && (
        <p className="cms-list__empty" data-testid="entry-list-loading">
          Reading {section.label.toLowerCase()}…
        </p>
      )}

      {!loading && entries.length === 0 && (
        <p className="cms-list__empty" data-testid="entry-list-empty">
          No {noun}s yet.
        </p>
      )}

      {entries.map((entry, index) => {
        const selected = entry.key === currentKey;
        const thumb = entry.thumb ?? null;
        return (
          <div
            key={entry.key}
            className={`cms-list__row${selected ? ' cms-list__row--current' : ''}${
              entry.invalid === true ? ' cms-list__row--invalid' : ''
            }`}
            data-testid={`entry-row-${entry.key}`}
            data-index={index}
          >
            <button
              type="button"
              className="cms-list__open"
              data-testid={`entry-open-${entry.key}`}
              aria-current={selected ? 'page' : undefined}
              title={`Edit “${entry.title}”`}
              onClick={() => store.openEntry(section.id, entry.key)}
            >
              {showThumb && (
                <span className={`cms-list__thumb${thumb === null ? ' cms-list__thumb--empty' : ''}`}>
                  {thumb === null ? (
                    <span aria-hidden="true">▫</span>
                  ) : (
                    <img src={resolveMediaSrc(thumb)} alt="" loading="lazy" />
                  )}
                </span>
              )}
              <span className="cms-list__text">
                <span className="cms-list__title">{entry.title}</span>
                <span className="cms-list__meta">
                  {entry.date !== undefined && <span data-testid={`entry-date-${entry.key}`}>{entry.date}</span>}
                  {entry.subtitle !== undefined && entry.subtitle !== '' && (
                    <span data-testid={`entry-subtitle-${entry.key}`}>{entry.subtitle}</span>
                  )}
                  {entry.hasDraft && !entry.hasPublished && (
                    <span
                      className="cms-list__badge cms-list__badge--new"
                      data-testid={`entry-badge-${entry.key}`}
                      title="Saved as a draft, never published"
                    >
                      new
                    </span>
                  )}
                  {entry.hasDraft && entry.hasPublished && (
                    <span
                      className="cms-list__badge"
                      data-testid={`entry-badge-${entry.key}`}
                      title="Unpublished changes"
                    >
                      draft
                    </span>
                  )}
                  {entry.invalid === true && (
                    <span className="cms-list__badge cms-list__badge--invalid" title="The file does not validate">
                      invalid
                    </span>
                  )}
                </span>
              </span>
            </button>

            <span className="cms-list__actions">
              {can.reorder && (
                <>
                  <button
                    type="button"
                    className="cms-btn cms-btn--quiet cms-btn--micro"
                    data-testid={`entry-up-${entry.key}`}
                    aria-label={`Move “${entry.title}” up`}
                    title="Move up"
                    disabled={index === 0}
                    onClick={() => store.moveEntry(section.id, entry.key, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="cms-btn cms-btn--quiet cms-btn--micro"
                    data-testid={`entry-down-${entry.key}`}
                    aria-label={`Move “${entry.title}” down`}
                    title="Move down"
                    disabled={index === entries.length - 1}
                    onClick={() => store.moveEntry(section.id, entry.key, 1)}
                  >
                    ↓
                  </button>
                </>
              )}
              {can.duplicate && (
                <button
                  type="button"
                  className="cms-btn cms-btn--quiet cms-btn--micro"
                  data-testid={`entry-duplicate-${entry.key}`}
                  aria-label={`Duplicate “${entry.title}”`}
                  title={`Duplicate this ${noun}`}
                  onClick={() => void store.duplicateEntry(section.id, entry.key)}
                >
                  ⧉
                </button>
              )}
              <button
                type="button"
                className="cms-btn cms-btn--quiet cms-btn--micro cms-btn--danger"
                data-testid={`entry-delete-${entry.key}`}
                aria-label={`Delete “${entry.title}”`}
                disabled={!can.delete}
                title={can.delete ? `Delete this ${noun}` : can.deleteReason}
                onClick={() => {
                  // A record delete is one undoable edit to the collection and
                  // the status line offers Undo, so it does not interrogate.
                  // Deleting a page is a commit that removes a file.
                  if (!isRecordSection(section) && !ask(`Delete “${entry.title}”? This cannot be undone here.`)) {
                    return;
                  }
                  void store.deleteEntry(section.id, entry.key);
                }}
              >
                ✕
              </button>
            </span>
          </div>
        );
      })}

      <div className="cms-list__bar">
        <button
          type="button"
          className="cms-btn cms-btn--tiny"
          data-testid="entry-create"
          disabled={!can.create}
          title={
            isRecordSection(section)
              ? `Add a ${noun} to this collection. Save writes the whole file.`
              : `Create a ${noun} as a draft`
          }
          onClick={() => void store.createEntry(section.id)}
        >
          + New {noun}
        </button>
        <span style={{ marginLeft: 'auto', color: 'var(--cms-muted)', fontSize: 10.5 }}>
          {entries.length} {entries.length === 1 ? noun : `${noun}s`}
        </span>
      </div>
    </div>
  );
}
