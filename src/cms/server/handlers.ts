/**
 * src/cms/server/handlers.ts
 *
 * WS-C. One body per endpoint, shared by the one- and two-segment URL forms.
 *
 * `/api/cms/draft/home` and `/api/cms/draft/essays/my-essay` are the same
 * operation reached through two Astro route patterns, because a singleton
 * section has no slug and a collection does. Astro cannot express both with
 * one pattern, so there are two tiny route files and the work happens here —
 * which also means the one- and two-segment forms cannot drift apart.
 *
 * Every function here is pure plumbing: resolve the section through WS-A's
 * registry, validate the key at the edge, call `store.ts` or `records.ts`,
 * shape the response. No section name is written as a string literal.
 */

import type { CookieJar } from './auth.ts';
import { ctxFrom } from './context.ts';
import { badRequest } from './errors.ts';
import {
  checkUploadSize,
  ifMatchSha,
  jsonBody,
  ok,
  requireDocumentKey,
  requireMediaKey,
  requireSectionParam,
  requiresAbsent,
  resolveSectionOrLegacySlug,
} from './http.ts';
import {
  applyRecordOp,
  discardRecordsDraft,
  parseRecordOp,
  publishRecords,
  readRecords,
  writeRecordsDraft,
} from './records.ts';
import {
  deleteEntryDraft,
  listEntries,
  listSections,
  publishEntry,
  readEntry,
  uploadSectionMedia,
  writeEntryDraft,
} from './store.ts';
import { isRecordSection, siteUrlFor } from '../sections.ts';
import type { DocumentSectionDef, RecordSectionDef, SectionDef } from '../sections.ts';

/* -------------------------------------------------------------------------- */
/* Resolving the URL                                                           */
/* -------------------------------------------------------------------------- */

/** The slice of Astro's APIContext these routes use, and nothing more. */
export type RouteParams = Record<string, string | undefined>;

export type Target = { section: SectionDef; keyRaw: string | undefined };

/**
 * A phase 1 URL: `/api/cms/<verb>/<one segment>`, where the segment is either
 * a section id or the slug of the one collection phase 1 could edit.
 *
 * **A section id wins**, which is what makes `/api/cms/draft/home` the
 * homepage while `/api/cms/draft/track-daily-habit-tracker` is still the
 * project (see `resolveSectionOrLegacySlug` for the consequence).
 */
export function legacyTarget(params: RouteParams): Target {
  const resolved = resolveSectionOrLegacySlug(params.slug);
  return { section: resolved.section, keyRaw: resolved.key ?? undefined };
}

/**
 * A phase 2 URL: `/api/cms/<verb>/<section>[/<key>]`. Unambiguous, and what
 * WS-D should build — a project whose slug happens to be a section id is only
 * reachable this way.
 */
export function sectionTarget(params: RouteParams): Target {
  return { section: requireSectionParam(params.section), keyRaw: params.slug };
}

/** A document section, or the 400 that says which endpoint records use. */
function asDocumentSection(section: SectionDef): DocumentSectionDef {
  if (isRecordSection(section)) {
    throw badRequest(
      `"${section.id}" holds ${section.records.noun}s, not documents. Its whole collection is one file: use /api/cms/records/${section.id}.`,
      'wrong_storage',
    );
  }
  return section;
}

function asRecordSection(section: SectionDef): RecordSectionDef {
  if (!isRecordSection(section)) {
    throw badRequest(
      `"${section.id}" holds documents, not records. Use /api/cms/entry/${section.id} and /api/cms/draft/${section.id}.`,
      'wrong_storage',
    );
  }
  return section;
}

/** `undefined` lets the server quote what it reads; `null` means "must be new". */
function expectationFrom(request: Request): string | null | undefined {
  return requiresAbsent(request) ? null : ifMatchSha(request);
}

/* -------------------------------------------------------------------------- */
/* Sections and entries                                                        */
/* -------------------------------------------------------------------------- */

/** GET /api/cms/sections */
export async function getSections(cookies: CookieJar): Promise<Response> {
  const sections = await listSections(await ctxFrom(cookies));
  return ok({ sections });
}

/** GET /api/cms/entries/:section */
export async function getEntries(cookies: CookieJar, params: RouteParams): Promise<Response> {
  const section = requireSectionParam(params.section);
  const entries = await listEntries(await ctxFrom(cookies), section);
  return ok({ section: section.id, storage: section.storage, shape: section.shape, entries });
}

/* -------------------------------------------------------------------------- */
/* One document                                                                */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/cms/entry/:section[/:slug], and phase 1's GET /api/cms/page/:slug.
 *
 * `slug` is in the response as well as `key` so phase 1's client, which reads
 * `slug`, keeps working unchanged.
 */
export async function getEntry(cookies: CookieJar, target: Target): Promise<Response> {
  const section = asDocumentSection(target.section);
  const key = requireDocumentKey(section, target.keyRaw);
  const read = await readEntry(await ctxFrom(cookies), section, key);
  return ok({
    section: section.id,
    key: key ?? section.id,
    slug: key ?? section.id,
    siteUrl: siteUrlFor(section, key) ?? section.indexUrl,
    ...read,
  });
}

/** PUT /api/cms/draft/:section[/:slug], and phase 1's PUT /api/cms/draft/:slug. */
export async function putDraft(
  cookies: CookieJar,
  request: Request,
  target: Target,
): Promise<Response> {
  const section = asDocumentSection(target.section);
  const key = requireDocumentKey(section, target.keyRaw);
  const ctx = await ctxFrom(cookies);
  const body = await jsonBody(request);
  const result = await writeEntryDraft(ctx, section, key, body, expectationFrom(request));
  return ok({
    section: section.id,
    key: key ?? section.id,
    slug: key ?? section.id,
    commit: result.commit,
    sha: result.sha,
    title: result.doc.meta.title,
  });
}

/** DELETE /api/cms/draft/:section[/:slug] */
export async function deleteDraftEntry(
  cookies: CookieJar,
  request: Request,
  target: Target,
): Promise<Response> {
  const section = asDocumentSection(target.section);
  const key = requireDocumentKey(section, target.keyRaw);
  const ctx = await ctxFrom(cookies);
  const result = await deleteEntryDraft(ctx, section, key, ifMatchSha(request));
  return ok({
    section: section.id,
    key: key ?? section.id,
    slug: key ?? section.id,
    commit: result.commit,
  });
}

/**
 * POST /api/cms/publish/:section[/:slug], and phase 1's
 * POST /api/cms/publish/:slug.
 *
 * The one verb that is the same for both storage shapes: publishing a record
 * collection is publishing its one file, so `/api/cms/publish/filmography`
 * works and means exactly what it says.
 */
export async function postPublish(
  cookies: CookieJar,
  request: Request,
  target: Target,
): Promise<Response> {
  const expected = expectationFrom(request);
  const ctx = await ctxFrom(cookies);

  if (isRecordSection(target.section)) {
    if (target.keyRaw !== undefined && target.keyRaw !== '') {
      throw badRequest(
        `"${target.section.id}" is one file, so there is nothing for "${target.keyRaw}" to publish on its own. Publish the collection: /api/cms/publish/${target.section.id}.`,
        'wrong_storage',
      );
    }
    const result = await publishRecords(ctx, target.section, expected);
    return ok({
      section: target.section.id,
      commit: result.commit,
      sha: result.sha,
      entries: result.entries,
    });
  }

  const section = asDocumentSection(target.section);
  const key = requireDocumentKey(section, target.keyRaw);
  const result = await publishEntry(ctx, section, key, expected);
  return ok({
    section: section.id,
    key: key ?? section.id,
    slug: key ?? section.id,
    commit: result.commit,
    sha: result.sha,
    title: result.doc.meta.title,
    siteUrl: siteUrlFor(section, key) ?? section.indexUrl,
  });
}

/* -------------------------------------------------------------------------- */
/* Record collections                                                          */
/* -------------------------------------------------------------------------- */

/** GET /api/cms/records/:section */
export async function getRecords(cookies: CookieJar, params: RouteParams): Promise<Response> {
  const section = asRecordSection(requireSectionParam(params.section));
  const read = await readRecords(await ctxFrom(cookies), section);
  return ok({ section: section.id, key: section.records.key, ...read });
}

/**
 * PUT /api/cms/records/:section — the whole collection, as the contract
 * specifies (docs/cms-contracts.md 11). It writes the DRAFT; publish moves it.
 */
export async function putRecords(
  cookies: CookieJar,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const section = asRecordSection(requireSectionParam(params.section));
  const ctx = await ctxFrom(cookies);
  const body = await jsonBody(request);
  const result = await writeRecordsDraft(ctx, section, body, expectationFrom(request));
  return ok({
    section: section.id,
    commit: result.commit,
    sha: result.sha,
    data: result.data,
    entries: result.entries,
  });
}

/**
 * POST /api/cms/records/:section — one operation, applied server side.
 *
 * `{ "op": "add" | "update" | "delete" | "reorder" | "move", ... }`. The read,
 * the permute and the write happen inside this one request against the sha it
 * just read, which is what makes a reorder safe against a save from another
 * tab; the whole-file PUT above cannot be, because the client's array is
 * already stale by the time it arrives.
 */
export async function postRecordOp(
  cookies: CookieJar,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const section = asRecordSection(requireSectionParam(params.section));
  const ctx = await ctxFrom(cookies);
  const op = parseRecordOp(section, await jsonBody(request));
  const result = await applyRecordOp(ctx, section, op, ifMatchSha(request));
  return ok({
    section: section.id,
    op: op.op,
    key: result.key,
    basedOn: result.basedOn,
    commit: result.commit,
    sha: result.sha,
    data: result.data,
    entries: result.entries,
  });
}

/** DELETE /api/cms/records/:section — discard the collection's draft. */
export async function deleteRecords(
  cookies: CookieJar,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const section = asRecordSection(requireSectionParam(params.section));
  const ctx = await ctxFrom(cookies);
  const result = await discardRecordsDraft(ctx, section, ifMatchSha(request));
  return ok({ section: section.id, commit: result.commit });
}

/* -------------------------------------------------------------------------- */
/* Media                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/cms/media/:section[/:slug], and phase 1's
 * POST /api/cms/media/:slug.
 *
 * `w` and `h` are read out of the file's own header, so the editor can place
 * the item at its real aspect ratio without waiting for the browser to load it
 * (docs/cms-contracts.md 3, 11). For an album the response's `src`, `w` and
 * `h` are exactly what `newPhoto(src, { w, h })` wants.
 */
export async function postMedia(
  cookies: CookieJar,
  request: Request,
  target: Target,
): Promise<Response> {
  const section = target.section;
  const key = requireMediaKey(section, target.keyRaw);
  const ctx = await ctxFrom(cookies);

  const type = request.headers.get('content-type') ?? '';
  if (!type.includes('multipart/form-data')) {
    throw badRequest(
      'Send the file as multipart/form-data with the field name "file".',
      'not_multipart',
    );
  }

  const form = await request.formData();
  const file = form.get('file');
  if (file === null) throw badRequest('No "file" field in the upload.');
  if (typeof file === 'string') {
    throw badRequest('The "file" field was text, not a file.');
  }

  checkUploadSize(file.size);
  const bytes = Buffer.from(await file.arrayBuffer());
  checkUploadSize(bytes.length);

  const result = await uploadSectionMedia(ctx, section, key, { name: file.name, bytes });
  return ok({
    section: section.id,
    key,
    src: result.src,
    w: result.w,
    h: result.h,
    commit: result.commit,
    path: result.path,
    dimensions: result.dimensions,
    format: result.format,
    bytes: result.bytes,
  });
}
