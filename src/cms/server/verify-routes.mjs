/**
 * src/cms/server/verify-routes.mjs
 *
 * WS-C. The one thing verify.ts cannot check.
 *
 * verify.ts drives the route handlers directly, with a hand-made Request, so
 * it proves what the handlers do but says nothing about whether Astro is
 * actually serving them at the URLs astro.config.mjs claims. A typo in an
 * `injectRoute` pattern, or a route pattern that shadows another, would pass
 * every check in that file and 404 in the browser.
 *
 * So this walks every endpoint over real HTTP against `astro dev`, with NO
 * session, and asserts the status each one answers with. 401 is the
 * interesting answer: it means the route exists, resolved its params and
 * reached the session check. A 404 on a path that should be a route is the
 * failure this exists to catch.
 *
 * Run it:
 *
 *   npm run dev -- --port 4399          # in one terminal, WITHOUT CMS_DEV_TOKEN
 *   node src/cms/server/verify-routes.mjs
 *
 * `CMS_DEV_TOKEN` must not be set, or the endpoints will answer 200 and talk
 * to the real repository. Nothing here writes anything in any case: every
 * request is unauthenticated.
 *
 * Pass a different origin as the first argument to check a deployment.
 */

const base = (process.argv[2] ?? 'http://127.0.0.1:4399').replace(/\/$/, '');

/**
 * [method, path, expected status, what it proves]
 *
 * 401 = the route is wired and the section and key in the URL resolved.
 * 404 = a section id that does not exist (and nothing else should 404).
 * 400 = the URL resolved to a real section whose shape refuses this request.
 */
const cases = [
  // Phase 2: the section-aware surface (docs/cms-contracts.md 11).
  ['GET', '/api/cms/sections', 401, 'the sidebar'],
  ['GET', '/api/cms/entries/essays', 401, 'a collection list'],
  ['GET', '/api/cms/entries/home', 401, 'a singleton list'],
  ['GET', '/api/cms/entries/filmography', 401, 'a record list'],
  ['GET', '/api/cms/entries/blog', 404, 'a section that does not exist'],
  ['GET', '/api/cms/entry/home', 401, 'the singleton, one segment, no slug'],
  ['GET', '/api/cms/entry/essays/some-essay', 401, 'a collection entry'],
  ['GET', '/api/cms/entry/home/nope', 400, 'a singleton has no entries'],
  ['GET', '/api/cms/entry/filmography', 400, 'records are not documents'],
  ['PUT', '/api/cms/draft/home', 401, 'write the homepage draft'],
  ['PUT', '/api/cms/draft/essays/some-essay', 401, 'write a collection draft'],
  ['PUT', '/api/cms/draft/essays', 400, 'a collection needs a slug'],
  ['PUT', '/api/cms/draft/filmography', 400, 'records use /records'],
  ['DELETE', '/api/cms/draft/home', 401, 'discard the homepage draft'],
  ['DELETE', '/api/cms/draft/essays/some-essay', 401, 'discard a collection draft'],
  ['POST', '/api/cms/publish/home', 401, 'publish the homepage'],
  ['POST', '/api/cms/publish/essays/some-essay', 401, 'publish an essay'],
  ['POST', '/api/cms/publish/filmography', 401, 'publish a whole collection'],
  ['GET', '/api/cms/records/filmography', 401, 'read a collection'],
  ['PUT', '/api/cms/records/photography', 401, 'write a whole collection'],
  ['POST', '/api/cms/records/photography', 401, 'one record operation'],
  ['DELETE', '/api/cms/records/filmography', 401, "discard a collection's draft"],
  ['GET', '/api/cms/records/essays', 400, 'documents are not records'],
  ['POST', '/api/cms/media/home', 401, 'upload with no key'],
  ['POST', '/api/cms/media/essays/some-essay', 401, 'upload to an essay'],
  ['POST', '/api/cms/media/filmography/film_untitled', 401, 'upload a film poster'],
  ['POST', '/api/cms/media/photography/an-album', 401, 'upload an album photo'],

  // The site chrome: one file, not a section, so two routes of its own.
  ['GET', '/api/cms/site', 401, 'read the nav and the footer'],
  ['PUT', '/api/cms/site', 401, 'save the nav-and-footer draft'],
  ['DELETE', '/api/cms/site', 401, 'discard that draft'],
  ['POST', '/api/cms/site/publish', 401, 'publish the nav and the footer'],

  // Phase 1, which must keep working (docs/cms-contracts.md 11, last paragraph).
  ['GET', '/api/cms/pages', 401, 'phase 1 list'],
  ['GET', '/api/cms/page/track-daily-habit-tracker', 401, 'phase 1 read'],
  ['PUT', '/api/cms/draft/track-daily-habit-tracker', 401, 'phase 1 draft write'],
  ['DELETE', '/api/cms/draft/track-daily-habit-tracker', 401, 'phase 1 discard'],
  ['POST', '/api/cms/publish/track-daily-habit-tracker', 401, 'phase 1 publish'],
  ['POST', '/api/cms/media/track-daily-habit-tracker', 401, 'phase 1 upload'],

  // Auth, unchanged.
  ['GET', '/api/cms/auth/status', 200, 'not signed in is an answer, not a failure'],
  ['POST', '/api/cms/auth/signout', 200, 'sign out'],
];

if (process.env.CMS_DEV_TOKEN !== undefined && process.env.CMS_DEV_TOKEN !== '') {
  console.error(
    'CMS_DEV_TOKEN is set in this shell. Unset it: these checks expect 401 and a token would make them talk to the real repository.',
  );
  process.exit(2);
}

let reachable = true;
try {
  await fetch(`${base}/api/cms/auth/status`);
} catch {
  reachable = false;
}
if (!reachable) {
  console.error(
    `Nothing is answering at ${base}. Start the editor first:\n  npm run dev -- --port 4399`,
  );
  process.exit(2);
}

console.log(`\u001b[1mWS-C route injection: every endpoint over real HTTP\u001b[0m`);
console.log(`  ${base}\n`);

let failed = 0;
for (const [method, path, want, why] of cases) {
  const init = { method, redirect: 'manual' };
  if (method === 'PUT' || method === 'POST') {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = '{}';
  }
  const response = await fetch(base + path, init);
  const body = (await response.text()).slice(0, 120).replace(/\s+/g, ' ');
  const ok = response.status === want;
  if (!ok) failed += 1;
  const tag = ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
  console.log(
    `  ${tag} ${String(response.status).padEnd(3)} ${method.padEnd(6)} ${path.padEnd(44)} ${why}`,
  );
  if (!ok) console.log(`       wanted ${want}; body was ${body}`);
}

console.log(
  `\n\u001b[1m${cases.length - failed} passed, ${failed} failed\u001b[0m`,
);
if (failed > 0) {
  console.log(
    '  A 404 where a 401 was wanted means astro.config.mjs is not injecting that route.',
  );
  process.exit(1);
}
