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
            name: 'preview-routes',
            hooks: {
              'astro:config:setup': ({ injectRoute }) => {
                injectRoute({
                  pattern: '/preview/projects/[slug]',
                  entrypoint: './src/preview/project-preview.astro',
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
