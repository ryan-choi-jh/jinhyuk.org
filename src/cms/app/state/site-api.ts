/**
 * src/cms/app/state/site-api.ts
 *
 * WS-D. The section-aware API the navigation shell talks to: one method per
 * row of docs/cms-contracts.md section 11, in the same order as the table.
 *
 * Phase 1's `CmsApi` (./api.ts) is one page deep: every method takes a slug
 * and nothing else. Phase 2's endpoints are all `:section[/:slug]`, so this
 * interface replaces it at the shell's edge — and `documentApiFor()` turns a
 * `SiteApi` plus one section back into a `CmsApi`, which is what lets the
 * phase 1 document store, its undo stack and its save/publish path run
 * unchanged under the new navigation. Nothing in `./store.ts` is edited.
 *
 * Nothing here imports from `src/cms/server/`. Deliberately, same as ./api.ts:
 * this file is the boundary. WS-C implements the HTTP side; WS-G hands an
 * implementation in. `./site-stub-api.ts` is the in-memory one the harness
 * uses, so the shell is driveable with no server.
 *
 * Error convention is unchanged: resolve with the success payload, reject with
 * a `CmsApiError` carrying the server's `error` string verbatim.
 */

import type { Doc, RecordFile, SectionId } from '../../schema.ts';
import type { SectionDef, SectionShape, SectionStorage } from '../../sections.ts';
import { isRecordSection } from '../../sections.ts';
import type {
  AuthStatus,
  CmsApi,
  CommitResult,
  MediaUploadResult,
  OkResult,
  PageDocs,
  PageSummary,
} from './api.ts';

/* -------------------------------------------------------------------------- */
/* Payloads                                                                    */
/* -------------------------------------------------------------------------- */

/** One row of `GET /api/cms/sections`. */
export type SectionSummary = {
  id: SectionId;
  label: string;
  shape: SectionShape;
  storage: SectionStorage;
  /** Entries in the section. 1 for a singleton. */
  count: number;
  /** Any draft anywhere in the section. */
  hasDraft: boolean;
};

/**
 * One row of `GET /api/cms/entries/:section`.
 *
 * `date` is the one field this type has that docs/cms-contracts.md 11 does not
 * list. It is optional and additive: the entry list shows a document's date
 * beside its title (that is WS-D's brief), the server already reads
 * `meta.title` out of the same document to fill `title`, and when it is absent
 * the row simply has no date. Reported as a deviation rather than assumed.
 */
export type EntrySummary = {
  /** The slug, or a film's record id. What `cmsEntryUrl` is filled with. */
  key: string;
  title: string;
  /** Records only (`RecordSummary.subtitle`): 'SHORT FILM · 2019'. */
  subtitle?: string;
  thumb?: string | null;
  hasDraft: boolean;
  hasPublished: boolean;
  /** The file on disk does not validate. The row is shown, and opening it will fail. */
  invalid?: boolean;
  /** `Doc.meta.date`, for document sections. See above. */
  date?: string;
};

/** `GET /api/cms/records/:section`. Both null means there is no file yet. */
export type RecordDocs = {
  published: RecordFile | null;
  draft: RecordFile | null;
};

/* -------------------------------------------------------------------------- */
/* The interface                                                               */
/* -------------------------------------------------------------------------- */

/**
 * docs/cms-contracts.md 11, as a TypeScript interface.
 *
 * | Method | Path                                 | This method                        |
 * |--------|--------------------------------------|------------------------------------|
 * | GET    | `/api/cms/sections`                  | `listSections()`                   |
 * | GET    | `/api/cms/entries/:section`          | `listEntries(section)`             |
 * | GET    | `/api/cms/entry/:section[/:slug]`    | `getEntry(section, slug)`          |
 * | PUT    | `/api/cms/draft/:section[/:slug]`    | `putDraft(section, slug, doc)`     |
 * | DELETE | `/api/cms/draft/:section[/:slug]`    | `deleteDraft(section, slug)`       |
 * | POST   | `/api/cms/publish/:section[/:slug]`  | `publish(section, slug)`           |
 * | GET    | `/api/cms/records/:section`          | `getRecords(section)`              |
 * | PUT    | `/api/cms/records/:section`          | `putRecords(section, file)`        |
 * | POST   | `/api/cms/media/:section[/:slug]`    | `uploadMedia(section, slug, file)` |
 * | GET    | `/api/cms/auth/status`               | `authStatus()`                     |
 *
 * `slug` is `null` for a singleton section and for a record collection, which
 * is what section 11 means by "`:slug` is omitted".
 */
export interface SiteApi {
  listSections(): Promise<SectionSummary[]>;
  listEntries(section: SectionId): Promise<EntrySummary[]>;

  getEntry(section: SectionId, slug: string | null): Promise<PageDocs>;
  putDraft(section: SectionId, slug: string | null, doc: Doc): Promise<CommitResult>;
  deleteDraft(section: SectionId, slug: string | null): Promise<OkResult>;
  publish(section: SectionId, slug: string | null): Promise<CommitResult>;

  /** The whole collection file. One file is one commit; there are no per-record endpoints. */
  getRecords(section: SectionId): Promise<RecordDocs>;
  /** The whole collection file, after adding, editing, deleting or permuting. */
  putRecords(section: SectionId, file: RecordFile): Promise<CommitResult>;

  uploadMedia(section: SectionId, slug: string | null, file: File): Promise<MediaUploadResult>;
  authStatus(): Promise<AuthStatus>;

  /**
   * Delete a published entry of a document collection, not just its draft.
   *
   * OPTIONAL, and the only optional method here, because section 11's table
   * has no endpoint for it: `DELETE /api/cms/draft/...` throws the draft away
   * and leaves the published page. WS-D's brief asks for Delete in the entry
   * list, so the shell offers it when this exists and disables the button with
   * a reason when it does not. Reported in contractDeviations.
   */
  deleteEntry?(section: SectionId, slug: string): Promise<OkResult>;
}

/** True when this API can delete a published document entry, not only a draft. */
export function canDeleteEntry(api: SiteApi): boolean {
  return typeof api.deleteEntry === 'function';
}

/* -------------------------------------------------------------------------- */
/* Media slugs                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The `:slug` an upload for this entry belongs under, per
 * docs/cms-contracts.md 9.3:
 *
 *   home                 null                 public/media/home/
 *   projects, essays     the page slug        public/media/projects/<slug>/
 *   filmography          the film record id   public/media/filmography/<id>/
 *   photography          the album slug       public/media/photography/<slug>/
 *
 * A record section's entry key already *is* the right value — a film's key is
 * its record id and an album's key is its slug (`RecordsDef.slugField`) — so
 * this is one rule and not five.
 */
export function mediaSlugFor(section: SectionDef, entryKey: string | null): string | null {
  if (section.shape === 'singleton') return null;
  return entryKey;
}

/* -------------------------------------------------------------------------- */
/* The document adapter                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A `SiteApi` plus one document section, as phase 1's `CmsApi`.
 *
 * This is the whole reason `src/cms/app/state/store.ts` did not have to
 * change. The document store calls `putDraft(slug, doc)`; the adapter turns
 * that slug into `(section, slug)`, and into `(section, null)` for the
 * singleton, where the store's slug is `doc.meta.slug` ('home') and the API
 * wants nothing.
 *
 * `listPages()` answers from `listEntries(section)` so WS-G's existing page
 * switcher keeps working inside one section.
 */
export function documentApiFor(api: SiteApi, section: SectionDef): CmsApi {
  if (isRecordSection(section)) {
    throw new TypeError(
      `section "${section.id}" holds records; it has no document API. ` +
        'Use recordStore / getRecords instead.',
    );
  }

  /** A singleton has no slug on the wire, whatever the document's meta says. */
  const wire = (slug: string): string | null => (section.shape === 'singleton' ? null : slug);

  return {
    async listPages(): Promise<PageSummary[]> {
      const entries = await api.listEntries(section.id);
      return entries.map((entry) => ({
        slug: entry.key,
        title: entry.title,
        hasDraft: entry.hasDraft,
      }));
    },

    getPage(slug: string): Promise<PageDocs> {
      return api.getEntry(section.id, wire(slug));
    },

    putDraft(slug: string, doc: Doc): Promise<CommitResult> {
      return api.putDraft(section.id, wire(slug), doc);
    },

    publish(slug: string): Promise<CommitResult> {
      return api.publish(section.id, wire(slug));
    },

    deleteDraft(slug: string): Promise<OkResult> {
      return api.deleteDraft(section.id, wire(slug));
    },

    uploadMedia(slug: string, file: File): Promise<MediaUploadResult> {
      return api.uploadMedia(section.id, mediaSlugFor(section, wire(slug)), file);
    },

    authStatus(): Promise<AuthStatus> {
      return api.authStatus();
    },
  };
}

