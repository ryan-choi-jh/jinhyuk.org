/**
 * GET    /api/cms/site  ->  { ok, published: SiteChrome|null, draft: ..., shas }
 * PUT    /api/cms/site  body: SiteChrome  ->  { ok, commit, sha, data }
 * DELETE /api/cms/site                    ->  { ok, commit }
 *
 * The nav bar and the footer: one file, `src/content/data/site.json`, drawn
 * around every page by src/layouts/Base.astro. Not a section — it has no index,
 * no entries and no place in the sidebar — so it has its own endpoints instead
 * of a row in the section table.
 *
 * PUT writes the DRAFT, exactly as every other write in this API does;
 * `POST /api/cms/site/publish` moves it into the published tree.
 */

import type { APIRoute } from 'astro';
import { deleteSite, getSite, putSite } from '../handlers.ts';
import { handle } from '../http.ts';

export const prerender = false;

export const GET: APIRoute = ({ cookies }) => handle(async () => getSite(cookies));

export const PUT: APIRoute = ({ cookies, request }) => handle(async () => putSite(cookies, request));

export const DELETE: APIRoute = ({ cookies, request }) =>
  handle(async () => deleteSite(cookies, request));
