# Does the editor show you the page?

The editing surface exists to look like the published page. It cannot *be* the
page: the page is static HTML styled by `doc.css`, and the surface is a React
tree styled by `SHELL_CSS`, with a live ProseMirror instance in every block.
So the question is always "where do the two disagree, and does it matter".

Everything below was measured, not read off a stylesheet. The method is the
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

### An empty row is a blank line in the CMS and nothing at all on the page

Still true, and the one thing in this file that is not fixed: it is a feature,
[`roadmap.md`](roadmap.md) F1, not a bug. Worth the whole table.

| | Height of an empty paragraph block |
| --- | --- |
| Editor | **35px** (a full line: ProseMirror gives every empty block a line box so you can put the caret in it) |
| Published page | **0px** |

And the gap it creates on the page, measured for every pair of neighbouring
block kinds in an essay, with zero, one, two and three empty rows between
them:

```
  first  -> second        none    one     two   three
  p      -> p              27     27     27     27
  p      -> h2             48     48     48     48
  p      -> h3             32     32     32     32
  p      -> quote          27     27     27     27
  p      -> ul             27     27     27     27
  p      -> callout        28     28     28     28
  h2     -> p               8     27     27     27   <- moves
  h2     -> h2             48     48     48     48
  h2     -> h3             32     32     32     32
  h2     -> quote           8     27     27     27   <- moves
  h2     -> ul              8     27     27     27   <- moves
  h2     -> callout        28     28     28     28
  h3     -> p               4     27     27     27   <- moves
  h3     -> h2             48     48     48     48
  h3     -> h3             32     32     32     32
  h3     -> quote           4     27     27     27   <- moves
  h3     -> ul              4     27     27     27   <- moves
  h3     -> callout        28     28     28     28
  quote  -> p              27     27     27     27
  quote  -> h2             48     48     48     48
  quote  -> h3             32     32     32     32
  quote  -> quote          27     27     27     27
  quote  -> ul             27     27     27     27
  quote  -> callout        28     28     28     28
  ul     -> p              27     27     27     27
  ul     -> h2             48     48     48     48
  ul     -> h3             32     32     32     32
  ul     -> quote          27     27     27     27
  ul     -> ul             27     27     27     27
  ul     -> callout        28     28     28     28
  callout-> p              28     28     28     28
  callout-> h2             48     48     48     48
  callout-> h3             32     32     32     32
  callout-> quote          28     28     28     28
  callout-> ul             28     28     28     28
  callout-> callout        28     28     28     28
```

Three facts fall out of that grid:

1. **An empty row changes the page in 6 of 36 cases.** All six are directly
   after a heading, where the gap goes from 8px (h2) or 4px (h3) up to 27px.
2. **Everywhere else it does nothing at all**, because CSS margins between
   siblings collapse and the margin already there is bigger than anything an
   empty paragraph can contribute.
3. **Three empty rows do exactly what one does.** They all collapse into the
   same single gap. You cannot stack them to get more air.

So the behaviour is not "empty rows are ignored" and it is not "empty rows add
space". It is "empty rows sometimes add up to 23px and you cannot tell which
from looking at the CMS, where they always look like a full 35px line". That
is why a real spacing control is worth building; it is [`roadmap.md`](roadmap.md)
F1.

### The editor is light-only and desktop-only

The surface has no theme switch and no width switch. Preview has both
(`?theme=dark`, `?width=390`). Nothing is wrong here, but it means **dark mode
and phone layout are only ever checked in Preview**, and nothing makes you go
there. Worth knowing before changing a colour.

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
