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

## How to edit with the visual editor

```
npm run dev
```

Then open http://localhost:4321/keystatic. It edits the files in `src/content/`
directly — commit and push when you're done.

The editor only runs locally. The live site is plain static files on GitHub
Pages, which can't run the server the editor needs to log in with GitHub.
(Editing a `.md` file on github.com and committing works too, from any device.)

## How to publish changes

Push to `main`. GitHub Actions (`.github/workflows/deploy.yml`) builds the site
and deploys it to GitHub Pages at https://jinhyuk.org — usually live within a
minute or two.

## Where to edit things

- Your name, bio, social links: `src/layouts/Base.astro` and `src/pages/index.astro`
- The About page: `src/pages/about.astro`
- Colors and fonts: `src/styles/global.css`
