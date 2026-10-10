/**
 * GET /api/cms/pages  ->  { ok, pages: { slug, title, hasDraft }[] }
 *
 * docs/cms-contracts.md 3. Injected by astro.config.mjs; this file is
 * deliberately not under src/pages/, because anything under src/pages/ exists
 * in the static GitHub Pages build too, and an on-demand route there fails it.
 */

import type { APIRoute } from 'astro';
import { ctxFrom } from '../context.ts';
import { handle, ok } from '../http.ts';
import { listPages } from '../store.ts';

export const prerender = false;

export const GET: APIRoute = ({ cookies }) =>
  handle(async () => {
    const pages = await listPages(await ctxFrom(cookies));
    return ok({ pages });
  });
