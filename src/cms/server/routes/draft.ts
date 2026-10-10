/**
 * PUT    /api/cms/draft/[slug]   body: Doc  ->  { ok, commit }
 * DELETE /api/cms/draft/[slug]              ->  { ok }
 *
 * The single-segment draft endpoint, which is two things at once.
 *
 *  - `/api/cms/draft/home` is the HOMEPAGE. A singleton section's content path
 *    has no `:slug` to fill, so one segment is its whole address.
 *  - `/api/cms/draft/track-daily-habit-tracker` is phase 1's endpoint,
 *    unchanged, and means the projects collection
 *    (docs/cms-contracts.md 11, last paragraph).
 *
 * A section id wins over a project slug; `legacyTarget` says what that costs.
 * Collections are better addressed at the two-segment form in draft-slug.ts.
 *
 * The editor only ever writes here (docs/cms-rebuild.md 2.3). Nothing in this
 * file can touch the published tree, so no bug in the editor can put an
 * unfinished page on the live site.
 *
 * Optional `If-Match: <blob sha>` is the concurrency control. Sent, it means
 * "the draft I loaded was this one"; absent, the server quotes whatever sha it
 * reads, so a commit landing in the window is still caught.
 */

import type { APIRoute } from 'astro';
import { deleteDraftEntry, legacyTarget, putDraft } from '../handlers.ts';
import { handle } from '../http.ts';

export const prerender = false;

export const PUT: APIRoute = ({ cookies, params, request }) =>
  handle(async () => putDraft(cookies, request, legacyTarget(params)));

export const DELETE: APIRoute = ({ cookies, params, request }) =>
  handle(async () => deleteDraftEntry(cookies, request, legacyTarget(params)));
