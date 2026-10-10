# CMS contracts

WS-0's output. The brief is `docs/cms-rebuild.md`; this is the part of it that
is now frozen, plus the decisions WS-0 had to make to freeze it.

`src/cms/schema.ts` is the machine-readable half of this document. Where the
two disagree, the code wins and this file is the bug.

Nothing here is negotiable inside phase 1. If a workstream needs a change,
write it in your report; do not edit `src/cms/schema.ts`.

**Phase 2** (`docs/cms-sections.md`) extended all of this to the whole site.
Sections 1 to 8 below are phase 1 and still hold, with `src/cms/sections.ts`
added as a second machine-readable half. Sections 9 to 13 are the extension:
the section registry, the record collections, the extended API table, and what
each of the four migrations has to preserve. Owned by WS-A.

---

## 1. Import paths

There are no TypeScript path aliases in this project (`tsconfig.json` extends
`astro/tsconfigs/strict` and adds none), so imports are relative.

```ts
// types and validator, from anywhere under src/cms/
import { validateDoc, REFERENCE_WIDTH, MOBILE_BREAKPOINT } from '../schema.ts';
import type { Doc, Band, ProseBand, CanvasBand, ProseBlock, CanvasItem } from '../schema.ts';

// from src/pages/api/cms/*
import { validateDoc } from '../../../cms/schema.ts';
```

Depth from the files each workstream owns:

| Importer | Specifier |
|---|---|
| `src/cms/render/index.ts` | `'../schema.ts'` |
| `src/cms/server/*.ts` | `'../schema.ts'` |
| `src/cms/assets/shapes.ts` | `'../schema.ts'` |
| `src/cms/app/shell/*.tsx` | `'../../schema.ts'` |
| `src/cms/app/canvas/*.tsx` | `'../../schema.ts'` |
| `src/cms/app/prose/*.tsx` | `'../../schema.ts'` |
| `src/cms/preview/*` | `'../schema.ts'` |
| `src/pages/api/cms/*.ts` | `'../../../cms/schema.ts'` |
| `scripts/migrate-mdoc.ts` | `'../src/cms/schema.ts'` |

`src/cms/sections.ts` sits beside `schema.ts`, so it is imported at the same
depth with the same rules: `'../sections.ts'` from `src/cms/*/`,
`'../../sections.ts'` from `src/cms/app/*/`, `'./schema.ts'` is how
`sections.ts` itself reaches the schema.

Write the `.ts` extension. The project sets `allowImportingTsExtensions`, so it
typechecks, and it is the only form that also runs under bare `node` (Node 25
strips types, but it does not resolve extensionless specifiers). That matters:
WS-1's screenshot script, WS-9's migration and WS-0's fixture check all run
outside Vite.

`verbatimModuleSyntax` is on. Type-only imports must say `import type`.

Fixtures are plain JSON, loaded with `fs`, not with an import attribute:

```ts
import { readFileSync } from 'node:fs';
import { validateDocJson } from '../schema.ts';

const result = validateDocJson(
  readFileSync(new URL('../fixtures/dense.json', import.meta.url), 'utf8'),
);
if (!result.ok) throw new Error(formatIssues(result.issues));
```

---

## 2. The document model

Types live in `src/cms/schema.ts` and follow `docs/cms-rebuild.md` 3.1 to 3.3.
Exported types, all inferred from their zod schema: `Doc`, `DocMeta`, `Band`,
`ProseBand`, `CanvasBand`, `ProseBlock`, `ProseBlockKind`, `CanvasItem`,
`CanvasItemKind`, `ShapeKind`, `Anchor`. Phase 2 added `SectionId`,
`DocButton`, `Film`, `Photo`, `Album`, `Filmography`, `Photography` — see §10.

`DocMeta` gained two optional keys in phase 2, `section` and `buttons`. Both
are optional, so a document written in phase 1 is still valid, and
`DocMetaSchema` is still a plain `ZodObject` so `DocMetaSchema.shape.slug`
keeps working for the three phase 1 files that use it.

Constants, so nobody hardcodes a number:

```ts
export const DOC_VERSION = 1;
export const REFERENCE_WIDTH = 1344;   // canvas geometry is authored against this
export const MOBILE_BREAKPOINT = 900;  // below this, canvas positioning is dropped
```

### 2.1 Validation

```ts
export type ValidationIssue = { path: string; message: string };

export type ValidateResult =
  | { ok: true; doc: Doc }
  | { ok: false; issues: ValidationIssue[] };

export function validateDoc(value: unknown): ValidateResult;
export function validateDocJson(text: string): ValidateResult;   // bad JSON is an issue, not a throw
export function formatIssues(issues: ValidationIssue[]): string;  // one line per issue
```

Neither validator throws. Switch on `ok`. `path` is dotted, for example
`bands.2.items.0.w`, and `(root)` for the document itself.

### 2.2 Rules the validator enforces

Worth knowing before you build a document by hand or by migration.

1. **Every object is strict.** An unknown key is an error, not something
   silently dropped. Keep editor state (selection, hover, drag deltas,
   `_dirty`) out of the document.
2. **`content` on a prose block is always an array**, possibly empty. An empty
   paragraph is `[]`, never a missing key.
3. **Every id in a document is unique, document-wide**, across bands, prose
   blocks and canvas items. Ids are `[A-Za-z0-9_-]{1,64}`, so they are safe to
   use as a DOM id suffix. Use `newId(prefix)`.
4. **`w` and `h` are greater than zero.** `x` and `y` may be negative, so an
   item can bleed off the left or top edge.
5. **`z` is an integer**, because it lands in CSS `z-index`.
6. **A shape item sets `shape`** and may not carry `src` or `alt`. `fill` is
   only valid on a rect or ellipse, `radius` only on a rect. Omitting `fill`
   means no fill; there is no `"none"` sentinel.
7. **An image, video or embed item sets `src`** and may not carry `shape`,
   `color`, `fill`, `strokeWidth` or `radius`.
8. **`src` and `cover`** are either site-absolute (`/media/<slug>/<file>`) or an
   absolute `http(s)` URL.
9. **`meta.slug`** is lowercase kebab-case. **`meta.date`** is `YYYY-MM-DD` and
   has to be a real calendar date; `2026-02-30` is rejected.
10. **The first band cannot be an overlay.** There is nothing for it to sit over.
11. **Colours are hex**: `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`.

A **dangling anchor is not an error**. Deleting a paragraph must not make a
document unsaveable. Use `resolveAnchor`, and skip the connector when it
returns `null`.

### 2.3 Prose content, exactly

`ProseBlock.content` is the `content` array of one top-level TipTap node whose
type comes from the block's `kind`:

```ts
export const PROSE_NODE_TYPE = {
  p: 'paragraph', h2: 'heading', h3: 'heading',
  quote: 'blockquote', ul: 'bulletList', ol: 'orderedList',
};
export const PROSE_HEADING_LEVEL = { h2: 2, h3: 3 };
```

So the round trip through an editor instance is:

```ts
// block -> editor
{ type: 'doc', content: [{ type: PROSE_NODE_TYPE[block.kind], attrs, content: block.content }] }
// editor -> block
block.content = editorDoc.content?.[0]?.content ?? [];
```

Heading level is **not** stored in `content` attrs. It is derived from `kind`,
so `h2` and its attrs can never disagree.

Shapes per kind:

```jsonc
// p | h2 | h3 : inline nodes
[{ "type": "text", "text": "plain" },
 { "type": "text", "marks": [{ "type": "bold" }], "text": "bold" }]

// quote : paragraph nodes
[{ "type": "paragraph", "content": [{ "type": "text", "text": "quoted" }] }]

// ul | ol : list items, each wrapping a paragraph
[{ "type": "listItem",
   "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "item" }] }] }]
```

Allowed marks, `PROSE_MARKS`:

```ts
['bold', 'italic', 'link', 'textStyle']
```

Two notes:

- **Text colour is the `textStyle` mark**, carrying a `color` attr:
  `{ "type": "textStyle", "attrs": { "color": "#ff5722" } }`. The brief (3.2)
  calls the mark "color"; TipTap's `@tiptap/extension-color` writes `textStyle`,
  and the contract follows TipTap so no workstream has to transform marks on the
  way in or out. WS-1 renders `textStyle` as `<span style="color:...">`.
- The **link** mark's attrs are TipTap's: `href`, `target`, `rel`. Read those
  three and ignore anything else TipTap adds.

Three facts about the installed TipTap 3.31.4, checked against the packages in
`node_modules`, because each one costs an hour to find:

- `@tiptap/starter-kit` **already includes Link** (and Underline, Strike, Code,
  CodeBlock, HorizontalRule, HardBreak). Adding `@tiptap/extension-link`
  alongside it duplicates the extension. Configure it through StarterKit's
  `link` option, or set `link: false` and add the standalone one.
- The marks StarterKit brings that this contract does not allow (`underline`,
  `strike`, `code`) have to be switched off, or a paste will smuggle them into
  stored content that `PROSE_MARKS` says cannot exist.
- The `textStyle` mark carries every global attribute registered on it. Register
  only `TextStyle` and `Color`, not the whole `TextStyleKit`, and the stored
  attrs stay `{ color }` instead of five keys that are mostly null. WS-1 reads
  `attrs.color` and ignores the rest either way.

### 2.4 Mobile fallback

`docs/cms-rebuild.md` 3.4, restated because it is a hard rule and WS-1 owns it.
Below `MOBILE_BREAKPOINT` (900px) the renderer drops canvas positioning
entirely: items stack in document order at full width, `overlay` is ignored,
rotation is kept, and connectors are not drawn.

### 2.5 Geometry helpers

```ts
export function refPxToPercent(px: number): number;  // (px / REFERENCE_WIDTH) * 100
```

Use it for `x` and `w`. `y` and `h` stay in px (3.3). One formula, so the editor
and the published page cannot drift.

### 2.6 Other shared helpers

```ts
export function isProseBand(band: Band): band is ProseBand;
export function isCanvasBand(band: Band): band is CanvasBand;
export function isShapeItem(item: CanvasItem): boolean;

export function resolveAnchor(doc: Doc, anchor: Anchor):
  { band: ProseBand; block: ProseBlock } | null;

export function newId(prefix?: string): string;   // 'b_3f9a1c20e4', valid against IdSchema
export function seedFromId(id: string): number;   // deterministic 32-bit, FNV-1a
```

Conventional `newId` prefixes: `b` band, `p` prose block, `i` canvas item.

---

## 3. API

Verbatim from `docs/cms-rebuild.md` 3.5. WS-2 owned it in phase 1. **§11 is the
phase 2 table, which supersedes this one**; these paths stay in the document
because WS-G's client is written against them today.

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

`Doc` in that table is `Doc` from `src/cms/schema.ts`. Run every incoming body
through `validateDoc` before writing it, and put `formatIssues(...)` in the
`error` string.

---

## 4. Renderer

Verbatim from `docs/cms-rebuild.md` 3.6. WS-1 owns it.

```ts
// src/cms/render/index.ts
export function renderDoc(doc: Doc): string;          // body HTML
export function docStyles(): string;                  // path to the stylesheet
```

No React, no Astro imports, no DOM. Pure string in, string out, so it can run
at build time, in SSR and in a test.

---

## 5. Asset generator, frozen

The one module two phase-1 workstreams share: WS-6 writes it, WS-1 and WS-4
import it. Frozen by WS-0 so it is not renegotiated later. The types live in
`src/cms/schema.ts`; the implementation is WS-6's.

### 5.1 Module

`src/cms/assets/shapes.ts`, with exactly these exports:

```ts
export function generateShape(spec: ShapeSpec): string;
export const SHAPE_KINDS: readonly ShapeKind[];
```

Nothing else in WS-6's tree is part of the contract. The picker component and
the catalogue page are WS-6's own business.

### 5.2 Input

```ts
export type ShapeKind = 'line' | 'rect' | 'ellipse' | 'squiggle' | 'arrow';

export type ShapeSpec = {
  shape: ShapeKind;
  width: number;        // reference px, the item's box
  height: number;
  color: string;        // stroke colour, hex
  strokeWidth: number;
  seed: number;         // stable wobble seed; use seedFromId(item.id)
  fill?: string;        // rect and ellipse only; omitted means no fill
  radius?: number;      // rect only, corner radius in reference px
};

export type ShapeGenerator = (spec: ShapeSpec) => string;
```

Every field that affects the drawing is explicit. There are no hidden defaults
inside the generator. For the fields `CanvasItem` leaves optional, the fallbacks
are in one place:

```ts
export const SHAPE_DEFAULTS = { color: '#111111', strokeWidth: 2 };  // colour is the site's --ink
```

and one conversion, which WS-1 and WS-4 both use rather than writing their own:

```ts
export function shapeSpecFromItem(item: CanvasItem): ShapeSpec | null;  // null for a non-shape item
```

**The seed comes from the item id**, through `seedFromId`. Never from
`Math.random()`, never from an array index. That is what makes a hand-drawn
squiggle look the same in the editor, in the preview and on the published page,
forever.

### 5.3 Output

One complete, self-contained `<svg>` element as a string. All of this is frozen:

- **Pure and deterministic.** The same `ShapeSpec` always returns the same
  string, byte for byte.
- **Exactly one root `<svg>`.** No XML declaration, no doctype, no surrounding
  whitespace.
- **Root attributes**: `xmlns`, `viewBox="0 0 {width} {height}"`, `width="100%"`,
  `height="100%"`, `preserveAspectRatio="none"`, `aria-hidden="true"`,
  `focusable="false"`. The item's box already has the authored aspect ratio, so
  the shape scales with its container and survives the mobile full-width stack.
- **No `id` attributes and no `<defs>`.** Many of these get inlined into one
  page and ids collide. Arrowheads are drawn as paths, not `<marker>`.
- **No `<style>` blocks, no CSS classes, no external references, no script.**
  Presentation goes in attributes, so the string is safe to inline in static
  HTML and to assign with `innerHTML` in the editor.
- Strokes use `stroke-linecap="round"`, and `fill="none"` unless `fill` is set.
- The generator never echoes raw input text into the output, so the result is
  safe to inline as-is.

Connectors are not in this module. WS-1 draws anchored connectors client side
from measured positions.

---

## 6. Fixtures

`src/cms/fixtures/*.json`. Owned by WS-0, read-only for everyone else. Every
image `src` points at a file that really exists under `public/`, so a rendered
fixture screenshots as a picture instead of a broken image.

| File | What it is for |
|---|---|
| `simple.json` | Prose only. All six block kinds, all four marks, a heading, a quote, a link, one coloured run. The baseline. |
| `canvas.json` | Prose plus one canvas band holding two images and a squiggle. The positioning baseline, no rotation. |
| `dense.json` | The hard case. An overlay band beside prose, five rotated media items, all five shape kinds, an anchored connector tying a canvas item to a specific prose block, and a canvas of four overlapping images. |
| `essay.json` | Phase 2. An essay `Doc`: `meta.section: 'essays'`, a `mailto:` button, the TL;DR as a quote block, a coloured list item, and a canvas band with an anchored squiggle — because decision 3.1 is that essays gain the canvas. WS-F's migration target. |
| `home.json` | Phase 2. The homepage as a singleton `Doc`: the hero as a full-width canvas item (`/home/hero.webp`, 1344 x 824), then the three intro paragraphs with the film titles in italics. The name is `meta.title`, not a prose block. |
| `filmography.json` | Phase 2. `{ films: Film[] }`: the four real films, three with an uploaded poster and one (`film_space_race_trailer`) with none, so `filmPosterSrc`'s YouTube fallback is exercised by the corpus and not only by a unit check. |
| `photography.json` | Phase 2. `{ albums: Album[] }`: `first-build` has six photos and a chosen cover that is deliberately the fourth photo, not the first; `developing` has one photo and no cover, so the fallback to `photos[0]` is exercised. One photo has no `alt`, one has neither `w` nor `h`. |

The record fixtures are not `Doc`s, so they go through `validateFilmography`
and `validatePhotography`, not `validateDoc`. Every `src` and `poster` in them
points at a file that really exists under `public/`, same rule as the
documents.

Useful ids in `dense.json`: the overlay band is `b_dense_overlay`, the connector
is `i_dense_connector`, and it anchors to block `p_dense_anchor` in band
`b_dense_prose_1`. The four overlapping images are in `b_dense_stack`.

Fixtures are the shared test corpus. WS-1 screenshots them at 1440, 1100 and
390. WS-3 runs its shell off them. WS-4 and WS-5 drive their harnesses from
them. WS-9's migration output should be comparable to them.

---

## 7. Verifying

```
npm run cms:verify
```

Runs `src/cms/fixtures/verify.ts` under bare `node`. 228 checks, in three parts.

**Documents.** All five document fixtures through `validateDocJson`: every
media `src` exists on disk, every anchor resolves, every shape converts to a
`ShapeSpec` with a stable seed, non-overlay bands reserve enough height for
their items, all geometry fits inside the reference width, and the fixtures
really do contain the hard cases they claim to.

**The section registry.** Every `SectionId` has exactly one entry, in sidebar
order; every `draftPath` really is `toDraftPath(contentPath)`; the content,
draft and media paths for each section come out as the literal strings
`docs/cms-sections.md` 4 promises; `fillSlug` refuses `../`, a slash, an empty
slug and a missing one, which is what makes it the path-traversal guard.

**The record collections.** Both files through their validator and again
through the registry's own `validateFile`; every poster and photo `src` on
disk; `youtubeIdFromInput` round-tripping every id from a watch URL, a
youtu.be link, an embed URL and a bare id; the poster and cover fallbacks
exercised from real data; reorder as a permutation that still validates.

It finishes with 13 phase 1 negative controls and 28 phase 2 ones, because a
validator that never rejects anything is not a validator.

Exit code 0 means every fixture validates and every guarantee in this document
holds.

To typecheck just these files, without waiting for anyone else's tree:

```
./node_modules/.bin/tsc --noEmit --strict --target esnext --module esnext \
  --moduleResolution bundler --allowImportingTsExtensions --resolveJsonModule \
  --verbatimModuleSyntax --isolatedModules --skipLibCheck --types node \
  src/cms/schema.ts src/cms/sections.ts src/cms/fixtures/verify.ts
```

---

## 8. Dependencies

WS-0 installed everything the project needs. No other workstream runs
`npm install`; if something is genuinely missing, report it.

| Package | Version | For |
|---|---|---|
| `zod` | 3.25.76 | schema and validation |
| `@tiptap/react` | 3.31.4 | WS-5 |
| `@tiptap/pm` | 3.31.4 | WS-5 |
| `@tiptap/starter-kit` | 3.31.4 | WS-5 |
| `@tiptap/extension-link` | 3.31.4 | WS-5 |
| `@tiptap/extension-text-style` | 3.31.4 | WS-5 |
| `@tiptap/extension-color` | 3.31.4 | WS-5 |
| `@types/node` | 26.6.4 | dev; node builtins in WS-1's scripts, WS-2's server, WS-9's migration |

`zod` is pinned to the 3.x line on purpose: `astro` depends on `zod@^3.25.76`,
and a top-level zod 4 would put two majors in one tree. Write zod 3 code.
Already present and unchanged: `astro`, `react`, `react-dom`, `@astrojs/react`,
`@astrojs/vercel`. Still present until WS-11 deletes them: `@keystatic/*`,
`@markdoc/markdoc`.

---
---

# Part two: the whole site

Phase 2, `docs/cms-sections.md`. Sections 1 to 8 above are unchanged. WS-A owns
everything below, in `src/cms/schema.ts`, `src/cms/sections.ts` and
`src/cms/fixtures/**`. If something here is wrong, write it in your report; do
not edit those files.

---

## 9. The section registry

`src/cms/sections.ts`. The CMS's map of the site. It exists so that **nothing
else writes a section name as a bare string literal** — WS-D renders
`SECTIONS`, WS-C looks a section up with `getSection` and asks it for paths. If
you find yourself writing `if (section === 'photography')` outside a narrow,
something is missing from the registry: say so rather than hardcoding it.

```ts
export const SECTIONS: readonly SectionDef[];              // sidebar order
export function getSection(id: string): SectionDef | null; // null = 404
export function requireSection(id: SectionId): SectionDef; // throws
export function isDocumentSection(s: SectionDef): s is DocumentSectionDef;
export function isRecordSection(s: SectionDef): s is RecordSectionDef;
export function documentSections(): DocumentSectionDef[];
export function recordSections(): RecordSectionDef[];
```

### 9.1 The five sections

| id | label | shape | storage | published file | live site |
|---|---|---|---|---|---|
| `home` | Home | singleton | document | `src/content/pages/home.json` | `/` |
| `projects` | Projects | collection | document | `src/content/pages/projects/<slug>.json` | `/projects/<slug>/` |
| `essays` | Essays | collection | document | `src/content/pages/essays/<slug>.json` | `/essays/<slug>/` |
| `filmography` | Filmography | collection | records | `src/content/data/filmography.json` | `/filmography/` (no entry page) |
| `photography` | Photography | collection | records | `src/content/data/photography.json` | `/photography/<slug>/` |

`storage` is which editor an entry opens in: `'document'` is the phase 1
editor, bands of prose and canvas; `'records'` is typed fields plus media.
`shape` is whether there is one entry or many. They are independent:
filmography is a collection of records, home is a singleton document.

`SectionId` and the two sub-unions live in the schema, not the registry, so a
type can name them without importing the registry:

```ts
export const SECTION_IDS = ['home', 'projects', 'essays', 'filmography', 'photography'];
export const DOCUMENT_SECTION_IDS = ['home', 'projects', 'essays'];
export const RECORD_SECTION_IDS = ['filmography', 'photography'];
export function isSectionId(v: string): v is SectionId;
export function isDocumentSectionId(v: string): v is DocumentSectionId;
export function isRecordSectionId(v: string): v is RecordSectionId;
```

### 9.2 Paths are patterns

A collection's `contentPath` contains the literal token `:slug`. **Fill it with
the helper, never with string concatenation**, because the fill is also the
path-traversal guard: it refuses anything that is not an id
(`[A-Za-z0-9_-]{1,64}`, so no slash, no dot, no `..`) by throwing.

```ts
export const SLUG_TOKEN = ':slug';
export function needsSlug(pattern: string): boolean;
export function fillSlug(pattern: string, slug?: string | null): string;  // throws on a bad slug

export function contentPathFor(s: SectionDef, slug?: string | null): string;
export function draftPathFor(s: SectionDef, slug?: string | null): string;
export function contentDirFor(s: SectionDef): string;   // what a list call reads
export function draftDirFor(s: SectionDef): string;
export function mediaDirFor(s: SectionDef, slug?: string | null): string;
export function mediaUrlFor(s: SectionDef, slug?: string | null): string;
export function mediaSrcFor(s: SectionDef, slug: string | null, file: string): string;
export function siteUrlFor(s: SectionDef, slug?: string | null): string | null;
export function cmsUrlFor(s: SectionDef, slug?: string | null): string;
export function slugFromFilename(file: string): string | null;   // 'a.json' -> 'a'
export function toDraftPath(contentPath: string): string;
```

It throws rather than returning null because an unfillable pattern is a caller
bug, not user input. Validate the slug at the edge, with `IdSchema` or
`DocMetaSchema.shape.slug`, where a bad request becomes a 400.

**A draft path is always the content path with `src/content/` swapped for
`src/content/drafts/`.** One rule, no section exceptions, so the draft tree is
a literal mirror of the published tree:

```
src/content/pages/home.json            ->  src/content/drafts/pages/home.json
src/content/pages/essays/a.json        ->  src/content/drafts/pages/essays/a.json
src/content/data/filmography.json      ->  src/content/drafts/data/filmography.json
```

Roots, so nobody writes one twice:

```ts
export const CONTENT_ROOT = 'src/content';
export const DRAFT_ROOT = 'src/content/drafts';
export const MEDIA_ROOT = 'public/media';
export const MEDIA_URL_ROOT = '/media';
export const CONTENT_FILE_EXT = '.json';
```

### 9.3 Media

One pipeline (`docs/cms-sections.md` 3.5). Every upload lands in
`public/media/<section>/<slug>/` and is served from `/media/<section>/<slug>/`.
The singleton has no slug, so home's is `public/media/home`. Films use their
record id as the slug; albums use their album slug.

```
public/media/home/                      home
public/media/projects/<slug>/           a project page
public/media/essays/<slug>/             an essay
public/media/filmography/<film id>/     a film's poster
public/media/photography/<album slug>/  an album's photos
```

The old conventions — `public/filmography/<id>.jpg`,
`public/projects/<slug>/...` — are not written to any more. Files already there
keep working; they are ordinary site-absolute `src` values.

### 9.4 Record sections carry a `RecordsDef`

`section.records` is `null` on a document section and a `RecordsDef` on a
record section. Every function on it is typed against the `RecordFile` and
`RecordEntry` unions, so it is callable without narrowing first:

```ts
type RecordsDef = {
  key: 'films' | 'albums';        // the one key in the JSON file; also the discriminant
  noun: string;                   // 'film', 'album'
  fields: readonly RecordField[]; // every editable field, in editor order
  titleField: string;
  slugField: string | null;       // null means the record id is the URL key
  idPrefix: string;               // newId prefix

  empty: () => RecordFile;
  create: () => RecordEntry;
  entries: (file: RecordFile) => RecordEntry[];
  withEntries: (file: RecordFile, entries: RecordEntry[]) => RecordFile;  // does NOT validate
  summarise: (file: RecordFile) => RecordSummary[];
  validateFile: (value: unknown) => ValidateResultOf<RecordFile>;
  validateEntry: (value: unknown) => ValidateResultOf<RecordEntry>;
};

type RecordSummary = {
  id: string;        // the record id
  key: string;       // what identifies it in a URL: a film's id, an album's slug
  title: string;
  subtitle: string;  // 'SHORT FILM · 2019', '2026 · 6 photos'
  thumb: string | null;  // through the section's own fallback
};
```

**Reordering is read, permute, write back.** `entries` out, permuted array
back in through `withEntries`, then `validateFile`, then save the whole file.
There is nothing else to it, and no separate reorder format.

To get at a concrete shape, narrow with the schema's guards or switch on `key`:

```ts
export function isFilmography(f: RecordFile): f is Filmography;
export function isPhotography(f: RecordFile): f is Photography;
export function isFilm(e: RecordEntry): e is Film;
export function isAlbum(e: RecordEntry): e is Album;
```

### 9.5 Fields

`RecordField` is `{ name, label, type, required, help?, suggestions? }`, where
`name` is the key on the record, exactly as the schema spells it. `type` is a
closed union so WS-E can switch exhaustively and the compiler says something
when a type is added:

| type | input |
|---|---|
| `text` | one line |
| `textarea` | several lines, no formatting |
| `slug` | lowercase kebab-case; drives a URL |
| `year` | `"2019"`, or a range like `"2018-2019"` |
| `youtube` | paste a URL, store the 11-character id (`youtubeIdFromInput`) |
| `image` | one uploaded image, optional |
| `photos` | an ordered, reorderable list of uploaded photos |
| `cover` | pick one of this record's own photos, by id |

`suggestions` is a datalist, not a constraint: the schema takes any string for
`kind`, so a new kind of film does not need a schema change.

Filmography: `youtubeId`, `title`, `kind`, `year`, `note`, `poster`.
Photography: `title`, `slug`, `year`, `summary`, `photos`, `cover`.

---

## 10. The record shapes

`docs/cms-sections.md` 4, in `src/cms/schema.ts`. Same two rules as the
document model: every object is `.strict()`, and every exported type is
`z.infer` of its schema.

### 10.1 Film

```ts
type Film = {
  id: string;         // stable record id, NOT the video id
  youtubeId: string;  // exactly 11 characters of [A-Za-z0-9_-]
  title: string;      // not empty
  note?: string;
  kind: string;       // not empty. 'SHORT FILM', 'TRAILER'
  year: string;       // '2019' or '2018-2019'
  poster?: string;    // omitted means YouTube's own thumbnail
};

type Filmography = { films: Film[] };   // film ids unique across the collection
```

`id` and `youtubeId` are separate on purpose. The live `src/data/filmography.ts`
uses the video id for both; splitting them means re-uploading a film to a new
YouTube URL does not orphan its poster or its place in the order.

```ts
export function filmPosterSrc(film: Film): string;  // film.poster ?? YouTube's thumbnail
export function youtubeIdFromInput(input: string): string | null;
export function youtubeEmbedUrl(id: string, opts?: { autoplay?: boolean }): string;
export function youtubeThumbUrl(id: string, quality?: YouTubeThumbQuality): string;
export const FILM_KIND_SUGGESTIONS = ['SHORT FILM', 'TRAILER'];
```

`youtubeIdFromInput` takes a bare id, a watch URL, a `youtu.be` link, or an
`/embed/`, `/shorts/`, `/live/` or `/v/` path, with or without `www.` or `m.`,
on `youtube.com` or `youtube-nocookie.com`. It returns null when there is no id
in there, which is the signal to say "that is not a YouTube link" rather than
to save something broken. It lives in the schema so WS-E and WS-F cannot
disagree about what counts as an id.

`youtubeEmbedUrl` builds exactly what the live filmography page builds today.

### 10.2 Photo and Album

```ts
type Photo = {
  id: string;
  src: string;        // site-absolute or http(s), same rule as a canvas item
  alt?: string;
  caption?: string;
  w?: number;         // intrinsic, whole pixels, from the upload endpoint
  h?: number;
};

type Album = {
  id: string;
  slug: string;       // lowercase kebab-case; the page is /photography/<slug>/
  title: string;      // not empty
  year: string;
  cover?: string;     // the id of one of THIS album's photos
  summary?: string;
  photos: Photo[];    // may be empty: create the album, then upload
};

type Photography = { albums: Album[] };  // album ids AND slugs unique
```

```ts
export function albumCoverPhoto(album: Album): Photo | null;  // chosen, else first, else null
export function albumCoverSrc(album: Album): string | null;
```

Three cross-field rules worth knowing before you build one by hand:

1. **`w` and `h` travel together.** A width with no height is not an aspect
   ratio, and a grid that reserves space from one of them will jump. Set both
   or neither.
2. **Photo ids are unique within their album.**
3. **`cover` must be the id of a photo in the same album.** Unlike a dangling
   anchor, this one *is* an error: a cover pointing at a deleted photo is a
   broken tile, not a recoverable fallback. Deleting the cover photo has to
   clear `cover` in the same edit.

### 10.3 `Doc.meta` gained two keys

```ts
section?: SectionId;      // 'home' | 'projects' | 'essays' only
buttons?: DocButton[];    // { label: string; href: string }
```

Both optional, so every phase 1 document is still valid.

`DocSchema` rejects a `section` that holds records: a `Doc` cannot claim to be
in filmography or photography. That check lives on `DocSchema`, not on
`DocMetaSchema`, deliberately — `DocMetaSchema` has to stay a plain `ZodObject`
because three phase 1 files reach into `DocMetaSchema.shape.slug`.

`buttons` is the shape the live essays already use in their frontmatter, so
migrating them is a copy and not a translation. `href` is wider than `src`: a
site-absolute path, an `http(s)` URL, a `mailto:` address or a `#fragment`.
`javascript:` is rejected.

### 10.4 Validators and factories

```ts
export type ValidateResultOf<T> =
  | { ok: true; data: T }
  | { ok: false; issues: ValidationIssue[] };

export function validateFilmography(value: unknown): ValidateResultOf<Filmography>;
export function validateFilmographyJson(text: string): ValidateResultOf<Filmography>;
export function validatePhotography(value: unknown): ValidateResultOf<Photography>;
export function validatePhotographyJson(text: string): ValidateResultOf<Photography>;
export function validateFilm(value: unknown): ValidateResultOf<Film>;
export function validateAlbum(value: unknown): ValidateResultOf<Album>;
```

Same discriminated-result contract as `validateDoc`, and neither validator
throws. **The payload key is `data`, not `doc`**, because these are not
documents; `ValidateResult` keeps its `doc` key so phase 1 code is untouched.
`formatIssues` works on both.

```ts
export function newFilm(overrides?: Partial<Film>): Film;
export function newAlbum(overrides?: Partial<Album>): Album;
export function newPhoto(src: string, dims?: { w: number; h: number }, o?: Partial<Photo>): Photo;
export function slugify(text: string): string;   // '' when nothing survives
```

`newFilm()` is deliberately **invalid** until it has a video: `youtubeId` is
empty, which is the one thing the editor must ask for before a save can
succeed. `newAlbum()` validates as it stands, so an album can be created and
saved before anything is uploaded; its slug comes from the title, falling back
to the record id when the title slugifies to nothing (a title of only Hangul,
or only punctuation). Conventional `newId` prefixes extend with `film`,
`album` and `ph`.

---

## 11. API, phase 2

Derived from `docs/cms-sections.md` 5, WS-C. WS-C owns it. All under
`/api/cms/`, JSON in, JSON out, every response either `{ ok: true, ... }` or
`{ error: string }` with a non-200 status — unchanged from §3.

`:section` is a `SectionId`; anything else is a 404, which is what
`getSection(id) === null` is for. `:slug` is omitted for a singleton section
(`home`), and for the two record sections, whose whole collection is one file.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/cms/sections` | – | `{ sections: SectionSummary[] }` |
| GET | `/api/cms/entries/:section` | – | `{ entries: EntrySummary[] }` |
| GET | `/api/cms/entry/:section[/:slug]` | – | `{ published: Doc\|null, draft: Doc\|null }` |
| PUT | `/api/cms/draft/:section[/:slug]` | `Doc` | `{ ok, commit }` |
| DELETE | `/api/cms/draft/:section[/:slug]` | – | `{ ok }` |
| POST | `/api/cms/publish/:section[/:slug]` | – | `{ ok, commit }` |
| GET | `/api/cms/records/:section` | – | `{ published: RecordFile\|null, draft: RecordFile\|null }` |
| PUT | `/api/cms/records/:section` | `RecordFile` | `{ ok, commit }` |
| POST | `/api/cms/media/:section[/:slug]` | multipart `file` | `{ ok, src, w, h }` |
| GET | `/api/cms/auth/status` | – | `{ signedIn: boolean, login?: string }` |

```ts
type SectionSummary = {
  id: SectionId; label: string; shape: SectionShape; storage: SectionStorage;
  count: number;        // entries, 1 for a singleton
  hasDraft: boolean;    // any draft anywhere in the section
};

type EntrySummary = {
  key: string;          // the slug, or a film's record id
  title: string;
  subtitle?: string;    // records only; RecordSummary.subtitle
  thumb?: string | null;
  hasDraft: boolean;
  hasPublished: boolean;
  invalid?: boolean;    // the file on disk does not validate
};
```

Four notes:

- **Records have no per-entry endpoints.** One file is one commit, so the whole
  collection is read and written at once. Adding, deleting, editing and
  reordering a film are all `PUT /api/cms/records/filmography` with a different
  array. That is why there is no `POST /api/cms/reorder`: see §9.4.
- **Draft and publish semantics are unchanged** (`docs/cms-rebuild.md` 2.3).
  The editor always writes the draft; publish copies the draft over the
  published file and deletes the draft, in one commit. For records, "the draft"
  is `src/content/drafts/data/<section>.json`.
- **`POST /api/cms/media` still has to return the intrinsic width and height,**
  and now writes to `mediaDirFor(section, slug)`. For an album, the response's
  `src`, `w` and `h` are exactly what `newPhoto(src, { w, h })` wants.
- **Validate before writing,** through the section: `validateDoc` for a
  document section, `section.records.validateFile` for a record section, with
  `formatIssues(...)` in the `error` string.

The phase 1 paths in §3 (`/api/cms/pages`, `/api/cms/page/:slug`,
`/api/cms/draft/:slug`, `/api/cms/publish/:slug`, `/api/cms/media/:slug`) are
WS-C's to keep as aliases for `section = projects` or to retire with WS-G. The
registry does not require either. Say which in your report.

---

## 12. What the four migrations have to preserve

WS-F owns the scripts. This is what WS-A found in the live sources, because the
brief's §4 was written from them and two details are not in it.

**`src/content/home.yaml` -> `src/content/pages/home.json`.** `name` becomes
`meta.title`; it is *not* a prose block, or it renders twice. `intro` is a
textarea where blank lines separate paragraphs and `*asterisks*` mark italics
(`src/pages/index.astro` does the conversion today) — each paragraph becomes
one `p` block, each asterisk pair becomes an `italic` mark. The hero
illustration is not in the YAML at all: it is hardcoded as `/home/hero.webp` in
the page, 2688 x 1648, and becomes a full-width canvas item. `home.json` in the
fixtures is the target.

**`src/content/writing/*.md` -> `src/content/pages/essays/<slug>.json`.**
Frontmatter is `title`, `date`, `draft`, `summary?`, `buttons[]`;
`title`, `date`, `summary` and `buttons` map straight onto `meta`, and
`section` is `'essays'`. Two traps. **`draft: boolean` has nowhere to go** —
the `Doc` model has no draft flag, because a draft is a file in
`src/content/drafts/`; an unpublished essay migrates to the draft tree, not to
the published tree with a flag. And **two of the three essays open with an
`# H1`** while the live page already renders `post.data.title` as the `h1`
itself. `chasing-the-workaround.md` repeats the title exactly;
`who-i-m-looking-for.md` extends it ("Who I'm Looking For: The Temporarily
Stuck") and that subtitle is worth keeping somewhere. There is no `h1` prose
kind, so drop the duplicate line rather than demoting it to `h2`, and decide
per file whether anything in it is being lost. `essay.json` in the fixtures
is the target.

**`src/data/filmography.ts` -> `src/content/data/filmography.json`.** Each
entry's `id` is the *video* id: it becomes `youtubeId`, and the record gets a
new stable `id`. The poster convention `public/filmography/<video id>.jpg`
becomes an explicit `poster` value. Those four files exist, so the cheapest
correct migration points `poster` at `/filmography/<video id>.jpg` and leaves
them where they are; moving them under `/media/filmography/<record id>/` is
tidier and is a second commit, not a blocker. `filmography.json` in the
fixtures is the target, with real ids and real posters.

**`src/data/photography.ts` -> `src/content/data/photography.json`.** It is
empty (`albums: []`) and always has been. The migration is `{ "albums": [] }`.
The empty-state illustration at `/photography/placeholder.webp` is in
`src/pages/photography/index.astro`, not in the data, and stays there — WS-B
keeps showing it while `albums` is empty, which is what the live page does.

---

## 13. Decisions WS-A had to make

`docs/cms-sections.md` left these open. They are frozen now; if one is wrong,
write it in your report.

1. **Draft paths mirror the whole content tree.** The brief says
   "`src/content/drafts/**` mirrors the above" without saying how. One
   mechanical rule — swap `src/content/` for `src/content/drafts/` — beats five
   per-section rules, and it keeps `pages/home.json` from colliding with a
   project called `home`. Phase 1 wrote `src/content/drafts/<slug>.json` flat;
   that moves.
2. **Phase 1's published path moves too.** Phase 1 wrote
   `src/content/pages/<slug>.json`; §4 says
   `src/content/pages/projects/<slug>.json`. There is one file in the working
   tree today, `src/content/pages/track-daily-habit-tracker.json`, and it
   belongs one directory deeper. It still validates as it stands.
3. **Media uses one convention for every section,**
   `public/media/<section>/<slug>/`, following decision 3.5, including
   filmography. §4's comment on `Film.poster` sketches a flat
   `/media/filmography/<id>.jpg`; the per-record directory is what the rest of
   the brief says and what the endpoint already does.
4. **`year` is constrained,** to `"2019"` or `"2018-2019"`, rather than the
   brief's bare `string`. A year that gets concatenated into
   `"SHORT FILM · 2019"` should not be able to hold `""`.
5. **`youtubeId` is constrained** to 11 characters, which catches the obvious
   mistake of pasting a whole URL into the field.
6. **`kind` is not an enum.** `FILM_KIND_SUGGESTIONS` is a datalist, so a music
   video does not need a schema change.
7. **A record collection file has no `version` key.** §4 gives the literal
   shapes `{ films: Film[] }` and `{ albums: Album[] }`, and `.strict()` means
   adding one would make the brief's own shape invalid. The documents keep
   `version: 1`.
8. **`ValidateResultOf<T>` uses `data`, not `doc`.** Phase 1's `ValidateResult`
   is untouched, so its `doc` key keeps working.
9. **`fillSlug` throws.** It is the only place a slug reaches a file path, so
   it is the traversal guard, and a pattern that cannot be filled is a caller
   bug rather than user input.
10. **There is no reorder endpoint.** Reordering a record collection is a `PUT`
    of the whole file with the array permuted (§9.4, §11).
