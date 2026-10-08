# jinhyuk.org

Ryan Choi's personal site. Built with [Astro](https://astro.build), edited with
[Keystatic](https://keystatic.com), deployed to GitHub Pages at
<https://jinhyuk.org>.

The design lives in Paper ("Personal Site" file) — the landing page plus four
section pages. `src/styles/global.css` holds the tokens that mirror it.

## Pages

| Address | What it is | Where the content comes from |
| --- | --- | --- |
| `/` | Hero illustration + intro | `src/content/home.yaml` |
| `/projects/` | List of projects | `src/content/projects/*.yaml` |
| `/projects/<slug>/` | A project write-up | same |
| `/essays/` | List of essays | `src/content/writing/*.md` |
| `/essays/<slug>/` | An essay | same |
| `/photography/` | Album grid | `src/data/photography.ts` |
| `/filmography/` | Short films | `src/data/filmography.ts` |

`/writing/` and `/writing/<slug>/` still work — they redirect to `/essays/`,
because the essays lived there before the nav was renamed.

## Editing

```
npm run dev
```

Then <http://localhost:4321/keystatic> for the visual editor (home page,
projects, essays). It edits the files in `src/content/` directly — commit and
push when you're done. The editor only runs locally; the live site is static
files on GitHub Pages, which can't run the server the editor needs.

Editing a `.md` file on github.com and committing works too, from any device.

### Adding an essay by hand

Create `src/content/writing/the-thing-i-learned.md`. The filename becomes the
URL (`/essays/the-thing-i-learned/`).

```
---
title: "The thing I learned"
date: 2026-06-10
---

Your writing goes here, in plain Markdown.
```

Add `draft: true` under the date to keep it unpublished.

### Photography and filmography

These two aren't in Keystatic — they're small TypeScript files you edit
directly.

- **Photography** (`src/data/photography.ts`) is currently placeholders with no
  images behind them. Put images in `public/photography/<slug>/` and point each
  album's `cover` at one.
- **Filmography** (`src/data/filmography.ts`) lists YouTube video IDs. Each film
  needs a poster frame at `public/filmography/<id>.jpg` (1280×720). The page
  shows that still and only loads the YouTube player when someone clicks, so
  four embeds don't slow the page down.

### The hero illustration

`public/home/hero.webp` (with a `.jpg` twin for social previews) is exported
from the Paper file at 2× — the "Grid hero" frame. Re-export and re-convert it
there when the illustration changes.

## Publishing

Push to `main`. GitHub Actions (`.github/workflows/deploy.yml`) builds and
deploys to GitHub Pages, usually live within a minute or two.

## Where to change things

- Colours, type, spacing: `src/styles/global.css` (tokens at the top)
- Nav and footer: `src/layouts/Base.astro`
- Social links: `src/components/SocialLinks.astro`
