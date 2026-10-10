/**
 * POST /api/cms/publish/[section]/[slug]  ->  { ok, commit }
 *
 * Copies the draft over the published entry and deletes the draft, in one
 * commit (docs/cms-rebuild.md 2.3).
 */

import type { APIRoute } from 'astro';
import { postPublish, sectionTarget } from '../handlers.ts';
import { handle } from '../http.ts';

export const prerender = false;

export const POST: APIRoute = ({ cookies, params, request }) =>
  handle(async () => postPublish(cookies, request, sectionTarget(params)));
