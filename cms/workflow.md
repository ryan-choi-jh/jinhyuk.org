# How the editor works

Four views of the same machine: what you do, what the screen is made of, where
a keystroke ends up, and what happens between Publish and the live page.

The diagrams are Mermaid. GitHub renders them in place. In VS Code you need a
Mermaid preview extension, or read the labelled prose under each one, which
says the same thing.

---

## 1. The UX flow

What you actually do, from opening the editor to seeing the change on
jinhyuk.org.

```mermaid
flowchart TD
    A([Open jinhyuk-editor.vercel.app/cms]) --> B{Signed in<br/>to GitHub?}
    B -- no --> B1[Sign in to GitHub<br/>OAuth, sets a session cookie] --> C
    B -- yes --> C[Sidebar: five sections]

    C --> D{Which section?}
    D -- Home --> E1[Straight into the page editor<br/>it is a singleton]
    D -- Projects / Essays --> E2[List of entries<br/>+ New, Duplicate]
    D -- Filmography / Photography --> E3[List of records<br/>+ New, Duplicate, Delete, Reorder]

    E2 --> F1[Page editor]
    E1 --> F1
    E3 --> F2[Record editor<br/>typed fields + uploads]

    F1 --> G[Three panes:<br/>outline, page surface, inspector]
    G --> H1[Edit text in place<br/>TipTap, one editor per block]
    G --> H2[Drag, resize, rotate on a canvas band<br/>upload by drag-and-drop]
    G --> H3[Edit title, date, summary, link,<br/>space above a block,<br/>hidden, buttons in the inspector]

    H1 --> I[Save draft<br/>⌘S, or the button]
    H2 --> I
    H3 --> I
    F2 --> I

    I --> J{Happy?}
    J -- not yet --> K[Preview, or Phone<br/>real renderer, real CSS,<br/>a real iframe at 390] --> G
    J -- yes --> L[Publish]
    L --> CL{Anything<br/>worth a look?}
    CL -- yes --> CL2[The checklist: missing alt text,<br/>empty rows, dead links] --> L2[Publish anyway]
    CL -- no --> L2

    L2 --> M[Deploy chip starts watching]
    M --> N{State}
    N -- queued / building --> M
    N -- live --> O([The page is on jinhyuk.org<br/>chip links to it])
    N -- failed --> P[Chip links to the failed Actions run]

    style O fill:#e8f5e9,stroke:#2e7d52
    style P fill:#fdeef3,stroke:#c0392b
    style L fill:#fdf6e0,stroke:#e8d79a
```

Two things that are easy to miss from the picture:

- **The body size is a setting, under Home.** One number, applied to whichever
  sections you tick, with the scale and the affected pages shown before you
  apply. See section 4b.
- **A whole essay can be pasted in at once.** Copy from Notion, Docs or a
  web page and paste into a text block: headings, paragraphs, lists and
  quotes arrive as separate blocks, in order, with bold, italics, colour and
  links intact. An empty block is replaced; a block with text in it keeps its
  text and the pasted blocks follow. Images, tables and code blocks have no
  home in a text band, so they are left out and the editor says how many.
- **Save and Publish are different commits.** Save writes a working copy under
  `src/content/drafts/`, which the site build ignores and which no longer
  triggers a deploy. Publish moves that file into `src/content/pages/` and
  deletes the draft. You cannot publish something you have not saved, and
  Publish saves for you if you forgot.
- **Publish asks once** when the page has something worth knowing about:
  an image with no alt text, empty rows, a link into the editor. Warnings,
  never a block; a clean page publishes on the first press.
- **Unsaved work is copied into this browser** on a debounce and offered
  back if the tab dies. It is never sent anywhere, and it is offered, never
  applied.
- **Dark mode is on the surface; phone width is only in Preview.** The mobile
  rules are viewport media queries, so a narrowed surface cannot fire them.
  The "Phone" button opens the preview at 390 in a real iframe.
- **A page can be taken off the site without deleting it** (`hidden` in the
  inspector): no page is built at its address, and it stays here, editable.
- **A page can be renamed or deleted** from the entry list. A rename moves
  the file, its draft and `meta.slug` in one commit, and leaves the old
  address redirecting.

---

## 2. What the screen is made of

```mermaid
flowchart LR
    subgraph Site["/cms &nbsp;&nbsp;SiteShell"]
        direction TB
        SB[Section rail<br/>Home · Projects · Essays<br/>Filmography · Photography]
        EL[Entry list]
        subgraph Doc["EditorShell &nbsp;· home, projects, essays"]
            direction LR
            OL[Outline<br/>bands and blocks<br/>add, reorder, delete]
            PS[Page surface<br/>the page, to scale<br/>nav and footer drawn around it]
            IN[Inspector<br/>page details, band settings,<br/>item geometry, Add panel]
        end
        subgraph Rec["RecordEditor &nbsp;· filmography, photography"]
            direction LR
            RF[Typed fields]
            RU[Uploads with progress]
        end
        TB[Toolbar<br/>Save · Publish · Preview · Undo<br/>deploy chip · who is signed in]
    end
    SB --> EL --> Doc
    SB --> EL --> Rec
    Doc --- TB
    Rec --- TB
```

The page surface is the part that matters most and the part most likely to
lie. It draws the page with the **real renderer** (`renderDoc`) and a
**mirrored copy** of the page's typography (`SHELL_CSS`, not `doc.css`). That
mirror is where every editor-versus-site drift has come from. See
[`consistency.md`](consistency.md).

---

## 3. Where a keystroke ends up

```mermaid
flowchart TD
    K([You type a character]) --> TT[TipTap / ProseMirror<br/>one editor per block]
    TT --> NB["blockFromDoc + normalizeProseContent<br/>src/cms/app/prose/block.ts<br/><i>coerces to the exact stored shape</i>"]
    NB --> SL["ProseSlot onChange<br/>src/cms/app/index.tsx"]
    SL --> UP["store.update(replaceProseBlock)<br/>one undo step, coalesced by block id"]
    UP --> ST[("DocStore<br/>doc · selection · dirty<br/>undo / redo")]
    ST --> SF[Page surface re-renders]
    ST --> OUT[Outline and inspector re-render]

    ST -. Save .-> V{validateDoc}
    V -- fails --> VN[Red notice, nothing written]
    V -- passes --> API["PUT /api/cms/draft/&lt;section&gt;/&lt;slug&gt;<br/>If-Match: blob sha"]
    API --> SRV["server/store.ts<br/>validates AGAIN, checks slug and section<br/>match the path"]
    SRV --> GH["GitHub contents API<br/>commit on main"]
    GH --> DR[/"src/content/drafts/pages/&lt;section&gt;/&lt;slug&gt;.json"/]

    ST -. Publish .-> PUB["POST /api/cms/publish/&lt;section&gt;/&lt;slug&gt;"]
    PUB --> MV["read the draft, write it to the published path,<br/>delete the draft &nbsp;(one or two commits)"]
    MV --> PP[/"src/content/pages/&lt;section&gt;/&lt;slug&gt;.json"/]

    style VN fill:#fdeef3,stroke:#c0392b
    style PP fill:#e8f5e9,stroke:#2e7d52
```

Four invariants worth knowing by heart:

1. **One ProseBlock is one top-level node.** A paragraph block's ProseMirror
   schema literally has no heading, no list and no blockquote in it. That is
   why Enter has to be caught and turned into "cut this block in two" rather
   than left to make a second paragraph.
2. **The document is validated twice**, once in the browser before the request
   and once on the server before the commit, against the same `schema.ts`. A
   draft on disk is always loadable.
3. **Every write carries the blob sha it expects.** A second tab that saved
   first gets you a 409 with an explanation, not a silent overwrite.
4. **Editor state never enters the document.** Selection, hover, zoom and
   drag deltas live in the store. Every schema object is `.strict()`, so a
   stray key is a validation error rather than something that quietly ships.

---

## 4. Publish to live

```mermaid
flowchart TD
    P([Publish]) --> C1[Commit on main]
    C1 --> GA{{"GitHub Actions: Deploy to GitHub Pages<br/>no path filter, so EVERY push rebuilds<br/>concurrency: cancel-in-progress"}}
    GA --> BUILD[astro build, static output]
    BUILD --> PAGES[Pages artefact uploaded and deployed]
    PAGES --> CDN[(jinhyuk.org)]

    C1 -.-> CHIP[Deploy chip polls<br/>GET /api/cms/deploy?commit=...]
    CHIP --> Q1{Workflow run<br/>for this commit?}
    CHIP --> Q2["Fetch jinhyuk.org/?nonce<br/>read &lt;meta name=build-rev&gt;"]
    Q2 --> Q3{"Does the live build contain<br/>the publish commit?"}
    Q3 -- yes --> LIVE([live])
    Q3 -- no --> Q1
    Q1 -- none yet --> QUEUED([queued])
    Q1 -- in progress --> BUILDING([building])
    Q1 -- cancelled --> SUP([superseded<br/>a newer publish carries it])
    Q1 -- failure --> FAIL([failed])

    style LIVE fill:#e8f5e9,stroke:#2e7d52
    style FAIL fill:#fdeef3,stroke:#c0392b
```

The chip trusts the **live page**, not the green tick. A finished run means
Pages accepted the artefact; it does not mean the CDN is handing it to you.
So every page carries `<meta name="build-rev">` with the commit it was built
from, and a publish is live when the page being served was built from that
commit or from something after it. "Or after it" is what stops two quick
publishes in a row reading as a failure, since the first run gets cancelled
and its content rides along in the second.

**A draft save no longer triggers a rebuild.** The workflow ignores a push
that only touches `src/content/drafts/`, so saving a working copy costs
nothing. Publishing touches the published tree in the same commit, so it
still builds.

---

## 4b. Changing the body size

The one setting that changes every page at once, so it is the one that shows
you what it will do before it does it.

```mermaid
flowchart TD
    A([Home → inspector → Body size]) --> B[Step the number<br/>17.5 → 16]
    B --> C[The sample, the scale table<br/>and the per-section rows<br/><i>nothing has changed yet</i>]
    C --> D{Tick the sections}
    D --> E["Apply 16px to 2 sections"]
    E --> F[["applyBodySize<br/>src/cms/app/chrome/edits.ts"]]
    F --> G[("site.json → type<br/>{ size, sections }")]

    G --> H[The page in the middle repaints<br/>EDITOR_DIALECT, injected live]
    G --> I[Save draft → Publish<br/>same path as the nav and footer]
    I --> J[[Base.astro<br/>sectionForPath → body data-section<br/>typeScaleCss SITE_DIALECT]]
    J --> K([Only those sections are smaller<br/>on jinhyuk.org])

    F -. "unticked sections" .-> L([Untouched. Not reset, not mentioned])

    style C fill:#fdf6e0,stroke:#e8d79a
    style K fill:#e8f5e9,stroke:#2e7d52
    style L fill:#e8f5e9,stroke:#2e7d52
```

**One generator, two dialects.** `src/cms/styles/type-scale.ts` holds the base
size of every kind of running text and scales them all by one ratio. The site
gets selectors scoped by `body[data-section='…']`; the editor gets the same
roles under `.cms-surface--…`, because the editor does not load `doc.css` and
names the same things differently. They cannot produce different numbers,
because they call one function, and
`styles/verify-type-scale-browser.mjs` measures both in a browser to prove the
rules actually land.

**What moves:** paragraphs, list items, quotes and callouts, leading included.
**What does not:** headings, captions, the nav, the footer, buttons.

**Nothing set is nothing generated.** A site at the design's own 17.5px
produces an empty stylesheet and no `type` key in `site.json`, and builds
byte-for-byte what it built before the feature existed.

---

## 5. Where the content lives

| Section | Shape | Editor | Published file | Draft file | Live URL |
| --- | --- | --- | --- | --- | --- |
| Home | singleton | document | `src/content/pages/home.json` | `src/content/drafts/pages/home.json` | `/` |
| Projects | collection | document | `src/content/pages/projects/<slug>.json` | `src/content/drafts/pages/projects/<slug>.json` | `/projects/<slug>/` |
| Essays | collection | document | `src/content/pages/essays/<slug>.json` | same, under `drafts/` | `/essays/<slug>/` |
| Filmography | collection | records | `src/content/data/filmography.json` | same, under `drafts/` | `/filmography/` (no per-film page) |
| Photography | collection | records | `src/content/data/photography.json` | same, under `drafts/` | `/photography/<slug>/` |
| Nav and footer, and body size | one file | chrome panel, under Home | `src/content/data/site.json` | same, under `drafts/` | every page |
| Old addresses | one file | written by a rename | `src/content/data/redirects.json` | n/a | the URLs it lists |

Uploads go to `public/media/<section>/<key>/` and are served at
`/media/<section>/<key>/<file>`.

The draft tree is a literal mirror of the published tree: swap `src/content/`
for `src/content/drafts/` and that is the path. No section has its own rule.

**Two deployments, one repository.**

| | Built with | Output | Where | What it is |
| --- | --- | --- | --- | --- |
| The site | `astro build` | static | GitHub Pages, jinhyuk.org | what readers get |
| The editor | `PUBLIC_EDITOR_BUILD=1 astro build` | server | Vercel, jinhyuk-editor.vercel.app | the CMS, the API routes, the preview |

The editor commits to `main` in `ryan-choi-jh/jinhyuk.org` (override with
`CMS_BRANCH`). That commit is what triggers the site build. The two
deployments never talk to each other; git is the whole interface between
them.
