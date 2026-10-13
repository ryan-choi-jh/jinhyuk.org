# Does the editor show you the page?

The editing surface exists to look like the published page. It cannot *be* the
page: the page is static HTML styled by `doc.css`, and the surface is a React
tree styled by `SHELL_CSS`, with a live ProseMirror instance in every block.
So the question is always "where do the two disagree, and does it matter".

Last updated 2026-10-13. Everything below was measured, not read off a
stylesheet. The method is the
one in `src/cms/app/shell/verify-typography.mjs`: render the same document
twice in one browser, once as the page with `doc.css` and once inside
`.cms-surface` with `SHELL_CSS`, then compare `getComputedStyle`. Declared CSS
is not evidence; a rule inside a media query looks identical to one outside it
in the source and behaves differently on the screen.

---

## What is shared, and therefore cannot drift

| Thing | Where the one copy lives |
| --- | --- |
| The HTML of every band, block and canvas item | `src/cms/render/` (`renderDoc`). The surface calls it. |
| The masthead | `renderProjectHead` / `renderDocHead`, called by both. |
| The nav and footer | `src/content/data/site.json`, drawn around the surface and around the page. |
| The highlighter's four inks | `src/cms/styles/highlight.ts`, mirrored into `doc.css` between markers. |
| The callout's five tones | `src/cms/styles/callout.ts`, same mirror. |
| The text palette | `src/cms/app/prose/palette.ts`. |
| The date format | `formatLongDate` in `schema.ts`. |
| Canvas geometry | `REFERENCE_WIDTH` and `refPxToPercent` in `schema.ts`. |
| Shape drawings | `src/cms/assets/shapes.ts`, seeded from the item id so the wobble is identical everywhere. |

`npm run cms:verify` asserts the two CSS mirrors are byte-identical to their
TypeScript originals. A backtick inside a CSS comment in one of those template
literals has broken the build five times; the guard now catches it in seconds.

---

## What still drifts

### Block typography: clean

`verify-typography.mjs`, over paragraph, h2, h3, quote, callout and lists in
both the essay and the project setting. All pass. This is recent:
headings were 56/4 in the editor against the page's 48/8, and every quote was
drawn the project way, which is why an essay's TL;DR looked half as large
again in the CMS as on the site.

### Marks and the masthead: clean, as of 2026-10-13

They were not. The same harness, extended from 6 block kinds to 17 subjects
across both sections (34 checks), found two drifts it had been blind to:

| | Was | Now |
| --- | --- | --- |
| Bold | 400 on the page, 600 in the editor | **600 in both** |
| A link in a callout | `rgb(216,216,216)` on the page, `rgb(228,228,228)` in the editor | 216 in both |

Bold was a decision, not a slip. The page value was deliberate and `doc.css`
said so: before the cutover there was no rule at all, so the browser's
`bolder` against the body's 300 resolved to 400, and matching it kept the
cutover a change of data source. But at a 300 body, 400 is very nearly no
step, and the editor had been drawing 600 the whole time, so the author and
the reader were seeing different words emphasised. 600 on both sides is the
version where bold means bold, and it is a visible change to every published
page that uses it.

The callout link was a plain specificity accident: `.doc-callout a` and
`.cms-surface a` have the same weight, so whichever stylesheet was appended
last won. `CALLOUT_CSS` now names the surface itself, which puts the answer
in the file that owns the callout.

### An empty row: answered, and replaced

This was the one that came up repeatedly. The measurements that settled it,
for every pair of block kinds in an essay, with zero to three empty rows
between them:

| | |
| --- | --- |
| An empty paragraph in the editor | **35px** (ProseMirror gives every empty block a line box so the caret has somewhere to go) |
| The same on the published page | **0px** (its margins adjoin its neighbours' and collapse) |
| Pairings where it changes the page | **6 of 36**, all directly after a heading, never by more than 23px |
| What a second or third one adds | **nothing** — they all collapse into one gap |

So "press Enter twice for more air" was never available.

**Both halves are fixed.** A block can ask for space above it (`meta`-level
`space`: small 48px, medium 80, large 120, stepping to 32/52/76 below the
breakpoint), and the editor marks an empty row with "empty row · adds
nothing to the page" rather than drawing a convincing blank line. A band
with empty rows in it offers to remove them.

The control is a **floor, not an addition**: the rule is a `margin-top`, it
adjoins the previous block's `margin-bottom`, and adjoining margins collapse
to the larger of the two. So "small" after a paragraph (27px) and "small"
after a heading (8px) both come out at 48. The inspector says so in those
words, because "adds 48px" would be wrong and would have people stacking
them again.

`styles/verify-spacing.mjs` checks every size against every pairing, at both
widths, and checks the editor's gap equals the page's.

### Dark mode: on the surface. Phone width: only in Preview, and that is correct

The surface has a theme switch now (light / dark / system) that sets
`data-theme` on `<html>`, exactly as the site's own pre-paint script does.
It works because `.cms-surface` is `background: var(--paper)` and every
colour in the drawn page comes from the same tokens the site uses, so the
page in the middle pane becomes the dark page while the editor's own chrome,
on a separate `--cms-*` scale, does not move.

**Width is deliberately not on the surface.** The mobile rules are VIEWPORT
media queries — `@media (max-width: 900px)` in `doc.css` and again in
`global.css` — and a viewport is a window or an iframe, never a scaled div.
A narrowed surface would change the measure and change nothing else: the
canvas would stay absolutely positioned where a phone stacks it into a
column, and the type would stay at 17.5 where a phone steps to 14. That is a
worse lie than not offering it. The "Phone" button beside Preview opens the
preview at 390 in a real iframe, which is where it was already right.

---

## Known places the editor deliberately differs

Not drift. These are choices, listed so nobody "fixes" them.

- **The masthead is inert.** Links in it do not navigate; those fields are
  edited in the inspector, and a live `target="_blank"` inside an editing
  surface loses your place.
- **Every block has a focus ring, a hover box and a floating toolbar.** None
  of that is on the page.
- **A canvas band shows its bounds** even when its contents do not fill it.
- **An overlay band is draggable** where the page just paints it.
- **The page surface is scaled with a CSS transform** so the 1344px reference
  column fits the middle pane. The canvas editor is told the same scale and
  `applyTransform={false}` so the zoom is not applied twice.
