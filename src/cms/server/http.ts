/**
 * src/cms/server/http.ts
 *
 * WS-2. The thin layer between an Astro route and this module's functions:
 * JSON out, bodies in, slug checking, and one place that turns a thrown error
 * into the right response.
 *
 * Deliberately free of Astro imports beyond types, so the whole server side
 * can be driven from a test script with a hand-made Request.
 */

import { ApiError, ConflictError, badRequest, messageOf, notFound, payloadTooLarge, statusOf } from './errors.ts';
import { DocMetaSchema, IdSchema, SECTION_IDS } from '../schema.ts';
import { getSection, isRecordSection, needsSlug, requireSection } from '../sections.ts';
import type { SectionDef } from '../sections.ts';
import { LEGACY_SECTION_ID, MAX_UPLOAD_BYTES } from './config.ts';

// no-store on everything. These responses are authenticated and change on
// every write; a CDN or a browser holding on to one would show a stale
// document or leak one page's JSON to the next request.
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

/**
 * A success response. Always `{ ok: true, ... }` (docs/cms-contracts.md 3).
 * `ok` is written last deliberately: spreading the payload first means a
 * payload key called `ok` cannot shadow it.
 */
export function ok(payload: Record<string, unknown> = {}, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ ...payload, ok: true }), {
    status: init.status ?? 200,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  });
}

/** A failure response. Always `{ error: string }` with a non-200 status. */
export function fail(message: string, status = 500, extra: Record<string, unknown> = {}): Response {
  const body: Record<string, unknown> = { ...extra, error: message };
  return new Response(JSON.stringify(body), {
    status: status === 200 ? 500 : status,
    headers: JSON_HEADERS,
  });
}

/**
 * Turn anything thrown into a response. A conflict carries its shas through,
 * because the editor has to act on them rather than only show them.
 */
export function failFrom(error: unknown): Response {
  if (error instanceof ConflictError) {
    return fail(error.message, 409, {
      code: 'conflict',
      path: error.path,
      expectedSha: error.expectedSha,
      actualSha: error.actualSha,
    });
  }
  const status = statusOf(error);
  const extra = error instanceof ApiError && error.code !== undefined ? { code: error.code } : {};
  if (status === 500) {
    // An unexpected throw is worth a server log; the client only gets the message.
    console.error('[cms/api] unhandled error', error);
  }
  return fail(messageOf(error), status, extra);
}

/** Wrap a handler so no route has to repeat the try/catch. */
export async function handle(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    return failFrom(error);
  }
}

/**
 * Validate a slug from the URL. Reuses WS-0's own regex through
 * DocMetaSchema rather than restating it, so the two can never disagree, and
 * so a slug can never contain a path traversal.
 */
export function requireSlug(raw: string | undefined): string {
  if (raw === undefined || raw === '') throw badRequest('Missing slug in the URL.');
  const parsed = DocMetaSchema.shape.slug.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(
      `Bad slug "${raw}". A slug is lowercase kebab-case, for example "track-daily-habit-tracker".`,
    );
  }
  return parsed.data;
}

/**
 * Validate a record key from the URL: a film's id, an album's slug.
 *
 * Wider than `requireSlug` on purpose. A record id is `IdSchema`
 * (`[A-Za-z0-9_-]{1,64}`), so `film_untitled` is a legal key and would be
 * refused by the kebab-case document-slug rule. It is still narrow enough that
 * `fillSlug` will accept it, which is where the traversal guard lives.
 */
export function requireId(raw: string | undefined): string {
  if (raw === undefined || raw === '') throw badRequest('Missing record key in the URL.');
  const parsed = IdSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(
      `Bad record key "${raw}". A key is 1-64 characters from A-Z a-z 0-9 _ - (for example "film_untitled" or "first-build").`,
    );
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Sections (docs/cms-contracts.md 11)                                         */
/* -------------------------------------------------------------------------- */

/**
 * The section named in the URL, or a 404.
 *
 * A 404 and not a 400: `:section` is part of the path, so a request to
 * `/api/cms/entries/blog` is a request for something that does not exist,
 * exactly as `getSection` returning null says.
 */
export function requireSectionParam(raw: string | undefined): SectionDef {
  if (raw === undefined || raw === '') throw badRequest('Missing section in the URL.');
  const section = getSection(raw);
  if (section === null) {
    throw notFound(
      `No section "${raw}". The sections are ${SECTION_IDS.join(', ')}.`,
    );
  }
  return section;
}

/**
 * One URL segment where both a section id and a phase 1 project slug are
 * possible, which is every single-segment phase 1 endpoint:
 * `/api/cms/draft/home` is the homepage, `/api/cms/draft/track-daily-habit-tracker`
 * is the project phase 1 could already edit.
 *
 * **A section id wins.** A project whose slug happens to be `essays` is
 * therefore only reachable at the two-segment form,
 * `/api/cms/draft/projects/essays`, which is unambiguous and is what WS-D
 * should build its URLs with. Phase 1's one page, `track-daily-habit-tracker`,
 * is not a section id, so nothing that exists today is affected.
 */
export function resolveSectionOrLegacySlug(raw: string | undefined): {
  section: SectionDef;
  key: string | null;
} {
  if (raw !== undefined && raw !== '' && getSection(raw) !== null) {
    return { section: requireSectionParam(raw), key: null };
  }
  return { section: requireSection(LEGACY_SECTION_ID), key: requireSlug(raw) };
}

/**
 * The entry key for a document section, checked against the section's shape.
 *
 * A singleton has no key (`home` is one page, at one path). A collection must
 * have one, and it is a document slug. A record section has no per-entry
 * endpoints at all (docs/cms-contracts.md 11, note 1), so it is refused here
 * with the endpoint that does work.
 */
export function requireDocumentKey(section: SectionDef, raw: string | undefined): string | null {
  if (isRecordSection(section)) {
    throw badRequest(
      `"${section.id}" holds ${section.records.noun}s, not documents. Its whole collection is one file: use /api/cms/records/${section.id}.`,
      'wrong_storage',
    );
  }
  if (!needsSlug(section.contentPath)) {
    if (raw !== undefined && raw !== '') {
      throw badRequest(
        `"${section.id}" is a single ${section.noun} and has no entries, so there is nothing for "${raw}" to name. Use /api/cms/entry/${section.id}.`,
        'not_a_collection',
      );
    }
    return null;
  }
  if (raw === undefined || raw === '') {
    throw badRequest(
      `"${section.id}" is a collection, so the URL needs a ${section.noun}: /api/cms/entry/${section.id}/<slug>.`,
      'needs_slug',
    );
  }
  return requireSlug(raw);
}

/**
 * The key that picks an upload directory (docs/cms-contracts.md 9.3).
 *
 * The same rule as `requireDocumentKey` for the three document sections, and
 * for the two record sections the record's own key — a film id or an album
 * slug — because that is what `mediaDirFor` fills.
 */
export function requireMediaKey(section: SectionDef, raw: string | undefined): string | null {
  if (!needsSlug(section.mediaDir)) {
    if (raw !== undefined && raw !== '') {
      throw badRequest(
        `"${section.id}" uploads to one directory and has no entries, so there is nothing for "${raw}" to name. Use /api/cms/media/${section.id}.`,
        'not_a_collection',
      );
    }
    return null;
  }
  if (raw === undefined || raw === '') {
    throw badRequest(
      `An upload to "${section.id}" needs to say which ${section.noun} it belongs to: /api/cms/media/${section.id}/<key>.`,
      'needs_slug',
    );
  }
  return isRecordSection(section) ? requireId(raw) : requireSlug(raw);
}

/** Parse a JSON request body, with a readable error for the two usual mistakes. */
export async function jsonBody(request: Request): Promise<unknown> {
  const type = request.headers.get('content-type') ?? '';
  if (type !== '' && !type.includes('json')) {
    throw badRequest(`Expected a JSON body; got Content-Type "${type}".`);
  }
  const text = await request.text();
  if (text.trim() === '') throw badRequest('Expected a JSON body; the request was empty.');
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw badRequest(`Body was not valid JSON: ${messageOf(error)}`);
  }
}

/**
 * The optimistic-concurrency header. A client that read a document and is
 * writing it back sends the sha it read, as `If-Match`.
 *
 *   absent            -> no client expectation; the server still quotes the
 *                        sha it reads, so a concurrent commit is caught
 *   "<sha>"           -> must still be that blob
 *   "" or "*" absent  -> see below
 *   If-None-Match: *  -> the file must not exist yet
 *
 * Quotes and a W/ prefix are stripped, because that is how real HTTP clients
 * send an ETag back.
 */
export function ifMatchSha(request: Request): string | undefined {
  const raw = request.headers.get('if-match');
  if (raw === null) return undefined;
  const cleaned = raw.trim().replace(/^W\//i, '').replace(/^"|"$/g, '');
  if (cleaned === '' || cleaned === '*') return undefined;
  return cleaned;
}

/** `If-None-Match: *` means "only create, never overwrite". */
export function requiresAbsent(request: Request): boolean {
  const raw = request.headers.get('if-none-match');
  return raw !== null && raw.trim() === '*';
}

/** Reject an oversized upload before it is read into memory as a buffer. */
export function checkUploadSize(bytes: number): void {
  if (bytes > MAX_UPLOAD_BYTES) {
    throw payloadTooLarge(
      `That file is ${mib(bytes)}MB. The limit is ${mib(MAX_UPLOAD_BYTES)}MB, because it has to fit in a git commit.`,
    );
  }
}

function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
}
