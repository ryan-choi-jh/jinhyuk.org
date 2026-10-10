/**
 * src/cms/app/state/site-stub-api.ts
 *
 * WS-D. A `SiteApi` that is entirely in memory: no fetch, no network, no
 * GitHub, no WS-C. It is `./stub-api.ts` for phase 2, and it exists for the
 * same two reasons — the navigation shell has to be buildable, driveable and
 * screenshottable before WS-C's section-aware client lands, and afterwards
 * there has to be a deterministic fake to test against.
 *
 * It behaves like the real thing where that matters to the shell:
 *
 *  - every write validates, through the section: `validateDoc` for a document
 *    section, `section.records.validateFile` for a record section, rejecting
 *    with `formatIssues()` output (docs/cms-contracts.md 11).
 *  - `publish` copies the draft over the published file and deletes the draft,
 *    in one step, and publishing with no draft is an error.
 *  - a record collection is one file, so `putRecords` is the only way a film
 *    is added, edited, deleted or moved.
 *  - everything is deep cloned in and out, so a caller holding a reference
 *    cannot reach into the "server".
 *  - uploads answer with `mediaSrcFor(section, slug, file)`, so the `src` a
 *    photo gets in the harness is the one the real endpoint would write.
 *
 * It also implements the optional `deleteEntry`, which section 11 has no
 * endpoint for, so the entry list's Delete is driveable. Pass
 * `canDeleteEntry: false` to get an API that does not, which is how the
 * disabled state is verified.
 */

import { formatIssues, validateDoc } from '../../schema.ts';
import type { Doc, RecordFile, SectionId } from '../../schema.ts';
import { SECTIONS, isRecordSection, mediaSrcFor, requireSection } from '../../sections.ts';
import type { DocumentSectionDef, RecordSectionDef, SectionDef } from '../../sections.ts';
import { CmsApiError } from './api.ts';
import type { AuthStatus, CommitResult, MediaUploadResult, OkResult, PageDocs } from './api.ts';
import type { EntrySummary, RecordDocs, SectionSummary, SiteApi } from './site-api.ts';

/* -------------------------------------------------------------------------- */
/* Seeds                                                                       */
/* -------------------------------------------------------------------------- */

export type StubEntry = {
  published: Doc | null;
  draft: Doc | null;
};

export type StubSiteApiOptions = {
  /** Document sections: section id -> slug -> the two documents. */
  docs?: Partial<Record<SectionId, Record<string, Partial<StubEntry>>>>;
  /** Record sections: section id -> the two collection files. */
  records?: Partial<Record<SectionId, Partial<RecordDocs>>>;
  /** Artificial delay on every call, in ms. Default 0. */
  latencyMs?: number;
  auth?: AuthStatus;
  /** Dimensions `uploadMedia` reports when it cannot measure the file. */
  mediaSize?: { w: number; h: number };
  /** Omit the optional `deleteEntry` method. Default true, i.e. it exists. */
  canDeleteEntry?: boolean;
};

export type StubSiteCall = {
  method: keyof SiteApi;
  section?: SectionId;
  slug?: string | null;
  at: number;
};

/** Everything a test needs on top of `SiteApi`. Not part of the interface. */
export type StubSiteApi = SiteApi & {
  readonly calls: StubSiteCall[];
  /** Deep copy of the whole in-memory server, for assertions. */
  snapshot(): {
    docs: Record<string, Record<string, StubEntry>>;
    records: Record<string, RecordDocs>;
  };
  /** Make the next call of `method` reject with `message`. */
  failNext(method: keyof SiteApi, message: string): void;
  setEntry(section: SectionId, slug: string, entry: Partial<StubEntry>): void;
  setRecords(section: SectionId, files: Partial<RecordDocs>): void;
};

const DEFAULT_AUTH: AuthStatus = { signedIn: true, login: 'stub' };

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/* -------------------------------------------------------------------------- */
/* The stub                                                                    */
/* -------------------------------------------------------------------------- */

export function createStubSiteApi(options: StubSiteApiOptions = {}): StubSiteApi {
  const latency = options.latencyMs ?? 0;
  const auth = options.auth ?? DEFAULT_AUTH;
  const mediaSize = options.mediaSize ?? { w: 1200, h: 800 };

  /** section id -> slug -> entry. A singleton keeps its one entry under ''. */
  const docs = new Map<SectionId, Map<string, StubEntry>>();
  /** section id -> the collection's two files. */
  const files = new Map<SectionId, RecordDocs>();

  for (const section of SECTIONS) {
    if (isRecordSection(section)) files.set(section.id, { published: null, draft: null });
    else docs.set(section.id, new Map<string, StubEntry>());
  }

  const calls: StubSiteCall[] = [];
  const failures = new Map<keyof SiteApi, string>();
  let commitCounter = 0;

  /** The slug a singleton's one entry is filed under internally. */
  const SINGLETON = '';

  function section_(id: SectionId): SectionDef {
    const found = SECTIONS.find((candidate) => candidate.id === id);
    if (found === undefined) throw new CmsApiError(`no section "${id}"`, { status: 404 });
    return found;
  }

  function documentSection(id: SectionId): DocumentSectionDef {
    const section = section_(id);
    if (isRecordSection(section)) {
      throw new CmsApiError(`section "${id}" holds records, not documents`, { status: 400 });
    }
    return section;
  }

  function recordSection(id: SectionId): RecordSectionDef {
    const section = section_(id);
    if (!isRecordSection(section)) {
      throw new CmsApiError(`section "${id}" holds documents, not records`, { status: 400 });
    }
    return section;
  }

  /** `null` for a singleton means the one entry; a collection must say which. */
  function keyFor(section: SectionDef, slug: string | null): string {
    if (section.shape === 'singleton') return SINGLETON;
    if (slug === null || slug === '') {
      throw new CmsApiError(`section "${section.id}" is a collection; :slug is required`, {
        status: 400,
      });
    }
    return slug;
  }

  function bucket(section: SectionDef): Map<string, StubEntry> {
    const map = docs.get(section.id);
    if (map === undefined) throw new CmsApiError(`no document bucket for "${section.id}"`, { status: 500 });
    return map;
  }

  function entryOrNew(section: SectionDef, key: string): StubEntry {
    const map = bucket(section);
    const existing = map.get(key);
    if (existing !== undefined) return existing;
    const fresh: StubEntry = { published: null, draft: null };
    map.set(key, fresh);
    return fresh;
  }

  async function enter(method: keyof SiteApi, section?: SectionId, slug?: string | null): Promise<void> {
    calls.push({ method, section, slug, at: Date.now() });
    if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
    const failure = failures.get(method);
    if (failure !== undefined) {
      failures.delete(method);
      throw new CmsApiError(failure, { status: 500 });
    }
  }

  /** Looks like a sha, is not one. Monotonic, so two writes are tellable apart. */
  function nextCommit(): string {
    commitCounter += 1;
    return `stub${String(commitCounter).padStart(4, '0')}${'0'.repeat(32)}`.slice(0, 40);
  }

  function entriesOf(section: SectionDef): EntrySummary[] {
    if (isRecordSection(section)) {
      const pair = files.get(section.id) ?? { published: null, draft: null };
      const file = pair.draft ?? pair.published ?? section.records.empty();
      const hasDraft = pair.draft !== null;
      const hasPublished = pair.published !== null;
      return section.records.summarise(file).map((summary) => ({
        key: summary.key,
        title: summary.title,
        subtitle: summary.subtitle,
        thumb: summary.thumb,
        hasDraft,
        hasPublished,
      }));
    }

    const rows: EntrySummary[] = [];
    for (const [key, entry] of bucket(section).entries()) {
      const doc = entry.draft ?? entry.published;
      if (doc === null) continue;
      rows.push({
        key: section.shape === 'singleton' ? doc.meta.slug : key,
        title: doc.meta.title,
        hasDraft: entry.draft !== null,
        hasPublished: entry.published !== null,
        date: doc.meta.date,
        ...(doc.meta.cover === undefined ? {} : { thumb: doc.meta.cover }),
      });
    }
    // Newest first, which is how the site orders both document collections.
    rows.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.key.localeCompare(b.key));
    return rows;
  }

  const api: StubSiteApi = {
    calls,

    async listSections(): Promise<SectionSummary[]> {
      await enter('listSections');
      return SECTIONS.map((section) => {
        const rows = entriesOf(section);
        return {
          id: section.id,
          label: section.label,
          shape: section.shape,
          storage: section.storage,
          count: section.shape === 'singleton' ? 1 : rows.length,
          hasDraft: rows.some((row) => row.hasDraft),
        };
      });
    },

    async listEntries(id: SectionId): Promise<EntrySummary[]> {
      await enter('listEntries', id);
      return entriesOf(section_(id));
    },

    async getEntry(id: SectionId, slug: string | null): Promise<PageDocs> {
      await enter('getEntry', id, slug);
      const section = documentSection(id);
      const key = keyFor(section, slug);
      const entry = bucket(section).get(key);
      if (entry === undefined) {
        throw new CmsApiError(`no ${section.noun} "${slug ?? section.id}"`, { status: 404 });
      }
      return {
        published: entry.published === null ? null : clone(entry.published),
        draft: entry.draft === null ? null : clone(entry.draft),
      };
    },

    async putDraft(id: SectionId, slug: string | null, doc: Doc): Promise<CommitResult> {
      await enter('putDraft', id, slug);
      const section = documentSection(id);
      const key = keyFor(section, slug);

      const result = validateDoc(doc);
      if (!result.ok) {
        const issues = formatIssues(result.issues);
        throw new CmsApiError(`invalid document:\n${issues}`, { status: 400, issues });
      }
      if (section.shape === 'collection' && result.doc.meta.slug !== key) {
        throw new CmsApiError(
          `slug mismatch: body says "${result.doc.meta.slug}", path says "${key}"`,
          { status: 400 },
        );
      }
      if (result.doc.meta.section !== undefined && result.doc.meta.section !== id) {
        throw new CmsApiError(
          `section mismatch: body says "${result.doc.meta.section}", path says "${id}"`,
          { status: 400 },
        );
      }
      entryOrNew(section, key).draft = clone(result.doc);
      return { ok: true, commit: nextCommit() };
    },

    async deleteDraft(id: SectionId, slug: string | null): Promise<OkResult> {
      await enter('deleteDraft', id, slug);
      const section = section_(id);

      if (isRecordSection(section)) {
        const pair = files.get(id);
        if (pair === undefined || pair.draft === null) {
          throw new CmsApiError(`no draft for "${id}"`, { status: 404 });
        }
        pair.draft = null;
        return { ok: true };
      }

      const key = keyFor(section, slug);
      const entry = bucket(section).get(key);
      if (entry === undefined || entry.draft === null) {
        throw new CmsApiError(`no draft for "${slug ?? id}"`, { status: 404 });
      }
      entry.draft = null;
      return { ok: true };
    },

    async publish(id: SectionId, slug: string | null): Promise<CommitResult> {
      await enter('publish', id, slug);
      const section = section_(id);

      if (isRecordSection(section)) {
        const pair = files.get(id);
        if (pair === undefined || pair.draft === null) {
          throw new CmsApiError(`no draft to publish for "${id}"`, { status: 409 });
        }
        pair.published = pair.draft;
        pair.draft = null;
        return { ok: true, commit: nextCommit() };
      }

      const key = keyFor(section, slug);
      const entry = bucket(section).get(key);
      if (entry === undefined || entry.draft === null) {
        throw new CmsApiError(`no draft to publish for "${slug ?? id}"`, { status: 409 });
      }
      entry.published = entry.draft;
      entry.draft = null;
      return { ok: true, commit: nextCommit() };
    },

    async getRecords(id: SectionId): Promise<RecordDocs> {
      await enter('getRecords', id);
      recordSection(id);
      const pair = files.get(id) ?? { published: null, draft: null };
      return {
        published: pair.published === null ? null : clone(pair.published),
        draft: pair.draft === null ? null : clone(pair.draft),
      };
    },

    async putRecords(id: SectionId, file: RecordFile): Promise<CommitResult> {
      await enter('putRecords', id);
      const section = recordSection(id);
      const result = section.records.validateFile(file);
      if (!result.ok) {
        const issues = formatIssues(result.issues);
        throw new CmsApiError(`invalid ${section.id}:\n${issues}`, { status: 400, issues });
      }
      const pair = files.get(id) ?? { published: null, draft: null };
      pair.draft = clone(result.data);
      files.set(id, pair);
      return { ok: true, commit: nextCommit() };
    },

    async uploadMedia(id: SectionId, slug: string | null, file: File): Promise<MediaUploadResult> {
      await enter('uploadMedia', id, slug);
      const section = section_(id);
      const name = sanitizeFileName(file.name);
      const measured = await measureImage(file);
      return {
        ok: true,
        src: mediaSrcFor(section, slug, name),
        w: measured?.w ?? mediaSize.w,
        h: measured?.h ?? mediaSize.h,
      };
    },

    async authStatus(): Promise<AuthStatus> {
      await enter('authStatus');
      return { ...auth };
    },

    snapshot() {
      const outDocs: Record<string, Record<string, StubEntry>> = {};
      for (const [id, map] of docs.entries()) {
        const section: Record<string, StubEntry> = {};
        for (const [key, entry] of map.entries()) {
          section[key] = {
            published: entry.published === null ? null : clone(entry.published),
            draft: entry.draft === null ? null : clone(entry.draft),
          };
        }
        outDocs[id] = section;
      }
      const outFiles: Record<string, RecordDocs> = {};
      for (const [id, pair] of files.entries()) {
        outFiles[id] = {
          published: pair.published === null ? null : clone(pair.published),
          draft: pair.draft === null ? null : clone(pair.draft),
        };
      }
      return { docs: outDocs, records: outFiles };
    },

    failNext(method, message) {
      failures.set(method, message);
    },

    setEntry(id, slug, entry) {
      const section = documentSection(id);
      bucket(section).set(keyFor(section, slug), {
        published: entry.published === undefined || entry.published === null ? null : clone(entry.published),
        draft: entry.draft === undefined || entry.draft === null ? null : clone(entry.draft),
      });
    },

    setRecords(id, pair) {
      recordSection(id);
      files.set(id, {
        published: pair.published === undefined || pair.published === null ? null : clone(pair.published),
        draft: pair.draft === undefined || pair.draft === null ? null : clone(pair.draft),
      });
    },
  };

  /**
   * Optional (docs/cms-contracts.md 11 has no endpoint for it), so it is a
   * property added conditionally rather than a method that throws: the shell
   * tests for it with `canDeleteEntry(api)`.
   */
  if (options.canDeleteEntry !== false) {
    api.deleteEntry = async (id: SectionId, slug: string): Promise<OkResult> => {
      await enter('deleteEntry', id, slug);
      const section = documentSection(id);
      if (section.shape === 'singleton') {
        throw new CmsApiError(`"${section.label}" is a singleton; it cannot be deleted`, { status: 400 });
      }
      const map = bucket(section);
      if (!map.has(slug)) {
        throw new CmsApiError(`no ${section.noun} "${slug}"`, { status: 404 });
      }
      map.delete(slug);
      return { ok: true };
    };
  }

  /* Seeds, after construction so they go through the same validation path as
     a write would if the caller asks for it. They are trusted here: a fixture
     that does not validate is the harness's problem, and it says so loudly. */
  for (const [id, entries] of Object.entries(options.docs ?? {})) {
    if (entries === undefined) continue;
    const section = requireSection(id as SectionId);
    for (const [slug, entry] of Object.entries(entries)) {
      bucket(section).set(keyFor(section, section.shape === 'singleton' ? null : slug), {
        published: entry.published ?? null,
        draft: entry.draft ?? null,
      });
    }
  }
  for (const [id, pair] of Object.entries(options.records ?? {})) {
    if (pair === undefined) continue;
    files.set(id as SectionId, { published: pair.published ?? null, draft: pair.draft ?? null });
  }

  return api;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** The uploaded `src` has to match `SrcSchema`, so no spaces and no oddities. */
function sanitizeFileName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'file';
}

/**
 * Real intrinsic dimensions when the stub is running in a browser, because
 * `newPhoto(src, { w, h })` wants them and an album grid that reserves space
 * from them would otherwise jump. Falls back to the configured size where
 * there is no DOM. Uses an object URL, so still no network.
 */
async function measureImage(file: File): Promise<{ w: number; h: number } | null> {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  if (!file.type.startsWith('image/')) return null;
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<{ w: number; h: number } | null>((resolve) => {
      const image = new Image();
      image.onload = () => resolve({ w: image.naturalWidth, h: image.naturalHeight });
      image.onerror = () => resolve(null);
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
