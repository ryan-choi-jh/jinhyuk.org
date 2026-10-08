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

// https://astro.build/config
export default defineConfig({
  site: 'https://jinhyuk.org',
  output: isEditor ? 'server' : 'static',
  ...(isEditor ? { adapter: vercel() } : {}),
  integrations: withKeystatic ? [react(), keystatic()] : [],
});
