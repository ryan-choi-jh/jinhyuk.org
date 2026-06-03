// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import keystatic from '@keystatic/astro';
import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
  // When you add a custom domain later, set this to e.g. 'https://ryanchoi.com'
  site: 'https://jinhyukchoi.vercel.app',
  // Essay pages stay static/prerendered; only the /keystatic editor and its
  // API routes are server-rendered (as Vercel functions) — the Keystatic
  // integration marks those routes prerender:false automatically.
  integrations: [react(), keystatic()],
  adapter: vercel(),
});
