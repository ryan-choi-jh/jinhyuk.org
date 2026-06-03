# Personal site

A minimal, text-first personal website — built with [Astro](https://astro.build).
Inspired by the plainness of paulgraham.com, patrickcollison.com, and
blog.samaltman.com.

## How to add a new post

1. Create a new file in `src/content/writing/`, e.g. `the-thing-i-learned.md`.
   The filename (minus `.md`) becomes the URL: `/writing/the-thing-i-learned/`.
2. Put this at the top of the file (the "frontmatter"):

   ```
   ---
   title: "The thing I learned"
   date: 2026-06-10
   ---

   Your writing goes here, in plain Markdown.
   ```

3. That's it. The post shows up automatically on the home page and `/writing/`,
   newest first.

### Tips

- To save a draft without publishing it, add `draft: true` under the date.
- Markdown basics: `**bold**`, `*italic*`, `## Heading`, `[link](https://...)`,
  `> quote`, and `- ` for bullet lists.

## How to see it locally

```
npm run dev
```

Then open http://localhost:4321/ in your browser. Changes appear instantly as
you save.

## How to publish changes

If deploying with the Vercel CLI: `npm run build` then `vercel --prod`.
(Or, once GitHub is connected, just push and it deploys automatically.)

## Where to edit things

- Your name, bio, social links: `src/layouts/Base.astro` and `src/pages/index.astro`
- The About page: `src/pages/about.astro`
- Colors and fonts: `src/styles/global.css`
