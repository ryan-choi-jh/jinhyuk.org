/**
 * POST /api/cms/media/[slug]  multipart `file`  ->  { ok, src, w, h }
 *
 * w and h are read out of the file's own header, so the editor can place the
 * item at its real aspect ratio without waiting for the browser to load it
 * (docs/cms-contracts.md 3). `dimensions` says where the numbers came from:
 * 'intrinsic' from the pixels, 'declared' from SVG markup, 'fallback' for a
 * format whose header this cannot read (WebM, today).
 *
 * `/api/cms/media/home` uploads into the homepage's directory; anything else
 * is phase 1's endpoint and uploads into a project's. Per-section directories
 * are docs/cms-sections.md 3.5; the two-segment form is in media-slug.ts.
 */

import type { APIRoute } from 'astro';
import { legacyTarget, postMedia } from '../handlers.ts';
import { handle } from '../http.ts';

export const prerender = false;

export const POST: APIRoute = ({ cookies, params, request }) =>
  handle(async () => postMedia(cookies, request, legacyTarget(params)));
