# Building a personal CMS for jinhyuk.org

A clean-slate build. Not an extension of Keystatic, and not an extension of the
`src/studio/` prototype. Both get deleted at cutover.

This document is the brief every agent reads first. It fixes the architecture,
the contracts between workstreams, and which files each workstream owns, so
that work can run in parallel without agents colliding or guessing at each
other's types.

---

## 1. What is being built

A single-user CMS for one personal site. Desktop only for the editor UI.

It must let one person:

1. Write body text, with headings, quotes, bold, italic, links and text colour.
2. Drop in media, images and video, **several in one section**.
3. Drag that media around on a canvas: move, resize, rotate, stack.
4. Add components from an asset library: squiggly lines, shapes, connectors.
5. Save a working draft that is not on the live site.
6. Preview the draft exactly as it will look published.
7. Publish when ready.

Not in scope for v1: multi-user, comments, scheduling, an editor that works on
a phone, and automatic responsive layout tuning. Mobile output has a defined
fallback (§3.4) but no per-breakpoint controls; those come later.

---

## 2. Architecture decisions

These are settled. An agent that wants to change one must raise it, not
unilaterally diverge.

**2.1 Content is JSON, one file per page.**
`src/content/pages/<slug>.json`. Markdoc is dropped entirely. Canvas
coordinates and nested media arrays are a poor fit for Markdoc tag attributes,
and the current line-splicing writer only exists because of that mismatch.
With JSON, saving is a plain serialise.

**2.2 A page is a vertical stack of bands.**
Each band is either prose or a canvas. Prose stays in normal document flow,
which is what keeps the page readable on a phone. A canvas band is a free area
where anything can sit at any position, size and angle. A canvas band may set
`overlay: true`, meaning it takes no vertical space and instead sits over the
band before it, which is how media ends up beside a paragraph.

**2.3 Drafts are separate files.**
`src/content/drafts/<slug>.json` is the working copy. The editor always writes
the draft. Publish copies draft over published and deletes the draft. The site
builds from `pages/` only, so a draft can never appear on the live site.

**2.4 One renderer, used by both the site and the preview.**
`renderDoc()` is the only thing that turns a document into HTML. The site build
and the preview both call it. They cannot drift, because there is nothing to
drift from.

**2.5 Hosting and auth.**
The editor stays a server-rendered app on Vercel, separate from the static
site on GitHub Pages. It owns its GitHub OAuth against the existing GitHub App
(`jinhyuk.org Keystatic`, client ID `Iv23liDOxIhxb7inF4fu`, Contents:
read+write). Token in an httpOnly cookie. It commits through the GitHub API.

**2.6 Stack.**
Astro for routing and SSR, React for the editor app, TipTap (ProseMirror) for
prose blocks only. React is already a dependency. TipTap is worth its weight:
hand-rolled contenteditable is where this kind of project dies.

**2.7 Everything new lives under `src/cms/`.**
A clean tree means agents are not editing the same files as each other, or the
same files as the existing site.

---

## 3. The contract

WS-0 produces the real types. This section is the shape they must take, so the
other workstreams can be written against it before WS-0 lands.

### 3.1 Document

```ts
type Doc = {
  version: 1;
  meta: {
    title: string;
    slug: string;
    date: string;        // YYYY-MM-DD
    summary?: string;
    url?: string;        // the "Visit" link
    cover?: string;      // list thumbnail
  };
  bands: Band[];
};

type Band = ProseBand | CanvasBand;

type ProseBand = {
  id: string;            // stable, generated once, never reused
  type: 'prose';
  blocks: ProseBlock[];
};

type CanvasBand = {
  id: string;
  type: 'canvas';
  height: number;        // reserved vertical space, in reference px
  overlay?: boolean;     // sit over the previous band instead of below it
  items: CanvasItem[];
};
```

### 3.2 Prose

```ts
type ProseBlock = {
  id: string;
  kind: 'p' | 'h2' | 'h3' | 'quote' | 'ul' | 'ol';
  // TipTap JSON for the block's inline content. Marks allowed:
  // bold, italic, link, color.
  content: unknown;
};
```

### 3.3 Canvas

All geometry is in **reference pixels against a 1344px content width**. The
renderer converts x and w to percentages so a layout scales with the page
instead of being pinned to the screen it was made on.

```ts
type CanvasItem = {
  id: string;
  kind: 'image' | 'video' | 'embed' | 'shape';
  x: number; y: number; w: number; h: number;
  rotate?: number;       // degrees
  z?: number;
  // media
  src?: string;          // /media/<slug>/<file>
  alt?: string;
  caption?: string;
  // shape
  shape?: 'line' | 'rect' | 'ellipse' | 'squiggle' | 'arrow';
  color?: string;        // hex
  fill?: string;
  strokeWidth?: number;
  radius?: number;
  // optional tie to a paragraph, drawn as a hand-drawn connector
  anchor?: { bandId: string; blockId: string };
};
```

### 3.4 Mobile fallback

Below 900px the renderer drops canvas positioning entirely: items stack in
document order at full width, `overlay` is ignored, rotation is kept, and
connectors are not drawn. This is a hard rule, not a preference, and WS-1 owns
it.

### 3.5 API

All under `/api/cms/`. JSON in, JSON out. Every response is either
`{ ok: true, ... }` or `{ error: string }` with a non-200 status.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/cms/pages` | – | `{ pages: {slug, title, hasDraft}[] }` |
| GET | `/api/cms/page/:slug` | – | `{ published: Doc\|null, draft: Doc\|null }` |
| PUT | `/api/cms/draft/:slug` | `Doc` | `{ ok, commit }` |
| POST | `/api/cms/publish/:slug` | – | `{ ok, commit }` |
| DELETE | `/api/cms/draft/:slug` | – | `{ ok }` |
| POST | `/api/cms/media/:slug` | multipart `file` | `{ ok, src, w, h }` |
| GET | `/api/cms/auth/status` | – | `{ signedIn: boolean, login?: string }` |

`POST /api/cms/media` must return the intrinsic width and height. The editor
needs them to place an image at a sane size without waiting for a load.

### 3.6 Renderer

```ts
// src/cms/render/index.ts
export function renderDoc(doc: Doc): string;          // body HTML
export function docStyles(): string;                  // path to the stylesheet
```

No React, no Astro imports, no DOM. Pure string in, string out, so it can run
at build time, in SSR and in a test.

---

## 4. Workstreams and dependencies

```
                        ┌───────────────┐
                        │ WS-0 CONTRACTS│   (blocking, alone)
                        └───────┬───────┘
         ┌──────────┬───────────┼───────────┬──────────┐
         ▼          ▼           ▼           ▼          ▼
     ┌───────┐  ┌───────┐  ┌────────┐  ┌────────┐  ┌────────┐
     │ WS-1  │  │ WS-2  │  │  WS-3  │  │  WS-4  │  │  WS-5  │   + WS-6
     │Render │  │ API   │  │ Shell  │  │ Canvas │  │ Prose  │
     └───┬───┘  └───┬───┘  └────┬───┘  └───┬────┘  └───┬────┘
         │          │           └─────┬────┴───────────┘
         ├──────────┤                 ▼
         ▼          ▼            ┌─────────┐
     ┌────────────────┐          │  WS-8   │  Editor integration
     │  WS-7 Preview  │          └────┬────┘
     └───────┬────────┘               │
             │     ┌──────────────┐   │
             ├────▶│ WS-9 Migrate │◀──┤
             │     └──────┬───────┘   │
             ▼            ▼           ▼
         ┌──────────────────────────────┐
         │ WS-10 Mobile · WS-11 Cutover │
         └──────────────────────────────┘
```

### Phase 0 — one agent, nothing else runs

**WS-0 Contracts.** Writes the types, validators and fixtures everything else
is built against.

- Owns: `src/cms/schema.ts`, `src/cms/fixtures/*.json`, `docs/cms-contracts.md`
- Delivers: zod schemas and inferred TS types for §3.1–3.3; three fixture
  documents (text only; text plus a canvas; a dense page with overlay, rotated
  media, shapes and an anchored connector); a `validateDoc()` helper.
- Done when: fixtures validate, and `docs/cms-contracts.md` states the API
  table and renderer signature verbatim from §3.5 and §3.6.

### Phase 1 — six agents in parallel, all depend only on WS-0

None of these may import from each other. They share types, nothing else.

**WS-1 Renderer.**
- Owns: `src/cms/render/**`, `src/cms/styles/doc.css`
- Delivers: `renderDoc()`, the stylesheet, canvas positioning, overlay bands,
  the §3.4 mobile fallback, and the client script that draws anchored
  connectors from real measured positions.
- Verify: a script that renders each fixture to a file and screenshots it at
  1440, 1100 and 390 wide. Those screenshots are the deliverable's evidence.
- Must not: import React or Astro.

**WS-2 Storage and API.**
- Owns: `src/cms/server/**`, `src/pages/api/cms/**`
- Delivers: GitHub OAuth, cookie session, every endpoint in §3.5, media upload
  with intrinsic dimensions, draft/publish semantics per §2.3, and blob-sha
  conflict detection on write.
- Verify: an integration test that runs against a throwaway branch and asserts
  a full cycle of write draft, read back, publish, confirm published changed
  and draft is gone. **Never test against `main`.**
- Must not: touch anything under `src/cms/app/` or `src/cms/render/`.

**WS-3 Editor shell.**
- Owns: `src/cms/app/shell/**`, `src/cms/app/state/**`
- Delivers: the three-pane frame, the document store, undo and redo, dirty
  tracking, band outline with reorder and insert and delete, and save, publish
  and preview buttons wired to a `CmsApi` **interface** it defines and stubs.
- Verify: works entirely from fixtures with the stub API, no network.
- Must not: implement canvas or prose editing. It renders slots for them.

**WS-4 Canvas interaction.**
- Owns: `src/cms/app/canvas/**`
- Delivers: `<CanvasEditor items onChange />`. Move, resize from corners,
  rotate, z-order, multi-select, arrow-key nudge, snap to edges and centres of
  other items, shift to constrain ratio and to 15° steps, and correct maths
  when the stage is scaled.
- Verify: a standalone harness page driving it from a fixture, no shell.
- Must not: fetch anything, or know what a band is beyond its items array.

**WS-5 Prose editing.**
- Owns: `src/cms/app/prose/**`
- Delivers: `<ProseEditor block onChange />` on TipTap. Paragraph, h2, h3,
  quote, lists, bold, italic, link and text colour with a real colour picker
  plus the site palette as swatches. Emits the §3.2 shape.
- Verify: a standalone harness, round-tripping fixture content unchanged.
- Must not: style the page. It emits content, WS-1 decides how it looks.

**WS-6 Asset library.**
- Owns: `src/cms/assets/**`
- Delivers: parameterised SVG generators for squiggle, arrow, line,
  rectangle, ellipse, each taking width, height, colour, stroke width and a
  seed so a hand-drawn wobble is stable across renders; plus a picker
  component; plus a catalogue page showing every asset at several sizes.
- Verify: the catalogue page.
- Note: WS-1 and WS-4 both import these generators. It is the one shared
  module in phase 1, so its signature is frozen by WS-0.

### Phase 2 — starts as its inputs land

**WS-7 Preview.** Needs WS-1 and WS-2.
- Owns: `src/cms/preview/**`
- Delivers: a route rendering a draft or published doc with the real
  stylesheet, a draft/published toggle, and width presets for 1440, 1100, 390.

**WS-8 Editor integration.** Needs WS-3, WS-4, WS-5, WS-6, and WS-2's real API.
- Owns: `src/cms/app/index.tsx` and the wiring only
- Delivers: the real app. Swaps WS-3's stub for WS-2's client, mounts WS-4 and
  WS-5 into the shell's slots, hooks up media upload and the asset picker.
- This agent fixes integration bugs in its own file, and files issues against
  the owning workstream for anything deeper. It does not edit their files.

**WS-9 Migration.** Needs WS-0 and WS-1.
- Owns: `scripts/migrate-mdoc.ts`
- Delivers: a converter from the existing `.mdoc` files to `Doc` JSON.
- Done when: the migrated page renders byte-identically to the current live
  page, modulo known intentional differences, with a diff report as evidence.
  This is the acceptance test; a migration that loses a paragraph is a failure
  even if it looks fine.

### Phase 3

**WS-10 Mobile rules.** Needs WS-1 and WS-8. Per-band mobile overrides: hide
on mobile, reorder, override width.

**WS-11 Cutover.** Needs everything. Delete `keystatic.config.tsx`,
`src/studio/`, `src/preview/`, Markdoc rendering, and the `@keystatic/*` and
`@markdoc/markdoc` dependencies. Repoint the site's project pages at
`renderDoc()`. Keep the old `.mdoc` files until the migrated output has been
live and reviewed.

---

## 5. Rules for every agent

1. **Only touch files you own.** The ownership list is the contract. If you
   need something changed elsewhere, write it in your report; do not reach in.
2. **The schema is WS-0's.** If it is wrong, say so. Do not edit it.
3. **Ship a way to verify your work alone.** A harness page, a test, or a
   screenshot script. Work that can only be judged after integration is work
   that is not done.
4. **Never write to `main`.** Branch per workstream: `cms/ws-N-name`.
5. **Do not break the live site.** `npm run build` must pass at every commit.
   The site keeps building from `.mdoc` until WS-11.
6. **Reference width is 1344px. Breakpoint is 900px.** Do not invent others.
7. Prefer boring. This is a tool for one person.

---

## 6. Decide before dispatch

Five things worth settling, because changing them later is expensive:

1. **JSON over Markdoc** (§2.1). Readable in git, but no longer hand-editable
   as prose. Recommended.
2. **Drafts as separate files** (§2.3), rather than branches. Simpler, and the
   branch mechanism still exists underneath if wanted.
3. **TipTap** (§2.6) as a dependency, versus hand-rolled contenteditable.
   Recommended, strongly.
4. **Bands, not a free canvas for everything** (§2.2). Text stays in flow so
   the page survives a phone. The alternative is a true free canvas and a
   separately authored mobile layout.
5. **Where the editor lives.** Same Vercel project, or its own. Same project
   is less to run; its own is cleaner to reason about.
