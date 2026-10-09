// The studio's own GitHub access.
//
// For now this borrows the session Keystatic already established: logging in
// at /keystatic sets a keystatic-gh-access-token cookie on this origin, and
// the studio reads it. That is deliberate. It means the studio can commit
// from day one without rebuilding OAuth, and Keystatic stays usable as a
// fallback editor while the studio is still growing. When the studio replaces
// it outright, only this file needs to change.

import type { AstroCookies } from 'astro';

export const REPO_OWNER = 'ryan-choi-jh';
export const REPO_NAME = 'jinhyuk.org';
export const REPO = `${REPO_OWNER}/${REPO_NAME}`;

const API = 'https://api.github.com';

export function tokenFrom(cookies: AstroCookies): string | null {
  const fromCookie = cookies.get('keystatic-gh-access-token')?.value;
  if (fromCookie) return fromCookie;
  // Local convenience only. `import.meta.env.DEV` is false in both builds, so
  // this cannot become a way into the deployed studio; it exists so the studio
  // can be driven against the real repo from `npm run dev`, where there is no
  // GitHub session to borrow. Supply it as STUDIO_DEV_TOKEN in the shell.
  if (import.meta.env.DEV) return process.env.STUDIO_DEV_TOKEN ?? null;
  return null;
}

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

export type FileAtRef = { text: string; sha: string };

/** Read a file, and its blob sha, which a later write has to quote so two
 *  tabs cannot silently overwrite each other. */
export async function readFile(
  token: string,
  path: string,
  ref: string
): Promise<FileAtRef | null> {
  const res = await fetch(
    `${API}/repos/${REPO}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`,
    { headers: headers(token) }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { content: string; encoding: string; sha: string };
  const text = Buffer.from(json.content, json.encoding as BufferEncoding).toString('utf8');
  return { text, sha: json.sha };
}

export async function writeFile(
  token: string,
  path: string,
  ref: string,
  content: Buffer | string,
  message: string,
  sha?: string
): Promise<{ commit: string }> {
  const body = {
    message,
    content: Buffer.from(content as any).toString('base64'),
    branch: ref,
    ...(sha ? { sha } : {}),
  };
  const res = await fetch(`${API}/repos/${REPO}/contents/${encodeURI(path)}`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    if (res.status === 409 || res.status === 422) {
      throw new Error(
        'This file changed in the repo since the studio loaded it. Reload and redo the change.'
      );
    }
    throw new Error(`GitHub write failed (${res.status}): ${detail}`);
  }
  const json = (await res.json()) as { commit: { sha: string } };
  return { commit: json.commit.sha };
}

export async function listProjects(
  token: string,
  ref: string
): Promise<{ name: string; path: string }[]> {
  const res = await fetch(
    `${API}/repos/${REPO}/contents/src/content/projects?ref=${encodeURIComponent(ref)}`,
    { headers: headers(token) }
  );
  if (!res.ok) return [];
  const json = (await res.json()) as { name: string; path: string; type: string }[];
  return json
    .filter((f) => f.type === 'file' && f.name.endsWith('.mdoc'))
    .map((f) => ({ name: f.name.replace(/\.mdoc$/, ''), path: f.path }));
}

/** The frontmatter title, for the dashboard, without parsing YAML properly. */
export function titleOf(raw: string, fallback: string): string {
  const m = raw.match(/^title:\s*(.+)$/m);
  if (!m) return fallback;
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}
