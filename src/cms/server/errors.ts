/**
 * src/cms/server/errors.ts
 *
 * WS-2. One error vocabulary for the whole server side, so that every route
 * can turn a failure into the right status code without knowing where the
 * failure came from.
 *
 * The contract (docs/cms-contracts.md 3) is that a failure is
 * `{ error: string }` with a non-200 status. The `error` string is read by a
 * human sitting in the editor, so it says what happened and what to do, not
 * just which layer broke.
 */

/** Anything thrown deliberately by this module carries a status. */
export class ApiError extends Error {
  readonly status: number;
  /** Optional machine-readable tag, for a client that wants to branch. */
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** 400. The request was wrong. */
export function badRequest(message: string, code?: string): ApiError {
  return new ApiError(400, message, code);
}

/** 401. No usable GitHub session. */
export function unauthorized(
  message = 'Not signed in. Open /api/cms/auth/login to connect GitHub.',
): ApiError {
  return new ApiError(401, message, 'not_signed_in');
}

/** 403. Signed in, but not as the one person this CMS is for. */
export function forbidden(message: string): ApiError {
  return new ApiError(403, message, 'forbidden');
}

/** 404. */
export function notFound(message: string): ApiError {
  return new ApiError(404, message, 'not_found');
}

/** 405. */
export function methodNotAllowed(allowed: string[]): ApiError {
  return new ApiError(405, `Method not allowed. Use ${allowed.join(' or ')}.`, 'method');
}

/** 413. */
export function payloadTooLarge(message: string): ApiError {
  return new ApiError(413, message, 'too_large');
}

/**
 * 409. The file moved underneath us. This is the one error the editor must
 * handle rather than just display, so it carries the shas that disagreed.
 */
export class ConflictError extends ApiError {
  readonly path: string;
  readonly expectedSha: string | null;
  readonly actualSha: string | null;

  constructor(options: {
    path: string;
    expectedSha: string | null;
    actualSha: string | null;
    message: string;
  }) {
    super(409, options.message, 'conflict');
    this.name = 'ConflictError';
    this.path = options.path;
    this.expectedSha = options.expectedSha;
    this.actualSha = options.actualSha;
  }
}

/** A failure reported by the GitHub API itself. */
export class GitHubError extends ApiError {
  readonly githubStatus: number;
  readonly detail: string;

  constructor(githubStatus: number, where: string, detail: string) {
    // A GitHub 401/403 means our token is finished, which to our own caller is
    // an authentication problem, not a server fault. Everything else that is
    // GitHub's fault is reported as 502: this server is fine, its dependency
    // is not.
    const status =
      githubStatus === 401 || githubStatus === 403
        ? 401
        : githubStatus === 404
          ? 404
          : githubStatus >= 500
            ? 502
            : 502;
    super(status, `GitHub ${where} failed (${githubStatus}): ${truncate(detail, 400)}`, 'github');
    this.name = 'GitHubError';
    this.githubStatus = githubStatus;
    this.detail = detail;
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The status any thrown value should become. Unknown throws are 500. */
export function statusOf(error: unknown): number {
  return error instanceof ApiError ? error.status : 500;
}

/** The message any thrown value should become. */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
