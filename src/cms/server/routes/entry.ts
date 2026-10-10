/**
 * GET /api/cms/entry/[section]  ->  { ok, published: Doc|null, draft: Doc|null, ... }
 *
 * The singleton form. `/api/cms/entry/home` is the homepage; a collection
 * section here is a 400 saying it needs a slug, and a record section a 400
 * pointing at /api/cms/records/<section>.
 *
 * Also returns `publishedSha` and `draftSha`: the editor sends one back as
 * `If-Match` on its next write and gets a 409 instead of silently overwriting
 * somebody.
 */

import type { APIRoute } from 'astro';
import { getEntry, sectionTarget } from '../handlers.ts';
import { handle } from '../http.ts';

export const prerender = false;

export const GET: APIRoute = ({ cookies, params }) =>
  handle(async () => getEntry(cookies, sectionTarget(params)));
