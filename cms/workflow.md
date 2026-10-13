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
    G --> H3[Edit title, date, summary, link,<br/>buttons, band settings in the inspector]

    H1 --> I[Save draft]
    H2 --> I
    H3 --> I
    F2 --> I

    I --> J{Happy?}
    J -- not yet --> K[Preview<br/>real renderer, real CSS,<br/>pick a width, pick a theme] --> G
    J -- yes --> L[Publish]

    L --> M[Deploy chip starts watching]
    M --> N{State}
    N -- queued / building --> M
    N -- live --> O([The page is on jinhyuk.org<br/>chip links to it])
    N -- failed --> P[Chip links to the failed Actions run]

    style O fill:#e8f5e9,stroke:#2e7d52
    style P fill:#fdeef3,stroke:#c0392b
    style L fill:#fdf6e0,stroke:#e8d79a
```

Two things that are easy to miss from the picture:

- **Save and Publish are different commits.** Save writes a working copy under
  `src/content/drafts/`, which the site build ignores. Publish moves that file
  into `src/content/pages/` and deletes the draft. You cannot publish something
  you have not saved, and Publish saves for you if you forgot.
- **Preview is the only place you can check dark mode and phone width.** The
  editing surface is always light and always the desktop measure.

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

**A draft save also triggers a full rebuild and deploy.** The workflow has no
path filter, so saving a working copy costs an Actions run that changes
nothing on the site. See [`roadmap.md`](roadmap.md) F11.

---

## 5. Where the content lives

| Section | Shape | Editor | Published file | Draft file | Live URL |
| --- | --- | --- | --- | --- | --- |
| Home | singleton | document | `src/content/pages/home.json` | `src/content/drafts/pages/home.json` | `/` |
| Projects | collection | document | `src/content/pages/projects/<slug>.json` | `src/content/drafts/pages/projects/<slug>.json` | `/projects/<slug>/` |
| Essays | collection | document | `src/content/pages/essays/<slug>.json` | same, under `drafts/` | `/essays/<slug>/` |
| Filmography | collection | records | `src/content/data/filmography.json` | same, under `drafts/` | `/filmography/` (no per-film page) |
| Photography | collection | records | `src/content/data/photography.json` | same, under `drafts/` | `/photography/<slug>/` |
| Nav and footer | one file | chrome panel, under Home | `src/content/data/site.json` | same, under `drafts/` | every page |

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
