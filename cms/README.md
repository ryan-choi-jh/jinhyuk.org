# The CMS, documented

Everything known about the editor that is not in the code itself. 
Last updated: 2026-10-13.

| File | What it is |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | **Read this first if you are about to change the editor.** The rules the system already keeps, and the ways people have broken it. |
| [`workflow.md`](workflow.md) | How the editor works, end to end, as flowcharts. What happens between a keystroke and the live site. |
| [`consistency.md`](consistency.md) | Where the editor and the published page agree, where they do not, and how each answer was measured. |
| [`bugs.md`](bugs.md) | Twenty findings from the sweep, each with the evidence that produced it and the fix. |
| [`roadmap.md`](roadmap.md) | The edge cases worth turning into features. Problem, fix, size. |

The authoritative description of the data model stays where it is:
`src/cms/schema.ts` (machine readable) and `docs/cms-contracts.md` (prose).
Where those two and these files disagree, the code wins.

## Running the checks

Everything here is a plain `node` script. No build, no test runner, no watch
mode. Nothing needs a network except where it says so.

```
# the fast ones, all offline, about ten seconds for the lot
node src/cms/fixtures/verify.ts            # the schema, the fixtures, the CSS mirrors
node src/cms/render/selftest.ts            # what the renderer's string actually says
node src/cms/app/state/verify-state.ts     # the document store, undo, dirty
node src/cms/app/state/verify-site-state.ts
node src/cms/app/prose/verify.ts           # the real ProseMirror schema, round trips
node src/cms/app/canvas/verify-geometry.ts
node src/cms/app/records/verify.ts
node src/cms/assets/verify.ts
node src/cms/preview/selftest.ts

# these open a real browser
node src/cms/app/prose/harness/run.mjs            # the live prose component
node src/cms/app/prose/harness/keys.mjs           # the block-boundary keys
node src/cms/app/shell/harness/drive.mjs          # the live shell
node src/cms/app/shell/site-harness/drive.mjs
node src/cms/app/shell/verify-typography.mjs      # editor type vs page type
node src/cms/app/records/harness/drive.mjs
node src/cms/app/chrome/harness/run.mjs
node src/cms/app/guide/harness/run.mjs
node src/cms/app/library/harness/run.mjs
node src/cms/app/canvas/harness/verify-browser.mjs
node src/cms/render/verify.ts
node src/cms/render/verify-sections.ts
node src/cms/preview/verify.ts
node src/cms/app/integration/e2e.mjs
node src/cms/app/integration/site-e2e.mjs
node src/cms/app/integration/verify.ts

# this one talks to GitHub, on a throwaway branch it creates and deletes
node src/cms/server/verify.ts
node src/cms/server/verify.ts --offline     # or just the offline half
node src/cms/server/verify-routes.mjs
```

`npm run cms:verify` is `src/cms/fixtures/verify.ts` alone.

Two more that are tools rather than checks:

```
node src/cms/styles/sync-doc-css.mjs       # copy highlight.ts/callout.ts into doc.css
node src/cms/server/unused-media.mjs       # which uploads nothing points at
```

On this machine `git` and `node` need `DEVELOPER_DIR=/Library/Developer/CommandLineTools`
in front of them until the Xcode licence is accepted.

## State as of this sweep

**All 27 suites pass**, as of 2026-10-13 after the twenty fixes in
[`bugs.md`](bugs.md). Five of them were red before, none for a product
reason, and that was the finding that mattered most: everything running in
ten seconds passed, and everything slow or awkward to run was broken, so
nothing the slow ones would have caught was being caught.

| Suite | Result |
| --- | --- |
| `fixtures/verify.ts` | pass |
| `render/selftest.ts` | 112 / 112 |
| `app/state/verify-state.ts` | 121 / 121 |
| `app/state/verify-site-state.ts` | 182 / 182 |
| `app/prose/verify.ts` | 176 / 176 |
| `app/canvas/verify-geometry.ts` | 207 / 207 |
| `app/records/verify.ts` | pass |
| `assets/verify.ts` | 10 / 10 |
| `preview/selftest.ts` | 202 / 202 |
| `app/prose/harness/run.mjs` | 127 / 127 |
| `app/prose/harness/keys.mjs` | 26 / 26 (new) |
| `app/shell/harness/drive.mjs` | 116 / 116 |
| `app/shell/site-harness/drive.mjs` | 143 / 143 |
| `app/shell/verify-typography.mjs` | 34 / 34 (was 12) |
| `app/records/harness/drive.mjs` | 103 / 103 |
| `app/chrome/harness/run.mjs` | 46 / 46 |
| `app/guide/harness/run.mjs` | 90 / 90 |
| `app/library/harness/run.mjs` | 68 / 68 |
| `app/canvas/harness/verify-browser.mjs` | 70 / 70 |
| `preview/verify.ts` | 424 / 424 |
| `render/verify.ts` | pass |
| `render/verify-sections.ts` | pass (7 failures before) |
| `app/integration/verify.ts` | 108 / 108 |
| `app/integration/e2e.mjs` | 48 / 48 (died in step 4 before) |
| `app/integration/site-e2e.mjs` | 96 / 96 (died in step 4 before) |
| `server/verify-routes.mjs` | 40 / 40 |
| `server/verify.ts --offline` | 74 / 74 |

`server/verify.ts` without `--offline` writes to GitHub on a throwaway
branch and was not run in this sweep.
