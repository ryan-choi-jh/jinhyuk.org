/**
 * POST /api/cms/publish/[slug]  ->  { ok, commit }
 *
 * Copies the draft over the published file and deletes the draft, in one
 * commit (docs/cms-rebuild.md 2.3). An optional `If-Match` is the published
 * blob the author believes they are replacing, which turns "somebody else
 * published while I was writing" into a 409.
 *
 * One segment, three meanings, in the order `legacyTarget` resolves them:
 * `/api/cms/publish/home` is the homepage, `/api/cms/publish/filmography` is
 * that whole record collection (one file, one commit), and anything else is
 * phase 1's endpoint for a project.
 */

import type { APIRoute } from 'astro';
import { legacyTarget, postPublish } from '../handlers.ts';
import { handle } from '../http.ts';

export const prerender = false;

export const POST: APIRoute = ({ cookies, params, request }) =>
  handle(async () => postPublish(cookies, request, legacyTarget(params)));
