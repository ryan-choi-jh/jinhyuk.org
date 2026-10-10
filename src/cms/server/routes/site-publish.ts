/**
 * POST /api/cms/site/publish  ->  { ok, commit, sha, data }
 *
 * Copy the nav-and-footer draft over `src/content/data/site.json` and delete the
 * draft, in one commit — the same `publishSlot` every other publish goes
 * through, so a reader of the repo never sees both files disagreeing and the
 * Pages deploy fires once.
 *
 * `If-Match` is the published file the author believes they are replacing, which
 * turns "someone else published while I was editing" into a 409 instead of a
 * silent overwrite.
 */

import type { APIRoute } from 'astro';
import { postSitePublish } from '../handlers.ts';
import { handle } from '../http.ts';

export const prerender = false;

export const POST: APIRoute = ({ cookies, request }) =>
  handle(async () => postSitePublish(cookies, request));
