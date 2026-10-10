# The cutover: the site now builds from the CMS

WS-11. Every page under `src/pages/` now reads `src/content/pages/**` and
`src/content/data/**` and renders through `src/cms/render`. Nothing under
`src/cms/` was touched. Nothing was deleted. Nothing was committed.

**Result: five of the nine existing pages are pixel-identical to the live site
at both 1440 and 390. Four are not, and three of the reasons are faults in
`src/cms/styles/doc.css` that I am not allowed to fix and have not worked
around.** Section 5 is the list, in severity order. Section 5.1 is the one to
read first: below 900px every document page sets its body text at 17.5/35
where the live site sets 14/24, which makes the three essays roughly half as
tall again on a phone. The cutover should not be pushed until that is settled.

Both builds pass. No CMS or API route reaches the static output.

---

## Contents

1. What changed, file by file
2. How this was verified
3. Results, page by page
4. Differences that change nothing a reader sees
5. Differences that change how a page looks
6. The album page, which is new
7. Builds, and what is in `dist/`
8. What I could not finish

---

## 1. What changed, file by file

### New

**`src/lib/site-content.ts`** — the site's content loader. Reads the CMS's JSON
and nothing else, validates every file through `src/cms/schema.ts`, and
installs WS-6's shape generator (`src/cms/render/with-shape-assets.ts`).
Exports `homeDoc()`, `essayDocs()`, `essayMetas()`, `projectDocs()`,
`projectMetas()`, `films()`, `albums()`.

Three decisions in it:

- **`import.meta.glob`, not `node:fs`.** Vite inlines the JSON at build time,
  so the content travels with the bundle. A filesystem read would work in the
  static Pages build and fail silently in the Vercel editor build, where a
  page is rendered on demand in a function that has no `src/` directory.
  Verified: the three content sources are present in
  `.vercel/output/_functions/chunks/site-content_*.mjs`.
- **Invalid content fails the build.** Skipping a bad file would publish a site
  with an essay quietly missing from it. This matches what the site does today:
  frontmatter that does not match `src/content.config.ts` already fails
  `astro build`.
- **The file name is the URL,** and `meta.slug` is asserted against it, so an
  entry cannot be listed on the index at one address and built at another. The
  globbed directories are also asserted against `contentDirFor()` in the
  registry, so the two cannot drift silently.

**`src/pages/photography/[slug].astro`** — the album page, the only new surface
(§6). `[slug]` and not `[...slug]`: a rest parameter can match the empty
string and would fight `photography/index.astro` over `/photography/`.

### Repointed

| File | Was | Now |
|---|---|---|
| `src/pages/index.astro` | `src/content/home.yaml` via the Keystatic reader, with the hero, the overlay and a 60-line inline script written out by hand | `src/content/pages/home.json` → `renderDoc` (which builds `.hero`, `.hero-hint`, `.intro`, `.lightbox`), plus `initLightboxes()` |
| `src/pages/essays/[...slug].astro` | the `writing` markdown collection | `src/content/pages/essays/<slug>.json` → `renderDocPage` |
| `src/pages/essays/index.astro` | `getCollection('writing')` | essay `meta` → `renderLedgerPage(…, 'essays')` |
| `src/pages/projects/[...slug].astro` | `.mdoc` via the Keystatic reader, rendered by `src/lib/project-doc.ts` | `src/content/pages/projects/<slug>.json` → `renderDoc` |
| `src/pages/projects/index.astro` | the Keystatic reader over `*.mdoc` | project `meta` → `renderLedgerPage(…, 'projects')` |
| `src/pages/filmography/index.astro` | `src/data/filmography.ts` + an inline click handler | `src/content/data/filmography.json` → `renderFilmography`, plus `initVideoFacades()` |
| `src/pages/photography/index.astro` | `src/data/photography.ts` | `src/content/data/photography.json` → `renderPhotography` |
| `src/pages/writing/[...slug].astro` | `getCollection('writing')`, for the redirect slugs | `essayDocs()` |

`src/pages/writing/index.astro` is unchanged. Its four redirect pages build
byte-identically to the pre-change build.

Two deliberate departures from the obvious:

- **The project page keeps its own masthead.** `renderDocHead` exists and the
  essay page uses it, but a project's "Visit" link is not the same object: live
  it is `.project-link`, a 13px nav-face row on a hairline underline with an
  arrow glyph, and `renderDocHead` emits `.doc-visit`, a 15px row with a bold
  label, no rule and no arrow. Using it would have changed how the page looks
  for no gain. `renderDocHead` is explicitly optional and outside the renderer
  contract (`docs/cms-contracts.md` §4), so the page builds its own header out
  of `doc.meta`. The body goes through `renderDoc`. The masthead region of the
  page is pixel-identical to live as a result.
- **The essay page has no `<article>` wrapper, and must not.**
  `article { max-width: 720px }` would cap the whole document at the reading
  measure, and an essay can hold a canvas band now
  (`docs/cms-sections.md` 3.1). The measure moved onto the blocks, which is
  where `.project-body > p` already had it. `doc.css` is written for exactly
  this shape.

### Left alone, as instructed

`src/content/home.yaml`, `src/content/writing/*.md`,
`src/content/projects/*.mdoc`, `src/data/filmography.ts`,
`src/data/photography.ts`, `src/lib/project-doc.ts`, `src/content.config.ts`,
`keystatic.config.tsx`, `src/studio/`, `src/preview/`, every `@keystatic/*`
dependency. A grep of `src/pages`, `src/layouts`, `src/components` and
`src/lib` finds no code reference to any of the old sources — only the comments
that say what each page used to read.

Nothing under `src/cms/` was edited. No git command was run.

---

## 2. How this was verified

**The baseline is honest.** Before changing anything, the nine live pages were
fetched from `https://jinhyuk.org/` and the pre-change `dist/` was built and
diffed against them. All nine were identical, whitespace normalised, so the
local build really is what the live site serves and a later diff is a diff
against the live page.

**Markup.** Each page's `<main>` is tokenised (one token per tag, one per run
of text, attribute whitespace normalised) and aligned with an LCS diff. A
second pass compares visible text only, which separates "the words changed"
from "the markup changed". Head metadata (`<title>`, `description`, `og:*`) is
compared separately.

**Pixels.** Both sides are served from one local origin so the 390 case can sit
in a same-origin iframe — Chrome will not open a window narrower than about
500px. The live side is the real HTML off the wire with
`<base href="https://jinhyuk.org/">` prepended, so its CSS, fonts and pictures
still come from the deployed site: it is the live page, addressed locally. On
both sides `loading="lazy"` is dropped and `decoding="async"` becomes `sync`,
and a blocking script holds the load event open for 2s so the webfonts land
before the shutter. That changes when a picture is painted, never where.
Screenshots are full-page, taken with
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new
--run-all-compositor-stages-before-draw`, and compared pixel by pixel on a
canvas with a tolerance of 8/255 on any channel.

**Numbers, not just pictures.** Where a screenshot showed a difference, the
same elements were measured on both sides with `getComputedStyle` at 1600,
1440, 1100 and 390, and vertical offsets were resolved by aligning the two
pages' row-ink profiles — which is how §5 can say "the body sits exactly 44px
higher" rather than "the body moved".

**1600 as well as 1440.** `html { scrollbar-gutter: stable }` means a 1440px
window leaves a 1329px content column, not the 1344px reference width. 1600 is
included because it is the first width at which the column really is 1344px,
and the difference between the two runs is itself a finding (§5.2).

**Behaviour.** The two client behaviours this cutover moved out of inline
`<script>` tags were driven against the real built pages in `dist/`: clicking a
film facade, and the hero enlarge at 900px and at 1440px. All eleven assertions
pass (§3.3).

Artefacts from this run (screenshots, per-page diffs, the measurement output)
are in
`/private/tmp/claude-501/-Users-ryanchoi/fa7cb6d4-c038-4224-a4ba-36ed240f803d/scratchpad/`,
which is a session temp directory and will not survive. The numbers below are
the evidence; `node src/cms/render/verify-sections.ts` is WS-B's own
equivalent harness and is permanent.

---

## 3. Results, page by page

### 3.1 Pixels, local `dist/` against live

Differing pixels, tolerance 8/255. "height" is the full document height.

| Page | 1440 | 390 |
|---|---|---|
| `/` | **0** of 2,118,240 · 1471 = 1471 | **0** of 534,040 · 1019 = 1019 |
| `/projects/` | **0** of 1,170,720 · 813 = 813 | **0** of 420,160 · 800 = 800 |
| `/essays/` | **0** of 1,170,720 · 813 = 813 | **0** of 420,160 · 800 = 800 |
| `/filmography/` | **0** of 2,089,440 · 1451 = 1451 | **0** of 866,320 · 1658 = 1658 |
| `/photography/` | **0** of 1,658,880 · 1152 = 1152 | **0** of 420,160 · 800 = 800 |
| `/projects/track-daily-habit-tracker/` | 678,088 of 10,209,600 (6.6417%) · 7110 vs 7090 | 981,933 of 4,156,360 (23.6248%) · 9147 vs 7985 |
| `/essays/chasing-the-workaround/` | 463,853 of 5,542,560 (8.3689%) · 3849 vs 3866 | 317,867 of 2,261,480 (14.0557%) · 6559 vs 4341 |
| `/essays/who-i-m-looking-for/` | 491,496 of 6,194,880 (7.9339%) · 4360 vs 4302 | 356,632 of 2,487,160 (14.3389%) · 7363 vs 4775 |
| `/essays/whos-choosing/` | 9,389 of 6,878,880 (0.1365%) · 4804 vs 4777 | 429,186 of 2,803,320 (15.3099%) · 8666 vs 5383 |

And at 1600, where the content column is the 1344px reference width:

| Page | 1600 |
|---|---|
| `/projects/track-daily-habit-tracker/` | 251,744 of 11,344,000 (2.2192%) · 7091 vs 7090 |
| `/essays/chasing-the-workaround/` | 463,813 of 6,158,400 (7.5314%) · 3849 vs 3866 |
| `/essays/who-i-m-looking-for/` | 491,391 of 6,883,200 (7.1390%) · 4360 vs 4302 |
| `/essays/whos-choosing/` | 9,449 of 7,643,200 (0.1236%) · 4804 vs 4777 |

The project page loses two thirds of its difference between 1440 and 1600. That
is §5.2.

### 3.2 Markup and words

| Page | words a reader sees | markup tokens | head metadata |
|---|---|---|---|
| `/` | identical but for the dropped inline script | 43 vs 47, 18 differ | identical |
| `/projects/` | **identical** | **identical** | identical |
| `/projects/track-daily-habit-tracker/` | identical but for the dropped inline script | 164 vs 127, 133 differ | identical |
| `/essays/` | identical (two `&#39;` vs `'`) | 37 vs 37, 4 differ | identical |
| `/essays/chasing-the-workaround/` | one dropped `h1`, §5.6 | 100 vs 97, 69 differ | identical |
| `/essays/who-i-m-looking-for/` | identical (two `&#39;` vs `'`) | 137 vs 131, 76 differ | identical |
| `/essays/whos-choosing/` | identical (two `&#39;` vs `'`) | 103 vs 97, 64 differ | identical |
| `/filmography/` | **identical** | 88 vs 92, 28 differ | identical |
| `/photography/` | **identical** | 20 vs 20, 6 differ | identical |

No prose, link, caption, button, film field, `src` or `alt` is lost on any
page. The only text that disappears anywhere on the site is the duplicate
`<h1>` on `chasing-the-workaround` (§5.6).

### 3.3 Behaviour, driven against the built pages

```
PASS  filmography: clicking a facade builds exactly one player
PASS  filmography: the player loads https://www.youtube-nocookie.com/embed/EudrajWcwwg?autoplay=1&rel=0
PASS  filmography: the other three stills are untouched
PASS  filmography: no player before any click
PASS  home @900:  clicking the hero opens the enlarge overlay
PASS  home @900:  the page behind stops scrolling
PASS  home @900:  the trigger is in the tab order (tabIndex 0)
PASS  home @900:  Escape closes the overlay
PASS  home @900:  and the page scrolls again
PASS  home @1440: a desktop click does NOT enlarge, as live
PASS  home @1440: the trigger stays out of the tab order (tabIndex -1)
```

`npm run cms:verify` still passes.

---

## 4. Differences that change nothing a reader sees

These account for every token difference on the five pixel-identical pages, and
for most of them on the other four.

**4.1 Void elements are self-closed.** `<img …>` becomes `<img …/>`,
`<path …></path>` becomes `<path …/>`, `<br class="brk-wide">` becomes
`<br class="brk-wide"/>`. Identical parse, identical rendering. WS-1's style
(migration report §5.16).

**4.2 Apostrophes change side of the escaping line.** The renderer's
`escapeAttr` writes `&#39;` where Astro wrote a literal `'` in the hero's
`alt`, and `escapeText` leaves a literal `'` in body text where Astro wrote
`&#39;` (the essay index titles, the essay `h1`s). Both forms render the same
character. Zero pixels differ on the two index pages, which is the proof.

**4.3 Stable ids appear as data attributes.** `data-band-id`,
`data-block-id`, `data-item-id`, `data-doc-slug`. The connector script measures
a named block by them, and they let two documents sit in one page. Attributes,
not `id`. Migration report §5.4.

**4.4 A film button gains `data-embed`.** The whole autoplay embed URL, built
by `youtubeEmbedUrl`, so the client script reads it instead of assembling a URL
of its own and does not have to import zod to format one string.
`data-video-id` is now the YouTube id rather than the record id, which the
schema separates on purpose (contracts §10.1). The filmography page is
pixel-identical at both widths.

**4.5 The hero's intrinsic size is stated at half the numbers.**
`width="2688" height="1648"` becomes `width="1344" height="824"` — the authored
box in reference pixels, the same 1.6311 ratio. `.hero img` is
`width: 100%; height: auto`, so these only reserve the right shape before the
file arrives. Zero pixels differ on the homepage.

**4.6 Inline scripts became bundled modules.** The homepage's 60-line hero
script is `initLightboxes()`; the filmography click handler is
`initVideoFacades()`; the project page's connector script is
`initDocConnectors()`. All three move out of `<main>` and into the head as
`<script type="module">`, which is why `<main>` loses a token on those pages.
The behaviour is unchanged and asserted (§3.3). One behavioural nuance: the
shared `centreStage` also sets `scrollTop`, where the homepage's own script set
only `scrollLeft`. It affects where an already-open overlay starts scrolled on
a picture taller than the window, nothing on the page behind it.

**4.7 `sections.css` is inlined on the photography page.** 2,714 bytes of
`<style>` in the head, holding `.card-link`, `.album-*` and the overlay
chrome — all new class names. Zero pixels differ.

**4.8 The essay page gains the connector script.** Live essays load no
JavaScript. An essay can now carry a canvas band with an anchored item
(`docs/cms-sections.md` 3.1), and without the script that item would render an
empty `<svg class="doc-connectors">` and no line. The module is 2.5 kB (1.2 kB
gzipped) and does nothing when there is nothing anchored. This is an addition,
not a change: it is outside `<main>` and no pixel moves.

**4.9 The project page's body is a different shape.** `figure.pb` /
`div.media-items` / `div.media-item` collapsed into `figure.doc-item` +
`div.doc-frame`, and flexbox layout became coordinates. Migration report
§5.1–5.8 covers all of it, and §4 of that report measured the result in a
browser: every picture within 0.03px in x, w and h. Nothing in the collapsed
wrappers carried text, a caption, a `src` or an `alt`.

**4.10 The project page's body sits exactly 1px lower.** Measured by aligning
the two pages' row-ink profiles: everything below the first picture registers
zero residual after a +1px shift. The live `.media-item img` is 719.969px tall
(fractional flexbox sizing); the doc frame is exactly 720. This is the whole of
the 7090 → 7091 height difference at 1600, and it is why so many prose rows
register in the pixel count while looking identical in a crop.

---

## 5. Differences that change how a page looks

Eight of them. Four (5.1 to 5.4) are faults in `src/cms/styles/doc.css`; one
(5.5) is a shape the schema cannot hold; one (5.8) is a gap in
`src/cms/render/prose.ts` that breaks links rather than moving anything; and
two (5.6, 5.7) are the migration's own intended changes. Every one of the
first six is inside `src/cms/`, which I am not allowed to edit and have
deliberately not worked around in the page files.

### 5.1 Below 900px a document's body type is not stepped down — SEVERE

`src/styles/global.css` sets `body { font-size: 14px; line-height: 24px }`
under `@media (max-width: 900px)`, and the live article pages inherit it:
`article p` and `.project-body > p` declare no size of their own.
`src/cms/styles/doc.css` declares `.doc { font-size: 17.5px; line-height: 35px }`
on the container, and its own 900px block never resets it.

Measured on `/essays/whos-choosing/` in a 390px viewport:

| | live | local |
|---|---|---|
| `body` | 14px / 24px | 14px / 24px |
| first paragraph | 14px / 24px | **17.5px / 35px** |
| blockquote | 14px / 24px | **17.5px / 35px** |
| document height | 5383px | **8666px** |

The other two essays are the same: 4341 → 6559 and 4775 → 7363. The project
page is hit too, 7985 → 9147, less badly only because its pictures already
dominate its height. `h2` and `h3` are unaffected: they carry explicit sizes in
both stylesheets.

This is the single largest regression in the cutover, and it is on every
document page at every width below 900px. It is `doc.css`'s to fix — something
of the shape

```css
@media (max-width: 900px) {
  .doc { font-size: 14px; line-height: 24px; }
  .doc--essays .doc-quote { font-size: 14px; line-height: 24px; }
}
```

would close it, but that file belongs to WS-1/WS-B and this report is the
place to raise it rather than patch it.

### 5.2 The project page's reading column scales where live's was fixed

`.doc-p` is `max-width: min(720px, 100cqw × 720/1344)`; `.project-body > p` is a
flat `max-width: 720px`. The two agree only when the content column is at least
1344px wide.

| window | content column | live `p` | local `p` | page height |
|---|---|---|---|---|
| 1600 | 1344px | 720px | 720px | 7090 vs 7091 |
| 1440 | 1329px | 720px | **711.95px** | 7090 vs 7110 |
| 1100 | 989px | 720px | **529.81px** | 7090 vs 6390 |

At 1440 — a common laptop window, and the width this verification was asked to
use — `html { scrollbar-gutter: stable }` takes the column to 1329px and the
prose wraps eight pixels early, which reflows the whole page and makes it 20px
taller. At 1100 the text column is 26% narrower than live and the pictures
scale with it, so the page is 700px shorter.

This is deliberate in the renderer: a project page's canvas items are placed in
percentages, so the measure has to scale with the column or an item authored to
sit beside a paragraph walks into it. `doc.css` says as much, and gives essays
a flat 720px for exactly the reason that bites here ("at a 1440px window the
scrollbar gutter alone takes the measure to 712px and the text wraps eight
pixels early, for nothing"). The same argument applies to a project page with
no item beside its text — which is every band on the one project page that
exists; all seven of its pictures are in their own full-width canvas bands with
no overlay. A `.doc--projects` rule mirroring `.doc--essays` would close it.
Not mine to add.

### 5.3 Bold is heavier than it was

`.doc strong { font-weight: 600 }`. Live, `article` and `.project-body` say
nothing about `<strong>`, so it falls to the user agent's `bolder`, which
against the site's inherited `font-weight: 300` resolves to **400**. Measured
on both pages at every width: live 400, local 600.

This is migration report §5.19, raised there and still open. It affects "you
build your own cover" on the project page and the `TL;DR` run that opens each
of the three essays. It is the only difference left on
`/essays/whos-choosing/` at 1600 besides §5.4, and it is visible in a crop: the
local bold is distinctly darker. 400 is what has been published for months and
is very nearly not bold at all; 600 is probably what the author meant by
`**bold**`. The owner's call; `doc.css`'s line either way.

### 5.4 An essay gains 27px before the footer

`.doc` carries `container-type: inline-size`, which brings layout containment,
which stops the last paragraph's 27px bottom margin collapsing out of the
document. Live, `article` has no containment and the margin collapses away.

Measured, last paragraph to footer: live 120px, local 147px, at 1600, 1440 and
1100 alike. It is the whole of the 4777 → 4804 height difference on
`/essays/whos-choosing/`. The project page is not affected: live
`.project-body` already has `display: flow-root`, which contains the margin the
same way — measured 148px on both sides.

A `.doc--essays > .doc-group:last-child .doc-band > :last-child { margin-bottom: 0 }`
in `doc.css` would close it. Not mine to add.

### 5.5 A group caption now belongs to the first picture

Migration report §5.3. `.media-caption--group` was one caption for a whole
figure, 720px wide at the reference width; `CanvasItem.caption` puts it on the
first item, 332.25px wide. Measured at 1600: live 720px, local 332.25px.

On the one project page that exists this is invisible — all six captions are
short enough to fit on one line in 332px, and a crop of the first one ("The
welcome screen") shows it in the same place in both. A longer caption would
wrap differently. It wants either a caption on `CanvasBand` in the schema or a
band-level caption in the renderer; it cannot be fixed in a page.

### 5.6 `chasing-the-workaround` loses its duplicate `h1` — intended, but worth confirming

The live page renders the title twice: once as the template's `<h1>` and again
as `<h1 id="chasing-the-workaround">` from the body markdown, which repeats it
character for character. `PROSE_BLOCK_KINDS` has no `h1`, and
`docs/cms-contracts.md` §12 says to drop the duplicate rather than demote it,
so the migration did.

Measured: the body sits exactly **44px higher** than live — one `article h1`
at 32/44 with no margin — and aligns with zero residual after that shift. No
words are lost; the title is still on the page, printed by the template. But it
*is* a visible change, and the brief named only `who-i-m-looking-for` as
expected, so it is called out here.

### 5.7 `who-i-m-looking-for`'s body heading becomes the standfirst — the known, expected one

`<h1 id="who-im-looking-for-the-temporarily-stuck">Who I'm Looking For: The
Temporarily Stuck</h1>` is now `<p class="doc-summary">` with the same text,
rendering as the italic standfirst above the essay. Measured: the body sits
exactly **31px lower** (75px of standfirst plus margin, against 44px of `h1`)
and aligns with zero residual after that shift. Every word survives, in the
same order; only the tag and the type changed. This is the difference the brief
pre-approved.

### 5.8 Heading `id` attributes are gone — no visual change, but links break

Astro's markdown gave every essay heading a slug `id`
(`<h2 id="pain-is-invisible-the-workaround-is-not">`). `ProseBlock` has nowhere
to store one and `renderProseBlock` emits `<h2 class="doc-h2" data-block-id="…">`
with no `id`. Nothing moves on the page, but **any `#fragment` link into an
essay stops resolving** — an external link, a shared anchor, a search result
deep link.

WS-F flagged this for WS-B (migration report §2.3.5: "any external link to an
essay fragment depends on WS-B regenerating those ids"); WS-B did not. The
renderer can derive the same slug from the heading text. It is `prose.ts`'s to
add, and I have not post-processed the HTML in the page to fake it, because
that is working around a renderer rather than reporting it.

---

## 6. The album page, which is new

`/photography/<slug>/`, built by `src/pages/photography/[slug].astro` from
`albumPagePaths(albums())` and rendered by `renderAlbumPage`. The live site
404s on this address today, so there is nothing to compare it to.

`src/content/data/photography.json` is `{"albums": []}`, so the route builds
nothing and the photography index shows the same empty state it shows live.
To prove the page actually works, `src/cms/fixtures/photography.json` was
copied over the content file, the site was built, both albums were
screenshotted at 1440 and 390, and the content file was then restored — `git
status` reports `src/content/` clean, so the restore is byte-exact.

What the screenshots show, and I looked at them:

- `/photography/` with albums: two `.cards--thirds` tiles, each a `.card-link`
  to its album page, 4:3 crop, title and year. Three across at 1440 (two filled),
  one column at 390. The empty state is gone, as it should be.
- `/photography/first-build/`: the masthead, the year in the accent nav face
  under it, the italic standfirst, then the justified grid — five photographs
  in a row of equal height at 1440 with the sixth below, each at its own aspect
  ratio and none cropped, captions under the ones that have them. At 390 it is
  one column, full width, captions intact.
- `/photography/developing/`: the single-photograph album renders, with the
  no-arrows single-picture overlay.

WS-B's own `src/cms/render/verify-sections.ts` drives the overlay itself —
opening on the clicked photograph, the counter reading `1 / 6`, ArrowRight
advancing, Escape closing and unlocking the page. The page here uses the same
`initLightboxes()` entry point that §3.3 proves is wired up and working on the
homepage hero.

---

## 7. Builds, and what is in `dist/`

```
npm run build                      PASS   13 pages
PUBLIC_EDITOR_BUILD=1 npm run build PASS   server output + .vercel/output
npm run cms:verify                 PASS
```

The editor build prints four `getStaticPaths() ignored in dynamic page`
warnings. Three are pre-existing — `projects/[...slug]`, `essays/[...slug]`
and `writing/[...slug]` all had `getStaticPaths` before this change and the
editor build is `output: 'server'`. The fourth is the new
`photography/[slug]`. They are warnings, not errors, and the pages are rendered
on demand in that build by design.

`dist/` holds 13 HTML pages, the same 13 as before the change (the album route
builds nothing while `albums` is empty), plus two CSS bundles and six script
chunks. Checked:

- **No CMS, API, studio or preview route reaches the static build.** `find dist
  -ipath '*cms*' -o -ipath '*api*' -o -ipath '*studio*' -o -ipath '*preview*'`
  returns nothing, and grepping every built `.html`, `.js` and `.css` for
  `/api/cms`, `/cms/` or `keystatic` returns nothing. They are injected in
  `astro.config.mjs` only when `isDev || PUBLIC_EDITOR_BUILD=1`, and their
  files live outside `src/pages/`, so this holds structurally and not by luck.
- The four `/writing/` redirect pages are byte-identical to the pre-change
  build.
- `_slug_.c3FOXrl-.css` is `global.css`, unchanged in content and hash from the
  pre-change build. `_slug_.DNLM550z.css` is `doc.css`, loaded on the homepage,
  the three essays and the project page. `sections.css` is inlined on the
  photography pages. Every rule in both new stylesheets is scoped under `.doc`,
  `.card-link`, `.album-*` or `.lightbox-*`; neither contains a bare element
  selector, so neither can reach a page that does not use those classes.

---

## 8. What I could not finish

**The four differences in §5.1 to §5.4 are not fixed.** All four live in
`src/cms/styles/doc.css`, which I was told not to touch, and all four would be
a few lines there. §5.8 is in `src/cms/render/prose.ts`. I have not worked
around any of them in the page files, because a page that compensates for a
renderer is a page that will disagree with the preview and the editor.

**§5.1 should block the push.** Everything else is a few pixels, a font weight
or a documented decision. That one makes three essays roughly half as tall again
on a phone, with the body set three and a half points too large, and it is
plainly wrong rather than arguable.

**The order I would do them in:** §5.1 (mobile type), then §5.2 (a
`.doc--projects` flat measure to match `.doc--essays`), then §5.4 (27px), then
§5.8 (heading ids, which is correctness rather than appearance), and §5.3 and
§5.5 are the owner's taste.

**Not attempted, and out of scope:** deleting the old sources, removing
Keystatic or the studio, moving media under `public/media/<section>/`. The
working tree is left uncommitted for review.
