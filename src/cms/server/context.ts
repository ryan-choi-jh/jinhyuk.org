/**
 * src/cms/server/context.ts
 *
 * WS-2. One line, but it is the line every endpoint starts with: turn the
 * request's cookies into a store context, or fail with a 401.
 */

import { requireToken } from './auth.ts';
import type { CookieJar } from './auth.ts';
import { defaultBranch } from './config.ts';
import type { Ctx } from './store.ts';

export async function ctxFrom(cookies: CookieJar): Promise<Ctx> {
  return { token: await requireToken(cookies), branch: defaultBranch() };
}
