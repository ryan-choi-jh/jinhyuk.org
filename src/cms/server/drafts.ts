/**
 * src/cms/server/drafts.ts
 *
 * WS-C. The one implementation of draft semantics, for every kind of content
 * file the CMS writes.
 *
 * Phase 1 had these four operations written once, inline, for the one thing it
 * stored: a project document. Phase 2 stores five things in two shapes
 * (documents and record collections), and the semantics are identical for all
 * of them, so they are lifted out here rather than copied twice:
 *
 *   - the editor always writes the draft mirror of a file, never the published
 *     file (docs/cms-rebuild.md 2.3)
 *   - publish copies the draft's own bytes over the published file and deletes
 *     the draft, in ONE commit
 *   - the site builds from the published tree only, so a draft can never reach
 *     the live site, and neither can a half-finished publish
 *
 * A `Slot` is "one content file and its draft, and how to tell whether its
 * contents are valid". Everything in this file is generic over what the file
 * holds; `store.ts` makes slots for documents, `records.ts` for the two record
 * collections, and neither has to restate any of the above.
 */

import { ConflictError, badRequest, notFound } from './errors.ts';
import { commitFiles, headSha, readText } from './github.ts';
import type { FileChange } from './github.ts';
import { formatIssues } from '../schema.ts';
import type { ValidateResultOf } from '../schema.ts';

/** Everything a store call needs: who is asking, and on which branch. */
export type Ctx = {
  token: string;
  branch: string;
};

/**
 * `undefined` means "no expectation from the client": the server reads the
 * current sha and quotes that, so a commit landing in the window is still
 * caught. `null` means the client believes the file does not exist yet.
 */
export type ShaExpectation = string | null | undefined;

export type WriteResult = { commit: string; sha: string };

/**
 * One content file, its draft mirror, and how to read it.
 *
 * `label` is what appears in a commit message and in an error a human reads:
 * `projects/track-daily-habit-tracker`, `home`, `filmography`. It is never
 * used to build a path — `contentPath` and `draftPath` come from the registry,
 * already filled and already traversal-checked by `fillSlug`.
 */
export type Slot<T> = {
  label: string;
  contentPath: string;
  draftPath: string;
  /** Parse and validate the file's text. Never throws; see ValidateResultOf. */
  parse: (text: string) => ValidateResultOf<T>;
};

/**
 * What is on disk at both ends of a slot.
 *
 * A file that exists but does not validate reports an `error` and a null
 * value, rather than reading as absent: absence would tell the editor there is
 * nothing there, and the next save would quietly overwrite a file somebody has
 * hand-edited into an invalid state.
 */
export type SlotRead<T> = {
  published: T | null;
  draft: T | null;
  /**
   * Blob shas, so the editor can send one back as If-Match on its next write
   * and find out about a conflict instead of causing one. Null where the file
   * does not exist.
   */
  publishedSha: string | null;
  draftSha: string | null;
  publishedError?: string;
  draftError?: string;
};

/**
 * A read that must not be allowed to say "absent" too early.
 *
 * GitHub's contents API answers from read replicas and with a 60-second
 * `max-age`, so for a short window after a write it can still report a path as
 * missing. For an ordinary read that is harmless — `readSlot` reporting "no
 * draft" is the common and correct answer for most pages. For the two
 * operations that *require* the draft to exist, publish and discard, it is not:
 * it turns "I saved this a moment ago" into "There is no draft to publish",
 * which is the kind of answer that makes a tool feel broken when it is only
 * being hasty.
 *
 * So those two look twice before believing an absence, and nothing else pays
 * for it.
 */
const ABSENCE_RECHECK_MS = 400;

async function readTextInsisting(
  ctx: Ctx,
  path: string,
): Promise<{ text: string; sha: string } | null> {
  const first = await readText(ctx.token, path, ctx.branch);
  if (first !== null) return first;
  await new Promise((resolve) => setTimeout(resolve, ABSENCE_RECHECK_MS));
  return readText(ctx.token, path, ctx.branch);
}

async function headShaInsisting(ctx: Ctx, path: string): Promise<string | null> {
  const first = await headSha(ctx.token, path, ctx.branch);
  if (first !== null) return first;
  await new Promise((resolve) => setTimeout(resolve, ABSENCE_RECHECK_MS));
  return headSha(ctx.token, path, ctx.branch);
}

type Side<T> = { value: T | null; sha: string | null; error?: string };

async function readSide<T>(ctx: Ctx, slot: Slot<T>, path: string): Promise<Side<T>> {
  const file = await readText(ctx.token, path, ctx.branch);
  if (file === null) return { value: null, sha: null };
  const result = slot.parse(file.text);
  if (!result.ok) {
    return { value: null, sha: file.sha, error: formatIssues(result.issues) };
  }
  return { value: result.data, sha: file.sha };
}

export async function readSlot<T>(ctx: Ctx, slot: Slot<T>): Promise<SlotRead<T>> {
  const [published, draft] = await Promise.all([
    readSide(ctx, slot, slot.contentPath),
    readSide(ctx, slot, slot.draftPath),
  ]);
  const read: SlotRead<T> = {
    published: published.value,
    draft: draft.value,
    publishedSha: published.sha,
    draftSha: draft.sha,
  };
  if (published.error !== undefined) read.publishedError = published.error;
  if (draft.error !== undefined) read.draftError = draft.error;
  return read;
}

/** The draft's parsed contents, else the published file's, else null. */
export async function readSlotWorking<T>(
  ctx: Ctx,
  slot: Slot<T>,
): Promise<{ value: T | null; from: 'draft' | 'published' | 'none'; draftSha: string | null }> {
  const read = await readSlot(ctx, slot);
  // An invalid file is reported rather than silently stepped over: an edit
  // applied on top of a file we could not read would throw away its contents.
  if (read.draftError !== undefined) {
    throw badRequest(
      `The draft of "${slot.label}" does not validate, so it cannot be edited:\n${read.draftError}`,
      'invalid_draft',
    );
  }
  if (read.draft !== null) return { value: read.draft, from: 'draft', draftSha: read.draftSha };
  if (read.publishedError !== undefined) {
    throw badRequest(
      `The published "${slot.label}" does not validate, so it cannot be edited:\n${read.publishedError}`,
      'invalid_published',
    );
  }
  if (read.published !== null) {
    return { value: read.published, from: 'published', draftSha: read.draftSha };
  }
  return { value: null, from: 'none', draftSha: read.draftSha };
}

/**
 * Save the working copy. The text is already serialised and already validated
 * by the caller, which is what makes "a draft on disk is always loadable" true
 * rather than hoped for; this function re-checks it anyway, because it is the
 * only door to the draft tree and the check costs nothing.
 */
export async function writeSlotDraft<T>(
  ctx: Ctx,
  slot: Slot<T>,
  text: string,
  expected: ShaExpectation = undefined,
): Promise<WriteResult> {
  const result = slot.parse(text);
  if (!result.ok) {
    throw badRequest(
      `That ${slot.label} does not validate:\n${formatIssues(result.issues)}`,
      'invalid_content',
    );
  }

  const path = slot.draftPath;
  const expectedSha =
    expected === undefined ? await headSha(ctx.token, path, ctx.branch) : expected;

  const commit = await commitFiles(ctx.token, {
    branch: ctx.branch,
    message: `CMS: save draft ${slot.label}`,
    changes: [{ path, content: text, expectedSha }],
  });

  return { commit: commit.commit, sha: commit.shas[path] as string };
}

/** Throw the draft away. The published file is untouched. */
export async function discardSlotDraft<T>(
  ctx: Ctx,
  slot: Slot<T>,
  expected: ShaExpectation = undefined,
): Promise<{ commit: string }> {
  const path = slot.draftPath;
  const current = await headShaInsisting(ctx, path);
  if (current === null) {
    throw notFound(`There is no draft of "${slot.label}" to discard.`);
  }
  if (expected !== undefined && expected !== null && expected !== current) {
    throw new ConflictError({
      path,
      expectedSha: expected,
      actualSha: current,
      message: `The draft of "${slot.label}" changed since you loaded it. Reload before discarding it, or you will throw away an edit you have not seen.`,
    });
  }

  const commit = await commitFiles(ctx.token, {
    branch: ctx.branch,
    message: `CMS: discard draft ${slot.label}`,
    changes: [{ path, content: null, expectedSha: current }],
  });
  return { commit: commit.commit };
}

/**
 * Copy the draft over the published file and delete the draft, as one commit.
 *
 * One commit matters twice over. A reader of the repo can never see a state
 * where both files exist with different contents, and the Pages deploy
 * workflow fires once for a publish instead of twice.
 *
 * `expected` is the published file the author believes they are replacing.
 * Passing what was read when the editor opened turns "someone else published
 * while I was writing" from a silent overwrite into a 409.
 */
export async function publishSlot<T>(
  ctx: Ctx,
  slot: Slot<T>,
  expected: ShaExpectation = undefined,
): Promise<WriteResult & { value: T }> {
  // Publishing reads the draft and then writes it, so it can be refused
  // because the draft moved between the two — which happens both when the
  // author saved again and, far more often, when the read was simply behind
  // the last save (see readTextInsisting). Either way the answer is the same
  // and it is not "refuse": publish means "move the draft as it now stands",
  // and re-reading publishes the newer text rather than losing it.
  //
  // A conflict on the PUBLISHED path is a different thing entirely — somebody
  // else's publication would be overwritten — and is never retried here.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await attemptPublish(ctx, slot, expected);
    } catch (error) {
      const staleDraftRead =
        error instanceof ConflictError && error.path === slot.draftPath && attempt < 2;
      if (!staleDraftRead) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}

async function attemptPublish<T>(
  ctx: Ctx,
  slot: Slot<T>,
  expected: ShaExpectation,
): Promise<WriteResult & { value: T }> {
  const draftFile = await readTextInsisting(ctx, slot.draftPath);
  if (draftFile === null) {
    throw notFound(
      `There is no draft of "${slot.label}" to publish. Save a draft first; publishing only ever moves a draft into the published tree.`,
    );
  }

  const result = slot.parse(draftFile.text);
  if (!result.ok) {
    // Unreachable through writeSlotDraft, which validates before writing.
    // Reachable by hand-editing the file in the repo, which is a thing a
    // person with a text editor does, so it is still checked.
    throw badRequest(
      `The draft of "${slot.label}" does not validate, so it was not published:\n${formatIssues(result.issues)}`,
      'invalid_content',
    );
  }

  const target = slot.contentPath;
  const expectedPublished =
    expected === undefined ? await headSha(ctx.token, target, ctx.branch) : expected;

  // The draft's own bytes go to the published tree unchanged, so publishing is
  // a copy and cannot reformat or lose anything. The draft is deleted in the
  // same commit, with its sha quoted, so a save racing a publish is a conflict
  // rather than a lost edit.
  const changes: FileChange[] = [
    { path: target, content: draftFile.text, expectedSha: expectedPublished },
    { path: slot.draftPath, content: null, expectedSha: draftFile.sha },
  ];

  const commit = await commitFiles(ctx.token, {
    branch: ctx.branch,
    message: `CMS: publish ${slot.label}`,
    changes,
  });

  return { commit: commit.commit, sha: commit.shas[target] as string, value: result.data };
}
