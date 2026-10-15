# The CMS, documented

Everything known about the editor that is not in the code itself.
Last updated: 2026-10-13.

| File | What it is |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | **Read this first if you are about to change the editor.** The rules the system keeps, and the ways people have broken it. |
| [`workflow.md`](workflow.md) | How the editor works, end to end, as flowcharts. What happens between a keystroke and the live site. |
| [`consistency.md`](consistency.md) | Where the editor and the published page agree, where they do not, and how each answer was measured. |

The authoritative description of the data model stays where it is:
`src/cms/schema.ts` (machine readable) and `docs/cms-contracts.md` (prose).
Where those two and these files disagree, the code wins.

## Running the checks

Three groups, all plain `node`. No build, no test runner, no watch mode.

```
npm run cms:check           # 17 offline suites, about two seconds
npm run cms:check:browser   # 17 that open a browser, about eight minutes
npm run cms:check:e2e       # 2 that create a GitHub branch and drive a dev server
```

The runner (`src/cms/check.mjs`) runs every suite in the group rather than
stopping at the first failure, prints a table with timings, and then prints
the output of only the ones that failed. A passing run is six lines. Exit
code 0, or 1 for any failure, or 2 for an unknown group name.

`npm run cms:verify` is `src/cms/fixtures/verify.ts` alone, which is the
schema, the fixtures and the mirrored-CSS guard. Run it after touching
`src/cms/styles/*.ts`.

Two more that are tools rather than checks:

```
node src/cms/styles/sync-doc-css.mjs       # copy highlight/callout/spacing into doc.css
node src/cms/server/unused-media.mjs       # which uploads nothing points at
```

On this machine, `git` and `node` need
`DEVELOPER_DIR=/Library/Developer/CommandLineTools` in front of them until
the Xcode licence is accepted.

## What each suite is for

**Offline** (`npm run cms:check`)

| Suite | What it proves |
| --- | --- |
| `fixtures/verify.ts` | Every fixture validates; the mirrored CSS in `doc.css` is byte-identical to its TypeScript source |
| `render/selftest.ts` | What the renderer's string actually says: escaping, marks, heading ids, block spacing |
| `app/state/verify-state.ts` | The document store: undo, redo, dirty tracking, selection pruning |
| `app/state/verify-site-state.ts` | Navigation across the five sections |
| `app/state/verify-local-draft.ts` | The crash copy, against storage that throws, is full, or holds rubbish |
| `server/verify-moves.ts` | The redirect bookkeeping behind a rename, including the chain case |
| `app/prose/verify.ts` | The real ProseMirror schema: block ↔ editor round trips, mark order |
| `app/canvas/verify-geometry.ts` | Dragging, resizing, rotating, snapping, z-order |
| `app/records/verify.ts` | Film and album editing |
| `assets/verify.ts` | The shape generator, including hostile input |
| `preview/selftest.ts` | What the preview renders for each surface |
| `verify-preflight.ts` | The pre-publish checklist finds what it should and stays quiet otherwise |
| `verify-hidden.ts` | `meta.hidden` makes a page absent, not merely unlisted |
| `styles/verify-css-strings.ts` | No backtick inside a CSS comment, and the braces balance |
| `styles/verify-tokens.ts` | The editor's copy of the site's design tokens still matches `global.css`, both ways |
| `styles/verify-type-scale.ts` | The body-size scale: its base numbers are what the stylesheets declare, the default generates nothing, and every override out-specifies what it overrides |
| `server/verify.ts --offline` | Header parsers, HTTP helpers, route refusals |

**Browser** (`npm run cms:check:browser`)

| Suite | What it proves |
| --- | --- |
| `app/prose/harness/run.mjs` | The live prose component |
| `app/prose/harness/keys.mjs` | The block-boundary keys, and pasting a whole essay, in a band of real editors |
| `app/shell/harness/drive.mjs` | The editor shell: the crash copy, the publish picker, that the toolbar fits at six widths, that Theme actually repaints the sheet, and that Fit does not fight the scrollbar |
| `app/shell/site-harness/drive.mjs` | The whole-site navigation shell, and renaming a page from the inspector |
| `app/shell/verify-typography.mjs` | The editor sets prose exactly as the page does, in light and in dark |
| `styles/verify-spacing.mjs` | "Space above" is a floor, in both places, at both widths |
| `styles/verify-type-scale-browser.mjs` | A scaled section measures the same in the editor as on the page, at three sizes |
| `app/records/harness/drive.mjs` | The record editors |
| `app/chrome/harness/run.mjs` | The nav and footer editor, the body-size panel, and that two saves at once do not dead-end the draft |
| `app/guide/harness/run.mjs` | The welcome guide |
| `app/library/harness/run.mjs` | The component library |
| `app/canvas/harness/verify-browser.mjs` | The canvas, measured in a browser |
| `preview/verify.ts` | The preview, every surface, every width |
| `render/verify.ts` | Layout at 1440, 1100 and 390 |
| `render/verify-sections.ts` | **Pixel-compared against jinhyuk.org as it is right now** |
| `render/verify-home-note.mjs` | The homepage's 원고지 note, on a real build: its squares on the grid's own lines (found in the image's pixels) at 1440 and 1100, every trigger and way out, the phone caption, dark mode, reduced motion, the keyboard, the accessibility tree, storage that throws, and that it is invisible without its script |
| `app/integration/verify.ts` | The wiring between workstreams |

**End to end** (`npm run cms:check:e2e`) creates a throwaway branch, drives
a real dev server against it, and deletes the branch in a `finally`. Never
touches `main`.

## Two things to know about the slow ones

**`render/verify-sections.ts` compares against the live site**, so it is
red in the window between a content change landing locally and the deploy
finishing. That is the check working, not failing.

**`site-e2e.mjs` has been seen to die partway once in several runs**, at
around check 83, in a way that has not reproduced since. Logged rather than
claimed fixed.

## State

All 34 non-e2e suites passed on 2026-10-14: 17 offline, 17 browser. The
17th browser suite, `render/verify-home-note.mjs`, came in with the
homepage's 원고지 note; the end-to-end pair was not re-run for it, since the
note touches neither the API nor the editor. With them that is 36.

`preview/verify.ts` has failed two or four of its 424 checks in three
full-group runs and passed 424/424 in nine runs on its own, including
under the runner's exact spawn. Not reproduced in isolation and not
understood. `check.mjs` now prints the named failures of a failed suite
rather than only its tail, so the next group run says which ones.
