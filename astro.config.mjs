// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import keystatic from '@keystatic/astro';
import vercel from '@astrojs/vercel';

// This repo builds two different things.
//
// 1. The site itself: static HTML, built by GitHub Actions and served from
//    GitHub Pages at https://jinhyuk.org (see .github/workflows/deploy.yml).
//    Pages can't run a server, so Keystatic's editor and its API routes are
//    left out entirely — along with the React runtime they need.
//
// 2. The Keystatic editor: deployed separately to Vercel, which can run
//    Node. Set PUBLIC_EDITOR_BUILD=1 and the build switches to server output with
//    the Vercel adapter and includes Keystatic. That deployment commits to
//    the GitHub repo, which triggers the Pages build above.
//
// `npm run dev` gets the editor too, reading and writing local files.
const isDev = process.argv.includes('dev');
const isEditor = process.env.PUBLIC_EDITOR_BUILD === '1';
const withKeystatic = isDev || isEditor;

const EDITOR_ORIGIN = 'https://jinhyuk-editor.vercel.app';

// https://astro.build/config
export default defineConfig({
  site: isEditor ? EDITOR_ORIGIN : 'https://jinhyuk.org',
  output: isEditor ? 'server' : 'static',
  ...(isEditor ? { adapter: vercel() } : {}),
  integrations: [
    ...(withKeystatic ? [react(), keystatic()] : []),
    // The live preview behind Keystatic's Preview button. It is server
    // rendered, so it can only exist where there is an adapter: injecting it
    // here keeps it out of the static Pages build, which would otherwise fail
    // on its `prerender = false`.
    ...(withKeystatic
      ? [
          {
            name: 'editor-routes',
            hooks: {
              'astro:config:setup': ({ injectRoute }) => {
                injectRoute({
                  pattern: '/preview/projects/[slug]',
                  entrypoint: './src/preview/project-preview.astro',
                });
                // The studio: the editor that is meant to replace Keystatic.
                injectRoute({ pattern: '/studio', entrypoint: './src/studio/index.astro' });
                injectRoute({
                  pattern: '/studio/projects/[slug]',
                  entrypoint: './src/studio/project.astro',
                });
                injectRoute({
                  pattern: '/studio/api/save',
                  entrypoint: './src/studio/api/save.ts',
                });
                injectRoute({
                  pattern: '/studio/api/upload',
                  entrypoint: './src/studio/api/upload.ts',
                });

                // WS-2 STORAGE AND API. The CMS's own endpoints
                // (docs/cms-rebuild.md 3.5). Injected here, next to the ones
                // above, for the same reason: they are server rendered, they
                // set `prerender = false`, and the static GitHub Pages build
                // fails on an on-demand route. That is also why their files
                // live under src/cms/server/routes/ and not under src/pages/
                // — anything under src/pages/ is a route in BOTH builds.
                injectRoute({
                  pattern: '/api/cms/pages',
                  entrypoint: './src/cms/server/routes/pages.ts',
                });
                injectRoute({
                  pattern: '/api/cms/page/[slug]',
                  entrypoint: './src/cms/server/routes/page.ts',
                });
                injectRoute({
                  pattern: '/api/cms/draft/[slug]',
                  entrypoint: './src/cms/server/routes/draft.ts',
                });
                injectRoute({
                  pattern: '/api/cms/publish/[slug]',
                  entrypoint: './src/cms/server/routes/publish.ts',
                });
                injectRoute({
                  pattern: '/api/cms/media/[slug]',
                  entrypoint: './src/cms/server/routes/media.ts',
                });

                // WS-C API EXTENSION. The same API, now for all five sections
                // (docs/cms-contracts.md 11). Two patterns per verb, because a
                // singleton section has no slug and a collection does, and
                // Astro cannot express both with one pattern:
                //
                //   /api/cms/draft/home                 the five routes above
                //   /api/cms/draft/essays/my-essay      the five routes here
                //
                // The single-segment routes above dispatch on whether their
                // segment is a section id, which is what keeps every phase 1
                // URL working. Record collections are one file each, so they
                // get one route and no per-entry patterns at all.
                injectRoute({
                  pattern: '/api/cms/sections',
                  entrypoint: './src/cms/server/routes/sections.ts',
                });
                injectRoute({
                  pattern: '/api/cms/entries/[section]',
                  entrypoint: './src/cms/server/routes/entries.ts',
                });
                injectRoute({
                  pattern: '/api/cms/entry/[section]',
                  entrypoint: './src/cms/server/routes/entry.ts',
                });
                injectRoute({
                  pattern: '/api/cms/entry/[section]/[slug]',
                  entrypoint: './src/cms/server/routes/entry-slug.ts',
                });
                injectRoute({
                  pattern: '/api/cms/draft/[section]/[slug]',
                  entrypoint: './src/cms/server/routes/draft-slug.ts',
                });
                injectRoute({
                  pattern: '/api/cms/publish/[section]/[slug]',
                  entrypoint: './src/cms/server/routes/publish-slug.ts',
                });
                injectRoute({
                  pattern: '/api/cms/media/[section]/[slug]',
                  entrypoint: './src/cms/server/routes/media-slug.ts',
                });
                injectRoute({
                  pattern: '/api/cms/records/[section]',
                  entrypoint: './src/cms/server/routes/records.ts',
                });

                // THE SITE CHROME. The nav bar and the footer live in one file,
                // src/content/data/site.json, and are drawn around every page
                // by src/layouts/Base.astro — so they are not a section and do
                // not fit the table above: no index, no entries, no slug.
                // Hence two routes of their own, read/write/discard plus
                // publish, with the same auth, the same draft-then-publish and
                // the same blob-sha conflict detection as everything else.
                //
                // Injected here, under the same condition and for the same
                // reason as every other endpoint: they set `prerender = false`,
                // and an on-demand route in the static GitHub Pages build fails
                // it. Their files live under src/cms/server/routes/ rather than
                // src/pages/ so they are not routes in both builds.
                injectRoute({
                  pattern: '/api/cms/site',
                  entrypoint: './src/cms/server/routes/site.ts',
                });
                injectRoute({
                  pattern: '/api/cms/site/publish',
                  entrypoint: './src/cms/server/routes/site-publish.ts',
                });

                injectRoute({
                  pattern: '/api/cms/auth/status',
                  entrypoint: './src/cms/server/routes/auth-status.ts',
                });
                injectRoute({
                  pattern: '/api/cms/auth/login',
                  entrypoint: './src/cms/server/routes/auth-login.ts',
                });
                injectRoute({
                  pattern: '/api/cms/auth/callback',
                  entrypoint: './src/cms/server/routes/auth-callback.ts',
                });
                injectRoute({
                  pattern: '/api/cms/auth/signout',
                  entrypoint: './src/cms/server/routes/auth-signout.ts',
                });

                // WS-G EDITOR INTEGRATION (docs/cms-sections.md 5, WS-G). The
                // editor itself. Injected here, under the same condition and
                // for the same reason as everything else in this hook: the
                // route sets `prerender = false`, and an on-demand route in
                // the static GitHub Pages build fails it. Its file lives under
                // src/cms/app/routes/ rather than src/pages/ so it is not a
                // route in both builds.
                //
                // THREE PATTERNS, ONE FILE, ONE ISLAND. /cms is the section
                // list, /cms/<section> is that section's entry list, and
                // /cms/<section>/<slug> is one entry open in its editor. Astro
                // cannot express all three with one pattern, and the shell
                // routes between them client side through History, so the same
                // entrypoint answers all three and the browser only ever loads
                // the application once.
                //
                // /cms/[section] and /cms/preview both match /cms/preview, as
                // do /cms/[section]/[slug] and /cms/preview/[slug]. Astro's
                // router prefers a static segment over a dynamic one, so the
                // preview wins; site.astro redirects those shapes as well, so
                // the two cannot fight even if the rule ever changes.
                //
                // Phase 1's /cms/[slug] -> editor.astro is replaced by
                // /cms/[section]. A single segment that is a slug and not a
                // section redirects to /cms/projects/<slug>, which is where a
                // phase 1 project page lives now, so phase 1 bookmarks still
                // land somewhere right.
                injectRoute({ pattern: '/cms', entrypoint: './src/cms/app/routes/site.astro' });
                injectRoute({
                  pattern: '/cms/[section]',
                  entrypoint: './src/cms/app/routes/site.astro',
                });
                injectRoute({
                  pattern: '/cms/[section]/[slug]',
                  entrypoint: './src/cms/app/routes/site.astro',
                });

                // WS-7 PREVIEW, extended by WS-H (docs/cms-sections.md 5).
                // Server rendered, and excluded from the static Pages build in
                // exactly the way the Keystatic-era /preview/projects/[slug]
                // above is: injected under this same `withKeystatic`
                // condition, with the files outside src/pages/ so they are not
                // routes in both builds.
                //
                // THREE ROUTES, and the order of the last two matters.
                //
                //   /cms/preview              the site, as sections
                //   /cms/preview/frame/...    the surface itself, no chrome
                //   /cms/preview/...          the chrome around it
                //
                // Both of the last two are rest patterns because a preview
                // address is now a section and optionally one key:
                // `home`, `essays/<slug>`, `photography/<album>`, plus phase
                // 1's bare project slug. The frame's marker is a literal
                // segment IN FRONT of the path rather than phase 1's trailing
                // `/frame`, because a trailing marker becomes ambiguous the
                // moment a path can have two segments —
                // `/cms/preview/essays/frame` would be both "the essays index,
                // framed" and "the essay called frame". Astro prefers a static
                // segment over a rest one, so the frame route wins for
                // /cms/preview/frame/... and the chrome takes everything else;
                // preview.astro answers the phase 1 URL with a redirect.
                injectRoute({
                  pattern: '/cms/preview',
                  entrypoint: './src/cms/preview/index.astro',
                });
                injectRoute({
                  pattern: '/cms/preview/frame/[...path]',
                  entrypoint: './src/cms/preview/frame.astro',
                });
                injectRoute({
                  pattern: '/cms/preview/[...path]',
                  entrypoint: './src/cms/preview/preview.astro',
                });
              },
            },
          },
        ]
      : []),
  ],

  // Astro ignores X-Forwarded-Host unless the domain is allowlisted, to stop
  // host-header injection. Behind Vercel's proxy that meant every request
  // looked like https://localhost, and Keystatic builds its GitHub OAuth
  // redirect_uri from the request origin — so GitHub was being told to
  // redirect back to localhost and login could never complete. The wildcard
  // covers preview deployments, which get a generated subdomain.
  ...(isEditor
    ? {
        security: {
          allowedDomains: [
            { hostname: 'jinhyuk-editor.vercel.app', protocol: 'https' },
            { hostname: '**.vercel.app', protocol: 'https' },
          ],
        },
      }
    : {}),
});
