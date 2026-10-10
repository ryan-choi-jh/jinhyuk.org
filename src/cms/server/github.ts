/**
 * src/cms/server/github.ts
 *
 * WS-2. Everything that talks to GitHub. No knowledge of documents, drafts or
 * media lives here: this file reads bytes, writes bytes, and commits.
 *
 * Two decisions worth knowing before reading on.
 *
 * 1. Writes go through the Git Data API (blob -> tree -> commit -> ref), not
 *    the Contents API. The Contents API can only touch one file per commit,
 *    and publishing is two file operations (copy the draft over the published
 *    page, delete the draft) that must not be separately observable. Two
 *    commits would also trigger the Pages deploy twice for one publish.
 *
 * 2. Conflict detection has two layers. The blob sha at each path is checked
 *    against what the caller expected, which catches "someone edited this
 *    page"; and the ref is updated without force from the head we read, which
 *    catches "someone committed anything at all" in the window. The second is
 *    stricter than it needs to be, and that is the right way round for a tool
 *    whose whole job is not to lose writing.
 */

import { ConflictError, GitHubError, notFound } from './errors.ts';
import { REPO } from './config.ts';

const API = 'https://api.github.com';

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

function headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'jinhyuk.org-cms',
    // No `Cache-Control: no-cache` here, deliberately, and it was tried.
    // GitHub answers a contents read with `private, max-age=60`, so the
    // obvious hardening against a stale read is to ask for a revalidation.
    // Measured over three full runs of verify.ts, it made things WORSE: with
    // the cache in play a read that has seen a write keeps seeing it, and
    // without it every read is free to land on a replica that has not caught
    // up, so reads stopped being monotonic. Conflict detection is what makes
    // a stale read safe here, not read freshness.
    ...extra,
  };
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  /** Used in the error message, so a failure says which call failed. */
  where: string;
  /** 404 comes back as null instead of throwing. */
  allow404?: boolean;
};

async function gh<T>(token: string, path: string, options: RequestOptions): Promise<T | null> {
  const method = options.method ?? 'GET';
  const init: RequestInit = {
    method,
    headers:
      options.body === undefined
        ? headers(token)
        : headers(token, { 'Content-Type': 'application/json' }),
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  const response = await fetch(`${API}${path}`, init);
  if (response.status === 404 && options.allow404 === true) return null;
  if (!response.ok) {
    throw new GitHubError(response.status, options.where, await response.text());
  }
  if (response.status === 204) return null;
  return (await response.json()) as T;
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

export type GitHubUser = { login: string; name: string | null; avatarUrl: string | null };

/** Who the token belongs to. Also the cheapest way to tell a live token from a dead one. */
export async function getUser(token: string): Promise<GitHubUser> {
  const body = await gh<{ login: string; name: string | null; avatar_url?: string }>(
    token,
    '/user',
    { where: 'whoami' },
  );
  if (body === null) throw new GitHubError(404, 'whoami', 'no body');
  return { login: body.login, name: body.name ?? null, avatarUrl: body.avatar_url ?? null };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

export type BlobAtRef = { bytes: Buffer; sha: string; size: number };
export type TextAtRef = { text: string; sha: string };

function contentsUrl(path: string, ref: string): string {
  // encodeURIComponent would escape the slashes; a path segment here is always
  // made of characters this project controls (slug regex plus a sanitised
  // filename), so encodeURI is the right strength.
  return `/repos/${REPO}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`;
}

/** Read a file's bytes and its blob sha. Null when it is not there. */
export async function readBlob(token: string, path: string, ref: string): Promise<BlobAtRef | null> {
  const body = await gh<{
    content?: string;
    encoding?: string;
    sha: string;
    size: number;
    type: string;
    git_url?: string;
  }>(token, contentsUrl(path, ref), { where: `read ${path}`, allow404: true });
  if (body === null) return null;
  if (body.type !== 'file') {
    throw notFound(`${path} is a ${body.type}, not a file.`);
  }
  // Over 1MB the Contents API returns metadata with no content and expects a
  // follow-up to the blobs endpoint, which has a 100MB ceiling.
  if (body.content === undefined || body.content === '') {
    const blob = await gh<{ content: string; encoding: string }>(
      token,
      `/repos/${REPO}/git/blobs/${body.sha}`,
      { where: `read blob ${path}` },
    );
    if (blob === null) throw new GitHubError(404, `read blob ${path}`, 'no body');
    return {
      bytes: Buffer.from(blob.content, blob.encoding as BufferEncoding),
      sha: body.sha,
      size: body.size,
    };
  }
  return {
    bytes: Buffer.from(body.content, (body.encoding ?? 'base64') as BufferEncoding),
    sha: body.sha,
    size: body.size,
  };
}

/** Read a file as UTF-8 text, with its blob sha. Null when it is not there. */
export async function readText(token: string, path: string, ref: string): Promise<TextAtRef | null> {
  const blob = await readBlob(token, path, ref);
  if (blob === null) return null;
  return { text: blob.bytes.toString('utf8'), sha: blob.sha };
}

/** The blob sha at a path, without transferring the file. Null when absent. */
export async function headSha(token: string, path: string, ref: string): Promise<string | null> {
  const body = await gh<{ sha: string; type: string }>(token, contentsUrl(path, ref), {
    where: `stat ${path}`,
    allow404: true,
  });
  if (body === null) return null;
  return body.sha;
}

export type DirEntry = { name: string; path: string; sha: string; size: number; type: string };

/** List a directory. An absent directory is an empty list, not an error. */
export async function listDir(token: string, dir: string, ref: string): Promise<DirEntry[]> {
  const body = await gh<DirEntry[] | { type: string }>(token, contentsUrl(dir, ref), {
    where: `list ${dir}`,
    allow404: true,
  });
  if (body === null) return [];
  if (!Array.isArray(body)) {
    throw notFound(`${dir} is a file, not a directory.`);
  }
  return body;
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One file operation inside a commit.
 *
 * `expectedSha` is the optimistic lock:
 *   - a sha string: the file must still be exactly that blob
 *   - null:         the file must not exist yet
 *   - undefined:    no expectation (a blind write)
 */
export type FileChange = {
  path: string;
  /** Buffer or string to write; null deletes the file. */
  content: Buffer | string | null;
  expectedSha?: string | null;
};

export type CommitResult = {
  /** The new commit sha. */
  commit: string;
  /** New blob sha per written path; null for a path that was deleted. */
  shas: Record<string, string | null>;
  /** The commit this one was built on. */
  parent: string;
};

type RefBody = { object: { sha: string } };
type CommitBody = { sha: string; tree: { sha: string } };

/** The branch head. */
export async function getBranchHead(token: string, branch: string): Promise<string> {
  const body = await gh<RefBody>(token, `/repos/${REPO}/git/ref/heads/${encodeURIComponent(branch)}`, {
    where: `read branch ${branch}`,
    allow404: true,
  });
  if (body === null) throw notFound(`No branch "${branch}" in ${REPO}.`);
  return body.object.sha;
}

/**
 * Commit a set of file operations as exactly one commit.
 *
 * Throws ConflictError, and nothing is written, when any expectation fails or
 * when the branch moved while this was being assembled.
 *
 * WS-C: a conflict is re-checked before it is believed, because GitHub's own
 * reads lag its writes. `GET /git/ref/heads/<branch>` immediately after a
 * commit sometimes still answers with the commit before it, and a contents
 * read can still report a path as missing for a second or so after it was
 * written. Measured on this repo: roughly one write in five when writes are a
 * second or two apart, which unretried surfaced in the editor as "another
 * commit landed, nothing was saved" and "that file was deleted since you
 * loaded it" when nothing of the sort had happened.
 *
 * **Re-checking cannot weaken the guarantee.** Both layers of conflict
 * detection are reads, and a retry starts over from a fresh head and applies
 * every `expectedSha` to it unchanged. A retry can only succeed if the repo
 * genuinely matches what the caller said it expected; a real concurrent change
 * fails every attempt and still becomes a 409, a few seconds later. What is
 * absorbed is only the server disagreeing with itself. The orphaned blobs and
 * commit objects left by a refused attempt are unreachable, and git collects
 * them.
 */
export async function commitFiles(
  token: string,
  options: { branch: string; message: string; changes: FileChange[] },
): Promise<CommitResult> {
  if (options.changes.length === 0) throw new Error('commitFiles: nothing to commit');

  const backoffMs = [250, 750, 2000];
  /**
   * Commits we were told were refused. A refusal can itself be a stale answer:
   * the ref update lands and the response, or the follow-up read of the head,
   * describes the branch as it was. Before retrying, the head is read again —
   * and if it has become one of these, that attempt did land after all and
   * retrying would re-check an expectation against our own work and report a
   * conflict with ourselves.
   */
  const refused: CommitResult[] = [];
  let lastConflict: ConflictError | null = null;

  for (let attempt = 0; attempt <= backoffMs.length; attempt += 1) {
    const result = await attemptCommit(token, options);
    if (result.ok) return result.commit;
    if (result.pending !== null) refused.push(result.pending);
    lastConflict = result.conflict;

    const wait = backoffMs[Math.min(attempt, backoffMs.length - 1)] as number;
    await new Promise((resolve) => setTimeout(resolve, wait));

    const head = await getBranchHead(token, options.branch).catch(() => null);
    const landed = refused.find((candidate) => candidate.commit === head);
    if (landed !== undefined) return landed;
  }

  throw lastConflict as ConflictError;
}

type Attempt =
  | { ok: true; commit: CommitResult }
  /**
   * Something disagreed. Retryable: the next attempt re-reads the head and
   * applies every expectation to it unchanged, so a real conflict fails again.
   * `pending` is the commit object this attempt created — unreachable if the
   * refusal was real, and the branch head if the refusal was itself stale. It
   * is null when the expectations failed, because then nothing was created.
   */
  | { ok: false; conflict: ConflictError; pending: CommitResult | null };

async function attemptCommit(
  token: string,
  options: { branch: string; message: string; changes: FileChange[] },
): Promise<Attempt> {
  const { branch, message, changes } = options;

  const parent = await getBranchHead(token, branch);
  const parentCommit = await gh<CommitBody>(token, `/repos/${REPO}/git/commits/${parent}`, {
    where: `read commit ${parent}`,
  });
  if (parentCommit === null) throw new GitHubError(404, `read commit ${parent}`, 'no body');

  // Layer one: check every expectation against the tree we are about to build
  // on. Done before any blob is created, so a conflict leaves no litter.
  //
  // allSettled, not all: publishing checks two paths at once, and if both have
  // moved, Promise.all would reject on the first and leave the second
  // rejection unhandled, which Node reports as a crash rather than as the 409
  // this is.
  const expectations = await Promise.allSettled(
    changes.map(async (change) => {
      if (!('expectedSha' in change)) return;
      const expected = change.expectedSha;
      if (expected === undefined) return;
      const actual = await headSha(token, change.path, parent);
      if (expected === null) {
        if (actual !== null) {
          throw new ConflictError({
            path: change.path,
            expectedSha: null,
            actualSha: actual,
            message: `${change.path} already exists. It was expected to be a new file; refusing to overwrite it.`,
          });
        }
        return;
      }
      if (actual === null) {
        throw new ConflictError({
          path: change.path,
          expectedSha: expected,
          actualSha: null,
          message: `${change.path} has been deleted in the repo since you loaded it. Reload before saving, or your change will resurrect a file somebody removed.`,
        });
      }
      if (actual !== expected) {
        throw new ConflictError({
          path: change.path,
          expectedSha: expected,
          actualSha: actual,
          message: `${change.path} changed in the repo since you loaded it (you had ${short(expected)}, it is now ${short(actual)}). Reload the page in the editor, then redo this change, or you will overwrite the newer version.`,
        });
      }
    }),
  );
  // A conflict is the more useful thing to report, so it wins over a transport
  // failure that happened alongside it.
  const rejections = expectations
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason as unknown);
  const firstConflict = rejections.find((reason) => reason instanceof ConflictError);
  if (firstConflict !== undefined) {
    // Returned rather than thrown, so commitFiles re-reads and re-checks: the
    // expectation above was tested against a read, and a read can be behind.
    // Nothing has been created, hence no pending commit.
    return { ok: false, conflict: firstConflict, pending: null };
  }
  if (rejections.length > 0) throw rejections[0];

  // Blobs. base64 so the same path works for a PNG and for JSON.
  const written: { path: string; sha: string }[] = [];
  for (const change of changes) {
    if (change.content === null) continue;
    const buffer =
      typeof change.content === 'string' ? Buffer.from(change.content, 'utf8') : change.content;
    const blob = await gh<{ sha: string }>(token, `/repos/${REPO}/git/blobs`, {
      method: 'POST',
      where: `create blob for ${change.path}`,
      body: { content: buffer.toString('base64'), encoding: 'base64' },
    });
    if (blob === null) throw new GitHubError(500, `create blob for ${change.path}`, 'no body');
    written.push({ path: change.path, sha: blob.sha });
  }

  const byPath = new Map(written.map((entry) => [entry.path, entry.sha]));
  const tree = changes.map((change) =>
    change.content === null
      ? // A null sha in a tree built on base_tree is a deletion.
        { path: change.path, mode: '100644' as const, type: 'blob' as const, sha: null }
      : {
          path: change.path,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: byPath.get(change.path) as string,
        },
  );

  const newTree = await gh<{ sha: string }>(token, `/repos/${REPO}/git/trees`, {
    method: 'POST',
    where: 'create tree',
    body: { base_tree: parentCommit.tree.sha, tree },
  });
  if (newTree === null) throw new GitHubError(500, 'create tree', 'no body');

  const commit = await gh<{ sha: string }>(token, `/repos/${REPO}/git/commits`, {
    method: 'POST',
    where: 'create commit',
    body: { message, tree: newTree.sha, parents: [parent] },
  });
  if (commit === null) throw new GitHubError(500, 'create commit', 'no body');

  // Layer two: fast-forward only. If anything landed on the branch while this
  // commit was being built, the ref no longer points at `parent` and GitHub
  // refuses. The commit object exists but is unreachable, which git garbage
  // collects; nothing the caller asked for has been applied.
  const shas: Record<string, string | null> = {};
  for (const change of changes) {
    shas[change.path] = change.content === null ? null : (byPath.get(change.path) ?? null);
  }
  const landed: CommitResult = { commit: commit.sha, shas, parent };

  const update = await fetch(
    `${API}/repos/${REPO}/git/refs/heads/${encodeURIComponent(branch)}`,
    {
      method: 'PATCH',
      headers: headers(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ sha: commit.sha, force: false }),
    },
  );
  if (!update.ok) {
    const detail = await update.text();
    if (update.status === 422 || update.status === 409) {
      const nowAt = await getBranchHead(token, branch).catch(() => 'unknown');
      // The refusal can itself be stale: the PATCH may have landed and only
      // its answer gone astray. If the branch is already at our commit, the
      // write succeeded and retrying would fight our own work.
      if (nowAt !== commit.sha) {
        return {
          ok: false,
          pending: landed,
          conflict: new ConflictError({
            path: branch,
            expectedSha: parent,
            actualSha: nowAt === 'unknown' ? null : nowAt,
            message: `Another commit landed on ${branch} while this one was being written (branch was ${short(parent)}, is now ${short(String(nowAt))}). Nothing was saved. Reload the editor and try again.`,
          }),
        };
      }
    } else {
      throw new GitHubError(update.status, `update ${branch}`, detail);
    }
  }

  return { ok: true, commit: landed };
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

/* -------------------------------------------------------------------------- */
/* Branches (used by the integration test, which never touches main)           */
/* -------------------------------------------------------------------------- */

export async function createBranch(
  token: string,
  options: { name: string; fromBranch: string },
): Promise<{ name: string; sha: string }> {
  const sha = await getBranchHead(token, options.fromBranch);
  await gh(token, `/repos/${REPO}/git/refs`, {
    method: 'POST',
    where: `create branch ${options.name}`,
    body: { ref: `refs/heads/${options.name}`, sha },
  });
  return { name: options.name, sha };
}

export async function deleteBranch(token: string, name: string): Promise<void> {
  await gh(token, `/repos/${REPO}/git/refs/heads/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    where: `delete branch ${name}`,
    allow404: true,
  });
}
