// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import keystatic from '@keystatic/astro';

// The whole site is static HTML, built by GitHub Actions and served from
// GitHub Pages at https://jinhyuk.org (see .github/workflows/deploy.yml).
//
// Keystatic's editor (/keystatic) and its API routes need a server, which
// GitHub Pages can't provide — so the integration (and the React runtime it
// needs) is only loaded for `npm run dev`, where it runs in local mode and
// edits the files directly. Commit + push those edits and the site rebuilds.
const isDev = process.argv.includes('dev');

// https://astro.build/config
export default defineConfig({
  site: 'https://jinhyuk.org',
  output: 'static',
  integrations: isDev ? [react(), keystatic()] : [],
});
