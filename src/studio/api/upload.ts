import type { APIRoute } from 'astro';
import { writeFile, readFile, tokenFrom } from '../lib/github';

export const prerender = false;

const ALLOWED = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'mp4', 'webm']);

/** Put a dropped file into public/projects/<slug>/ and hand back its path. */
export const POST: APIRoute = async ({ request, cookies }) => {
  const token = tokenFrom(cookies);
  if (!token) {
    return json({ error: 'Not signed in. Open /keystatic once to sign in to GitHub.' }, 401);
  }

  const form = await request.formData();
  const file = form.get('file');
  const slug = String(form.get('slug') ?? '');
  const branch = String(form.get('branch') ?? 'main');

  if (!(file instanceof File)) return json({ error: 'No file.' }, 400);
  if (!/^[a-z0-9-]+$/i.test(slug)) return json({ error: 'Bad slug.' }, 400);

  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  if (!ALLOWED.has(ext)) return json({ error: `Cannot take a .${ext} file.` }, 400);
  if (file.size > 20 * 1024 * 1024) return json({ error: 'Larger than 20MB.' }, 400);

  // Keep the original name where possible; it is far easier to recognise in
  // the repo later than a hash would be.
  const base = file.name
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'image';

  const dir = `public/projects/${slug}`;
  let name = `${base}.${ext}`;
  let path = `${dir}/${name}`;

  // Do not quietly replace a file that is already there under that name.
  for (let n = 2; n < 50; n += 1) {
    const existing = await readFile(token, path, branch).catch(() => null);
    if (!existing) break;
    name = `${base}-${n}.${ext}`;
    path = `${dir}/${name}`;
  }

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    await writeFile(token, path, branch, buf, `Studio: add ${name} to ${slug}`);
    return json({ ok: true, src: `/projects/${slug}/${name}` });
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
