/**
 * src/cms/preview/source.ts
 *
 * WS-7, extended by WS-H. Where the preview gets its content.
 *
 * The real source is WS-C: `readEntry(ctx, section, key)` returns a published
 * document, its draft and their shas, and `readRecords(ctx, section)` does the
 * same for a record collection — both already validated. This file does not
 * reimplement any of that and does not talk to GitHub itself. It exists for
 * three things the API deliberately does not do, because they are the
 * preview's problem and not the API's:
 *
 *  1. NOT THROWING. `ctxFrom` is a 401 when there is no session, which is
 *     right for an endpoint and wrong for a page: a page should render a
 *     "sign in to GitHub" link, not a JSON error. So the token is fetched with
 *     `sessionToken` and the absence of one is a state, not an exception.
 *
 *  2. A LOCAL MODE, under `astro dev` only. The preview is the one part of the
 *     CMS that is worth looking at before the editor can write anything, and
 *     a verification run must not need a GitHub token, a network, or a commit
 *     to a branch. With `CMS_PREVIEW_LOCAL_DIR` set it reads a directory
 *     laid out like `src/content/` itself; with nothing set and no session it
 *     reads the working tree. Both are gated on `isDev()`, which Vite replaces
 *     with `false` in either production build, exactly as WS-2 gates
 *     CMS_DEV_TOKEN. The deployed preview can only ever read GitHub.
 *
 *  3. MEDIA THAT EXISTS YET. The editor runs on Vercel and the media it
 *     uploads is committed to the repo, so a picture added five minutes ago is
 *     in git but not in this deployment's `public/`, and not on GitHub Pages
 *     until it rebuilds. The preview would show a broken image for the one
 *     image you most want to look at. src/preview/project-preview.astro
 *     already solves this by pointing media at raw.githubusercontent on the
 *     branch being edited; `rewriteMediaForBranch` is the same trick, narrowed
 *     to `/media/` so it cannot touch anything else the renderer emitted.
 *
 * WS-H'S CHANGES. Three, and the first one is a bug fix:
 *
 *  - PATHS COME FROM THE REGISTRY NOW. Phase 1 joined `src/content/pages` with
 *    `<slug>.json`, which was right when every document was
 *    `src/content/pages/<slug>.json` and is one directory short of a project
 *    since WS-A moved them into `pages/projects/`. Every path here is now
 *    `contentPathFor`/`draftPathFor`, so local mode and GitHub mode read the
 *    same file. (Reported by WS-C; it was mine to fix.)
 *  - RECORD COLLECTIONS, read the same way, through `readRecords` and the
 *    section's own `validateFile`.
 *  - THE LEDGER INDEXES, which are a list of documents rather than one, so
 *    they need every entry's `meta` and not just its title.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { formatIssues, validateDocJson } from '../schema.ts';
import type { Doc, DocMeta, RecordFile } from '../schema.ts';
import type { LedgerItem } from '../render/pages/ledger.ts';
import { ledgerItemsFromMetas } from '../render/pages/ledger.ts';
import {
  CONTENT_ROOT,
  contentDirFor,
  contentPathFor,
  draftDirFor,
  draftPathFor,
  isRecordSection,
  needsSlug,
  slugFromFilename,
} from '../sections.ts';
import type { DocumentSectionDef, RecordSectionDef, SectionDef } from '../sections.ts';
import type { CookieJar } from '../server/auth.ts';
import { sessionToken } from '../server/auth.ts';
import { REPO, defaultBranch, env, isDev } from '../server/config.ts';
import { messageOf } from '../server/errors.ts';
import { publishedKeys, readRecords } from '../server/records.ts';
import { listEntries, listPages, readEntry, readPage } from '../server/store.ts';
import type { Ctx, EntrySummary, PageSummary } from '../server/store.ts';
import { parseTargetPath, sectionNav, targetPath } from './target.ts';
import type { PreviewTarget } from './target.ts';

/* -------------------------------------------------------------------------- */
/* Which source                                                              */
/* -------------------------------------------------------------------------- */

export type SourceKind = 'github' | 'local' | 'none';

export type PreviewSource = {
  kind: SourceKind;
  /** github: the branch being read. */
  branch: string | null;
  /** local: the directory standing in for `src/content/`. */
  root: string | null;
  /** Whether a GitHub session was found. False in local mode. */
  signedIn: boolean;
  /** One line for the toolbar, so it is never a mystery what you are looking at. */
  label: string;
};

/**
 * The local root, or null when local mode is off.
 *
 * `CMS_PREVIEW_LOCAL_DIR` is an explicit instruction and wins over a session,
 * because that is what makes a verification run deterministic: the point of
 * setting it is "read these files, not the repo". Without it, local mode is
 * only the fallback for `astro dev` with no token at all.
 */
function localRoot(signedIn: boolean): string | null {
  if (!isDev()) return null;
  const pinned = env('CMS_PREVIEW_LOCAL_DIR');
  if (pinned !== undefined && pinned !== '') return resolve(pinned);
  if (signedIn) return null;
  return process.cwd();
}

/** True when the root stands in for `src/content/` rather than for the repo. */
function isPinned(): boolean {
  const pinned = env('CMS_PREVIEW_LOCAL_DIR');
  return pinned !== undefined && pinned !== '';
}

const CONTENT_PREFIX = `${CONTENT_ROOT}/`;

/**
 * A repository-relative content path, as a path on this disk.
 *
 * A pinned directory IS `src/content/`, so the prefix comes off; the working
 * tree holds the path as written. One function for both, so there is no
 * per-section rule and no second place that knows the layout.
 */
function localPath(root: string, repoPath: string): string {
  if (!isPinned()) return join(root, repoPath);
  const relative = repoPath.startsWith(CONTENT_PREFIX)
    ? repoPath.slice(CONTENT_PREFIX.length)
    : repoPath;
  return join(root, relative);
}

export async function resolveSource(cookies: CookieJar): Promise<PreviewSource> {
  let token: string | null = null;
  try {
    token = await sessionToken(cookies);
  } catch {
    // A dead refresh token is a sign-out, not a failure to render a page.
    token = null;
  }
  const root = localRoot(token !== null);
  if (root !== null) {
    return {
      kind: 'local',
      branch: null,
      root,
      signedIn: false,
      label: `local files · ${(isPinned() ? root : join(root, CONTENT_ROOT)).replace(`${process.cwd()}/`, '')}`,
    };
  }
  if (token !== null) {
    const branch = defaultBranch();
    return {
      kind: 'github',
      branch,
      root: null,
      signedIn: true,
      label: `${REPO} · ${branch}`,
    };
  }
  return { kind: 'none', branch: null, root: null, signedIn: false, label: 'not signed in' };
}

async function ctxFor(cookies: CookieJar): Promise<Ctx | null> {
  const token = await sessionToken(cookies);
  if (token === null) return null;
  return { token, branch: defaultBranch() };
}

/* -------------------------------------------------------------------------- */
/* Reading a file locally                                                    */
/* -------------------------------------------------------------------------- */

type Parsed<T> = { value: T | null; error?: string };

type Parse<T> = (text: string) => { ok: true; value: T } | { ok: false; error: string };

const parseDocText: Parse<Doc> = (text) => {
  const result = validateDocJson(text);
  return result.ok
    ? { ok: true, value: result.doc }
    : { ok: false, error: formatIssues(result.issues) };
};

function parseRecordText(section: RecordSectionDef): Parse<RecordFile> {
  return (text) => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      return { ok: false, error: `invalid JSON: ${messageOf(error)}` };
    }
    const result = section.records.validateFile(value);
    return result.ok
      ? { ok: true, value: result.data }
      : { ok: false, error: formatIssues(result.issues) };
  };
}

/**
 * Read one file, with the same semantics WS-C's `readSlot` has: a file that is
 * there but does not validate reports an error and a null value, rather than
 * reading as absent. Absence would tell the preview there is nothing there,
 * which is a different and much more confusing thing to be told.
 */
function readLocalFile<T>(paths: readonly (string | null)[], parse: Parse<T>): Parsed<T> {
  for (const path of paths) {
    if (path === null || !existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      return { value: null, error: messageOf(error) };
    }
    const result = parse(text);
    if (!result.ok) return { value: null, error: result.error };
    return { value: result.value };
  }
  return { value: null };
}

/**
 * Where one side of one document is: the registry's path, and only that.
 *
 * Phase 1's flat pinned layout (`pages/<slug>.json`) is NOT consulted here,
 * and the reason is worth recording because the fallback was written and then
 * taken out. `pages/` now holds `home.json` beside the `essays/` and
 * `projects/` directories, so a fallback that listed it as a flat collection
 * gave the essays index a row called "home". A directory layout you half
 * support is worse than one you do not: `loadPreview` below keeps the flat
 * read for the one phase 1 call that needs it, and the routes read one layout.
 */
function localDocPaths(
  root: string,
  section: DocumentSectionDef,
  key: string | null,
  side: 'draft' | 'published',
): (string | null)[] {
  const repoPath = side === 'draft' ? draftPathFor(section, key) : contentPathFor(section, key);
  return [localPath(root, repoPath)];
}

/* -------------------------------------------------------------------------- */
/* One document                                                              */
/* -------------------------------------------------------------------------- */

/** Both sides of one content slot, whatever the slot holds. */
export type Sides<T> = {
  published: T | null;
  draft: T | null;
  /** Set when the file is there but does not validate. The value is null then. */
  publishedError?: string;
  draftError?: string;
};

export type DocSides = Sides<Doc>;
export type RecordSides = Sides<RecordFile>;

/** Phase 1's shape, kept because selftest.ts and the e2e run read it. */
export type PreviewLoad = DocSides & {
  slug: string;
  source: PreviewSource;
  /** Set when the source itself could not be read at all. */
  loadError?: string;
};

async function loadDocSides(
  cookies: CookieJar,
  source: PreviewSource,
  section: DocumentSectionDef,
  key: string | null,
): Promise<DocSides & { loadError?: string }> {
  if (source.kind === 'local' && source.root !== null) {
    const draft = readLocalFile(localDocPaths(source.root, section, key, 'draft'), parseDocText);
    const published = readLocalFile(
      localDocPaths(source.root, section, key, 'published'),
      parseDocText,
    );
    const sides: DocSides = { published: published.value, draft: draft.value };
    if (draft.error !== undefined) sides.draftError = draft.error;
    if (published.error !== undefined) sides.publishedError = published.error;
    return sides;
  }
  if (source.kind !== 'github') return { published: null, draft: null };
  try {
    const ctx = await ctxFor(cookies);
    if (ctx === null) return { published: null, draft: null };
    const read = await readEntry(ctx, section, key);
    const sides: DocSides = { published: read.published, draft: read.draft };
    if (read.draftError !== undefined) sides.draftError = read.draftError;
    if (read.publishedError !== undefined) sides.publishedError = read.publishedError;
    return sides;
  } catch (error) {
    return { published: null, draft: null, loadError: messageOf(error) };
  }
}

async function loadRecordSides(
  cookies: CookieJar,
  source: PreviewSource,
  section: RecordSectionDef,
): Promise<RecordSides & { loadError?: string }> {
  if (source.kind === 'local' && source.root !== null) {
    const parse = parseRecordText(section);
    const draft = readLocalFile([localPath(source.root, draftPathFor(section))], parse);
    const published = readLocalFile([localPath(source.root, contentPathFor(section))], parse);
    const sides: RecordSides = { published: published.value, draft: draft.value };
    if (draft.error !== undefined) sides.draftError = draft.error;
    if (published.error !== undefined) sides.publishedError = published.error;
    return sides;
  }
  if (source.kind !== 'github') return { published: null, draft: null };
  try {
    const ctx = await ctxFor(cookies);
    if (ctx === null) return { published: null, draft: null };
    const read = await readRecords(ctx, section);
    const sides: RecordSides = { published: read.published, draft: read.draft };
    if (read.draftError !== undefined) sides.draftError = read.draftError;
    if (read.publishedError !== undefined) sides.publishedError = read.publishedError;
    return sides;
  } catch (error) {
    return { published: null, draft: null, loadError: messageOf(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* A ledger: every document in a collection                                  */
/* -------------------------------------------------------------------------- */

/**
 * An index page is a list of other pages, so its draft/published toggle means
 * something slightly different and worth being precise about:
 *
 *   published   the rows the live site would build right now: published
 *               documents only.
 *   draft       the rows it would build if everything were published: the
 *               draft of an entry that has one, the published file otherwise.
 *
 * So a new essay saved as a draft appears in the draft view and not in the
 * published one, which is exactly the question an index preview is asked.
 */
export type LedgerSides = {
  published: DocMeta[];
  /** Null when no entry in the section has a draft, so the toggle can say so. */
  draft: DocMeta[] | null;
  /**
   * The same read, as entry rows. Reading a collection's documents is the
   * expensive part of this page, and the chrome's entry picker wants exactly
   * what has just been read, so it comes back with the rows rather than being
   * asked for all over again.
   */
  entries: EntrySummary[];
};

/** Bounded concurrency. WS-C's store does the same, with the same ceiling. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function localSlugs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .map((name) => slugFromFilename(name))
      .filter((slug): slug is string => slug !== null);
  } catch {
    return [];
  }
}

async function loadLedgerSides(
  cookies: CookieJar,
  source: PreviewSource,
  section: DocumentSectionDef,
): Promise<LedgerSides & { loadError?: string }> {
  if (source.kind === 'local' && source.root !== null) {
    const contentDir = localPath(source.root, contentDirFor(section));
    const draftDir = localPath(source.root, draftDirFor(section));
    const published = new Set(localSlugs(contentDir));
    const drafts = new Set(localSlugs(draftDir));
    const keys = [...new Set([...published, ...drafts])].sort();
    const publishedMetas: DocMeta[] = [];
    const draftMetas: DocMeta[] = [];
    const entries: EntrySummary[] = [];
    for (const key of keys) {
      const live = readLocalFile(
        localDocPaths(source.root, section, key, 'published'),
        parseDocText,
      );
      const work = readLocalFile(localDocPaths(source.root, section, key, 'draft'), parseDocText);
      if (live.value !== null) publishedMetas.push(live.value.meta);
      const working = work.value ?? live.value;
      if (working !== null) draftMetas.push(working.meta);
      const row: EntrySummary = {
        key,
        title: working?.meta.title ?? key,
        hasDraft: drafts.has(key),
        hasPublished: published.has(key),
      };
      if (working === null) row.invalid = true;
      entries.push(row);
    }
    return {
      published: publishedMetas,
      draft: drafts.size > 0 ? draftMetas : null,
      entries,
    };
  }

  if (source.kind !== 'github') return { published: [], draft: null, entries: [] };

  try {
    const ctx = await ctxFor(cookies);
    if (ctx === null) return { published: [], draft: null, entries: [] };
    const entries = await listEntries(ctx, section);
    // One read per entry, both sides at once. A personal site's essays index
    // is a handful of small files; the cap keeps it polite rather than fast.
    const reads = await mapLimit(entries, 6, async (entry) => readEntry(ctx, section, entry.key));
    const published: DocMeta[] = [];
    const draft: DocMeta[] = [];
    for (const read of reads) {
      if (read.published !== null) published.push(read.published.meta);
      const working = read.draft ?? read.published;
      if (working !== null) draft.push(working.meta);
    }
    return {
      published,
      draft: entries.some((entry) => entry.hasDraft) ? draft : null,
      entries,
    };
  } catch (error) {
    return { published: [], draft: null, entries: [], loadError: messageOf(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* One target                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The content behind a target, discriminated the same way the target is, so
 * the route switches once and the compiler checks that every surface is
 * handled.
 */
export type TargetContent =
  | ({ surface: 'document' } & DocSides)
  | ({ surface: 'ledger' } & LedgerSides)
  | ({ surface: 'films' | 'albums' | 'album' } & RecordSides);

export type TargetLoad = {
  target: PreviewTarget;
  source: PreviewSource;
  content: TargetContent;
  /** Every entry in this target's section, for the chrome's picker. */
  entries: EntrySummary[];
  /** Set when the source itself could not be read at all. */
  loadError?: string;
};

/** Which of the two versions exist, for `resolveVersion`. */
export function availabilityOf(content: TargetContent): { draft: boolean; published: boolean } {
  if (content.surface === 'ledger') {
    return { draft: content.draft !== null, published: content.published.length > 0 };
  }
  return { draft: content.draft !== null, published: content.published !== null };
}

/** The validation errors on whichever sides have them, as lines for the notice. */
export function problemsOf(load: TargetLoad): string[] {
  const problems: string[] = [];
  if (load.loadError !== undefined) problems.push(load.loadError);
  const content = load.content;
  if (content.surface === 'ledger') return problems;
  if (content.draftError !== undefined) problems.push(`The draft does not validate: ${content.draftError}`);
  if (content.publishedError !== undefined) {
    problems.push(`The published file does not validate: ${content.publishedError}`);
  }
  return problems;
}

/**
 * Entry rows for the section a target belongs to.
 *
 * Free for a record section, because the collection is one file that has
 * already been read; a request per entry for a document collection, which is
 * why the ledger surface reuses what it read rather than asking twice.
 */
async function entriesFor(
  cookies: CookieJar,
  source: PreviewSource,
  section: SectionDef,
): Promise<EntrySummary[]> {
  if (source.kind === 'local' && source.root !== null) {
    if (isRecordSection(section)) {
      const sides = await loadRecordSides(cookies, source, section);
      const working = sides.draft ?? sides.published;
      if (working === null) return [];
      // PER ENTRY, not per collection. The draft and the published file are
      // one file each, so "this section has a draft" is one boolean — but
      // whether THIS film is live is a different question, and answering it
      // with the collection's boolean badged a draft-only film as published.
      // `publishedKeys` is WS-C's own answer, and it matches on the record id
      // as well as the key so a renamed album is still recognised as live.
      const live = publishedKeys(section, sides.published);
      return section.records.summarise(working).map((row) => ({
        key: row.key,
        title: row.title,
        subtitle: row.subtitle,
        thumb: row.thumb,
        hasDraft: sides.draft !== null,
        hasPublished: live.has(row.key) || live.has(row.id),
      }));
    }
    if (!needsSlug(section.contentPath)) {
      const sides = await loadDocSides(cookies, source, section, null);
      const doc = sides.draft ?? sides.published;
      return [
        {
          key: section.id,
          title: doc?.meta.title ?? section.label,
          hasDraft: sides.draft !== null,
          hasPublished: sides.published !== null,
        },
      ];
    }
    return (await loadLedgerSides(cookies, source, section)).entries;
  }

  if (source.kind !== 'github') return [];
  try {
    const ctx = await ctxFor(cookies);
    if (ctx === null) return [];
    return await listEntries(ctx, section);
  } catch {
    // The picker is a convenience. A page that cannot list its siblings should
    // still show the one it was asked for.
    return [];
  }
}

/** Everything the chrome and the frame need about one target. */
export async function loadTarget(
  cookies: CookieJar,
  target: PreviewTarget,
): Promise<TargetLoad> {
  const source = await resolveSource(cookies);
  const load: TargetLoad = {
    target,
    source,
    content: { surface: 'document', published: null, draft: null },
    entries: [],
  };

  if (target.surface === 'document') {
    const sides = await loadDocSides(cookies, source, target.section, target.key);
    load.content = { surface: 'document', ...sides };
    if (sides.loadError !== undefined) load.loadError = sides.loadError;
  } else if (target.surface === 'ledger') {
    const sides = await loadLedgerSides(cookies, source, target.section);
    load.content = {
      surface: 'ledger',
      published: sides.published,
      draft: sides.draft,
      entries: sides.entries,
    };
    // Already read: the rows the picker wants are the rows the index rendered.
    load.entries = sides.entries;
    if (sides.loadError !== undefined) load.loadError = sides.loadError;
  } else {
    const sides = await loadRecordSides(cookies, source, target.section);
    load.content = { surface: target.surface, ...sides };
    if (sides.loadError !== undefined) load.loadError = sides.loadError;
  }

  // The ledger branch above already has the rows. Everything else asks, which
  // for a record section is free and for a document is one request per entry.
  if (target.surface !== 'ledger') {
    load.entries = await entriesFor(cookies, source, target.section);
  }

  return load;
}

/* -------------------------------------------------------------------------- */
/* Picking the content for a version                                         */
/* -------------------------------------------------------------------------- */

/** The ledger rows for one side, as `renderLedgerPage` wants them. */
export function ledgerItemsFor(
  target: PreviewTarget,
  content: TargetContent,
  version: 'draft' | 'published' | null,
): LedgerItem[] | null {
  if (content.surface !== 'ledger' || target.surface !== 'ledger') return null;
  const metas = version === 'published' ? content.published : (content.draft ?? content.published);
  return ledgerItemsFromMetas(metas, target.ledger);
}

/* -------------------------------------------------------------------------- */
/* The whole site, for the list route                                        */
/* -------------------------------------------------------------------------- */

export type PreviewSectionRow = {
  section: SectionDef;
  target: PreviewTarget;
  /** The path of the section's own surface, for a link. */
  path: string;
  entries: EntrySummary[];
  /** True when each entry has a page of its own and so a preview of its own. */
  hasEntryPages: boolean;
  /** The entry path, for a link. Null when entries have no page. */
  entryPath: (key: string) => string | null;
};

export type PreviewIndex = {
  source: PreviewSource;
  sections: PreviewSectionRow[];
  error?: string;
};

/**
 * Every section and everything in it.
 *
 * Deliberately one function and not five: the list route should not know how
 * many sections there are, so adding a sixth to WS-A's registry puts it on
 * this page without touching it.
 */
export async function listPreviewSections(cookies: CookieJar): Promise<PreviewIndex> {
  const source = await resolveSource(cookies);
  const nav = sectionNav();
  try {
    const rows = await mapLimit(nav, 3, async (entry) => {
      const entries = await entriesFor(cookies, source, entry.section);
      const row: PreviewSectionRow = {
        section: entry.section,
        target: entry.target,
        path: targetPath(entry.target),
        entries,
        hasEntryPages: entry.hasEntryPages,
        entryPath: (key: string) =>
          entry.hasEntryPages ? `${entry.section.id}/${key}` : null,
      };
      return row;
    });
    return { source, sections: rows };
  } catch (error) {
    return { source, sections: [], error: messageOf(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* Phase 1's two functions, unchanged in shape                               */
/* -------------------------------------------------------------------------- */

/**
 * One project page by slug, which is what phase 1's `/cms/preview/<slug>`
 * meant. Kept because `selftest.ts` and `src/cms/app/integration/e2e.mjs`
 * both call this shape, and because a function that used to work should not
 * stop working for no better reason than that there are now five sections.
 */
export async function loadPreview(cookies: CookieJar, slug: string): Promise<PreviewLoad> {
  const source = await resolveSource(cookies);
  const load: PreviewLoad = { slug, source, published: null, draft: null };

  // Phase 1's flat pinned layout, if that is what the pinned directory holds.
  // Only for a pinned directory: in the working tree the flat paths were never
  // a thing, so there is nothing to be compatible with and the registry's
  // paths below are the only right answer.
  if (source.kind === 'local' && source.root !== null && isPinned()) {
    const draft = readLocalFile([join(source.root, 'drafts', `${slug}.json`)], parseDocText);
    const published = readLocalFile([join(source.root, 'pages', `${slug}.json`)], parseDocText);
    if (draft.value !== null || published.value !== null) {
      load.draft = draft.value;
      load.published = published.value;
      return load;
    }
  }

  const parsed = parseTargetPath(slug);
  if (!parsed.ok || parsed.target.surface !== 'document') return load;
  const sides = await loadDocSides(cookies, source, parsed.target.section, parsed.target.key);
  load.published = sides.published;
  load.draft = sides.draft;
  if (sides.draftError !== undefined) load.draftError = sides.draftError;
  if (sides.publishedError !== undefined) load.publishedError = sides.publishedError;
  if (sides.loadError !== undefined) load.loadError = sides.loadError;
  return load;
}

export type PreviewList = {
  source: PreviewSource;
  entries: PageSummary[];
  error?: string;
};

/** Phase 1's flat page list: the projects collection. */
export async function listPreviewPages(cookies: CookieJar): Promise<PreviewList> {
  const source = await resolveSource(cookies);
  if (source.kind === 'github') {
    try {
      const ctx = await ctxFor(cookies);
      if (ctx === null) return { source: { ...source, kind: 'none' }, entries: [] };
      return { source, entries: await listPages(ctx) };
    } catch (error) {
      return { source, entries: [], error: messageOf(error) };
    }
  }
  const index = await listPreviewSections(cookies);
  const projects = index.sections.find((row) => row.section.id === 'projects');
  const entries = (projects?.entries ?? []).map((entry) => {
    const page: PageSummary = {
      slug: entry.key,
      title: entry.title,
      hasDraft: entry.hasDraft,
      hasPublished: entry.hasPublished,
    };
    if (entry.invalid === true) page.invalid = true;
    return page;
  });
  const list: PreviewList = { source, entries };
  if (index.error !== undefined) list.error = index.error;
  return list;
}

/* -------------------------------------------------------------------------- */
/* Media                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Point `/media/...` at the branch, so an image committed by the editor a
 * moment ago appears instead of 404ing until GitHub Pages rebuilds.
 *
 * Deliberately narrow: only an attribute value that starts `/media/`, which
 * is the one prefix WS-C's upload endpoint produces (MEDIA_URL_ROOT). Text
 * that happens to mention /media/, an embed's external iframe src, and an
 * inline shape's svg are all untouched. In local mode this is not applied at
 * all, because there the working tree's own public/ is being served and is by
 * definition current.
 *
 * `srcset` is matched as well as `src` and `poster`: WS-B's album grid does
 * not use one today, but a responsive photograph is the obvious next thing to
 * add to it and a rewrite that silently skipped it would be found the hard way.
 */
export function rewriteMediaForBranch(html: string, branch: string): string {
  const raw = `https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(branch)}/public`;
  return html
    .replace(/(\s(?:src|poster)=")\/media\//g, `$1${raw}/media/`)
    .replace(/(\ssrcset=")([^"]*)"/g, (whole, lead: string, value: string) =>
      value.includes('/media/')
        ? `${lead}${value.replace(/(^|,\s*)\/media\//g, `$1${raw}/media/`)}"`
        : whole,
    );
}

/** The same rewrite, applied only when it is the right thing to do. */
export function withResolvedMedia(html: string, source: PreviewSource): string {
  if (source.kind !== 'github' || source.branch === null) return html;
  return rewriteMediaForBranch(html, source.branch);
}
