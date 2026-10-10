/**
 * src/cms/server/config.ts
 *
 * WS-2 STORAGE AND API. Every constant and every environment lookup the
 * server side needs, in one place, so nothing is hardcoded twice and no
 * secret is ever hardcoded once.
 *
 * Nothing in here reads a value at module scope that could differ between
 * requests; the lookups are functions so that a deployment can change an
 * environment variable without a rebuild of this module's assumptions.
 */

import {
  CONTENT_ROOT,
  DRAFT_ROOT,
  MEDIA_ROOT,
  MEDIA_URL_ROOT,
  contentPathFor,
  draftPathFor,
  mediaDirFor,
  mediaSrcFor,
  requireSection,
} from '../sections.ts';
import type { SectionDef } from '../sections.ts';

/* -------------------------------------------------------------------------- */
/* Environment                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read an environment variable from whichever of the two environments exists.
 *
 * `process.env` is the real one on Vercel's Node runtime and under bare
 * `node`. `import.meta.env` is Vite's build-time substitution, which is what
 * `astro dev` fills from `.env`. Under bare node `import.meta.env` does not
 * exist at all, hence the cast and the optional chain rather than a direct
 * property read.
 */
export function env(name: string): string | undefined {
  const fromProcess =
    typeof process !== 'undefined' && process.env ? process.env[name] : undefined;
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const fromMeta = meta?.[name];
  if (fromMeta !== undefined && fromMeta !== '') return fromMeta;
  return undefined;
}

/** True only under `astro dev`. Vite replaces this literally at build time. */
export function isDev(): boolean {
  const meta = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  return meta?.DEV === true;
}

/* -------------------------------------------------------------------------- */
/* Repository                                                                  */
/* -------------------------------------------------------------------------- */

export const REPO_OWNER = 'ryan-choi-jh';
export const REPO_NAME = 'jinhyuk.org';
export const REPO = `${REPO_OWNER}/${REPO_NAME}`;

/**
 * The branch the CMS reads and writes. `main`, because that is the branch
 * GitHub Pages builds the live site from (.github/workflows/deploy.yml).
 * Overridable with CMS_BRANCH, which is how a deployment can be pointed at a
 * staging branch without a code change.
 */
export function defaultBranch(): string {
  return env('CMS_BRANCH') ?? 'main';
}

/* -------------------------------------------------------------------------- */
/* Paths (docs/cms-rebuild.md 2.1, 2.3; docs/cms-contracts.md 9.2, 9.3)        */
/* -------------------------------------------------------------------------- */

/**
 * The roots. Re-exported from WS-A's registry rather than restated, so there
 * is exactly one spelling of each in the codebase.
 */
export const PAGES_DIR = `${CONTENT_ROOT}/pages`;
/** Working copies. Never read by the site build. */
export const DRAFTS_DIR = DRAFT_ROOT;
/** Uploaded media, served by the static site at MEDIA_URL_PREFIX. */
export const MEDIA_DIR = MEDIA_ROOT;
export const MEDIA_URL_PREFIX = MEDIA_URL_ROOT;

/**
 * WS-C: the section the phase 1 endpoints mean.
 *
 * Phase 1 had one collection and no section in its URLs, so
 * `/api/cms/draft/:slug` had to mean something once sections existed. It means
 * `projects` — the only thing phase 1 could edit — which keeps every phase 1
 * URL working against the phase 2 file layout
 * (docs/cms-contracts.md 11, last paragraph; decision 13.2).
 *
 * The one consequence worth knowing: these four helpers now resolve to
 * `src/content/pages/projects/<slug>.json`, not `src/content/pages/<slug>.json`,
 * and media to `public/media/projects/<slug>/`, not `public/media/<slug>/`.
 * Files already at the old paths are untouched and keep being served; nothing
 * writes there any more.
 */
export const LEGACY_SECTION_ID = 'projects' as const;

function legacySection(): SectionDef {
  return requireSection(LEGACY_SECTION_ID);
}

export function pagePath(slug: string): string {
  return contentPathFor(legacySection(), slug);
}

export function draftPath(slug: string): string {
  return draftPathFor(legacySection(), slug);
}

export function mediaPath(slug: string, filename: string): string {
  return `${mediaDirFor(legacySection(), slug)}/${filename}`;
}

export function mediaSrc(slug: string, filename: string): string {
  return mediaSrcFor(legacySection(), slug, filename);
}

/* -------------------------------------------------------------------------- */
/* Session cookies                                                             */
/* -------------------------------------------------------------------------- */

/** The session token. Name fixed by the brief. */
export const SESSION_COOKIE = 'cms-gh-token';
/**
 * The refresh token, when the GitHub App issues expiring user tokens (the
 * default for new apps: the access token lasts 8 hours). Without this, the
 * editor would silently log out mid-afternoon.
 */
export const REFRESH_COOKIE = 'cms-gh-refresh';
/** Single-use CSRF state for the OAuth round trip. */
export const STATE_COOKIE = 'cms-gh-oauth-state';
/** Where to send the browser after a successful sign-in. */
export const RETURN_COOKIE = 'cms-gh-return';

/* -------------------------------------------------------------------------- */
/* GitHub App (docs/cms-rebuild.md 2.5)                                        */
/* -------------------------------------------------------------------------- */

/**
 * `jinhyuk.org Keystatic`, which already has Contents read+write on the repo.
 * A client ID is not a secret; it travels in the authorize URL in plain sight.
 */
export function githubClientId(): string {
  return env('CMS_GITHUB_CLIENT_ID') ?? env('KEYSTATIC_GITHUB_CLIENT_ID') ?? 'Iv23liDOxIhxb7inF4fu';
}

/**
 * The client secret, by name only. It lives in the Vercel project env as
 * KEYSTATIC_GITHUB_CLIENT_SECRET and is never written down in this repo.
 * Returns null rather than throwing, so a missing secret becomes a clear 500
 * from one place instead of a crash at import time.
 */
export function githubClientSecret(): string | null {
  return env('KEYSTATIC_GITHUB_CLIENT_SECRET') ?? env('CMS_GITHUB_CLIENT_SECRET') ?? null;
}

/**
 * This is a single-user CMS (docs/cms-rebuild.md 1). A GitHub login that is
 * not this one is refused at the callback, before a cookie is ever set. The
 * App's own permissions would stop a stranger committing anyway; this makes
 * the refusal explicit and legible instead of a confusing 403 later.
 */
export function allowedLogin(): string {
  return env('CMS_ALLOWED_LOGIN') ?? REPO_OWNER;
}

/**
 * The OAuth callback. Normally derived from the request origin, so preview
 * deployments work without configuration; CMS_OAUTH_REDIRECT_URI pins it when
 * a proxy makes the origin untrustworthy.
 *
 * NOTE for whoever deploys this: this path has to be registered as a callback
 * URL on the GitHub App. The app currently only knows Keystatic's
 * `/api/keystatic/github/oauth/callback`.
 */
export const OAUTH_CALLBACK_PATH = '/api/cms/auth/callback';

export function oauthRedirectUri(requestUrl: string): string {
  const pinned = env('CMS_OAUTH_REDIRECT_URI');
  if (pinned !== undefined) return pinned;
  return new URL(OAUTH_CALLBACK_PATH, requestUrl).toString();
}

/* -------------------------------------------------------------------------- */
/* Upload limits                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 25MB. The GitHub Contents and Git Data APIs both refuse much past this, and
 * a personal site has no business committing a bigger file into git anyway.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Extensions the media endpoint will take, mapped to their media type. */
export const ALLOWED_MEDIA: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};
