/**
 * GET /api/cms/auth/login?return=/path  ->  302 to GitHub
 *
 * A browser navigation, not an API call, so a failure here is still JSON but
 * a success is a redirect.
 */

import type { APIRoute } from 'astro';
import { beginLogin } from '../auth.ts';
import { handle } from '../http.ts';

export const prerender = false;

export const GET: APIRoute = ({ cookies, request }) =>
  handle(async () => beginLogin(request, cookies));
