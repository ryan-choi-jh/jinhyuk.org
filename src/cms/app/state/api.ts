/**
 * src/cms/app/state/api.ts
 *
 * WS-3. The `CmsApi` interface: one method per row of docs/cms-rebuild.md 3.5
 * (restated in docs/cms-contracts.md section 3). The editor shell talks to
 * this interface and to nothing else, so WS-8 can swap WS-3's stub
 * (`./stub-api.ts`) for WS-2's real HTTP client without touching a shell file.
 *
 * Nothing here imports from `src/cms/server/`. Deliberately: this file is the
 * boundary.
 *
 * Error convention, which mirrors the wire format in 3.5. Every response is
 * either `{ ok: true, ... }` or `{ error: string }` with a non-200 status.
 * A method RESOLVES with the success payload and REJECTS with a `CmsApiError`
 * carrying that `error` string. Callers never see a `{ ok: false }` object, so
 * there is one failure path, not two.
 */

import type { Doc } from '../../schema.ts';

/* -------------------------------------------------------------------------- */
/* Payloads                                                                    */
/* -------------------------------------------------------------------------- */

/** One row of `GET /api/cms/pages`. */
export type PageSummary = {
  slug: string;
  title: string;
  hasDraft: boolean;
};

/** `GET /api/cms/page/:slug`. Both may be null: no draft, or no such page yet. */
export type PageDocs = {
  published: Doc | null;
  draft: Doc | null;
};

/** `PUT /api/cms/draft/:slug` and `POST /api/cms/publish/:slug`. */
export type CommitResult = {
  ok: true;
  /** Commit sha the write landed as. */
  commit: string;
};

/** `DELETE /api/cms/draft/:slug`. */
export type OkResult = {
  ok: true;
};

/**
 * `POST /api/cms/media/:slug`. `w` and `h` are the intrinsic pixel dimensions,
 * which 3.5 requires so the editor can place an image at a sane size without
 * waiting for a load.
 */
export type MediaUploadResult = {
  ok: true;
  /** Site-absolute, `/media/<slug>/<file>`. */
  src: string;
  w: number;
  h: number;
};

/** `GET /api/cms/auth/status`. */
export type AuthStatus = {
  signedIn: boolean;
  login?: string;
};

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What every `CmsApi` method rejects with. `message` is the server's `error`
 * string verbatim, so it is safe to show in the UI.
 */
export class CmsApiError extends Error {
  /** HTTP status, when the failure came from a response. */
  readonly status: number | undefined;
  /** `formatIssues()` output when the failure was document validation. */
  readonly issues: string | undefined;

  constructor(message: string, options: { status?: number; issues?: string } = {}) {
    super(message);
    this.name = 'CmsApiError';
    this.status = options.status;
    this.issues = options.issues;
  }
}

/** Narrow an unknown rejection to a message safe to display. */
export function apiErrorMessage(error: unknown): string {
  if (error instanceof CmsApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/* -------------------------------------------------------------------------- */
/* The interface                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The seven endpoints of 3.5, in the same order as the table.
 *
 * | Method | Path                        | This method                    |
 * |--------|-----------------------------|--------------------------------|
 * | GET    | `/api/cms/pages`            | `listPages()`                  |
 * | GET    | `/api/cms/page/:slug`       | `getPage(slug)`                |
 * | PUT    | `/api/cms/draft/:slug`      | `putDraft(slug, doc)`          |
 * | POST   | `/api/cms/publish/:slug`    | `publish(slug)`                |
 * | DELETE | `/api/cms/draft/:slug`      | `deleteDraft(slug)`            |
 * | POST   | `/api/cms/media/:slug`      | `uploadMedia(slug, file)`      |
 * | GET    | `/api/cms/auth/status`      | `authStatus()`                 |
 */
export interface CmsApi {
  /** GET `/api/cms/pages` -> `{ pages }`. Resolves with the `pages` array itself. */
  listPages(): Promise<PageSummary[]>;

  /** GET `/api/cms/page/:slug`. */
  getPage(slug: string): Promise<PageDocs>;

  /**
   * PUT `/api/cms/draft/:slug`, body is the whole `Doc`. Writes the working
   * copy only; per docs/cms-rebuild.md 2.3 the live site never builds from it.
   */
  putDraft(slug: string, doc: Doc): Promise<CommitResult>;

  /** POST `/api/cms/publish/:slug`. Copies draft over published and deletes the draft. */
  publish(slug: string): Promise<CommitResult>;

  /** DELETE `/api/cms/draft/:slug`. Throws the draft away; published is untouched. */
  deleteDraft(slug: string): Promise<OkResult>;

  /** POST `/api/cms/media/:slug`, multipart field `file`. */
  uploadMedia(slug: string, file: File): Promise<MediaUploadResult>;

  /** GET `/api/cms/auth/status`. */
  authStatus(): Promise<AuthStatus>;
}
