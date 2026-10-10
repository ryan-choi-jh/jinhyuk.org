/**
 * GET /api/cms/auth/status  ->  { ok, signedIn, login? }
 *
 * 200 either way: "not signed in" is an answer, not a failure. The token is
 * checked against GitHub, so a cookie holding a revoked token reports false
 * here rather than failing the first save.
 */

import type { APIRoute } from 'astro';
import { authStatus } from '../auth.ts';
import { handle, ok } from '../http.ts';
import { allowedLogin, defaultBranch } from '../config.ts';
import { REPO } from '../config.ts';

export const prerender = false;

export const GET: APIRoute = ({ cookies }) =>
  handle(async () => {
    const status = await authStatus(cookies);
    return ok({ ...status, repo: REPO, branch: defaultBranch(), expects: allowedLogin() });
  });
