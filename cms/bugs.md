# Sweep of 2026-10-13: twenty findings, all fixed

Every one of these was reproduced before it was written down, and every one
has since been fixed and re-measured. Kept until the roadmap work lands, then
this file goes: the lessons worth keeping have moved into
[`AGENTS.md`](AGENTS.md), and the editor-versus-page measurements into
[`consistency.md`](consistency.md).

**All 27 check suites pass.** Where a fix needed a guard that did not exist,
the guard went in too:

| Guard | Covers |
| --- | --- |
| `app/prose/harness/keys.mjs` (new, 26 checks) | B5 to B8: the block-boundary keys, against the real editor |
| `app/shell/verify-typography.mjs` (12 → 34) | B9, B10: marks and the masthead, not only block kinds |
| `render/selftest.ts` (+6) | B3: heading ids, including the collision and fallback cases |
| `styles/sync-doc-css.mjs` (new tool) | the mirrored-CSS copy, which was done by hand |
| `server/unused-media.mjs` (new tool) | B19: what nothing points at |

Two of the twenty needed Ryan's decision and got it: **bold goes to 600 on
the site** (B9), and **Keystatic is removed entirely** (B12).

Three turned out differently from how they were first written down, and the
record below says so where it happens:

- **B17e** needed no decision. `global.css` sets `body { font-size: 14px }`
  below 900px, so a pre-cutover blockquote inherited 14 like everything else.
  The CSS was right and the assertion was stale.
- **B6** was worse than described. Enter was dead on an empty item anywhere
  in a list, not only the last one, which only showed up once there was a
  test for it. The fix breaks the list open wherever the caret is.
- **A nonexistent entry was not a dead end.** It says "there is no project at
  X yet"; a 300-character truncation hid the message during the sweep.

---

## high

### B1. An essay's "Visit" link is not sanitised

`src/cms/render/index.ts:354` puts `meta.url` straight into an `href`.
`src/cms/schema.ts:223` types that field as `z.string().url()`, which is
`new URL()` in a try/catch, and `new URL('javascript:alert(1)')` succeeds.

Reproduced:

```
validateDoc({ ..., meta: { url: 'javascript:alert(document.domain)' } })  ->  ACCEPTED
renderDocHead(doc)  ->  href="javascript:alert(document.domain)"
renderProjectHead(doc)  ->  (no link emitted)
```

A project page is safe because `pages/project.ts:65` runs the same field
through `safeUrl` first. An essay page is not. `data:text/html,...` passes
too.

The practical risk is low, because the only person who can author content is
the person who owns the site. The reason it is still high is that the renderer
is the layer whose whole job is to not trust the document, one of its two
mastheads already does that job, and the other silently does not.

**Fix.** Two lines, in two places. In `renderDocHead`, do what
`renderProjectHead` does: `const href = meta.url === undefined ? null :
safeUrl(meta.url)`, and drop the link when it is null. Separately, narrow
`DocMetaSchema.url` so the value cannot be stored in the first place, reusing
the `HrefSchema` pattern that already rejects it for buttons
(`DocButtonSchema` is correct today: a `javascript:` button fails validation).

### B2. `meta.urlLabel` does nothing on an essay

Same function, next line. `src/cms/render/index.ts:355` hardcodes `Visit`.
The field was added so a link that goes to a demo can say so, and the project
page honours it.

```
project masthead label:  "Visit demo prototype:"
essay   masthead label:  "Visit"
```

The editor shows the same wrong label, because the surface draws an essay's
masthead with the same function. So it is at least consistently wrong.

**Fix.** `escapeText(meta.urlLabel ?? 'Visit')`.

### B3. Two headings with the same words get the same `id`

```
<h2 ... id="what-i-learned">What I learned</h2>
<h2 ... id="what-i-learned">What I learned</h2>
```

Duplicate ids in one document. `#what-i-learned` resolves to the first, so a
link into the second section goes to the wrong place. `headingSlug`
(`src/cms/render/prose.ts:288`) documents that it matches github-slugger,
which is what the old markdown pipeline used, and github-slugger disambiguates
with `-1`, `-2`.

Latent today: no published essay or project has two headings that slug the
same. Checked every file.

Related, same function: a heading whose text has no ASCII letters or digits
gets **no id at all**. `"한국어 제목"` and `"…"` both slug to `""`.

**Fix.** `renderProseBlock` is per-block and has no document scope, so the
counter has to be threaded from `renderProseBand` / `renderDocBands`. Keep a
`Set<string>` per document and append `-1`, `-2` on collision, matching
github-slugger. For the empty case, fall back to the block id, which is
already unique and already in the markup as `data-block-id`.

---

## medium

### B4. Changing a block's kind does different things from the toolbar and from the outline

There are two converters for one user-visible action:

| Where you click | What runs |
| --- | --- |
| The floating toolbar's P / H2 / H3 / quote / callout / list buttons | `convertBlockKind`, `src/cms/app/prose/block.ts:392` |
| The outline, and the inspector | `convertProseContent`, `src/cms/app/state/doc-ops.ts:588` |

They disagree. Given a run carrying a forbidden `underline` mark (which a
paste can produce), converting a paragraph to a quote gives:

```
block.ts  ->  [{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"x"}]}]
doc-ops   ->  [{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"},{"type":"underline"}],"text":"x"}]}]
```

The outline path writes a mark the contract says cannot exist. It is
invisible, because the renderer ignores unknown marks and the next edit in
TipTap normalises it away, but it is stored content that the whole
normalisation discipline exists to prevent.

**Fix.** Have `doc-ops.setBlockKind` call `convertBlockKind`. Both files are
pure data, `block.ts` imports only `schema.ts` and `palette.ts`, and there is
no import cycle. Then delete `convertProseContent` and its helpers, about 60
lines. One converter.

### B5. Cmd-S does nothing while the caret is in a block

Measured in the real editor: the keydown reaches `window` with
`defaultPrevented: false`, so nothing saves and the browser's own
"Save page as…" dialog opens.

`src/cms/app/shell/use-shortcuts.ts:46` is inside a guard that skips every
shortcut when focus is in an input, a textarea, a select or a contenteditable.
That guard is right for Cmd-Z, and the file explains why: TipTap owns undo
inside a block, and stealing it would undo a band reorder mid-sentence. It is
wrong for Cmd-S, which nothing else binds, and the caret is in a block
essentially always.

**Fix.** Check for `s` before the `isTextEntry` guard rather than after it.

### B6. You cannot leave a list with the keyboard

Measured in the real editor. In a two-item bulleted list:

```
Enter at the end of the last item   ->  3 items, the third empty
Enter again on the empty item       ->  still 3 items, still empty
                                        no paragraph created
```

In every other editor, Enter on an empty last item ends the list. Here it
cannot: the block's ProseMirror document is pinned to a single `bulletList`
node, so `liftListItem` has nowhere to lift to. The only way out is the
toolbar.

This also leaves an empty `<li>` in the document, which renders as an empty
bullet on the page.

**Fix.** In the list keymap, catch Enter when the selection is in an empty
last item: delete that item and call the host's `onSplit` with an empty tail,
which is exactly "end this block, start a paragraph after it". The host
machinery already exists for the single-line kinds.

### B7. Delete at the end of a block does nothing

Measured: 5 blocks before, 5 after. Backspace at the start of a block joins it
onto the one above (`onMergeUp`); the mirror case is simply unbound, so the
key does nothing at a block boundary.

**Fix.** An `onMergeDown` option alongside `onMergeUp` in
`ProseExtensionOptions`, bound to Delete when the caret is at the last
position with nothing selected. The host's handler is the same merge with the
indices shifted by one.

### B8. Arrow keys do not cross block boundaries

Measured: ArrowDown from the end of the first paragraph leaves focus in the
first paragraph. Every block is a separate editor, so there is nothing for the
caret to move into. On a long page you click into every block.

**Fix.** Bind ArrowDown at the last line and ArrowUp at the first to a caret
request on the neighbouring block. The `caretRequests` map in
`src/cms/app/index.tsx` already does exactly this for split and merge; this is
the third caller. Left and Right at the two ends are the same idea and should
go in at the same time.

### B9. Bold is 600 in the editor and 400 on the page

See [`consistency.md`](consistency.md). A decision, not a blind fix: the page
value is deliberate and documented in `doc.css`. Pick one, make the other
match, and extend `verify-typography.mjs` to cover marks so it cannot drift
again.

### B10. A link inside a callout is underlined in the wrong grey in the editor

`rgb(216,216,216)` on the page, `rgb(228,228,228)` in the editor.
`.doc-callout a` and `.cms-surface a` (`src/cms/app/shell/styles.ts:484`) have
equal specificity, so append order decides.

**Fix.** Give the editor's generic link rule a lower-specificity home, or add
`.cms-surface .doc-callout a` to `CALLOUT_CSS` so the one file that owns the
callout owns its link too.

### B11. Fit ignores rotation

`canvasContentHeight` (`src/cms/app/state/doc-ops.ts:245`) measures
`y + h + caption`. A 400 by 100 item rotated 90° occupies 400px of vertical
space and the function reports 200.

```
item 400x100 at y=100, rotate 90  ->  canvasContentHeight: 200   (should be ~350)
```

So pressing Fit on a band with a rotated item crops it.

**Fix.** Use the rotated bounding box: `|w·sin θ| + |h·cos θ|` for the height,
about the item's centre.

### B12. Keystatic is still mounted, and edits files nothing reads

`astro.config.mjs` includes Keystatic in `astro dev` and in the editor build.
`keystatic.config.tsx` edits `src/content/writing/*` and
`src/content/projects/*`. The site reads `src/content/pages/**` and nothing
else; `src/lib/site-content.ts` says so in its header. `src/content.config.ts`
still defines the `writing` collection.

So `/keystatic` on the editor deployment is a complete, working CMS that
changes nothing. The repo `README.md` still tells you to use it.

**Fix.** Decide whether Keystatic stays as a fallback. If not: drop the
integration from `astro.config.mjs`, delete `keystatic.config.tsx` and
`src/content.config.ts`, remove `@keystatic/*` from `package.json`, delete the
dead content files, and rewrite the Editing section of `README.md`. If yes: at
minimum put a banner in `keystatic.config.tsx` and a warning in `README.md`
saying nothing it writes reaches the site.

---

## low

### B13. `tone` is accepted on blocks that are not callouts

```
ProseBlockSchema.safeParse({ id, kind: 'p', tone: 'pink', content: [] })  ->  ACCEPTED
setBlockKind(callout -> p)  ->  { kind: 'p', tone: 'pink', ... }
```

`CanvasItemSchema` already has exactly this guard for shape-only and
media-only keys (`src/cms/schema.ts:488`). `ProseBlockSchema` does not.
Harmless on the page, since only a callout renders a tone, but it is the sort
of residue that confuses the next reader of the JSON.

**Fix.** A `superRefine` on `ProseBlockSchema` rejecting `tone` unless
`kind === 'callout'`, and strip it in `setBlockKind`.

### B14. `zoom` and `poster` are accepted where they mean nothing

```
zoom on a video / embed / shape  ->  ACCEPTED   (images only)
poster on an image               ->  ACCEPTED   (videos only)
```

Both fields document themselves as kind-specific. Same fix shape as B13, in
the refinement that is already there.

### B15. `updateMeta` can leave a label with no link

```
updateMeta(doc, { url: '' })  ->  { title, slug, date, urlLabel: 'Visit demo:' }
```

Clearing the URL keeps the label. The renderer drops both, so nothing shows,
but the field lingers in the file and reappears the moment a URL is typed.

**Fix.** Clear `urlLabel` when `url` goes.

### B16. Fit does nothing when every item sits above the band's top

`canvasContentHeight` returns `null` when the lowest bottom is `<= 0`, which
is correct for an empty band and wrong for a band whose items have all been
dragged above `y = 0`. Pressing Fit then appears broken.

### B17. Five of the 26 check suites are red, and not one of them for a product reason

This is the finding that matters most in this section, because it is why the
other four in it went unnoticed. Everything that runs in under a minute
passes. Everything slow or awkward to run is broken, and has been for a
while.

| Suite | State | Why |
| --- | --- | --- |
| `render/selftest.ts` | 106 of 108 | B17a below |
| `app/integration/verify.ts` | 107 of 108 | B17b below |
| `app/integration/e2e.mjs` | dies in step 4 | B17c below |
| `app/integration/site-e2e.mjs` | dies in step 4 | B17d below |
| `render/verify-sections.ts` | 7 failures | B17e below |
| `server/verify-routes.mjs` | exits 2 | not a failure: it needs `npm run dev -- --port 4399` first, and says so |

A suite that always fails is a suite people stop reading. Fixing these five is
worth more than any single item above it, because until they are green nothing
new they catch will be believed.

#### B17a. Two stale assertions in `render/selftest.ts`

106 pass, 2 fail. Both expect heading markup from before headings gained their
`id` anchors:

```
FAIL  block: h2   expected to find: <h2 class="doc-h2" data-block-id="h2">Two</h2>
FAIL  block: h3   expected to find: <h3 class="doc-h3" data-block-id="h3">Three</h3>
```

The renderer is right and the test is stale. A suite that always fails is a
suite people stop reading, which is the actual cost here.

**Fix.** Update the two expectations to include `id="two"` and `id="three"`.
Do it together with B3, since B3 changes the same markup.

#### B17b. The CSS-scope guard trips over `@keyframes`

```
FAIL  every rule is scoped to .ws8-* or inside .cms-* (got ["50%"], wanted [])
```

`src/cms/app/integration/verify.ts:718` finds selectors by splitting
`INTEGRATION_CSS` on `}` and `{`, and drops anything starting with `@`. That
works until an at-rule has a body: inside `@keyframes ws8-deploy-pulse`, the
keyframe percentages `0%, 100%` and `50%` look exactly like selectors to it.

**This one is mine.** The keyframes came in with the deploy chip. The guard's
intent is right and the animation is correctly scoped; the parser cannot see
inside an at-rule.

**Fix.** Strip at-rule blocks before splitting, or ignore a "selector" that
is only a percentage. Two lines either way.

#### B17c. The whole-system e2e has been red since the phase 2 path move

`src/cms/app/integration/e2e.mjs` seeds `src/content/pages/ws8-e2e.json` and
looks for its draft at `src/content/drafts/ws8-e2e.json` and its media at
`public/media/ws8-e2e/`. Those are phase 1 paths. Phase 2 moved them, and
`src/cms/server/config.ts` says so in a comment: a bare slug now resolves
through `LEGACY_SECTION_ID = 'projects'` to
`src/content/pages/projects/<slug>.json`, with media under
`public/media/projects/<slug>/`.

So it creates its throwaway branch, seeds a page the server will never look
for, and then waits 60 seconds for an editor that has nothing to open.

Confirmed not to be a product bug: a real dev server on `main` renders
`/cms/projects/track-daily-habit-tracker` in 7ms.

**Fix.** Move the harness's seeded paths to the section paths, through
`contentPathFor` and `mediaDirFor` rather than string literals, which is what
would have kept it in step in the first place.

#### B17d. The site e2e is blocked by the guide's own welcome overlay

`src/cms/app/integration/site-e2e.mjs` gets through 16 checks and then times
out clicking a paragraph. The cause, proven rather than guessed:

```
a fresh profile shows the guide scrim: YES
it covers 1680x1050 of a 1680x1050 window
the block the e2e clicks exists: yes
clicking it: FAILS — page.click: Timeout 6000ms exceeded
with the guide flag seeded, the same click: works
```

The guide opens itself on a first visit, which is correct behaviour, and
`.cms-guide-backdrop` is `position: fixed; inset: 0; z-index: 200`. Every
Playwright run is a first visit, and neither e2e mentions the guide.

**Fix.** `await page.addInitScript(() => localStorage.setItem('jinhyuk-cms.guide-seen.v1', '1'))`
before the first navigation, in both e2e harnesses. `useGuide` also takes
`autoOpenOnFirstVisit: false`, but seeding the flag tests the shipped
behaviour rather than a second code path.

#### B17e. `verify-sections.ts` compares against a site that has moved on

Seven failures. Six of them are the check working correctly: it renders its
own fixtures and pixel-compares them against **jinhyuk.org as it is right
now**, and the real site has legitimately changed since those fixtures were
written. The homepage copy was rewritten, which is the 70px and 10.6%; a
second project was published, which is the projects index at 1.8%. Both are
content drift between the fixture and the site, not a renderer fault.

The seventh is real and worth settling:

```
essay @ 390: the quote is body size like a live essay, got 14
```

The assertion (`verify-sections.ts:946`) wants 17.5px at every width. A later
rule in `doc.css:800` deliberately sets an essay's quote to 14/24 below the
breakpoint, with a comment explaining that leaving it at 17.5 made an essay
run 169px long at 390. The two contradict each other and both are in the
repository.

The rule is the newer of the two and carries its reasoning, so the assertion
is the likely stale one, but confirm against a pre-cutover screenshot before
changing either: that is exactly the comparison the check exists to make, and
guessing would discard the only evidence anyone has.

**Fix for the other six.** Point the fixtures at the live content, or freeze a
baseline so "the site changed" stops reading as "the renderer broke".

### B18. `store.publish()` uses the wall clock instead of the injected one

`src/cms/app/state/store.ts:348` writes `at: Date.now()` where every other
timestamp in the file uses the injectable `now()`. The injectable clock exists
so history coalescing is deterministic in a test; this one line opts out.

### B19. Uploaded media is never deleted

There is no delete endpoint, and removing an item from a canvas or a photo
from an album removes the reference, not the file. `public/media/` only grows.

**Fix.** Not a delete button, which is how you lose a file that something else
still points at. A report: walk every published document and record, collect
every `src` under `/media/`, list what is in `public/media/` and not in that
set. Then deleting is a decision with a list in front of it.

### B20. `SITE_ORIGIN` is hardcoded in `deploy.ts`

`src/cms/server/deploy.ts:44` has `https://jinhyuk.org` as a literal, in a
codebase whose first rule is that nothing is spelled twice. It should come
from `config.ts` beside `REPO` and `defaultBranch()`, with an env override, so
a staging branch can be watched too.

---

## Checked and clean

Written down so the next sweep does not redo them.

- Prose round trip: `block -> TipTap -> block` is lossless, mark for mark and
  attr for attr, for every block kind. 176 checks, all passing, against the
  real ProseMirror schema.
- `normalizeProseContent` is a genuine fixed point; applying it twice equals
  applying it once.
- Escaping: `escapeText` and `escapeAttr` are applied to every piece of
  document text that lands in the output. `safeUrl` rejects `javascript:`,
  `data:` and `vbscript:` including when spelled with embedded control
  characters. B1 is a call site that skips `safeUrl`, not a hole in it.
- A `javascript:` URL in a `meta.buttons` entry fails validation.
- The slug is read-only in the inspector, and the server refuses a document
  whose `meta.slug` disagrees with its path. You cannot accidentally fork a
  page into two files.
- Dangling anchors validate and are skipped by the renderer, which is the
  documented intent: deleting a paragraph must not make a document unsaveable.
- Every write carries a blob sha; a concurrent commit is a 409 with an
  explanation rather than a silent overwrite.
- Undo, redo, dirty tracking and selection pruning: 121 checks, all passing.
- The mobile fallback drops canvas positioning below 900px and stacks items
  full width.
- Canvas geometry: 207 checks, all passing.
- The CSS mirrors in `doc.css` are byte-identical to `highlight.ts` and
  `callout.ts`.
