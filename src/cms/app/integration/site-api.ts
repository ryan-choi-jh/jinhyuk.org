/**
 * src/cms/app/integration/site-api.ts
 *
 * WS-G INTEGRATION. WS-D's `SiteApi` implemented over WS-C's HTTP client, for
 * all five sections. The phase 2 twin of `./api.ts`, which does the same job
 * for phase 1's one-page `CmsApi`.
 *
 * `./api.ts` is NOT replaced and NOT edited: `documentApiFor(siteApi, section)`
 * (WS-D) already turns this object back into a `CmsApi` for the document
 * store, so there is one translation layer in the application, not two. The
 * phase 1 adapter stays for the phase 1 route and its e2e harness.
 *
 * Four things to translate, three of them the same three as phase 1.
 *
 * 1. SHAPE. WS-C's client answers with a bit more than WS-D's interface wants
 *    (shas, the published title, where an upload's dimensions came from). The
 *    extra is kept here and read back through `shasFor`, `lastStatus` and
 *    `uploadDetailed`.
 *
 * 2. ERRORS. Everything thrown out of here is phase 1's `CmsWriteError`, a
 *    subclass of WS-3's `CmsApiError`, so `apiErrorMessage()` shows the
 *    server's sentence verbatim and `.isConflict` / `.isSignedOut` survive.
 *
 * 3. CONCURRENCY. Writes carry a blob-sha expectation. The bookkeeping cannot
 *    live in WS-D's store, which has no idea shas exist, so it lives here —
 *    one entry per (section, key), where the key is '' for a singleton and for
 *    a record collection, because those have no slug on the wire.
 *
 * 4. STORAGE. `deleteDraft(section, null)` and `publish(section, null)` mean
 *    two different endpoints depending on the section: a document's draft, or
 *    a record collection's. WS-D's record store calls exactly those two with
 *    `null`, so the branch is here, on `section.storage` from WS-A's registry,
 *    and never on a section name.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS AN XHR IN HERE
 * ---------------------------------------------------------------------------
 *
 * WS-E's `UploadMedia` takes `{ onProgress, signal }` and WS-E's album editor
 * draws a determinate progress bar per file and aborts in-flight uploads when
 * it unmounts. `fetch` cannot report upload progress, so `uploadDetailed`
 * posts the multipart body with `XMLHttpRequest` when either option is asked
 * for, and falls back to WS-C's client otherwise. The response parsing and the
 * error translation are the same in both paths.
 */

import { CmsApiError } from '../state/api.ts';
import type {
  AuthStatus,
  CommitResult,
  MediaUploadResult,
  OkResult,
  PageDocs,
} from '../state/api.ts';
import type { EntrySummary, RecordDocs, SectionSummary, SiteApi } from '../state/site-api.ts';
import type { Doc, RecordFile, SectionId } from '../../schema.ts';
import { getSection, requireSection } from '../../sections.ts';
import { createCmsClient, CmsApiError as WireError } from '../../server/client.ts';
import type {
  AuthStatus as WireAuthStatus,
  CmsClient,
  ConflictInfo,
  MediaUpload,
  ShaExpectation,
} from '../../server/client.ts';
import { CmsWriteError } from './api.ts';

/* -------------------------------------------------------------------------- */
/* Sha bookkeeping                                                             */
/* -------------------------------------------------------------------------- */

export type EntryShas = {
  /** Blob sha of the draft file, or null when there is none. */
  draftSha: string | null;
  /** Blob sha of the published file, or null when there is none. */
  publishedSha: string | null;
};

/**
 * One entry's identity in the sha map. A singleton and a record collection
 * both have no key on the wire, so both are '' — the same thing the URL does
 * by having one segment instead of two.
 */
function shaKey(section: SectionId, key: string | null): string {
  return `${section}\u0000${key ?? ''}`;
}

/* -------------------------------------------------------------------------- */
/* Upload options                                                              */
/* -------------------------------------------------------------------------- */

/** WS-E's `UploadOptions`, restated so this file does not import from records/. */
export type SiteUploadOptions = {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
};

/* -------------------------------------------------------------------------- */
/* The adapter                                                                 */
/* -------------------------------------------------------------------------- */

export type SiteApiAdapter = SiteApi & {
  /** WS-C's client, for the calls richer than WS-D's interface. */
  readonly client: CmsClient;
  loginUrl(returnTo?: string): string;
  signOut(): Promise<void>;
  /** The last answer from /auth/status, including repo and branch. */
  lastStatus(): WireAuthStatus | null;
  /** Undefined until this entry has been read, which is what makes `undefined` mean "no expectation". */
  shasFor(section: SectionId, key: string | null): EntryShas | undefined;
  /** Seed or correct the bookkeeping, e.g. from what a route read server side. */
  noteShas(section: SectionId, key: string | null, shas: Partial<EntryShas>): void;
  /** Forget an entry, so the next write sends no expectation at all. */
  forgetShas(section: SectionId, key: string | null): void;
  /**
   * Upload and keep everything WS-C returned, not just src/w/h, with
   * per-file progress and cancellation. This is what WS-E's editors are
   * handed; `uploadMedia` below is the narrower thing WS-D's interface asks
   * for and is implemented on top of it.
   */
  uploadDetailed(
    section: SectionId,
    key: string | null,
    file: Blob,
    filename?: string,
    options?: SiteUploadOptions,
  ): Promise<MediaUpload>;
};

export type SiteApiAdapterOptions = {
  /** Inject a client (tests). Otherwise one is built from baseUrl/fetch. */
  client?: CmsClient;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Seeded sha bookkeeping: `{ 'essays/my-essay': {...}, home: {...} }`. */
  initial?: Readonly<Record<string, Partial<EntryShas>>>;
  /** The session went away; the argument is where to send the browser. */
  onSignedOut?: (loginUrl: string) => void;
  /** A write was refused because the repo moved on under us. */
  onConflict?: (conflict: ConflictInfo, message: string) => void;
  /** Where to come back to after signing in. Defaults to the current path. */
  returnTo?: () => string | undefined;
};

export function createSiteApi(options: SiteApiAdapterOptions = {}): SiteApiAdapter {
  const base = (options.baseUrl ?? '').replace(/\/$/, '');
  const client =
    options.client ??
    createCmsClient({
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });

  const shas = new Map<string, EntryShas>();
  for (const [raw, seed] of Object.entries(options.initial ?? {})) {
    const slash = raw.indexOf('/');
    const section = (slash < 0 ? raw : raw.slice(0, slash)) as SectionId;
    const key = slash < 0 ? null : raw.slice(slash + 1);
    shas.set(shaKey(section, key), {
      draftSha: seed.draftSha ?? null,
      publishedSha: seed.publishedSha ?? null,
    });
  }

  let status: WireAuthStatus | null = null;

  const currentPath = (): string | undefined => {
    const asked = options.returnTo?.();
    if (asked !== undefined) return asked;
    if (typeof location === 'undefined') return undefined;
    return `${location.pathname}${location.search}`;
  };

  const loginUrl = (returnTo?: string): string => client.loginUrl(returnTo ?? currentPath());

  function note(section: SectionId, key: string | null, patch: Partial<EntryShas>): void {
    const id = shaKey(section, key);
    const current = shas.get(id) ?? { draftSha: null, publishedSha: null };
    shas.set(id, {
      draftSha: patch.draftSha === undefined ? current.draftSha : patch.draftSha,
      publishedSha: patch.publishedSha === undefined ? current.publishedSha : patch.publishedSha,
    });
  }

  function expectDraft(section: SectionId, key: string | null): ShaExpectation {
    const known = shas.get(shaKey(section, key));
    return known === undefined ? undefined : known.draftSha;
  }

  function expectPublished(section: SectionId, key: string | null): ShaExpectation {
    const known = shas.get(shaKey(section, key));
    return known === undefined ? undefined : known.publishedSha;
  }

  /** Translate, report, rethrow. Never returns. */
  function rethrow(error: unknown): never {
    if (error instanceof WireError) {
      if (error.status === 401) options.onSignedOut?.(loginUrl());
      if (error.status === 409 && error.conflict !== undefined) {
        options.onConflict?.(error.conflict, error.message);
      }
      throw new CmsWriteError(error.message, {
        status: error.status,
        ...(error.code === undefined ? {} : { code: error.code }),
        ...(error.conflict === undefined ? {} : { conflict: error.conflict }),
      });
    }
    if (error instanceof CmsApiError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new CmsWriteError(
      `Could not reach the CMS API (${detail}). Check the connection and try again.`,
    );
  }

  async function guarded<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      return rethrow(error);
    }
  }

  /** True when this section's content is one record file rather than per-entry documents. */
  function holdsRecords(section: SectionId): boolean {
    return getSection(section)?.storage === 'records';
  }

  /* ---------------------------------------------------------------------- */
  /* Upload, with progress and cancellation                                  */
  /* ---------------------------------------------------------------------- */

  const mediaUrl = (section: SectionId, key: string | null): string => {
    const path = `/api/cms/media/${encodeURIComponent(section)}`;
    return `${base}${key === null || key === '' ? path : `${path}/${encodeURIComponent(key)}`}`;
  };

  function filenameOf(file: Blob, filename?: string): string {
    if (filename !== undefined && filename !== '') return filename;
    const named = file as unknown as { name?: unknown };
    return typeof named.name === 'string' && named.name !== '' ? named.name : 'upload.png';
  }

  /**
   * The same POST WS-C's client makes, over XHR so the bytes going out can be
   * counted and the request can be aborted. Rejects with the same
   * `CmsWriteError` the fetch path does, built from the same `{ error, code }`
   * body, so a caller cannot tell which path it took except by the progress.
   */
  function xhrUpload(
    section: SectionId,
    key: string | null,
    file: Blob,
    filename: string,
    options2: SiteUploadOptions,
  ): Promise<MediaUpload> {
    return new Promise<MediaUpload>((resolve, reject) => {
      const signal = options2.signal;
      if (signal?.aborted === true) {
        reject(new CmsWriteError('Upload cancelled.', { code: 'aborted' }));
        return;
      }

      const form = new FormData();
      form.set('file', file, filename);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', mediaUrl(section, key), true);
      xhr.withCredentials = true;

      const onAbort = (): void => xhr.abort();
      if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
      const done = (): void => {
        if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      };

      if (options2.onProgress !== undefined) {
        xhr.upload.addEventListener('progress', (event) => {
          if (!event.lengthComputable || event.total === 0) return;
          options2.onProgress?.(Math.min(1, event.loaded / event.total));
        });
        // The bytes are out; what is left is the server committing to GitHub,
        // which has no progress to report. Showing 100% during that wait is a
        // lie, so the bar is pinned just short of full until the response.
        xhr.upload.addEventListener('load', () => options2.onProgress?.(0.98));
      }

      xhr.addEventListener('abort', () => {
        done();
        reject(new CmsWriteError('Upload cancelled.', { code: 'aborted' }));
      });
      xhr.addEventListener('error', () => {
        done();
        reject(
          new CmsWriteError(
            'Could not reach the CMS API while uploading. Check the connection and try again.',
          ),
        );
      });
      xhr.addEventListener('load', () => {
        done();
        let body: Record<string, unknown> = {};
        if (xhr.responseText !== '') {
          try {
            body = JSON.parse(xhr.responseText) as Record<string, unknown>;
          } catch {
            reject(
              new CmsWriteError(`The server did not answer with JSON (${xhr.status}).`, {
                status: xhr.status,
              }),
            );
            return;
          }
        }
        if (xhr.status < 200 || xhr.status >= 300 || body.ok !== true) {
          const message =
            typeof body.error === 'string' ? body.error : `Upload failed with ${xhr.status}.`;
          if (xhr.status === 401) options.onSignedOut?.(loginUrl());
          reject(
            new CmsWriteError(message, {
              status: xhr.status,
              ...(typeof body.code === 'string' ? { code: body.code } : {}),
            }),
          );
          return;
        }
        options2.onProgress?.(1);
        resolve(body as unknown as MediaUpload);
      });

      xhr.send(form);
    });
  }

  function uploadDetailed(
    section: SectionId,
    key: string | null,
    file: Blob,
    filename?: string,
    options2: SiteUploadOptions = {},
  ): Promise<MediaUpload> {
    const name = filenameOf(file, filename);
    const wantsXhr =
      (options2.onProgress !== undefined || options2.signal !== undefined) &&
      typeof XMLHttpRequest !== 'undefined';
    if (wantsXhr) {
      // Already translated; no `guarded` wrapper, or a CmsWriteError would be
      // caught and rewrapped as a network failure.
      return xhrUpload(section, key, file, name, options2);
    }
    return guarded(() => client.uploadSectionMedia(section, key, file, name));
  }

  /* ---------------------------------------------------------------------- */
  /* docs/cms-contracts.md 11, in the order of WS-D's interface              */
  /* ---------------------------------------------------------------------- */

  const adapter: SiteApiAdapter = {
    client,
    loginUrl,

    signOut() {
      return guarded(async () => {
        await client.signOut();
        status = null;
      });
    },

    lastStatus() {
      return status;
    },

    shasFor(section, key) {
      const known = shas.get(shaKey(section, key));
      return known === undefined ? undefined : { ...known };
    },

    noteShas(section, key, patch) {
      note(section, key, patch);
    },

    forgetShas(section, key) {
      shas.delete(shaKey(section, key));
    },

    uploadDetailed,

    listSections(): Promise<SectionSummary[]> {
      return guarded(async () => {
        const rows = await client.listSections();
        return rows.map((row) => ({
          id: row.id,
          label: row.label,
          shape: row.shape,
          storage: row.storage,
          count: row.count,
          hasDraft: row.hasDraft,
        }));
      });
    },

    listEntries(section: SectionId): Promise<EntrySummary[]> {
      return guarded(async () => {
        const rows = await client.listEntries(section);
        return rows.map((row) => {
          // `date` is WS-D's additive field; WS-C does not promise it, so it
          // is copied through when the server sends it and simply absent
          // otherwise, which is what WS-D's type says.
          const extra = row as unknown as { date?: unknown };
          return {
            key: row.key,
            title: row.title,
            ...(row.subtitle === undefined ? {} : { subtitle: row.subtitle }),
            ...(row.thumb === undefined ? {} : { thumb: row.thumb }),
            hasDraft: row.hasDraft,
            hasPublished: row.hasPublished,
            ...(row.invalid === undefined ? {} : { invalid: row.invalid }),
            ...(typeof extra.date === 'string' ? { date: extra.date } : {}),
          };
        });
      });
    },

    getEntry(section: SectionId, slug: string | null): Promise<PageDocs> {
      return guarded(async () => {
        const snapshot = await client.readEntry(section, slug);
        note(section, slug, {
          draftSha: snapshot.draftSha,
          publishedSha: snapshot.publishedSha,
        });
        // A file that exists but does not validate comes back as a null doc
        // plus a reason. Showing the other version silently would be a trap:
        // the author would edit the published page and save over a draft they
        // never saw. So it is an error, with WS-C's sentence in it.
        const broken = snapshot.draftError ?? snapshot.publishedError;
        if (broken !== undefined && snapshot.draft === null && snapshot.published === null) {
          throw new CmsWriteError(broken, { status: 422, code: 'invalid_doc' });
        }
        return { published: snapshot.published, draft: snapshot.draft };
      });
    },

    putDraft(section: SectionId, slug: string | null, doc: Doc): Promise<CommitResult> {
      return guarded(async () => {
        const ack = await client.saveEntryDraft(section, slug, doc, expectDraft(section, slug));
        note(section, slug, { draftSha: ack.sha });
        return { ok: true, commit: ack.commit };
      });
    },

    deleteDraft(section: SectionId, slug: string | null): Promise<OkResult> {
      return guarded(async () => {
        if (holdsRecords(section)) {
          await client.discardRecords(section, expectDraft(section, null));
          note(section, null, { draftSha: null });
          return { ok: true };
        }
        await client.deleteEntryDraft(section, slug, expectDraft(section, slug));
        note(section, slug, { draftSha: null });
        return { ok: true };
      });
    },

    publish(section: SectionId, slug: string | null): Promise<CommitResult> {
      return guarded(async () => {
        if (holdsRecords(section)) {
          const ack = await client.publishRecords(section, expectPublished(section, null));
          // Publish copies the draft over the published file and deletes the
          // draft in one commit (docs/cms-rebuild.md 2.3).
          note(section, null, { publishedSha: ack.sha, draftSha: null });
          return { ok: true, commit: ack.commit };
        }
        const ack = await client.publishEntry(section, slug, expectPublished(section, slug));
        note(section, slug, { publishedSha: ack.sha, draftSha: null });
        return { ok: true, commit: ack.commit };
      });
    },

    getRecords(section: SectionId): Promise<RecordDocs> {
      return guarded(async () => {
        const snapshot = await client.readRecords(section);
        note(section, null, {
          draftSha: snapshot.draftSha,
          publishedSha: snapshot.publishedSha,
        });
        const broken = snapshot.draftError ?? snapshot.publishedError;
        if (broken !== undefined && snapshot.draft === null && snapshot.published === null) {
          throw new CmsWriteError(broken, { status: 422, code: 'invalid_records' });
        }
        return { published: snapshot.published, draft: snapshot.draft };
      });
    },

    putRecords(section: SectionId, file: RecordFile): Promise<CommitResult> {
      return guarded(async () => {
        const ack = await client.saveRecords(section, file, expectDraft(section, null));
        note(section, null, { draftSha: ack.sha });
        return { ok: true, commit: ack.commit };
      });
    },

    uploadMedia(section: SectionId, slug: string | null, file: File): Promise<MediaUploadResult> {
      return guarded(async () => {
        const upload = await uploadDetailed(section, slug, file, file.name);
        return { ok: true, src: upload.src, w: upload.w, h: upload.h };
      });
    },

    authStatus(): Promise<AuthStatus> {
      return guarded(async () => {
        status = await client.status();
        return status;
      });
    },

    // deleteEntry is deliberately absent: docs/cms-contracts.md 11 has no
    // endpoint for removing a published entry, and WS-C confirms none exists.
    // WS-D disables Delete with a reason when it is missing, which is the
    // honest state of the API rather than a button that 404s.
  };

  return adapter;
}

/* -------------------------------------------------------------------------- */
/* Media keys                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The `:slug` an upload for this entry belongs under
 * (docs/cms-contracts.md 9.3). Thin wrapper over the registry so a call site
 * does not have to narrow a `SectionId` to a `SectionDef` first.
 */
export function uploadKeyFor(section: SectionId, entryKey: string | null): string | null {
  return requireSection(section).shape === 'singleton' ? null : entryKey;
}
