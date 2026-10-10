/**
 * src/cms/server/auth.ts
 *
 * WS-2. The CMS's own GitHub OAuth, against the existing GitHub App
 * (docs/cms-rebuild.md 2.5). It does not borrow Keystatic's session the way
 * src/studio/ does; that was a bridge, and this replaces it.
 *
 * The flow, in full:
 *
 *   GET  /api/cms/auth/login     -> 302 to github.com/login/oauth/authorize
 *   GET  /api/cms/auth/callback  -> exchanges ?code for a token, sets cookies,
 *                                   302 back to where login started
 *   GET  /api/cms/auth/status    -> { signedIn, login? }
 *   POST /api/cms/auth/signout   -> clears the cookies
 *
 * The client secret is read from the environment by name
 * (KEYSTATIC_GITHUB_CLIENT_SECRET, already set on the Vercel project) and
 * never appears in this repository.
 *
 * Only the session cookie leaves this file. The token itself is never put in a
 * response body, so a cross-site script that can read JSON still cannot read
 * the token.
 */

import {
  RETURN_COOKIE,
  REFRESH_COOKIE,
  SESSION_COOKIE,
  STATE_COOKIE,
  allowedLogin,
  env,
  githubClientId,
  githubClientSecret,
  isDev,
  oauthRedirectUri,
} from './config.ts';
import { ApiError, GitHubError, badRequest, forbidden, unauthorized } from './errors.ts';
import { getUser } from './github.ts';

/* -------------------------------------------------------------------------- */
/* Cookies                                                                     */
/* -------------------------------------------------------------------------- */

export type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none' | boolean;
  path?: string;
  maxAge?: number;
};

/**
 * The slice of Astro's `cookies` this module uses. Declared structurally
 * rather than imported so the whole auth path can be driven from a test
 * script with a plain object, which is how the verify script exercises the
 * routes without a server.
 */
export type CookieJar = {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options?: CookieOptions): void;
  delete(name: string, options?: CookieOptions): void;
};

/**
 * httpOnly, secure, sameSite=lax, as the brief specifies.
 *
 * sameSite=lax rather than strict because the OAuth callback is a top-level
 * navigation from github.com, and a strict cookie would not be sent on it.
 * secure is unconditional; browsers treat http://localhost as a secure origin,
 * so `astro dev` still works.
 */
function sessionCookieOptions(maxAge: number): CookieOptions {
  return { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge };
}

const THIRTY_DAYS = 60 * 60 * 24 * 30;
const SIX_MONTHS = 60 * 60 * 24 * 182;
const TEN_MINUTES = 60 * 10;

function clearSession(cookies: CookieJar): void {
  cookies.delete(SESSION_COOKIE, { path: '/' });
  cookies.delete(REFRESH_COOKIE, { path: '/' });
}

/* -------------------------------------------------------------------------- */
/* Token exchange                                                              */
/* -------------------------------------------------------------------------- */

const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
};

/**
 * GitHub answers a bad grant with HTTP 200 and an `error` key, which is the
 * single most common way to write a login that appears to work and produces a
 * session holding the string "undefined".
 */
async function exchange(body: Record<string, string>): Promise<TokenResponse> {
  const secret = githubClientSecret();
  if (secret === null) {
    throw new ApiError(
      500,
      'The GitHub client secret is not configured. Set KEYSTATIC_GITHUB_CLIENT_SECRET in the deployment environment.',
      'no_secret',
    );
  }
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: githubClientId(), client_secret: secret, ...body }),
  });
  if (!response.ok) {
    throw new GitHubError(response.status, 'token exchange', await response.text());
  }
  const parsed = (await response.json()) as TokenResponse;
  if (parsed.error !== undefined) {
    throw new ApiError(
      401,
      `GitHub refused the sign-in: ${parsed.error_description ?? parsed.error}`,
      parsed.error,
    );
  }
  if (parsed.access_token === undefined || parsed.access_token === '') {
    throw new ApiError(502, 'GitHub returned no access token.', 'no_token');
  }
  return parsed;
}

function storeSession(cookies: CookieJar, token: TokenResponse): void {
  const accessToken = token.access_token as string;
  // A GitHub App with expiring user tokens says how long it has; one with
  // expiry switched off says nothing, and the token lasts until it is revoked.
  cookies.set(SESSION_COOKIE, accessToken, sessionCookieOptions(token.expires_in ?? THIRTY_DAYS));
  if (token.refresh_token !== undefined && token.refresh_token !== '') {
    cookies.set(
      REFRESH_COOKIE,
      token.refresh_token,
      sessionCookieOptions(token.refresh_token_expires_in ?? SIX_MONTHS),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Sign in                                                                     */
/* -------------------------------------------------------------------------- */

/** A `?return=` that cannot be used to bounce someone off this origin. */
function safeReturnPath(raw: string | null): string {
  if (raw === null || raw === '') return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Start the round trip. The state is kept in its own short-lived cookie and
 * checked on the way back, so a callback this server did not initiate is
 * refused.
 *
 * No `scope` parameter: a GitHub App's permissions are fixed by its
 * installation, and sending a scope is how an App's authorize URL gets
 * rejected as if it were an OAuth App's.
 */
export function beginLogin(request: Request, cookies: CookieJar): Response {
  const url = new URL(request.url);
  const state = randomState();
  const returnTo = safeReturnPath(url.searchParams.get('return'));

  cookies.set(STATE_COOKIE, state, sessionCookieOptions(TEN_MINUTES));
  cookies.set(RETURN_COOKIE, returnTo, sessionCookieOptions(TEN_MINUTES));

  const authorize = new URL(AUTHORIZE_URL);
  authorize.searchParams.set('client_id', githubClientId());
  authorize.searchParams.set('redirect_uri', oauthRedirectUri(request.url));
  authorize.searchParams.set('state', state);

  return new Response(null, { status: 302, headers: { Location: authorize.toString() } });
}

/**
 * Finish the round trip: check the state, swap the code for a token, check who
 * it belongs to, set the session.
 *
 * The identity check happens before the cookie is set. This is a single-user
 * CMS; somebody else's valid GitHub token has no business becoming a session
 * here even though the App's own permissions would stop it committing.
 */
export async function completeLogin(request: Request, cookies: CookieJar): Promise<Response> {
  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  if (error !== null) {
    throw new ApiError(
      401,
      `GitHub refused the sign-in: ${url.searchParams.get('error_description') ?? error}`,
      error,
    );
  }

  const code = url.searchParams.get('code');
  if (code === null || code === '') throw badRequest('No ?code on the OAuth callback.');

  const expectedState = cookies.get(STATE_COOKIE)?.value;
  const actualState = url.searchParams.get('state');
  if (expectedState === undefined) {
    throw badRequest(
      'This sign-in has expired or did not start here. Open /api/cms/auth/login again.',
      'no_state',
    );
  }
  if (actualState !== expectedState) {
    throw forbidden('The OAuth state did not match. Start the sign-in again.');
  }
  cookies.delete(STATE_COOKIE, { path: '/' });

  const token = await exchange({
    code,
    redirect_uri: oauthRedirectUri(request.url),
  });

  const user = await getUser(token.access_token as string);
  const allowed = allowedLogin();
  if (user.login.toLowerCase() !== allowed.toLowerCase()) {
    throw forbidden(
      `Signed in to GitHub as "${user.login}", but this editor is only for "${allowed}".`,
    );
  }

  storeSession(cookies, token);
  const returnTo = safeReturnPath(cookies.get(RETURN_COOKIE)?.value ?? null);
  cookies.delete(RETURN_COOKIE, { path: '/' });

  return new Response(null, {
    status: 302,
    headers: { Location: new URL(returnTo, request.url).toString() },
  });
}

/* -------------------------------------------------------------------------- */
/* Using a session                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The token for this request, or null.
 *
 * When the access token has expired but a refresh token is still there, this
 * refreshes transparently and updates both cookies, so a session that is a day
 * old does not surface as a mysterious 401 in the middle of a save.
 */
export async function sessionToken(cookies: CookieJar): Promise<string | null> {
  const current = cookies.get(SESSION_COOKIE)?.value;
  if (current !== undefined && current !== '') return current;

  const refresh = cookies.get(REFRESH_COOKIE)?.value;
  if (refresh !== undefined && refresh !== '') {
    try {
      const token = await exchange({ grant_type: 'refresh_token', refresh_token: refresh });
      storeSession(cookies, token);
      return token.access_token as string;
    } catch {
      // A dead refresh token is a sign-out, not a server error.
      clearSession(cookies);
      return null;
    }
  }

  // Local convenience only, and only under `astro dev`: import.meta.env.DEV is
  // replaced with false in both production builds, so this cannot become a way
  // into the deployed editor. It exists so the CMS can be driven against the
  // real repo from `npm run dev` with `CMS_DEV_TOKEN=$(gh auth token)`.
  if (isDev()) {
    const devToken = env('CMS_DEV_TOKEN');
    if (devToken !== undefined) return devToken;
  }

  return null;
}

/** The token, or a 401 with a message that says what to do about it. */
export async function requireToken(cookies: CookieJar): Promise<string> {
  const token = await sessionToken(cookies);
  if (token === null) throw unauthorized();
  return token;
}

export type AuthStatus = { signedIn: boolean; login?: string; name?: string | null };

/**
 * Whether this browser has a working session. The token is checked against
 * GitHub rather than merely being present: a cookie holding a revoked token
 * looks exactly like a cookie holding a live one, and the editor should find
 * that out on load rather than on the first save.
 */
export async function authStatus(cookies: CookieJar): Promise<AuthStatus> {
  const token = await sessionToken(cookies);
  if (token === null) return { signedIn: false };
  try {
    const user = await getUser(token);
    return { signedIn: true, login: user.login, name: user.name };
  } catch {
    clearSession(cookies);
    return { signedIn: false };
  }
}

/** Forget the session. The token is not revoked at GitHub; this is a sign-out, not a teardown. */
export function signOut(cookies: CookieJar): void {
  clearSession(cookies);
  cookies.delete(STATE_COOKIE, { path: '/' });
  cookies.delete(RETURN_COOKIE, { path: '/' });
}
