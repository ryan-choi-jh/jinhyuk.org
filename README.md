# jinhyuk.org

Ryan Choi's personal site. Built with [Astro](https://astro.build), edited
with its own CMS, deployed to GitHub Pages at <https://jinhyuk.org>.

The design lives in Paper ("Personal Site" file): the landing page plus four
section pages. `src/styles/global.css` holds the tokens that mirror it.

## Pages

Every page is a JSON document validated against `src/cms/schema.ts` and read
through `src/lib/site-content.ts`.

| Address | What it is | Where the content comes from |
| --- | --- | --- |
| `/` | Hero illustration + intro | `src/content/pages/home.json` |
| `/projects/` | List of projects | `src/content/pages/projects/*.json` |
| `/projects/<slug>/` | A project write-up | same |
| `/essays/` | List of essays | `src/content/pages/essays/*.json` |
| `/essays/<slug>/` | An essay | same |
| `/photography/` | Album grid | `src/content/data/photography.json` |
| `/photography/<slug>/` | One album | same |
| `/filmography/` | Short films | `src/content/data/filmography.json` |
| the nav and the footer | drawn around every page | `src/content/data/site.json` |

`/writing/` and `/writing/<slug>/` still work: they redirect to `/essays/`,
because the essays lived there before the nav was renamed.

## Editing

The CMS is at <https://jinhyuk-editor.vercel.app/cms>. Sign in with GitHub and
edit any of the five sections in place. **Save** writes a draft the site
ignores; **Publish** moves that draft into the published tree and the site
rebuilds itself, usually within a minute or two. The deploy chip in the
toolbar watches the live site and tells you when your change is actually
being served.

To run it against the real repository from here:

```
CMS_DEV_TOKEN=$(gh auth token) npm run dev
```

then <http://localhost:4321/cms>.

Editing a `.json` file on github.com and committing works too, from any
device, as long as it still validates.

### What happened to Keystatic

It was removed on 2026-10-13. It had kept working long after the cutover,
pointed at `src/content/writing/*` and `src/content/projects/*`, which the
site stopped reading: a complete, usable editor that changed nothing on the
site. `/studio` and `/preview/projects/[slug]`, two earlier attempts at the
same job, went at the same time.

The files those three edited are still in the working tree, unreferenced:
`src/content/home.yaml`, `src/content/writing/*.md`,
`src/content/projects/*.mdoc`, `src/data/photography.ts`,
`src/data/filmography.ts`, and the code under `src/studio/` and
`src/preview/`. Nothing reads any of it. They are the pre-cutover originals,
kept as a safety net, and git has them whenever they are not wanted any more.

### The hero illustration

`public/home/hero.webp` (with a `.jpg` twin for social previews) is exported
from the Paper file at 2x, the "Grid hero" frame. Re-export and re-convert it
there when the illustration changes.

## Publishing

Push to `main`, or press Publish in the CMS, which commits to `main` for you.
GitHub Actions (`.github/workflows/deploy.yml`) builds and deploys to GitHub
Pages.

## Where to change things

- Colours, type, spacing: `src/styles/global.css` (tokens at the top)
- How a document is drawn: `src/cms/styles/doc.css` and `src/cms/render/`
- Nav and footer: edited in the CMS, under Home
- **Working on the CMS itself: read [`cms/AGENTS.md`](cms/AGENTS.md) first.**
  `cms/` holds its documentation: how it works, where it and the site can
  drift, and the rules that keep it honest.
