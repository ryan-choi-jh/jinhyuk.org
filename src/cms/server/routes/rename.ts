/**
 * POST /api/cms/rename/[section]/[slug]  ->  { ok, from, to, redirectFrom, ... }
 *
 * Body: `{ "to": "a-new-name" }`.
 *
 * A path of its own rather than a verb on the entry route, because it is
 * neither a read nor a write of that entry: it is a move, and the entry at
 * the old address stops existing. See src/cms/server/moves.ts.
 */

import type { APIRoute } from 'astro';
import { postRename } from '../handlers.ts';
import { handle } from '../http.ts';

export const prerender = false;

export const POST: APIRoute = ({ cookies, request, params }) =>
  handle(async () => postRename(cookies, request, params));
