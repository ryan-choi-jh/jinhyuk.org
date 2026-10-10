/**
 * src/cms/server/store.ts
 *
 * WS-2, extended by WS-C. The document store: what an entry is, where its
 * draft lives, what publish means, and where an upload lands. Everything above
 * this file is HTTP plumbing; `drafts.ts` is the draft/publish engine
 * underneath it, and `github.ts` is below that.
 *
 * Phase 1 stored one thing and could name its paths directly. Phase 2 has five
 * sections in two storage shapes, so every path in this file now comes from
 * WS-A's registry (`src/cms/sections.ts`) and **no section name is written as
 * a string literal anywhere in it**. The three document sections — home,
 * projects, essays — are handled here. The two record sections are
 * `records.ts`; the only thing this file does for them is count their entries
 * for the sidebar and put their uploads in the right directory.
 *
 * Draft semantics (docs/cms-rebuild.md 2.3) have not changed and are
 * implemented exactly once, in `drafts.ts`:
 *
 *   - the editor always writes the draft mirror of a file
 *   - publish copies the draft over the published file and deletes the draft,
 *     in ONE commit
 *   - the site builds from the published tree only
 *
 * Phase 1's exports are all still here, unchanged in shape, as thin wrappers
 * over the section-aware functions with `section = projects`
 * (docs/cms-contracts.md 11, last paragraph). `src/cms/preview/source.ts`
 * imports `listPages`, `readPage`, `PageSummary` and `Ctx` from this file and
 * must keep working.
 */

import { ALLOWED_MEDIA, LEGACY_SECTION_ID } from './config.ts';
import { ConflictError, badRequest } from './errors.ts';
import {
  discardSlotDraft,
  publishSlot,
  readSlot,
  writeSlotDraft,
} from './drafts.ts';
import type { Ctx, ShaExpectation, Slot, SlotRead, WriteResult } from './drafts.ts';
import { commitFiles, headSha, listDir, readBlob, readText } from './github.ts';
import { mediaDimensionsOrFallback } from './media-dimensions.ts';
import type { Dimensions } from './media-dimensions.ts';
import { publishedKeys, readRecords } from './records.ts';
import {
  contentDirFor,
  contentPathFor,
  draftDirFor,
  draftPathFor,
  isRecordSection,
  mediaDirFor,
  mediaSrcFor,
  needsSlug,
  requireSection,
  slugFromFilename,
  SECTIONS,
} from '../sections.ts';
import type { DocumentSectionDef, SectionDef, SectionShape, SectionStorage } from '../sections.ts';
import { formatIssues, validateDoc, validateDocJson } from '../schema.ts';
import type { Doc, DocumentSectionId, ValidateResultOf } from '../schema.ts';

export type { Ctx, ShaExpectation, WriteResult };

/* -------------------------------------------------------------------------- */
/* Serialisation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The on-disk form of a document: two-space indented JSON with a trailing
 * newline.
 *
 * The document written is the one zod returned, not the one the client sent.
 * zod builds its result by walking the schema's keys in order, so the file's
 * key order is the schema's key order no matter what order the editor
 * happened to serialise in. That is what makes a diff of a moved image one
 * changed line instead of a reshuffled file.
 */
export function serialiseDoc(doc: Doc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/* -------------------------------------------------------------------------- */
/* Document slots                                                              */
/* -------------------------------------------------------------------------- */

/** `validateDocJson` with the generic result key, so a Doc can use a Slot. */
function parseDoc(text: string): ValidateResultOf<Doc> {
  const result = validateDocJson(text);
  return result.ok ? { ok: true, data: result.doc } : { ok: false, issues: result.issues };
}

/** `projects/my-page`, `essays/my-essay`, `home`. Commit messages and errors. */
function labelFor(section: SectionDef, key: string | null): string {
  return key === null ? section.id : `${section.id}/${key}`;
}

/**
 * One document's file pair. `key` is null for the singleton, which is the only
 * section whose `contentPath` has no `:slug` to fill.
 *
 * `contentPathFor` is also the traversal guard: it throws on anything that is
 * not an id, which is why nothing below here re-checks the key.
 */
export function docSlot(section: DocumentSectionDef, key: string | null): Slot<Doc> {
  return {
    label: labelFor(section, key),
    contentPath: contentPathFor(section, key),
    draftPath: draftPathFor(section, key),
    parse: parseDoc,
  };
}

/* -------------------------------------------------------------------------- */
/* Listing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One row in a section's entry list (docs/cms-contracts.md 11).
 *
 * `subtitle` and `thumb` are records only; a document section leaves them out
 * rather than sending nulls, so a client can tell "no subtitle" from "this
 * kind of entry does not have one".
 */
export type EntrySummary = {
  /** The slug, or a film's record id. What the URL and the API use. */
  key: string;
  title: string;
  subtitle?: string;
  thumb?: string | null;
  hasDraft: boolean;
  hasPublished: boolean;
  /** The file on disk does not validate. Opening the entry will show why. */
  invalid?: boolean;
};

export type SectionSummary = {
  id: SectionDef['id'];
  label: string;
  shape: SectionShape;
  storage: SectionStorage;
  /** Entries. 1 for a singleton (docs/cms-contracts.md 11). */
  count: number;
  /** Any draft anywhere in the section. */
  hasDraft: boolean;
};

/** Phase 1's row shape. Kept because `src/cms/preview/source.ts` reads it. */
export type PageSummary = {
  slug: string;
  title: string;
  hasDraft: boolean;
  hasPublished: boolean;
  invalid?: boolean;
};

/** Run an async map with a ceiling on how many are in flight at once. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

function slugsIn(entries: { name: string; type: string }[]): string[] {
  const slugs: string[] = [];
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    const slug = slugFromFilename(entry.name);
    if (slug !== null) slugs.push(slug);
  }
  return slugs;
}

/**
 * Which slugs a document collection holds, published and drafted.
 *
 * Only ever called for a collection: the singleton's directory is
 * `src/content/pages`, which also contains the collections' own
 * subdirectories, so listing it would be wrong as well as pointless.
 */
async function collectionSlugs(
  ctx: Ctx,
  section: DocumentSectionDef,
): Promise<{ published: Set<string>; drafts: Set<string> }> {
  const [publishedEntries, draftEntries] = await Promise.all([
    listDir(ctx.token, contentDirFor(section), ctx.branch),
    listDir(ctx.token, draftDirFor(section), ctx.branch),
  ]);
  return {
    published: new Set(slugsIn(publishedEntries)),
    drafts: new Set(slugsIn(draftEntries)),
  };
}

/**
 * Every entry in a section: the union of published entries and drafts, so an
 * entry that has only ever been a draft still appears.
 *
 * Titles need the file contents, so a collection is one request per entry. For
 * a personal site that is a handful of small files; the concurrency cap keeps
 * it polite rather than fast. A record section is one request per side,
 * because the whole collection is one file.
 */
export async function listEntries(ctx: Ctx, section: SectionDef): Promise<EntrySummary[]> {
  if (isRecordSection(section)) {
    const read = await readRecords(ctx, section);
    const live = publishedKeys(section, read.published);
    const hasDraft = read.draft !== null;
    const invalid = read.draftError !== undefined || read.publishedError !== undefined;
    return read.entries.map((row) => {
      const summary: EntrySummary = {
        key: row.key,
        title: row.title,
        subtitle: row.subtitle,
        thumb: row.thumb,
        hasDraft,
        hasPublished: live.has(row.key) || live.has(row.id),
      };
      if (invalid) summary.invalid = true;
      return summary;
    });
  }

  if (!needsSlug(section.contentPath)) {
    // The singleton is one entry whether or not its file exists yet — that is
    // what makes "edit the homepage" possible in a repo that has no home.json
    // — so it is always listed, with the section's own label standing in for a
    // title until there is one.
    const read = await readSlot(ctx, docSlot(section, null));
    const summary: EntrySummary = {
      key: section.id,
      title: (read.draft ?? read.published)?.meta.title ?? section.label,
      hasDraft: read.draftSha !== null,
      hasPublished: read.publishedSha !== null,
    };
    if (read.draftError !== undefined || read.publishedError !== undefined) summary.invalid = true;
    return [summary];
  }

  const { published, drafts } = await collectionSlugs(ctx, section);
  const slugs = [...new Set([...published, ...drafts])].sort();

  return mapLimit(slugs, 6, async (slug) => {
    const slot = docSlot(section, slug);
    // The draft is the more interesting title when there is one, because it is
    // what the author last typed. One read, not two: the other side's title is
    // not shown anywhere, and a list of twenty essays should not be forty
    // requests.
    const path = drafts.has(slug) ? slot.draftPath : slot.contentPath;
    const summary: EntrySummary = {
      key: slug,
      title: slug,
      hasDraft: drafts.has(slug),
      hasPublished: published.has(slug),
    };
    const file = await readText(ctx.token, path, ctx.branch);
    if (file === null) return summary;
    const parsed = parseDoc(file.text);
    if (parsed.ok) summary.title = parsed.data.meta.title;
    else summary.invalid = true;
    return summary;
  });
}

/** The sidebar: every section, with how much is in it and whether it is dirty. */
export async function listSections(ctx: Ctx): Promise<SectionSummary[]> {
  return mapLimit([...SECTIONS], 5, async (section) => {
    const base = {
      id: section.id,
      label: section.label,
      shape: section.shape,
      storage: section.storage,
    };

    if (isRecordSection(section)) {
      const read = await readRecords(ctx, section);
      return { ...base, count: read.entries.length, hasDraft: read.draftSha !== null };
    }

    if (!needsSlug(section.contentPath)) {
      const draftSha = await headSha(ctx.token, draftPathFor(section), ctx.branch);
      // A singleton is one entry whether or not its file exists yet, which is
      // what the contract's "1 for a singleton" means.
      return { ...base, count: 1, hasDraft: draftSha !== null };
    }

    const { published, drafts } = await collectionSlugs(ctx, section);
    return {
      ...base,
      count: new Set([...published, ...drafts]).size,
      hasDraft: drafts.size > 0,
    };
  });
}

/** Phase 1's `/api/cms/pages`: the projects collection, in phase 1's row shape. */
export async function listPages(ctx: Ctx): Promise<PageSummary[]> {
  const entries = await listEntries(ctx, requireSection(LEGACY_SECTION_ID));
  return entries.map((entry) => {
    const page: PageSummary = {
      slug: entry.key,
      title: entry.title,
      hasDraft: entry.hasDraft,
      hasPublished: entry.hasPublished,
    };
    if (entry.invalid === true) page.invalid = true;
    return page;
  });
}

/* -------------------------------------------------------------------------- */
/* Reading one entry                                                           */
/* -------------------------------------------------------------------------- */

/** Phase 1's name for `SlotRead<Doc>`, which is what it always was. */
export type PageRead = SlotRead<Doc>;

export async function readEntry(
  ctx: Ctx,
  section: DocumentSectionDef,
  key: string | null,
): Promise<PageRead> {
  return readSlot(ctx, docSlot(section, key));
}

export async function readPage(ctx: Ctx, slug: string): Promise<PageRead> {
  return readEntry(ctx, documentSection(LEGACY_SECTION_ID), slug);
}

/** The registry lookup, narrowed. Only ever called with a literal document id. */
function documentSection(id: DocumentSectionId): DocumentSectionDef {
  const section = requireSection(id);
  if (isRecordSection(section)) throw new TypeError(`"${id}" is not a document section`);
  return section;
}

/* -------------------------------------------------------------------------- */
/* Writing a draft                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Check a document against the section and key it is being saved under.
 *
 * Two mismatches are possible and both are the author's, not the server's: a
 * document whose `meta.slug` is not the slug in the URL (a rename half done),
 * and a document whose `meta.section` names a different section (an essay
 * dragged into projects). Neither is corrected silently — the file is the
 * author's text, and a server that quietly rewrites `meta` is a server you
 * cannot trust with the rest of it.
 */
function checkDocPlacement(doc: Doc, section: DocumentSectionDef, key: string | null): void {
  const expectedSlug = key ?? section.id;
  if (doc.meta.slug !== expectedSlug) {
    throw badRequest(
      `This is ${section.cmsUrl}${key === null ? '' : `/${key}`} but the document's meta.slug is "${doc.meta.slug}". Rename one of them; a document is stored under its own slug.`,
      'slug_mismatch',
    );
  }
  if (doc.meta.section !== undefined && doc.meta.section !== section.id) {
    throw badRequest(
      `The document's meta.section is "${doc.meta.section}" but it is being saved into "${section.id}". Change one of them; a document lives in the section it says it is in.`,
      'section_mismatch',
    );
  }
}

/**
 * Save the working copy. Validates first: an invalid document is never
 * written, so a draft on disk is always loadable.
 */
export async function writeEntryDraft(
  ctx: Ctx,
  section: DocumentSectionDef,
  key: string | null,
  body: unknown,
  expected: ShaExpectation = undefined,
): Promise<WriteResult & { doc: Doc }> {
  const result = validateDoc(body);
  if (!result.ok) {
    throw badRequest(
      `That document does not validate:\n${formatIssues(result.issues)}`,
      'invalid_doc',
    );
  }
  const doc = result.doc;
  checkDocPlacement(doc, section, key);

  const write = await writeSlotDraft(ctx, docSlot(section, key), serialiseDoc(doc), expected);
  return { ...write, doc };
}

export async function writeDraft(
  ctx: Ctx,
  slug: string,
  body: unknown,
  expected: ShaExpectation = undefined,
): Promise<WriteResult & { doc: Doc }> {
  return writeEntryDraft(ctx, documentSection(LEGACY_SECTION_ID), slug, body, expected);
}

/* -------------------------------------------------------------------------- */
/* Deleting a draft                                                            */
/* -------------------------------------------------------------------------- */

/** Throw the draft away. The published entry is untouched. */
export async function deleteEntryDraft(
  ctx: Ctx,
  section: DocumentSectionDef,
  key: string | null,
  expected: ShaExpectation = undefined,
): Promise<{ commit: string }> {
  return discardSlotDraft(ctx, docSlot(section, key), expected);
}

export async function deleteDraft(
  ctx: Ctx,
  slug: string,
  expected: ShaExpectation = undefined,
): Promise<{ commit: string }> {
  return deleteEntryDraft(ctx, documentSection(LEGACY_SECTION_ID), slug, expected);
}

/* -------------------------------------------------------------------------- */
/* Publishing                                                                  */
/* -------------------------------------------------------------------------- */

export type PublishResult = { commit: string; sha: string; doc: Doc };

export async function publishEntry(
  ctx: Ctx,
  section: DocumentSectionDef,
  key: string | null,
  expectedPublishedSha: ShaExpectation = undefined,
): Promise<PublishResult> {
  const published = await publishSlot(ctx, docSlot(section, key), expectedPublishedSha);
  return { commit: published.commit, sha: published.sha, doc: published.value };
}

export async function publishDraft(
  ctx: Ctx,
  slug: string,
  expectedPublishedSha: ShaExpectation = undefined,
): Promise<PublishResult> {
  return publishEntry(ctx, documentSection(LEGACY_SECTION_ID), slug, expectedPublishedSha);
}

/* -------------------------------------------------------------------------- */
/* Media                                                                       */
/* -------------------------------------------------------------------------- */

export type UploadResult = {
  /** The public path, which is what goes in CanvasItem.src or Photo.src. */
  src: string;
  w: number;
  h: number;
  /** Where it landed in the repo. */
  path: string;
  commit: string;
  /** 'intrinsic' | 'declared' | 'fallback'; see media-dimensions.ts. */
  dimensions: Dimensions['source'];
  format: string;
  bytes: number;
};

/** Filename that is safe in a URL, in a commit and on every filesystem. */
export function safeFilename(original: string): { base: string; ext: string } {
  const dot = original.lastIndexOf('.');
  const rawExt = dot > 0 ? original.slice(dot + 1) : '';
  const rawBase = dot > 0 ? original.slice(0, dot) : original;
  const ext = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '');
  const base =
    rawBase
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'file';
  return { base, ext };
}

/**
 * Put an uploaded file in this section's own media directory and report where
 * it went and how big it is.
 *
 * One pipeline for all five sections (docs/cms-sections.md 3.5,
 * docs/cms-contracts.md 9.3): `public/media/<section>/<key>/`, with the
 * singleton's `public/media/home/` the one case that has no key. The old
 * conventions — `public/filmography/<video id>.jpg`,
 * `public/projects/<slug>/...` — are not written to any more; files already
 * there keep working as ordinary site-absolute `src` values.
 *
 * The name is kept where possible, because `IMG_2065.png` is recognisable in
 * the repo a year later and a content hash is not. A name already in use gets
 * a numeric suffix rather than replacing the file that is there: the editor
 * has no undo for a clobbered image.
 */
export async function uploadSectionMedia(
  ctx: Ctx,
  section: SectionDef,
  key: string | null,
  file: { name: string; bytes: Buffer },
): Promise<UploadResult> {
  const { base, ext } = safeFilename(file.name);
  const mediaType = ALLOWED_MEDIA[ext];
  if (mediaType === undefined) {
    throw badRequest(
      `Cannot take a ".${ext}" file. Allowed: ${Object.keys(ALLOWED_MEDIA).join(', ')}.`,
      'bad_type',
    );
  }
  if (file.bytes.length === 0) throw badRequest('That file is empty.');

  const dimensions = mediaDimensionsOrFallback(file.bytes, ext);
  const dir = mediaDirFor(section, key);

  /**
   * Find a free name, with the COMMIT as the authority rather than the scan.
   *
   * `expectedSha: null` makes the commit itself refuse to overwrite, which is
   * what makes this safe. The scan only picks a likely-free name — and it can
   * be wrong, because GitHub's contents API has a short window after a write
   * in which it still answers 404 for a path that now exists. Phase 1 trusted
   * the scan and surfaced that window to the author as "already exists;
   * refusing to overwrite it" on a perfectly ordinary second upload of the
   * same filename. Taking the next name on refusal is what the loop meant all
   * along.
   */
  for (let suffix = 1; suffix < 100; suffix += 1) {
    const filename = suffix === 1 ? `${base}.${ext}` : `${base}-${suffix}.${ext}`;
    const path = `${dir}/${filename}`;
    if ((await headSha(ctx.token, path, ctx.branch)) !== null) continue;
    try {
      const commit = await commitFiles(ctx.token, {
        branch: ctx.branch,
        message: `CMS: add ${path}`,
        changes: [{ path, content: file.bytes, expectedSha: null }],
      });
      return {
        src: mediaSrcFor(section, key, filename),
        w: dimensions.w,
        h: dimensions.h,
        path,
        commit: commit.commit,
        dimensions: dimensions.source,
        format: dimensions.format,
        bytes: file.bytes.length,
      };
    } catch (error) {
      // Only "that path was taken after all" is retryable. A conflict on the
      // branch, or anything else, is the caller's to hear about.
      if (!(error instanceof ConflictError) || error.path !== path) throw error;
    }
  }

  throw badRequest(
    `There are already 99 files called "${base}.${ext}" in ${dir}. Rename the file before uploading it.`,
    'too_many_names',
  );
}

/** Phase 1's `/api/cms/media/:slug`, which means the projects section. */
export async function uploadMedia(
  ctx: Ctx,
  slug: string,
  file: { name: string; bytes: Buffer },
): Promise<UploadResult> {
  return uploadSectionMedia(ctx, requireSection(LEGACY_SECTION_ID), slug, file);
}

/** Read an uploaded file back. Used by the integration test, and by nothing else. */
export async function readMedia(
  ctx: Ctx,
  path: string,
): Promise<{ bytes: Buffer; sha: string } | null> {
  const blob = await readBlob(ctx.token, path, ctx.branch);
  if (blob === null) return null;
  return { bytes: blob.bytes, sha: blob.sha };
}
