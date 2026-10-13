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
- One known exception, and it is a bug, not a precedent: `SITE_ORIGIN` in
  `src/cms/server/deploy.ts` is a literal. See [`bugs.md`](bugs.md) B20.

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
- Anything that would need to cross a block boundary needs host help. That is
  why arrow keys do not move between blocks today
  ([`bugs.md`](bugs.md) B8).
- **A split keeps the original block's id for the head.** An anchored
  connector stores a `blockId`, so the half that keeps the id is the half that
  keeps the connector.

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
anything that becomes an `href` or a `src`. There is exactly one known call
site that skips `safeUrl` and it is a bug ([`bugs.md`](bugs.md) B1).

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

**The trap, which has now bitten five times: a backtick inside a CSS comment
inside a TypeScript template literal ends the literal.** It usually appears
when writing something like `` /* the `--rule` token */ ``. The build error is
far from the cause and reads like nonsense. `cms:verify` catches it in
seconds, so run it immediately after touching one of those files.

**The editor's typography is a separate mirror** (`SHELL_CSS` in
`src/cms/app/shell/styles.ts`) and it has drifted from `doc.css` three times.
`src/cms/app/shell/verify-typography.mjs` renders the same document twice in
one browser and compares computed styles. Run it after any change to either
file. It covers block kinds only; marks and the masthead are not covered yet
([`roadmap.md`](roadmap.md) F9), which is how two more drifts survived this
long.

The surface carries its section as a class (`cms-surface--essays`,
`cms-surface--projects`) because an essay and a project really are set
differently, and the editor not knowing that was the cause of the last drift.

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
  rendering failure. It reads `src/content/pages/**` now.

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
- **A draft save is a commit too**, and it triggers a full site rebuild
  ([`roadmap.md`](roadmap.md) F11). Expect `main` to move under you often.
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
