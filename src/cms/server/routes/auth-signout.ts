/**
 * POST /api/cms/auth/signout  ->  { ok }
 *
 * POST, not GET: a GET sign-out can be fired by any page that can get the
 * browser to load a URL. The cookies are forgotten here; the token is not
 * revoked at GitHub, which is what the App's own settings page is for.
 */

import type { APIRoute } from 'astro';
import { signOut } from '../auth.ts';
import { handle, ok } from '../http.ts';

export const prerender = false;

export const POST: APIRoute = ({ cookies }) =>
  handle(async () => {
    signOut(cookies);
    return ok({ signedIn: false });
  });
