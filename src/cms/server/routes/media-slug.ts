/**
 * POST /api/cms/media/[section]/[slug]  multipart `file`  ->  { ok, src, w, h }
 *
 * Uploads into this section's own directory, `public/media/<section>/<key>/`
 * (docs/cms-sections.md 3.5). The key is a document slug for projects and
 * essays, a film's record id for filmography, an album's slug for photography.
 */

import type { APIRoute } from 'astro';
import { postMedia, sectionTarget } from '../handlers.ts';
import { handle } from '../http.ts';

export const prerender = false;

export const POST: APIRoute = ({ cookies, params, request }) =>
  handle(async () => postMedia(cookies, request, sectionTarget(params)));
