/**
 * GET /api/cms/auth/callback?code=&state=  ->  302 back into the editor
 *
 * NOTE: this path has to be registered as a callback URL on the GitHub App
 * (`jinhyuk.org Keystatic`). The App currently only knows Keystatic's
 * /api/keystatic/github/oauth/callback. A GitHub App takes up to ten.
 */

import type { APIRoute } from 'astro';
import { completeLogin } from '../auth.ts';
import { handle } from '../http.ts';

export const prerender = false;

export const GET: APIRoute = ({ cookies, request }) =>
  handle(async () => completeLogin(request, cookies));
