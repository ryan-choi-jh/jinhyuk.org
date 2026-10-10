/**
 * src/cms/app/state/stub-api.ts
 *
 * WS-3. A `CmsApi` that is entirely in memory. No fetch, no network, no
 * GitHub. It exists so the editor shell can be built, driven and screenshotted
 * before WS-2's real client lands, and so there is a deterministic fake for
 * tests afterwards.
 *
 * It behaves like the real thing in the ways that matter to the shell:
 *
 *  - `putDraft` runs the body through `validateDoc` and rejects with
 *    `formatIssues()` output, exactly as docs/cms-contracts.md section 3 says
 *    WS-2 must.
 *  - `publish` copies the draft over the published document and deletes the
 *    draft (docs/cms-rebuild.md 2.3). Publishing with no draft is an error.
 *  - Documents are deep cloned on the way in and out, so the caller cannot
 *    reach into the "server" state by holding a reference.
 *  - Every method is async and can be given an artificial latency, so loading
 *    states are reachable in the harness.
 *
 * WS-8 replaces this with WS-2's client. Nothing in `src/cms/app/shell/`
 * imports it; only the harness and tests do.
 */

import { formatIssues, validateDoc } from '../../schema.ts';
import type { Doc } from '../../schema.ts';
import { CmsApiError } from './api.ts';
import type {
  AuthStatus,
  CmsApi,
  CommitResult,
  MediaUploadResult,
  OkResult,
  PageDocs,
  PageSummary,
} from './api.ts';
import { cloneDoc } from './doc-ops.ts';

export type StubPage = {
  published: Doc | null;
  draft: Doc | null;
};

export type StubApiOptions = {
  /** Starting server contents, keyed by slug. Pass fixtures here. */
  pages?: Record<string, StubPage>;
  /** Artificial delay on every call, in ms. Default 0. */
  latencyMs?: number;
  /** Who the stub says is signed in. Default `{ signedIn: true, login: 'stub' }`. */
  auth?: AuthStatus;
  /** Dimensions `uploadMedia` reports when it cannot measure the file. */
  mediaSize?: { w: number; h: number };
};

/** Everything a test needs on top of `CmsApi`. Not part of the interface. */
export type StubApi = CmsApi & {
  /** Deep copy of the whole in-memory server, for assertions. */
  snapshot(): Record<string, StubPage>;
  /** Ordered log of every call, for assertions. */
  readonly calls: StubCall[];
  /** Make the next call of `method` reject with `message`. */
  failNext(method: keyof CmsApi, message: string): void;
  /** Put a page into the stub after construction. */
  setPage(slug: string, page: StubPage): void;
};

export type StubCall = { method: keyof CmsApi; slug?: string; at: number };

const DEFAULT_AUTH: AuthStatus = { signedIn: true, login: 'stub' };

export function createStubApi(options: StubApiOptions = {}): StubApi {
  const latency = options.latencyMs ?? 0;
  const auth = options.auth ?? DEFAULT_AUTH;
  const mediaSize = options.mediaSize ?? { w: 1200, h: 800 };

  const pages = new Map<string, StubPage>();
  for (const [slug, page] of Object.entries(options.pages ?? {})) {
    pages.set(slug, {
      published: page.published === null ? null : cloneDoc(page.published),
      draft: page.draft === null ? null : cloneDoc(page.draft),
    });
  }

  const calls: StubCall[] = [];
  const failures = new Map<keyof CmsApi, string>();
  let commitCounter = 0;

  async function enter(method: keyof CmsApi, slug?: string): Promise<void> {
    calls.push({ method, slug, at: Date.now() });
    if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
    const failure = failures.get(method);
    if (failure !== undefined) {
      failures.delete(method);
      throw new CmsApiError(failure, { status: 500 });
    }
  }

  function page(slug: string): StubPage {
    const existing = pages.get(slug);
    if (existing !== undefined) return existing;
    const fresh: StubPage = { published: null, draft: null };
    pages.set(slug, fresh);
    return fresh;
  }

  /** Looks like a sha, is not one. Monotonic so a test can tell two writes apart. */
  function nextCommit(): string {
    commitCounter += 1;
    return `stub${String(commitCounter).padStart(4, '0')}${'0'.repeat(32)}`.slice(0, 40);
  }

  const api: StubApi = {
    calls,

    async listPages(): Promise<PageSummary[]> {
      await enter('listPages');
      return [...pages.entries()]
        .map(([slug, entry]) => {
          const doc = entry.draft ?? entry.published;
          return {
            slug,
            title: doc?.meta.title ?? slug,
            hasDraft: entry.draft !== null,
          };
        })
        .sort((a, b) => a.slug.localeCompare(b.slug));
    },

    async getPage(slug: string): Promise<PageDocs> {
      await enter('getPage', slug);
      const entry = pages.get(slug);
      if (entry === undefined) throw new CmsApiError(`no page "${slug}"`, { status: 404 });
      return {
        published: entry.published === null ? null : cloneDoc(entry.published),
        draft: entry.draft === null ? null : cloneDoc(entry.draft),
      };
    },

    async putDraft(slug: string, doc: Doc): Promise<CommitResult> {
      await enter('putDraft', slug);
      const result = validateDoc(doc);
      if (!result.ok) {
        const issues = formatIssues(result.issues);
        throw new CmsApiError(`invalid document:\n${issues}`, { status: 400, issues });
      }
      if (result.doc.meta.slug !== slug) {
        throw new CmsApiError(
          `slug mismatch: body says "${result.doc.meta.slug}", path says "${slug}"`,
          { status: 400 },
        );
      }
      page(slug).draft = cloneDoc(result.doc);
      return { ok: true, commit: nextCommit() };
    },

    async publish(slug: string): Promise<CommitResult> {
      await enter('publish', slug);
      const entry = pages.get(slug);
      if (entry === undefined || entry.draft === null) {
        throw new CmsApiError(`no draft to publish for "${slug}"`, { status: 409 });
      }
      entry.published = entry.draft;
      entry.draft = null;
      return { ok: true, commit: nextCommit() };
    },

    async deleteDraft(slug: string): Promise<OkResult> {
      await enter('deleteDraft', slug);
      const entry = pages.get(slug);
      if (entry === undefined || entry.draft === null) {
        throw new CmsApiError(`no draft for "${slug}"`, { status: 404 });
      }
      entry.draft = null;
      return { ok: true };
    },

    async uploadMedia(slug: string, file: File): Promise<MediaUploadResult> {
      await enter('uploadMedia', slug);
      const name = sanitizeFileName(file.name);
      const measured = await measureImage(file);
      return {
        ok: true,
        src: `/media/${slug}/${name}`,
        w: measured?.w ?? mediaSize.w,
        h: measured?.h ?? mediaSize.h,
      };
    },

    async authStatus(): Promise<AuthStatus> {
      await enter('authStatus');
      return { ...auth };
    },

    snapshot() {
      const out: Record<string, StubPage> = {};
      for (const [slug, entry] of pages.entries()) {
        out[slug] = {
          published: entry.published === null ? null : cloneDoc(entry.published),
          draft: entry.draft === null ? null : cloneDoc(entry.draft),
        };
      }
      return out;
    },

    failNext(method, message) {
      failures.set(method, message);
    },

    setPage(slug, entry) {
      pages.set(slug, {
        published: entry.published === null ? null : cloneDoc(entry.published),
        draft: entry.draft === null ? null : cloneDoc(entry.draft),
      });
    },
  };

  return api;
}

/** `/media/<slug>/<file>` has to match `SrcSchema`, so no spaces and no oddities. */
function sanitizeFileName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'file';
}

/**
 * Real intrinsic dimensions when the stub is running in a browser, because 3.5
 * requires `w` and `h` and the shell places an image from them. Falls back to
 * the configured size anywhere there is no DOM. Uses an object URL, so still
 * no network.
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
