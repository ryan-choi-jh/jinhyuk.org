/**
 * src/cms/server/moves.ts
 *
 * Renaming a page, and deleting one.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE WERE MISSING, AND WHY THAT WAS HONEST
 * ---------------------------------------------------------------------------
 *
 * The slug field has been read-only since the CMS shipped, with the note
 * "renaming a page is a move, not an edit", and the delete button on a
 * document collection has been disabled with the reason written on it. Both
 * were true. A rename is three or four file operations that have to happen
 * together or not at all, and the API table had no verb for either.
 *
 * What it cost is that the CMS could not finish a job you started in it: a
 * page named wrong stayed named wrong, and a page you no longer wanted had
 * to be deleted in git.
 *
 * ---------------------------------------------------------------------------
 * ONE COMMIT, OR NOTHING
 * ---------------------------------------------------------------------------
 *
 * Both operations go through `commitFiles`, which takes a list of changes
 * and makes one commit of them. That matters more here than anywhere else in
 * this server: a rename that wrote the new file and failed to delete the old
 * one would publish the same page at two addresses, and the index would list
 * it twice. There is no intermediate state to be interrupted in.
 *
 * ---------------------------------------------------------------------------
 * A RENAME LEAVES A REDIRECT
 * ---------------------------------------------------------------------------
 *
 * The URL is the one part of a page other people hold a copy of. Renaming
 * without a redirect turns every link anyone has ever shared into a 404,
 * silently, and the person who did it is the last to find out.
 *
 * So a rename appends to `src/content/data/redirects.json`, which
 * `astro.config.mjs` feeds into Astro's own `redirects` option. In a static
 * build that becomes a real redirecting page at the old address. The same
 * commit carries it, so the redirect exists in the build that first lacks
 * the old page.
 *
 * ---------------------------------------------------------------------------
 * MEDIA DOES NOT MOVE
 * ---------------------------------------------------------------------------
 *
 * Uploads live at `public/media/<section>/<slug>/` and a document refers to
 * them by absolute path. A rename leaves them where they are and rewrites
 * nothing: the files still exist, the paths still resolve, and the page
 * looks identical. The alternative is moving binaries and rewriting every
 * `src` in the same commit, which is a great deal more that can go wrong in
 * exchange for a tidier directory name. New uploads after the rename land
 * under the new slug, so a renamed page can end up with media in two
 * directories; `server/unused-media.mjs` is what makes that visible, and
 * nothing breaks either way.
 */

import { IdSchema } from '../schema.ts';
import type { Doc } from '../schema.ts';
import { contentPathFor, draftPathFor, siteUrlFor } from '../sections.ts';
import type { DocumentSectionDef } from '../sections.ts';
import type { Ctx } from './store.ts';
import { ConflictError, badRequest, notFound } from './errors.ts';
import { commitFiles, readText } from './github.ts';
import { serialiseDoc } from './store.ts';

/** Where the list of old addresses lives. */
export const REDIRECTS_PATH = 'src/content/data/redirects.json';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type Redirect = { from: string; to: string };

/**
 * The list, as it is on the branch. A missing or unreadable file is an empty
 * list rather than an error: a redirect is a courtesy, and failing a rename
 * because the courtesy file is malformed would be the wrong trade.
 */
async function readRedirects(ctx: Ctx): Promise<{ list: Redirect[]; sha: string | null }> {
  const file = await readText(ctx.token, REDIRECTS_PATH, ctx.branch);
  if (file === null) return { list: [], sha: null };
  try {
    const parsed: unknown = JSON.parse(file.text);
    const list = (parsed as { redirects?: unknown }).redirects;
    if (!Array.isArray(list)) return { list: [], sha: file.sha };
    return {
      list: list.filter(
        (entry): entry is Redirect =>
          entry !== null &&
          typeof entry === 'object' &&
          typeof (entry as Redirect).from === 'string' &&
          typeof (entry as Redirect).to === 'string',
      ),
      sha: file.sha,
    };
  } catch {
    return { list: [], sha: file.sha };
  }
}

/**
 * Add one, and repoint anything that already pointed at the old address.
 *
 * The second half is what stops a chain. Rename A to B and then B to C, and
 * without it `/A` redirects to `/B`, which no longer exists. Following the
 * chain at build time is more machinery than this needs; rewriting the
 * existing entries as they are added keeps the list flat and every entry
 * pointing somewhere real.
 */
export function withRedirect(list: readonly Redirect[], from: string, to: string): Redirect[] {
  const out = list
    .filter((entry) => entry.from !== to)
    .map((entry) => (entry.to === from ? { from: entry.from, to } : entry));
  if (from !== to) out.push({ from, to });
  return out;
}

function serialiseRedirects(list: readonly Redirect[]): string {
  return `${JSON.stringify({ redirects: list }, null, 2)}\n`;
}

/* -------------------------------------------------------------------------- */
/* Rename                                                                      */
/* -------------------------------------------------------------------------- */

export type RenameResult = {
  commit: string;
  from: string;
  to: string;
  /** The old public address, now redirecting. Null for a section with no entry pages. */
  redirectFrom: string | null;
  movedDraft: boolean;
};

/**
 * Move a published page, and its draft if it has one, to a new slug.
 *
 * Refuses rather than guesses in four cases: a slug that is not a slug, a
 * target that already exists, a section whose entries have no slug at all,
 * and a page that is not there. Each one would otherwise silently destroy
 * something.
 */
export async function renameEntry(
  ctx: Ctx,
  section: DocumentSectionDef,
  from: string,
  to: string,
): Promise<RenameResult> {
  if (section.shape === 'singleton') {
    throw badRequest(`"${section.id}" is one page and has no slug to change.`, 'wrong_storage');
  }
  if (!SLUG_RE.test(to)) {
    throw badRequest(
      `"${to}" is not a page name. Use lowercase words joined by hyphens, like "a-second-look".`,
      'bad_slug',
    );
  }
  if (!IdSchema.safeParse(to).success) {
    throw badRequest(`"${to}" is not a usable file name.`, 'bad_slug');
  }
  if (from === to) throw badRequest('That is already its name.', 'bad_slug');

  const fromPath = contentPathFor(section, from);
  const toPath = contentPathFor(section, to);
  const fromDraft = draftPathFor(section, from);
  const toDraft = draftPathFor(section, to);

  const [published, draft, existing, existingDraft] = await Promise.all([
    readText(ctx.token, fromPath, ctx.branch),
    readText(ctx.token, fromDraft, ctx.branch),
    readText(ctx.token, toPath, ctx.branch),
    readText(ctx.token, toDraft, ctx.branch),
  ]);

  if (published === null && draft === null) {
    throw notFound(`There is no ${section.noun} called "${from}" to rename.`);
  }
  if (existing !== null || existingDraft !== null) {
    throw new ConflictError({
      path: toPath,
      expectedSha: null,
      actualSha: (existing ?? existingDraft)?.sha ?? null,
      message: `There is already a ${section.noun} called "${to}". Pick another name.`,
    });
  }

  /** The document with its slug changed, because the file name and `meta.slug` must agree. */
  const reslugged = (text: string): string => {
    const doc = JSON.parse(text) as Doc;
    return serialiseDoc({ ...doc, meta: { ...doc.meta, slug: to } });
  };

  const changes = [];
  if (published !== null) {
    changes.push({ path: toPath, content: reslugged(published.text), expectedSha: null });
    changes.push({ path: fromPath, content: null, expectedSha: published.sha });
  }
  if (draft !== null) {
    changes.push({ path: toDraft, content: reslugged(draft.text), expectedSha: null });
    changes.push({ path: fromDraft, content: null, expectedSha: draft.sha });
  }

  // The redirect, in the same commit, so it exists in the first build that
  // lacks the old page. Only for a published page: an unpublished draft has
  // no public address to redirect from.
  const redirectFrom = published === null ? null : siteUrlFor(section, from);
  const redirectTo = siteUrlFor(section, to);
  if (redirectFrom !== null && redirectTo !== null) {
    const { list, sha } = await readRedirects(ctx);
    changes.push({
      path: REDIRECTS_PATH,
      content: serialiseRedirects(withRedirect(list, redirectFrom, redirectTo)),
      expectedSha: sha,
    });
  }

  const result = await commitFiles(ctx.token, {
    branch: ctx.branch,
    message: `CMS: rename ${section.id}/${from} to ${to}`,
    changes,
  });

  return {
    commit: result.commit,
    from,
    to,
    redirectFrom: redirectFrom === null || redirectTo === null ? null : redirectFrom,
    movedDraft: draft !== null,
  };
}

/* -------------------------------------------------------------------------- */
/* Delete                                                                      */
/* -------------------------------------------------------------------------- */

export type DeleteResult = { commit: string; slug: string; hadDraft: boolean; url: string | null };

/**
 * Remove a page: the published file and its draft, in one commit.
 *
 * No redirect. There is nowhere to send anyone, and a redirect to the index
 * would be a lie about what happened to the page. The caller is told which
 * address will start returning 404 so it can say so before it asks.
 *
 * Media is left alone, as it is on a rename: `server/unused-media.mjs` is
 * what makes an orphan visible, and deleting files a page might share with
 * another is not something to do as a side effect.
 */
export async function deleteEntry(
  ctx: Ctx,
  section: DocumentSectionDef,
  slug: string,
): Promise<DeleteResult> {
  if (section.shape === 'singleton') {
    throw badRequest(
      `"${section.id}" is the one page of its section and cannot be deleted; there would be nothing at ${section.indexUrl}.`,
      'wrong_storage',
    );
  }

  const path = contentPathFor(section, slug);
  const draftPath = draftPathFor(section, slug);
  const [published, draft] = await Promise.all([
    readText(ctx.token, path, ctx.branch),
    readText(ctx.token, draftPath, ctx.branch),
  ]);

  if (published === null && draft === null) {
    throw notFound(`There is no ${section.noun} called "${slug}" to delete.`);
  }

  const changes = [];
  if (published !== null) changes.push({ path, content: null, expectedSha: published.sha });
  if (draft !== null) changes.push({ path: draftPath, content: null, expectedSha: draft.sha });

  const result = await commitFiles(ctx.token, {
    branch: ctx.branch,
    message: `CMS: delete ${section.id}/${slug}`,
    changes,
  });

  return {
    commit: result.commit,
    slug,
    hadDraft: draft !== null,
    url: published === null ? null : siteUrlFor(section, slug),
  };
}
