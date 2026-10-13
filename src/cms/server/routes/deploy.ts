/**
 * GET /api/cms/deploy?commit=<sha>  ->  { ok, state, liveRev, run, elapsedMs }
 *
 * Whether a published commit has reached the live site. Polled by the editor
 * after a publish; see src/cms/server/deploy.ts for what the states mean.
 *
 * Signed in, because this is editor machinery and there is no reason to let
 * the open internet drive polling of the site through this origin. The GitHub
 * reads behind it are anonymous all the same: the repo is public and the
 * author's token has no business being spent on a progress bar.
 */

import type { APIRoute } from 'astro';
import { requireToken } from '../auth.ts';
import { deployStatus } from '../deploy.ts';
import { badRequest } from '../errors.ts';
import { handle, ok } from '../http.ts';

export const prerender = false;

const SHA = /^[0-9a-f]{7,40}$/i;

export const GET: APIRoute = ({ cookies, url }) =>
  handle(async () => {
    await requireToken(cookies);

    const commit = (url.searchParams.get('commit') ?? '').trim();
    if (!SHA.test(commit)) {
      throw badRequest('A deploy check needs ?commit=<sha>.', 'bad_commit');
    }

    // The nonce busts the Pages CDN, which would otherwise answer with a
    // ten-minute-old copy and report a finished deploy as still building.
    const nonce = url.searchParams.get('nonce') ?? String(Date.now());

    const status = await deployStatus(commit, nonce);
    return ok({ ...status }, { headers: { 'Cache-Control': 'no-store' } });
  });
