# Agent instructions for jinhyuk.org

Ryan Choi's personal site, plus the custom CMS that edits it.

## If you are touching the CMS, read `cms/AGENTS.md` first

**Anything under `src/cms/` means reading [`cms/AGENTS.md`](cms/AGENTS.md)
before you change a line.** It holds the rules the system already keeps and
the specific ways people have broken it: what `schema.ts` owns, why one prose
block is exactly one ProseMirror node, the mirrored-CSS pattern and the
backtick trap in it, and the measure-do-not-assert discipline the whole
codebase is built on.

The rest of `cms/` is the documentation for that system:

| File | What it is |
| --- | --- |
| [`cms/README.md`](cms/README.md) | Index, what each of the 31 checks is for, and how to run them |
| [`cms/workflow.md`](cms/workflow.md) | How the editor works, end to end, as flowcharts |
| [`cms/consistency.md`](cms/consistency.md) | Where the editor and the published page disagree, measured |

## Hard rules

1. **Never commit or push without being asked.** A commit to `main` deploys
   the live site.
2. **Never hand-edit `src/content/pages/**` or `src/content/data/*.json`.**
   Those are published pages, written by the CMS. Test against
   `src/cms/fixtures/` instead.
3. **Never delete a file without confirming first.**
4. **Never modify `.env*` or put a secret in the repository.**
5. **Measure before you claim.** Numbers from a run, not inference from
   reading a stylesheet. `cms/AGENTS.md` section 5 says why, with the cases
   that taught it.

## The shape of the repository

```
src/cms/          the CMS: schema, renderer, server, editor app, preview
src/pages/        the site's Astro routes; they read through src/lib/site-content.ts
src/content/      the content, as JSON, written by the CMS
src/styles/       global.css: the site's tokens and base typography
docs/             the original CMS briefs and contracts
cms/              documentation for the CMS (this folder's companion)
```

Two deployments out of one repository:

- **the site**: `astro build`, static, GitHub Pages, <https://jinhyuk.org>
- **the editor**: `PUBLIC_EDITOR_BUILD=1 astro build`, server, Vercel,
  <https://jinhyuk-editor.vercel.app>

The editor commits to `main`, and that commit is what rebuilds the site. Git
is the whole interface between the two.

## Conventions

- Imports are relative and carry the `.ts` extension. There are no path
  aliases. `verbatimModuleSyntax` is on, so type-only imports say
  `import type`.
- Comments explain **why**, at length, and name the thing that went wrong if
  something did. Match the density of the file you are in.
- Prose written for the owner avoids em dashes.
- On this machine, prefix `git` and `node` with
  `DEVELOPER_DIR=/Library/Developer/CommandLineTools` until the Xcode licence
  is accepted.
