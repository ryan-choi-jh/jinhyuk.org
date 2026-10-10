/**
 * GET /api/cms/page/[slug]  ->  { ok, published: Doc|null, draft: Doc|null, ... }
 *
 * Phase 1's read endpoint, kept working (docs/cms-contracts.md 11, last
 * paragraph). `/api/cms/page/home` reads the homepage; anything else reads a
 * project. The phase 2 name for this is /api/cms/entry/[section][/slug], which
 * is the one to build new URLs against.
 *
 * Also returns `publishedSha` and `draftSha`. They are not in the phase 1
 * contract table, which only fixes a minimum; the editor sends one back as
 * `If-Match` on its next write and gets a 409 instead of silently overwriting
 * somebody.
 */

import type { APIRoute } from 'astro';
import { getEntry, legacyTarget } from '../handlers.ts';
import { handle } from '../http.ts';

export const prerender = false;

export const GET: APIRoute = ({ cookies, params }) =>
  handle(async () => getEntry(cookies, legacyTarget(params)));
