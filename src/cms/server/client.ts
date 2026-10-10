/**
 * src/cms/server/client.ts
 *
 * WS-2's client for WS-2's API. The editor (WS-8) swaps this in for WS-3's
 * stub, so this file is the place where the endpoint shapes are written down
 * once in TypeScript instead of being guessed at a call site.
 *
 * Browser-safe: no node builtins, no Buffer, no imports from anything else in
 * this directory. Types only, from the schema.
 *
 * Every method either resolves with the useful part of the payload or throws
 * a CmsApiError carrying the status and, for a conflict, the two shas that
 * disagreed.
 */

import type { Doc, RecordEntry, RecordFile, SectionId } from '../schema.ts';
import type { RecordSummary, SectionShape, SectionStorage } from '../sections.ts';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type AuthStatus = {
  signedIn: boolean;
  login?: string;
  name?: string | null;
  /** Which repo and branch this deployment is editing. */
  repo: string;
  branch: string;
  /** The one login this editor accepts. */
  expects: string;
};

export type PageListEntry = {
  slug: string;
  title: string;
  hasDraft: boolean;
  hasPublished: boolean;
  /** The file on disk does not validate. Opening it will show the reason. */
  invalid?: boolean;
};

export type PageSnapshot = {
  published: Doc | null;
  draft: Doc | null;
  /** Pass back as `ifMatch` on the next write to get a 409 instead of clobbering. */
  publishedSha: string | null;
  draftSha: string | null;
  /** Set when the file exists but does not validate; the doc is null then. */
  publishedError?: string;
  draftError?: string;
};

export type WriteAck = { commit: string; sha: string };

/* -------------------------------------------------------------------------- */
/* Phase 2: sections (docs/cms-contracts.md 11)                                */
/* -------------------------------------------------------------------------- */

export type SectionListEntry = {
  id: SectionId;
  label: string;
  shape: SectionShape;
  storage: SectionStorage;
  /** Entries. 1 for a singleton. */
  count: number;
  /** Any draft anywhere in the section. */
  hasDraft: boolean;
};

export type EntryListEntry = {
  /** The slug, or a film's record id. What every other call takes. */
  key: string;
  title: string;
  /** Records only: "SHORT FILM · 2019", "2026 · 6 photos". */
  subtitle?: string;
  /** Records only. Null when the entry has no picture. */
  thumb?: string | null;
  hasDraft: boolean;
  hasPublished: boolean;
  /** The file on disk does not validate. Opening it will show the reason. */
  invalid?: boolean;
};

export type EntrySnapshot = PageSnapshot & {
  section: SectionId;
  key: string;
  /** Where this entry is on the live site, or the section index for a singleton. */
  siteUrl: string | null;
};

export type RecordsSnapshot = {
  section: SectionId;
  /** The one key inside the file: 'films' or 'albums'. */
  key: 'films' | 'albums';
  published: RecordFile | null;
  draft: RecordFile | null;
  publishedSha: string | null;
  draftSha: string | null;
  publishedError?: string;
  draftError?: string;
  /** List rows for whichever side the editor should show. */
  entries: RecordSummary[];
  entriesFrom: 'draft' | 'published' | 'none';
};

export type RecordsAck = WriteAck & {
  /** The collection as it was written, normalised by the schema. */
  data: RecordFile;
  entries: RecordSummary[];
};

/**
 * One server-side change to a record collection. The server reads, applies and
 * writes inside one request, so a reorder cannot drop an entry another tab
 * added in the meantime.
 *
 *   add      a new entry, at `index` or at the end
 *   update   replace one entry wholesale; its `id` may not change
 *   delete   remove one entry
 *   reorder  every key, in the new order
 *   move     one entry to a new index — what a drag lands on
 */
export type RecordOpRequest =
  | { op: 'add'; entry: RecordEntry; index?: number }
  | { op: 'update'; key: string; entry: RecordEntry }
  | { op: 'delete'; key: string }
  | { op: 'reorder'; keys: string[] }
  | { op: 'move'; key: string; to: number };

export type RecordOpAck = RecordsAck & {
  op: RecordOpRequest['op'];
  /** The key the op acted on, which may be a new one after a rename. */
  key: string;
  /** Which side the op was applied on top of. */
  basedOn: 'draft' | 'published' | 'none';
};

export type MediaUpload = {
  /** Goes straight into CanvasItem.src. */
  src: string;
  /** Intrinsic size, so an item can be placed before the file has loaded. */
  w: number;
  h: number;
  commit: string;
  path: string;
  /** 'intrinsic' from the pixels, 'declared' from SVG markup, 'fallback' for a guess. */
  dimensions: 'intrinsic' | 'declared' | 'fallback';
  format: string;
  bytes: number;
};

/** What the server believes is in the repo, when a write is refused. */
export type ConflictInfo = {
  path: string;
  expectedSha: string | null;
  actualSha: string | null;
};

export class CmsApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly conflict: ConflictInfo | undefined;

  constructor(status: number, message: string, code?: string, conflict?: ConflictInfo) {
    super(message);
    this.name = 'CmsApiError';
    this.status = status;
    this.code = code;
    this.conflict = conflict;
  }

  /** True when the fix is "reload, then redo" rather than "try again". */
  get isConflict(): boolean {
    return this.status === 409;
  }

  get isSignedOut(): boolean {
    return this.status === 401;
  }
}

/**
 * `undefined` lets the server quote whatever sha it reads, which still catches
 * a concurrent commit. A sha says "this is the version I loaded". `null` says
 * "there should be nothing there yet".
 */
export type ShaExpectation = string | null | undefined;

export type CmsClientOptions = {
  /** Defaults to the current origin. Set it to point a local editor at a deployment. */
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
};

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

export type CmsClient = {
  status(): Promise<AuthStatus>;
  /** Navigate the browser here to sign in; it is a redirect, not an API call. */
  loginUrl(returnTo?: string): string;
  signOut(): Promise<void>;
  listPages(): Promise<PageListEntry[]>;
  readPage(slug: string): Promise<PageSnapshot>;
  saveDraft(slug: string, doc: Doc, expect?: ShaExpectation): Promise<WriteAck>;
  deleteDraft(slug: string, expect?: ShaExpectation): Promise<{ commit: string }>;
  publish(slug: string, expect?: ShaExpectation): Promise<WriteAck & { title: string }>;
  uploadMedia(slug: string, file: Blob, filename?: string): Promise<MediaUpload>;

  /* Phase 2. `key` is omitted for a singleton section (home). */
  listSections(): Promise<SectionListEntry[]>;
  listEntries(section: SectionId): Promise<EntryListEntry[]>;
  readEntry(section: SectionId, key?: string | null): Promise<EntrySnapshot>;
  saveEntryDraft(
    section: SectionId,
    key: string | null,
    doc: Doc,
    expect?: ShaExpectation,
  ): Promise<WriteAck & { title: string }>;
  deleteEntryDraft(
    section: SectionId,
    key: string | null,
    expect?: ShaExpectation,
  ): Promise<{ commit: string }>;
  publishEntry(
    section: SectionId,
    key?: string | null,
    expect?: ShaExpectation,
  ): Promise<WriteAck & { title?: string }>;

  /* Record collections. One file, so no per-entry calls. */
  readRecords(section: SectionId): Promise<RecordsSnapshot>;
  saveRecords(
    section: SectionId,
    file: RecordFile,
    expect?: ShaExpectation,
  ): Promise<RecordsAck>;
  recordOp(
    section: SectionId,
    op: RecordOpRequest,
    expect?: ShaExpectation,
  ): Promise<RecordOpAck>;
  discardRecords(section: SectionId, expect?: ShaExpectation): Promise<{ commit: string }>;
  publishRecords(
    section: SectionId,
    expect?: ShaExpectation,
  ): Promise<WriteAck & { entries: RecordSummary[] }>;

  uploadSectionMedia(
    section: SectionId,
    key: string | null,
    file: Blob,
    filename?: string,
  ): Promise<MediaUpload>;
};

export function createCmsClient(options: CmsClientOptions = {}): CmsClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = (options.baseUrl ?? '').replace(/\/$/, '');

  const url = (path: string): string => `${base}/api/cms${path}`;

  /** If-Match / If-None-Match from a sha expectation. */
  const concurrencyHeaders = (expect: ShaExpectation): Record<string, string> => {
    if (expect === undefined) return {};
    if (expect === null) return { 'If-None-Match': '*' };
    return { 'If-Match': expect };
  };

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await doFetch(url(path), {
      credentials: 'same-origin',
      ...init,
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    if (text !== '') {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new CmsApiError(
          response.status,
          `The server did not answer with JSON (${response.status}).`,
        );
      }
    }
    if (!response.ok || body.ok !== true) {
      const message =
        typeof body.error === 'string'
          ? body.error
          : `Request failed with ${response.status}.`;
      const code = typeof body.code === 'string' ? body.code : undefined;
      const conflict =
        response.status === 409 && typeof body.path === 'string'
          ? {
              path: body.path,
              expectedSha: (body.expectedSha as string | null) ?? null,
              actualSha: (body.actualSha as string | null) ?? null,
            }
          : undefined;
      throw new CmsApiError(response.status, message, code, conflict);
    }
    return body as T;
  }

  const jsonInit = (method: string, payload: unknown, expect: ShaExpectation): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json', ...concurrencyHeaders(expect) },
    body: JSON.stringify(payload),
  });

  /**
   * `/draft/essays/my-essay`, or `/draft/home` for a singleton. The server
   * resolves a single segment that is a section id to that section, so the
   * singleton form is one segment and nothing has to pretend home has a slug.
   */
  const at = (verb: string, section: SectionId, key?: string | null): string => {
    const base = `/${verb}/${encodeURIComponent(section)}`;
    return key === undefined || key === null ? base : `${base}/${encodeURIComponent(key)}`;
  };

  /** The multipart body for an upload, with a filename that survives the trip. */
  const upload = (file: Blob, filename?: string): FormData => {
    const form = new FormData();
    // The filename matters: it becomes the name in the repo. A Blob from a
    // canvas or a paste has none, hence the parameter.
    const maybeNamed = file as unknown as { name?: unknown };
    const name =
      filename ??
      (typeof maybeNamed.name === 'string' && maybeNamed.name !== ''
        ? maybeNamed.name
        : 'upload.png');
    form.set('file', file, name);
    return form;
  };

  return {
    async status() {
      return request<AuthStatus>('/auth/status');
    },

    loginUrl(returnTo) {
      const query =
        returnTo === undefined ? '' : `?return=${encodeURIComponent(returnTo)}`;
      return url(`/auth/login${query}`);
    },

    async signOut() {
      await request<{ signedIn: false }>('/auth/signout', { method: 'POST' });
    },

    async listPages() {
      const body = await request<{ pages: PageListEntry[] }>('/pages');
      return body.pages;
    },

    async readPage(slug) {
      return request<PageSnapshot>(`/page/${encodeURIComponent(slug)}`);
    },

    async saveDraft(slug, doc, expect) {
      return request<WriteAck>(`/draft/${encodeURIComponent(slug)}`, jsonInit('PUT', doc, expect));
    },

    async deleteDraft(slug, expect) {
      return request<{ commit: string }>(`/draft/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
        headers: concurrencyHeaders(expect),
      });
    },

    async publish(slug, expect) {
      return request<WriteAck & { title: string }>(`/publish/${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: concurrencyHeaders(expect),
      });
    },

    async uploadMedia(slug, file, filename) {
      return request<MediaUpload>(`/media/${encodeURIComponent(slug)}`, {
        method: 'POST',
        body: upload(file, filename),
      });
    },

    /* ---------------------------------------------------------------- */
    /* Phase 2                                                           */
    /* ---------------------------------------------------------------- */

    async listSections() {
      const body = await request<{ sections: SectionListEntry[] }>('/sections');
      return body.sections;
    },

    async listEntries(section) {
      const body = await request<{ entries: EntryListEntry[] }>(
        `/entries/${encodeURIComponent(section)}`,
      );
      return body.entries;
    },

    async readEntry(section, key) {
      return request<EntrySnapshot>(at('entry', section, key));
    },

    async saveEntryDraft(section, key, doc, expect) {
      return request<WriteAck & { title: string }>(
        at('draft', section, key),
        jsonInit('PUT', doc, expect),
      );
    },

    async deleteEntryDraft(section, key, expect) {
      return request<{ commit: string }>(at('draft', section, key), {
        method: 'DELETE',
        headers: concurrencyHeaders(expect),
      });
    },

    async publishEntry(section, key, expect) {
      return request<WriteAck & { title?: string }>(at('publish', section, key), {
        method: 'POST',
        headers: concurrencyHeaders(expect),
      });
    },

    async readRecords(section) {
      return request<RecordsSnapshot>(`/records/${encodeURIComponent(section)}`);
    },

    async saveRecords(section, file, expect) {
      return request<RecordsAck>(
        `/records/${encodeURIComponent(section)}`,
        jsonInit('PUT', file, expect),
      );
    },

    async recordOp(section, op, expect) {
      return request<RecordOpAck>(
        `/records/${encodeURIComponent(section)}`,
        jsonInit('POST', op, expect),
      );
    },

    async discardRecords(section, expect) {
      return request<{ commit: string }>(`/records/${encodeURIComponent(section)}`, {
        method: 'DELETE',
        headers: concurrencyHeaders(expect),
      });
    },

    async publishRecords(section, expect) {
      return request<WriteAck & { entries: RecordSummary[] }>(
        `/publish/${encodeURIComponent(section)}`,
        { method: 'POST', headers: concurrencyHeaders(expect) },
      );
    },

    async uploadSectionMedia(section, key, file, filename) {
      return request<MediaUpload>(at('media', section, key), {
        method: 'POST',
        body: upload(file, filename),
      });
    },
  };
}
