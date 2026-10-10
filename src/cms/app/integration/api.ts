/**
 * src/cms/app/integration/api.ts
 *
 * WS-8. WS-3's `CmsApi` implemented over WS-2's HTTP client, replacing the
 * in-memory stub. Nothing in src/cms/app/shell/ or src/cms/app/state/ changes;
 * the whole swap is which object gets handed to `createDocStore`.
 *
 * It is a translation layer, and there are exactly three things to translate.
 *
 * 1. SHAPE. WS-3's interface answers with the useful half of each payload
 *    (`PageDocs`, `CommitResult`); WS-2's client answers with a bit more
 *    (shas, the published title, where an upload's dimensions came from). The
 *    extra is kept here rather than thrown away, and read back through
 *    `shasFor`, `lastStatus` and `uploadMediaDetailed`.
 *
 * 2. ERRORS. Two classes share the name `CmsApiError`: WS-3's, which the store
 *    shows verbatim, and WS-2's, which carries `.status`, `.code`, `.conflict`.
 *    Everything thrown out of here is a `CmsWriteError`, a subclass of WS-3's,
 *    so `apiErrorMessage()` keeps working and `instanceof` narrowing keeps the
 *    conflict detail.
 *
 * 3. CONCURRENCY. This is the part worth getting right, and it is why the
 *    adapter is stateful. WS-2's writes take a blob-sha expectation:
 *    `undefined` means "no expectation" (the server still quotes what it
 *    reads), a sha means "this is the version I loaded", `null` means "there
 *    should be nothing there yet". The editor loop is read -> keep the sha ->
 *    write with it -> keep the sha the write returns. That bookkeeping cannot
 *    live in WS-3's store, which has no idea shas exist, so it lives here:
 *    one entry per slug, seeded by `getPage` or by the route that already read
 *    the page server side.
 */

import type {
  AuthStatus,
  CmsApi,
  CommitResult,
  MediaUploadResult,
  OkResult,
  PageDocs,
  PageSummary,
} from '../state/api.ts';
import { CmsApiError } from '../state/api.ts';
import { createCmsClient, CmsApiError as WireError } from '../../server/client.ts';
import type {
  AuthStatus as WireAuthStatus,
  CmsClient,
  ConflictInfo,
  MediaUpload,
  ShaExpectation,
} from '../../server/client.ts';

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What every method of the adapter rejects with. Extends WS-3's error so the
 * store's `apiErrorMessage()` shows the server's sentence unchanged, and adds
 * the two flags the editor acts on differently from "something went wrong".
 */
export class CmsWriteError extends CmsApiError {
  readonly code: string | undefined;
  readonly conflict: ConflictInfo | undefined;
  readonly isConflict: boolean;
  readonly isSignedOut: boolean;

  constructor(
    message: string,
    options: { status?: number; code?: string; conflict?: ConflictInfo } = {},
  ) {
    super(message, { status: options.status });
    this.name = 'CmsWriteError';
    this.code = options.code;
    this.conflict = options.conflict;
    this.isConflict = options.status === 409;
    this.isSignedOut = options.status === 401;
  }
}

/* -------------------------------------------------------------------------- */
/* Sha bookkeeping                                                             */
/* -------------------------------------------------------------------------- */

export type SlugShas = {
  /** Blob sha of src/content/drafts/<slug>.json, or null when there is none. */
  draftSha: string | null;
  /** Blob sha of src/content/pages/<slug>.json, or null when there is none. */
  publishedSha: string | null;
};

export type CmsApiAdapter = CmsApi & {
  /** WS-2's client, for the few calls richer than WS-3's interface. */
  readonly client: CmsClient;
  loginUrl(returnTo?: string): string;
  signOut(): Promise<void>;
  /** Undefined until this slug has been read, which is what makes `undefined` mean "no expectation". */
  shasFor(slug: string): SlugShas | undefined;
  /** Seed or correct the bookkeeping, e.g. from what the route read server side. */
  noteShas(slug: string, shas: Partial<SlugShas>): void;
  /** Forget a slug, so the next write sends no expectation at all. */
  forgetShas(slug: string): void;
  /** The last answer from /auth/status, including repo and branch. */
  lastStatus(): WireAuthStatus | null;
  /** Upload and keep everything WS-2 returned, not just src/w/h. */
  uploadMediaDetailed(slug: string, file: Blob, filename?: string): Promise<MediaUpload>;
};

export type CmsApiAdapterOptions = {
  /** Inject a client (tests). Otherwise one is built from baseUrl/fetch. */
  client?: CmsClient;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Seeded sha bookkeeping, keyed by slug. */
  initial?: Readonly<Record<string, Partial<SlugShas>>>;
  /** The session went away; the argument is where to send the browser. */
  onSignedOut?: (loginUrl: string) => void;
  /** A write was refused because the repo moved on under us. */
  onConflict?: (conflict: ConflictInfo, message: string) => void;
  /** Where to come back to after signing in. Defaults to the current path. */
  returnTo?: () => string | undefined;
};

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export function createCmsApi(options: CmsApiAdapterOptions = {}): CmsApiAdapter {
  const client =
    options.client ??
    createCmsClient({
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });

  const shas = new Map<string, SlugShas>();
  for (const [slug, seed] of Object.entries(options.initial ?? {})) {
    shas.set(slug, { draftSha: seed.draftSha ?? null, publishedSha: seed.publishedSha ?? null });
  }

  let status: WireAuthStatus | null = null;

  const currentPath = (): string | undefined => {
    const asked = options.returnTo?.();
    if (asked !== undefined) return asked;
    if (typeof location === 'undefined') return undefined;
    return `${location.pathname}${location.search}`;
  };

  const loginUrl = (returnTo?: string): string =>
    client.loginUrl(returnTo ?? currentPath());

  function note(slug: string, patch: Partial<SlugShas>): void {
    const current = shas.get(slug) ?? { draftSha: null, publishedSha: null };
    shas.set(slug, {
      draftSha: patch.draftSha === undefined ? current.draftSha : patch.draftSha,
      publishedSha: patch.publishedSha === undefined ? current.publishedSha : patch.publishedSha,
    });
  }

  /**
   * The expectation for a write. `undefined` only when this slug has never
   * been read in this session, because then "nothing is there" would be a
   * guess and a wrong guess is a 409 the author cannot act on.
   */
  function expectDraft(slug: string): ShaExpectation {
    const known = shas.get(slug);
    return known === undefined ? undefined : known.draftSha;
  }

  function expectPublished(slug: string): ShaExpectation {
    const known = shas.get(slug);
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
    // A network failure is a TypeError from fetch with a message like "Failed
    // to fetch", which on its own tells the author nothing.
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

  const adapter: CmsApiAdapter = {
    client,
    loginUrl,

    signOut() {
      return guarded(async () => {
        await client.signOut();
        status = null;
      });
    },

    shasFor(slug) {
      const known = shas.get(slug);
      return known === undefined ? undefined : { ...known };
    },

    noteShas(slug, patch) {
      note(slug, patch);
    },

    forgetShas(slug) {
      shas.delete(slug);
    },

    lastStatus() {
      return status;
    },

    /* ---------------------------------------------------------------- */
    /* The seven endpoints of docs/cms-rebuild.md 3.5                    */
    /* ---------------------------------------------------------------- */

    listPages(): Promise<PageSummary[]> {
      return guarded(async () => {
        const pages = await client.listPages();
        return pages.map((page) => ({
          slug: page.slug,
          title: page.title,
          hasDraft: page.hasDraft,
        }));
      });
    },

    getPage(slug: string): Promise<PageDocs> {
      return guarded(async () => {
        const snapshot = await client.readPage(slug);
        shas.set(slug, {
          draftSha: snapshot.draftSha,
          publishedSha: snapshot.publishedSha,
        });
        // A file that exists but does not validate comes back as a null doc
        // plus a reason. Silently showing the other version would be a trap:
        // the author would edit the published page and save over a draft they
        // never saw. So it is an error, with WS-2's sentence in it.
        const broken = snapshot.draftError ?? snapshot.publishedError;
        if (broken !== undefined && snapshot.draft === null && snapshot.published === null) {
          throw new CmsWriteError(broken, { status: 422, code: 'invalid_doc' });
        }
        return { published: snapshot.published, draft: snapshot.draft };
      });
    },

    putDraft(slug: string, doc): Promise<CommitResult> {
      return guarded(async () => {
        const ack = await client.saveDraft(slug, doc, expectDraft(slug));
        note(slug, { draftSha: ack.sha });
        return { ok: true, commit: ack.commit };
      });
    },

    publish(slug: string): Promise<CommitResult> {
      return guarded(async () => {
        const ack = await client.publish(slug, expectPublished(slug));
        // Publish copies the draft over pages/ and deletes the draft in one
        // commit (2.3), so after it there is no draft and the published blob
        // is the one just written.
        note(slug, { publishedSha: ack.sha, draftSha: null });
        return { ok: true, commit: ack.commit };
      });
    },

    deleteDraft(slug: string): Promise<OkResult> {
      return guarded(async () => {
        await client.deleteDraft(slug, expectDraft(slug));
        note(slug, { draftSha: null });
        return { ok: true };
      });
    },

    uploadMedia(slug: string, file: File): Promise<MediaUploadResult> {
      return guarded(async () => {
        const upload = await client.uploadMedia(slug, file, file.name);
        return { ok: true, src: upload.src, w: upload.w, h: upload.h };
      });
    },

    uploadMediaDetailed(slug, file, filename): Promise<MediaUpload> {
      return guarded(() => client.uploadMedia(slug, file, filename));
    },

    authStatus(): Promise<AuthStatus> {
      return guarded(async () => {
        status = await client.status();
        return status;
      });
    },
  };

  return adapter;
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What to put on the status line for a conflict. WS-2's own message already
 * says what happened in plain words, so this adds only the one thing it cannot
 * know: what the author should do about it here.
 */
export function conflictMessage(serverMessage: string): string {
  return `${serverMessage} Nothing was overwritten. Use “Reload from repo” to take the newer version, then redo the edit.`;
}
