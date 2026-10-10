# Phase 2: the CMS covers the whole site

Addendum to `docs/cms-rebuild.md`. That document still governs: the rules in
its section 5, the 1344px reference width, the 900px breakpoint, and the
contracts in its section 3 all stand. This adds the other four surfaces.

Read `docs/cms-rebuild.md` and `docs/cms-contracts.md` before this.

---

## 1. What is wrong today

Phase 1 built a good editor for exactly one thing: a project page. The site
has five surfaces and they store content five different ways.

| Surface | Stored today | Editable by a CMS? |
|---|---|---|
| Home | `src/content/home.yaml` | Only name and intro exist |
| Essays | `src/content/writing/*.md` | Markdown; no canvas, no media placement |
| Projects | `src/content/projects/*.mdoc` → `src/content/pages/*.json` | Yes, after phase 1 |
| Filmography | `src/data/filmography.ts` | **No. It is TypeScript source.** |
| Photography | `src/data/photography.ts` | **No. It is TypeScript source, and empty.** |

Two surfaces are source code. No editor can write them without the build
importing whatever the editor produced, so they have to become content.

## 2. What the CMS must become

A section-based tool. The left-hand navigation is the site:

```
Home          singleton   document
Projects      collection  documents
Essays        collection  documents
Filmography   collection  records      (YouTube films)
Photography   collection  records      (albums of photos)
```

Two kinds of editor, because two kinds of content:

- **Document editor** — the phase 1 editor: bands of prose and canvas. Used by
  Home, Projects and Essays.
- **Record editor** — typed fields plus media. Used by Filmography and
  Photography. A film is not a page and should not pretend to be one.

## 3. Decisions

**3.1 Essays become documents.** They are markdown today. Converting them to
`Doc` means one renderer, one editor, and essays gain the canvas, media
placement and squiggles that projects have. The alternative is maintaining a
second content path forever.

**3.2 Home becomes a document.** A singleton `Doc`, so the hero illustration
and the intro are editable, and so the homepage can eventually hold a canvas
like anything else. Its current `name` and `intro` map onto a prose band.

**3.3 Filmography and photography become JSON records,** not TypeScript. The
site reads the JSON at build time. `src/data/*.ts` is deleted at cutover.

**3.4 Albums get a page.** "Album, album name, album cover photo, other
photos" means an album is more than a tile: there is a page behind it. This is
new site surface, not only new CMS surface. `/photography/<album>/`.

**3.5 One shared media pipeline.** Everything uploads through WS-2's endpoint
to `public/media/<collection>/<slug>/`. No more `public/filmography/<id>.jpg`
conventions to remember.

## 4. Content shapes

Added to `src/cms/schema.ts`. Everything already there is unchanged.

```ts
type SectionId = 'home' | 'projects' | 'essays' | 'filmography' | 'photography';

// Filmography
type Film = {
  id: string;            // stable record id
  youtubeId: string;     // the embed
  title: string;
  note?: string;
  kind: string;          // "SHORT FILM"
  year: string;
  poster?: string;       // /media/filmography/<id>.jpg, else YouTube's
};

// Photography
type Photo = {
  id: string;
  src: string;
  alt?: string;
  caption?: string;
  w?: number;            // intrinsic, from the upload endpoint
  h?: number;
};

type Album = {
  id: string;
  slug: string;          // /photography/<slug>/
  title: string;
  year: string;
  cover?: string;        // a photo id, or the first photo
  summary?: string;
  photos: Photo[];
};
```

Files:

```
src/content/pages/home.json                 Doc
src/content/pages/projects/<slug>.json      Doc
src/content/pages/essays/<slug>.json        Doc + { kind: 'essay', buttons?: [...] }
src/content/data/filmography.json           { films: Film[] }
src/content/data/photography.json           { albums: Album[] }
src/content/drafts/**                       mirrors the above
```

`Doc.meta` gains an optional `section: SectionId` and an optional `buttons`
array, which essays already use for their end-of-post call to action.

## 5. Workstreams

```
                    ┌──────────────────┐
                    │ WS-A SCHEMA + NAV│   blocking, alone
                    │    CONTRACTS     │
                    └────────┬─────────┘
        ┌──────────┬─────────┼─────────┬──────────┐
        ▼          ▼         ▼         ▼          ▼
    ┌───────┐ ┌────────┐ ┌───────┐ ┌────────┐ ┌────────┐
    │ WS-B  │ │  WS-C  │ │ WS-D  │ │  WS-E  │ │  WS-F  │
    │ Site  │ │  API   │ │  Nav  │ │ Record │ │Migrate │
    │render │ │extend  │ │ shell │ │editors │ │ 4 srcs │
    └───┬───┘ └───┬────┘ └───┬───┘ └───┬────┘ └───┬────┘
        └─────┬───┴──────────┴─────────┘          │
              ▼                                   │
        ┌───────────┐                             │
        │   WS-G    │  integration  ◀─────────────┘
        └─────┬─────┘
              ▼
        ┌───────────┐
        │   WS-H    │  preview, all five sections
        └───────────┘
```

**WS-A Schema and navigation contracts** — blocking, alone.
Owns `src/cms/schema.ts`, `src/cms/sections.ts`, `src/cms/fixtures/**`,
`docs/cms-contracts.md`. Adds §4's shapes, a section registry describing each
section's kind, editor, paths and fields, and fixtures for a film list and a
photo album. Extends the API table for section-aware and record endpoints.

**WS-B Site rendering** — needs WS-A.
Owns `src/cms/render/**`, `src/cms/styles/**`, and the site pages for home,
essays, filmography and photography. Renders all five surfaces from the new
content, adds the album page at `/photography/<slug>/`, and keeps every page
visually identical to what is live today except the new album page.

**WS-C API extension** — needs WS-A.
Owns `src/cms/server/**`. Section-aware list/read/write/publish, record
collection endpoints, media upload to per-collection paths, and reordering
within a record collection.

**WS-D Navigation shell** — needs WS-A.
Owns `src/cms/app/shell/**`, `src/cms/app/state/**`. The section sidebar, the
entry list per section, create, duplicate, delete and reorder, and routing
between sections. Dispatches to the document editor or the record editor.

**WS-E Record editors** — needs WS-A.
Owns `src/cms/app/records/**`. A film editor (paste a YouTube URL, pull the id,
show the embed, poster upload) and an album editor (multi-upload, drag to
reorder, pick the cover, per-photo alt and caption).

**WS-F Migration** — needs WS-A.
Owns `scripts/migrate-*.ts`, `src/content/pages/**`, `src/content/data/**`.
Converts `home.yaml`, `writing/*.md`, `filmography.ts` and `photography.ts`.
Same acceptance bar as phase 1: diff the rendered output against the live
pages and assert that no prose, title, link or image is lost.

**WS-G Integration** — needs WS-C, WS-D, WS-E (and WS-B's renderer).
Owns `src/cms/app/index.tsx` and the route files. One application.

**WS-H Preview** — needs WS-B and WS-C.
Owns `src/cms/preview/**`. Preview any section, including the album page.

## 6. Acceptance

The CMS is done for this phase when, from `/cms` alone, one can: edit the
homepage intro; write an essay with a canvas in it; add a YouTube film with a
title and a note; create a photo album, upload six photos, reorder them and
choose a cover; save all of it as a draft; preview every one of those pages;
and publish. Without opening an editor, a terminal, or a `.ts` file.
