/**
 * PUT    /api/cms/draft/[section]/[slug]   body: Doc  ->  { ok, commit }
 * DELETE /api/cms/draft/[section]/[slug]              ->  { ok }
 *
 * The collection form of the draft endpoint. Nothing in this file can touch
 * the published tree, so no bug in the editor can put an unfinished page on
 * the live site (docs/cms-rebuild.md 2.3).
 */

import type { APIRoute } from 'astro';
import { deleteDraftEntry, putDraft, sectionTarget } from '../handlers.ts';
import { handle } from '../http.ts';

export const prerender = false;

export const PUT: APIRoute = ({ cookies, params, request }) =>
  handle(async () => putDraft(cookies, request, sectionTarget(params)));

export const DELETE: APIRoute = ({ cookies, params, request }) =>
  handle(async () => deleteDraftEntry(cookies, request, sectionTarget(params)));
