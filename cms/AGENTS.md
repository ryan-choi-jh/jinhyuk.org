# Working on the CMS

Read this before changing anything under `src/cms/`. It is the set of rules
the system already keeps and the specific ways people have broken it. Most of
these were learned by breaking them.

Start with [`workflow.md`](workflow.md) if you do not know how the editor
fits together, and [`README.md`](README.md) for the list of checks and how to
run them.

---

## 0. The three hard rules

1. **Never commit or push without being asked.** This repository is the
   owner's live personal site. A commit to `main` deploys it.
2. **Never hand-edit `src/content/pages/**` or `src/content/data/*.json`.**
   Those are published pages, written by the CMS. If you need different
   content for a test, use `src/cms/fixtures/`.
3. **Measure before you claim.** See section 5. This is the house style and
   it is not optional.

On this machine, `git` and `node` need `DEVELOPER_DIR=/Library/Developer/CommandLineTools`
in front of them until the Xcode licence is accepted.

---

## 1. Who owns what

| File | Status |
| --- | --- |
| `src/cms/schema.ts` | **The contract.** Every type in the system is `z.infer` of a schema here. Do not edit it to make something else compile; say what you need and why. |
| `src/cms/sections.ts` | **The registry.** What each of the five sections stores, where its files are, what fields a record has. |
| `docs/cms-contracts.md` | The prose companion to those two. Where it and the code disagree, the code wins and the document is the bug. |
| `docs/cms-rebuild.md`, `docs/cms-sections.md` | The original briefs. History, not truth. |

Derived rules:

- **Never write a section name as a string literal** outside a narrowing. No
  `if (section === 'photography')`. Ask the registry. If the registry cannot
  answer, that is the thing to fix.
- **Never hardcode a number the schema exports.** Not `1344`
  (`REFERENCE_WIDTH`), not `900` (`MOBILE_BREAKPOINT`), not `1440`/`48`
  (`PAGE_WIDTH`/`PAGE_GUTTER`). `schema.ts` throws at import time if those
  three stop agreeing with each other, which is the only reason that
  invariant has held.
- **Never build a content path by concatenation.** `contentPathFor(section,
  slug)` is also the path-traversal guard: it refuses anything that is not an
  id.
  There are no exceptions left. `SITE_ORIGIN` was the last literal address
  and now comes from `config.ts` with a `CMS_SITE_ORIGIN` override, read at
  call time rather than frozen at module load.

---

## 2. The document model, and what it costs

**Every object schema is `.strict()`.** An unknown key is a validation error,
not something quietly dropped. So editor-only state (selection, hover, drag
deltas, zoom) must never reach the document. The store holds it.

**All canvas geometry is in reference pixels against 1344.** The renderer
turns `x` and `w` into percentages; `y` and `h` stay in px. One conversion,
`refPxToPercent`, so the editor and the page cannot drift.

**A shape's wobble is seeded from its item id** (`seedFromId`). Never from
`Math.random()` and never from an array index, or the same squiggle will be
drawn differently in the editor, in the preview and on the page.

**One `ProseBlock` is exactly one top-level ProseMirror node.** This is the
single most consequential decision in the editor and nearly every prose
surprise traces back to it:

- A paragraph block's schema literally contains no heading, no list and no
  blockquote, so nothing a paste or a stray shortcut does can smuggle one in.
- Enter cannot make a second paragraph, so it is intercepted and turned into
  "cut this block in two" (`onSplit`), handled by the host.
- Backspace at position 1 cannot delete the block, so it is intercepted and
  turned into "join onto the block above" (`onMergeUp`).
- Anything that would need to cross a block boundary needs host help: the
  arrow keys, Delete at the end of a block, and Enter on an empty bullet all
  go out to the host and come back through the `caretRequests` map. All five
  were dead until they did.
- **A split keeps the original block's id for the head.** An anchored
  connector stores a `blockId`, so the half that keeps the id is the half that
  keeps the connector.
- **A paste of more than one block is a BAND operation, not a block one.**
  ProseMirror has nowhere to put the second paragraph of a twenty-paragraph
  paste, so it kept what fitted and dropped the rest, and moving an essay in
  from Notion meant pasting it a paragraph at a time. The clipboard is read
  in `src/cms/app/prose/paste.ts` before the editor sees it, parsed with
  `pasteExtensions()` — which is the editor's own extension set with the
  one-node pin removed and nothing else changed — and handed to the host as
  blocks. **A paste that comes to a single block is left entirely to
  ProseMirror**, which already does it correctly and knows where the caret
  is; re-implementing that is how paste gets subtly wrong.
  If you add a node kind, add it to `pasteExtensions` too, or it will be
  typeable and unpasteable.

**`meta.hidden` means there is no page, not an unlisted one.** The filter
lives in `src/lib/site-content.ts`, the single place every route and index
reads through, so a hidden document produces no `getStaticPaths` entry, no
row, and no `/writing/` redirect. Unlisted-but-reachable leaves the URL live
for anyone holding a link and for a search engine that already has it, and
the index looks correct, so nobody finds out. Do not add a route that globs
`src/content/pages/` itself; `verify-hidden.ts` fails if one appears.

**`normalizeProseContent` is a fixed point.** Applying it twice equals
applying it once, and applying it to what ProseMirror emits changes nothing.
If you touch `src/cms/app/prose/block.ts`, that property is what
`src/cms/app/prose/verify.ts` exists to defend. Three things it costs:
ProseMirror fills in every registered attr, so a link comes back with nulls
that must be dropped; ProseMirror merges adjacent text nodes with identical
marks, so we must too; ProseMirror emits marks in schema rank order, so marks
are sorted into `MARK_ORDER` and `MARK_ORDER` is asserted against the real
schema.

---

## 3. The renderer

**It must never throw.** One bad paragraph taking down the whole site build
is worse than one bad paragraph rendering as nothing. `content` is
`unknown[]` on purpose and everything in `render/prose.ts` is defensive.

**Everything that lands in the output goes through `escape.ts`.**
`escapeText` between tags, `escapeAttr` inside an attribute, `safeUrl` for
anything that becomes an `href` or a `src`. Every call site does; the one
that did not published `javascript:` straight into an essay's masthead for
months, because `z.string().url()` is `new URL()` in a try/catch and that
accepts it.

**There are two mastheads and they are genuinely different objects.**
`renderProjectHead` for a project (13px nav face, hairline rule, arrow) and
`renderDocHead` for an essay (15px, bold label, no rule). They are not two
implementations of one thing, and flattening them was considered and
rejected. But they must keep each other honest: B1 and B2 are both "one of
them does something the other forgot".

**The published page and the editor call the same renderer.** The page
surface is not a second implementation of the page. If you are about to write
JSX that draws something the page also draws, stop and call the renderer.

---

## 4. CSS lives in one place, and there is a trap in how

A stylesheet cannot import TypeScript, and the editor does not load
`doc.css`. So where both need the same rules, the pattern is:

1. A TypeScript module exports the CSS as a string
   (`src/cms/styles/highlight.ts`, `src/cms/styles/callout.ts`).
2. `src/cms/styles/doc.css` carries a **copy** of it between named markers.
3. `npm run cms:verify` asserts the copy is byte-identical.
4. The editor injects the string directly at runtime.

**Do not hand-copy the block into `doc.css`.** Run
`node src/cms/styles/sync-doc-css.mjs`, which writes it, then
`npm run cms:verify`, which proves it. The guard was always there; the
copying was by hand, which is the step the guard existed to catch.

**Two ways to break a CSS string silently, both now checked by
`src/cms/styles/verify-css-strings.ts` in the offline group.**

A **backtick inside a CSS comment** ends the template literal. It appears
when quoting a token, as in a comment about the `--rule` variable. This has
happened eight times, twice in one sitting, once within an hour of this
rule being written. The build catches it and reports `Expected ";" but
found "flex"` at a line far from the cause.

An **unbalanced brace** is worse, because nothing fails: the string builds,
the editor boots, and every rule after the bad brace is dropped by the CSS
parser. The symptoms of the last one were three panes at full width and a
"desktop only" notice on a 1600px screen, which looks like anything except
a brace.

Run `npm run cms:check` after touching any file that exports CSS.

**The editor's typography is a separate mirror** (`SHELL_CSS` in
`src/cms/app/shell/styles.ts`) and it has drifted from `doc.css` three times.
`src/cms/app/shell/verify-typography.mjs` renders the same document twice in
one browser and compares computed styles. Run it after any change to either
file. It covers block kinds, every mark and both mastheads, in both themes:
68 checks. The dark half is there because `color` only has one value to be
wrong in until there are two themes; a hardcoded light accent in SHELL_CSS
passes every light check there is. It covered
block kinds ALONE for a while, which is how bold stayed 600 in the editor
and 400 on the page, and how a link inside a callout stayed the wrong grey.
`styles/verify-spacing.mjs` is its companion for the space control.

The surface carries its section as a class (`cms-surface--essays`,
`cms-surface--projects`) because an essay and a project really are set
differently, and the editor not knowing that was the cause of the last drift.

**The editor does not load `src/styles/global.css`, so it does not get the
site's design tokens for free.** `/cms` is a React island; nothing in its
import graph pulls that stylesheet in, and importing it would be wrong
anyway, because it styles `body`, the nav and the article, and would repaint
the dark chrome as a white page. `src/cms/styles/tokens.ts` carries the
token table instead, and `useShellStyles` / `useSiteStyles` inject it.

That file exists because of a bug that hid for as long as it did by being
invisible: every colour on the page surface is written `var(--paper, #fff)`,
`var(--ink, #111111)`, `var(--rule, #e4e4e4)`, and with nothing declaring
those tokens **every one of them resolved to its light fallback, in both
themes, always**. The Theme control set `data-theme='dark'` on `<html>`
exactly as the site does, the attribute landed, and the page stayed white.

Two lessons worth more than the fix:

- **A var() with a fallback does not fail.** It silently uses the fallback.
  If you write `var(--x, …)` in editor CSS, check `--x` is in
  `src/cms/styles/tokens.ts`; `styles/verify-tokens.ts` asserts that table
  matches `global.css` in both directions, so adding a token there and not
  here is a red check rather than a wrong colour.
- **`verify-typography.mjs` could never have caught it**, because it builds
  its test document by concatenating `global.css` itself. It was measuring a
  page that loads the tokens, which the editor is not. When a harness
  assembles its own document, ask what the real route assembles.

**Zoom "Fit" must not depend on anything that depends on Zoom.** The scale is
the measured width of `.cms-surface-measure` over 1440, and that element sits
inside the scrolling box. With a classic scrollbar — macOS "Show scroll bars:
Always", and any Mac with a mouse attached under the default setting — the
width drops 15px the moment the page is tall enough to scroll, which lowers
the scale, which shortens the page, which may remove the scrollbar. On a page
whose scaled height lands within a scrollbar of the pane it oscillated
between 0.5500 and 0.5396 every frame: the sheet jittered and every line in
it rewrapped, continuously. `scrollbar-gutter: stable` makes the width a
constant and breaks the loop.

**A slug is a file name, so changing one is a move and a commit.** The
server refuses a document whose `meta.slug` is not the slug in its path, so
the slug cannot mirror the title as you type — that would be a commit per
keystroke. A new page's address follows its title on SAVE, when a commit is
being made anyway, and only while the move is free:

    published === null      there is no address yet, so nothing can break
    meta.slugFromTitle      the author has not taken the address over

`slugToFollow` in schema.ts is that rule and it is pure; everything that
could go wrong goes wrong there, so it is checked offline and the browser
only proves the wiring. Three things that are not obvious:

- **Save first, then move.** Renaming reloads the entry from the
  repository, so anything unwritten is gone. Moving before saving loses
  exactly the edit that prompted the move.
- **A failed move must not fail the save.** The slug may be taken, the
  branch may have moved. The writing landed under the name it had, and
  that is a note, not an error.
- **`renameEntry` throws the document's store away** — it is keyed to a
  slug that no longer exists. Anything you set on that store afterwards is
  set on a dead object, which is how the first version of "renaming by
  hand stops the following" did nothing at all. Write it, save it, then
  rename.

`meta.slugFromTitle` is ABSENT on every page written before it existed, and
absent means no. A field whose job is to decide whether a URL may change
gets the safe default.

**A slug is a file name, and the rule for one lives in exactly one place.**
It did not. `SLUG_RE` said kebab-case, `fillSlug` said
`[A-Za-z0-9_-]{1,64}`, `renameEntry` said both — and no two of them agreed
about length. A 69-character slug made from a real essay title passed the
editor, passed `DocMetaSchema`, and was refused by the rename with
`"…" is not a usable file name.`, which does not mention length at all.
Before that it was refused by the editor under a message naming a rule it
had not broken, because the field was validating with `IdSchema`, the rule
for block and band IDS.

`MAX_SLUG_LENGTH` is on `DocMetaSchema.shape.slug` now, and that schema is
what the field, the server's rename and the stub API all ask.
`fixtures/verify.ts` asserts `slugProblem` and the schema agree case by
case, that the cap is the path builder's own, and that every slug the CMS
generates fits inside it — `uniqueSlug`'s `-2` suffix included.

**A stub more permissive than the server cannot catch the bug that
matters.** `site-stub-api.ts`'s `renameEntry` accepted any string, so the
69-character slug renamed happily in every harness and failed only in the
editor. If a stub stands in for a gate, give it the gate.

And a refusal should hand over something that WORKS. "Slugs are lowercase:
caps and spaces" was the first attempt at a helpful message; the thing it
suggests is not a slug either. `slugProblem` offers `slugify(value)`, which
is the same function the New-entry flow uses to turn a title into a slug.

**Never signal intent with a header an intermediary has an opinion about.**
"This file must not exist yet" was `If-None-Match: *`, which is a real
conditional header. Publishing an essay that had never been published sent
it; the server published the essay and answered 200; the edge turned that
into a **304 Not Modified** on the way back, and the editor reported

    Publish failed: Request failed with 304.

over a page that was, at that moment, live. A false failure is worse than a
real one: the next thing you do is try again, and the thing you are trying
again has already happened. It is `X-CMS-Expect: absent` now. `If-Match`
with a real sha is fine — it carries a value nothing in the middle can
match against anything of its own.

The check that matters is on the CLIENT (`server/verify.ts`, "the client
does not send a conditional header any more"): the server reading the new
header fixes nothing on its own, because the 304 was produced by an
intermediary reacting to what went out.

**A harness must not assert against content the owner edits.** The
nav-and-footer harness bakes in the real `src/content/data/site.json`,
deliberately, so one of its checks can be "the scenery is the real nav, not
placeholders". When the body-size setting was added to that same file,
publishing 15px for essays turned eight passing checks red without a line of
code changing. The build now strips `type` from the fixture. Before you bake
a real content file into a harness, ask which parts of it are the owner's to
change.

**Publishing is one list, not one button per kind of draft.** There were
three — the toolbar's for the open document, the nav-and-footer panel's for
`site.json`, a third for a record collection — and each was right on its own
while the set of them was not. The owner had a body-size change in
`site.json` and an unfinished essay saved as a page draft, pressed the big
blue Publish, and got "There is no draft of \"home\" to publish": true,
useless, and silent about both of the things that really were waiting.

`src/cms/app/shell/publish-queue.ts` is the contract. The panel is handed a
list of items each carrying its own `publish`, and does not know there are
three endpoints behind them; `PublishQueueBridge` in `src/cms/app/index.tsx`
is the only place that does, because it is the only place that can see the
site API and the chrome store at once. Two rules:

- **The open page publishes through the DOCUMENT store**, not the queue.
  Both reach the same endpoint, but the doc store holds that page's draft
  state and its blob shas, and publishing around it leaves the toolbar
  saying "draft saved" over a page that is live.
- **Sequential, and it stops at the first failure.** Each item is a commit
  on the same branch; several at once race for the branch head and lose to
  each other's conflict detection. A partial run says how far it got,
  because "nothing happened" and "two of four are live" need different
  next moves.

**A draft save that quotes a sha must be serialised.** Every save quotes
`shas.current.draft`, which is only updated when a save RETURNS, so two
saves started before either returned quote the same thing — and when there
is no draft yet, the thing they both quote is "this file does not exist".
The first creates it; the second is refused with *"already exists. It was
expected to be a new file"*, and the panel is left saying "unsaved" over a
draft on disk that it will not write to again. A dead end, reached by
double-clicking Save on a slow connection. The chrome store waits for an
in-flight save before starting the next, and recovers from that one
conflict by re-reading and writing on top — but NOT from "the draft changed
since you loaded it", which means there is work in it this client has never
seen. The harness reproduces both by giving its stub API a latency knob;
with an API that answers instantly the race cannot happen and the check
passes on the broken build.

**The body size is generated, not edited into the stylesheets.**
`src/cms/styles/type-scale.ts` holds the base size of every kind of running
text and emits an ADDITIVE stylesheet that restates them scaled, scoped by
section. Nothing writes into `global.css` or `doc.css`, and that is the point:
those are hand-maintained design files, every page depends on them, and "the
CMS edits the stylesheet" is a far larger promise than "the CMS can make text
smaller". Four rules follow from it.

- **Default generates the empty string.** A site at 17.5px builds byte-for-byte
  what it built before the feature existed, and `site.json` has no `type` key
  at all. `verify-type-scale.ts` asserts both. If you change the generator,
  keep that property: it is what makes the feature safe to ship.
- **The base numbers are copies, and they are checked.** Every value in
  `ROLE_BASE` is a declaration in `global.css`, `doc.css` or `SHELL_CSS`, and
  a ratio against a stale base is wrong in the quietest way there is — the
  text comes out a slightly different size from the one asked for and looks
  fine. `verify-type-scale.ts` reads all three files and fails naming the role.
- **Two dialects, one generator.** The page scopes by
  `body[data-section='…']` (Base.astro puts it there, from `sectionForPath`);
  the editor scopes by `.cms-surface--…`, because it does not load `doc.css`
  and names the same things differently. They call one function, so their
  numbers cannot differ; what can differ is whether the rules LAND, which is
  why `verify-type-scale-browser.mjs` measures both in a browser.
- **`&` means the scoped element itself.** The first version joined every
  selector to its scope with a descendant combinator and produced
  `body[data-section='essays'] body` and `.cms-surface--essays .cms-surface`.
  Both are valid CSS. Neither matches an element, so the rules were simply
  inert. There is a check for that specific shape now.

If you add a kind of running text, add it to `ROLE_BASE`, to both dialects and
to `WITNESS` in the verify, or it will be the one thing on the page that does
not resize.

**The editor shell harness ran with `--hide-scrollbars` and therefore could
not see that, or any other scrollbar bug.** The flag was there to keep the
screenshots tidy. It is gone. A browser flag that simplifies the thing you
are measuring is not a convenience, it is a blind spot — and this one covered
a configuration a lot of people are actually in. If you add a Chrome flag to
a harness, say what it hides.

---

## 5. Measure, do not assert

The house style, and the reason most of this codebase is trustworthy.

- **Computed styles, not declared ones.** A regex over two stylesheets was
  tried for the typography guard and reported four differences a browser says
  are not there, because it could not tell a rule inside a media query from
  one outside it. It was thrown away. A test that cannot be trusted about
  what it measures is worse than no test.
- **Pixels, not reasoning.** The highlighter went through two unshippable
  designs before pixel-sampling showed that `mix-blend-mode` could never
  reach the text through the stacking contexts in the way.
- **Scope your selectors in a browser probe.** `#editor ul, ol` means "a `ul`
  inside `#editor`, **or** any `ol` anywhere", and the measurement walks
  straight out of the container. Scope each part of a selector list.
- **Synthetic key events cannot do everything.** A dispatched `keydown` will
  not perform a native Backspace deletion. Count the handler calls instead, or
  drive a real browser.
- **`Home` goes to the start of the visual line, not the block.** Measure
  where the caret actually is.
- **Home and End need a tick before the next key.** The browser moves the
  caret and ProseMirror hears about it from a `selectionchange` a moment
  later, so `press('End')` immediately followed by `press('Delete')` runs the
  keymap against the OLD selection and it concludes the caret is not at the
  edge. `keys.mjs` has `caretTo` for this.
- **Wait for the condition, not for a duration.** React commits a keystroke's
  edit on its own schedule. A 150ms sleep reported a merge that had happened
  as one that had not. `keys.mjs` has `settleAt`.
- **A fresh browser profile sees the welcome guide.** It auto-opens on a
  first visit and its backdrop is `position: fixed; inset: 0; z-index: 200`,
  so every click after it times out. Both e2e harnesses seed
  `localStorage['jinhyuk-cms.guide-seen.v1']` before the first navigation.
  This cost two harnesses months of being red.
- **Poison-test every new guard.** Break the thing on purpose and watch the
  check fail. A check that has never failed is a check you do not know works.
- **Never restate a formula a module already exports.** The shell harness
  kept its own copy of the fit calculation; the day the fit learned about
  rotation, the copy was 8px short and failed a band that was correct. It
  calls `canvasContentHeight` through the harness seam now. The same mistake,
  in a different costume, is a test that hardcodes a content path: the WS-8
  e2e wrote out phase 1's paths and went red the moment phase 2 moved them,
  so it asks the registry now.
- **A check that compares against the live site must read what the live site
  reads.** `verify-sections.ts` rendered fixtures and pixel-compared them to
  jinhyuk.org, so editing the homepage copy showed up as a ten per cent
  rendering failure. It reads `src/content/pages/**` now. It is therefore
  red in the window between a content change landing locally and the deploy
  finishing, which is the check working rather than failing.
- **Ask the API what it can do; do not branch on a section name.** `can()`
  tests whether the adapter HAS `deleteEntry` and `renameEntry`, which is
  why both buttons sat disabled with an honest reason on them for months and
  then lit up with no UI change at all when the methods arrived. A
  `section.id === 'essays'` would have had to be found and edited.
- **A popover anchored above a top toolbar opens off-screen.** The
  pre-publish checklist used `bottom: calc(100% + 8px)`, which put it at a
  negative y: in the DOM, impossible to click. The shell harness caught it
  by pressing the button inside it and watching nothing happen.

Every workstream ships two halves: a pure check that runs under bare `node`
in under a second, and a browser harness that drives the real component. Add
to both.

---

## 6. If you add a prose block kind

The callout took touching all of these. Miss one and the failure is quiet.

| File | What to add |
| --- | --- |
| `src/cms/schema.ts` | `PROSE_BLOCK_KINDS`, `PROSE_NODE_TYPE`, any new field plus its refinement |
| `src/cms/app/prose/block.ts` | the right branch of `contentForKind` |
| `src/cms/app/prose/extensions.ts` | `flagsFor`, `SINGLE_LINE_KINDS`, `PROSE_KINDS`, `PROSE_KIND_LABEL`, `PROSE_KIND_TITLE` |
| `src/cms/app/state/doc-ops.ts` | `shapeGroup` if its content shape is new |
| `src/cms/render/prose.ts` | `BLOCK_SHELL`, and the switch in `renderProseBlock` if its body is not plain inline content |
| `src/cms/styles/doc.css` | the page's rules, or a new `styles/<kind>.ts` plus its mirror |
| `src/cms/app/shell/styles.ts` | the editor's matching rules |
| `src/cms/app/shell/inspector.tsx` | any per-block control |
| `src/cms/fixtures/simple.json` | one instance, so every suite sees it |
| `src/cms/render/selftest.ts` | what its markup must say |
| `src/cms/app/shell/verify-typography.mjs` | `everyKind()` and `BLOCKS` |

---

## 7. The two deployments

| | Build | Output | Host |
| --- | --- | --- | --- |
| The site | `astro build` | static | GitHub Pages, jinhyuk.org |
| The editor | `PUBLIC_EDITOR_BUILD=1 astro build` | server | Vercel, jinhyuk-editor.vercel.app |

`PUBLIC_EDITOR_BUILD=1` switches `output` to `server`, adds the Vercel
adapter, and injects every `/cms`, `/api/cms` and preview route. None of that
exists in the static build, which is why Pages can serve the site at all.

**Read content through `src/lib/site-content.ts`.** It uses
`import.meta.glob`, not `node:fs`, deliberately: a filesystem read works in
the static build and fails silently in the Vercel editor build, where a page
is rendered on demand in a function with no `src/` directory.

**Keystatic is gone** (2026-10-13), and so are `/studio` and
`/preview/projects/[slug]`, two earlier attempts at the same job that
authenticated off its cookie. All three were still mounted long after the
cutover, editing files the site had stopped reading.

Their files are still in the working tree, unreferenced, along with the
content they edited: `src/studio/`, `src/preview/`, `src/content/home.yaml`,
`src/content/writing/*.md`, `src/content/projects/*.mdoc`,
`src/data/photography.ts`, `src/data/filmography.ts`. **Nothing reads any of
it.** Do not add a feature to any of them, and do not take a question about
"the editor" to mean one of them.

---

## 8. Working alongside the owner

The owner edits this site from the CMS while you are working on it, and those
edits are commits on `main` with messages like
`CMS: save draft projects/<slug>` and `CMS: publish essays/<slug>`.

- **Before rebasing, check for file overlap.** If your branch and their
  commits touch the same file, take their version as the base and re-apply
  your change on top. Never resolve a content file in your own favour.
- **The e2e suites create a branch and push eight to ten commits to it.**
  Vercel deploys every branch push, so a few runs of
  `npm run cms:check:e2e` put dozens of deployments through the editor
  project and, on 2026-10-13, used up enough of the allowance that pushes to
  `main` stopped deploying at all for a while. The editor sat on an old
  build and the fix looked like it had not worked.

  `vercel.json` now carries an `ignoreCommand` that builds `main` and
  nothing else, so the throwaway branches cost nothing. If a push to `main`
  ever seems not to deploy, look at the deployment list for a flood of
  `cms/ws-*-e2e-*` branches before looking at the code.

- **A draft save is a commit too**, though it no longer triggers a rebuild:
  the Pages workflow ignores a push that only touches
  `src/content/drafts/`. Expect `main` to move under you often.
- **Prose written for the owner avoids em dashes.** They read as machine
  written. Colons, commas, brackets and full stops do the same work.

---

## 9. Before you say you are done

```
node src/cms/fixtures/verify.ts
node src/cms/render/selftest.ts
node src/cms/app/prose/verify.ts
node src/cms/app/state/verify-state.ts
node src/cms/app/shell/verify-typography.mjs      # if you touched any CSS
node src/cms/app/prose/harness/run.mjs            # if you touched the prose editor
node src/cms/app/prose/harness/keys.mjs           # if you touched a keymap
node src/cms/styles/sync-doc-css.mjs              # if you touched highlight.ts or callout.ts
```

The full list of 27 suites, with what each one returned on 2026-10-13, is in
[`README.md`](README.md).

**All 27 pass.** So anything failing is yours. Keep it that way: five of them
were red for months for reasons that had nothing to do with the product, and
the cost was not the five failures, it was that nobody ran the slow checks
any more and so nothing they would have caught was caught.
