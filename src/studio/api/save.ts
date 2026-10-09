import type { APIRoute } from 'astro';
import { readFile, writeFile, tokenFrom } from '../lib/github';
import { applyEdits, type CanvasEdit } from '../lib/mdoc';

export const prerender = false;

/**
 * Commit canvas changes to a project.
 *
 * The client sends edits, not a file. The server re-reads the current file,
 * splices only the lines belonging to the canvases being changed, and commits
 * that. Prose is never round-tripped through a serialiser, so a bug here
 * cannot reflow or lose a paragraph.
 */
export const POST: APIRoute = async ({ request, cookies }) => {
  const token = tokenFrom(cookies);
  if (!token) {
    return json({ error: 'Not signed in. Open /keystatic once to sign in to GitHub.' }, 401);
  }

  let payload: { slug?: string; branch?: string; edits?: CanvasEdit[] };
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Expected JSON.' }, 400);
  }

  const slug = payload.slug;
  const branch = payload.branch || 'main';
  const edits = payload.edits ?? [];

  if (!slug || !/^[a-z0-9-]+$/i.test(slug)) return json({ error: 'Bad slug.' }, 400);
  if (edits.length === 0) return json({ error: 'Nothing to save.' }, 400);

  const path = `src/content/projects/${slug}.mdoc`;

  try {
    const current = await readFile(token, path, branch);
    if (!current) return json({ error: `No such project: ${slug}` }, 404);

    const next = applyEdits(current.text, edits);
    if (next === current.text) return json({ ok: true, unchanged: true });

    const { commit } = await writeFile(
      token,
      path,
      branch,
      next,
      `Studio: update ${slug}`,
      current.sha
    );
    return json({ ok: true, commit });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
