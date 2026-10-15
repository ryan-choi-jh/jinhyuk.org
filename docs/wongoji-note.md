# 원고지 note: homepage annotation (implementation handoff)

Status: built and shipped 2026-10-15. Section 10 lists where the build departs from this spec. Visual source of truth is the Paper file **Personal Site → page "Homepage"**, artboards:

| Artboard | Shows |
| --- | --- |
| `원고지 note · 1 Writing on (t ≈ 0.7s)` | mid-build: grid dimmed, 원 written, 고 half written |
| `원고지 note · 2 Annotated` | **key frame**: the note fully on screen |
| `원고지 note · 3 Into the hint (dismiss +350ms)` | the heading cells mid-flight into the replay hint (onion skins and the dotted path are storyboard only) |
| `원고지 note · 4 Handed back` | resting state after: normal homepage + replay hint |
| `원고지 note · Mobile · annotated` / `· handed back` | phone layout |
| `원고지 note · Motion spec` | timeline + rules (summarised below) |

If the Paper MCP is available, read exact values with `get_jsx` / `get_computed_styles` on those artboards. Everything you need is also written out below, so Paper is optional.

---

## 1. What it is

The homepage hero is an illustrated 원고지 (Korean manuscript paper) grid. Most visitors don't know what the grid is. On a first visit, after a moment, the page explains itself once, then gets out of the way:

1. The drawings and the grid fade back. Three of the grid's cells light up, and 원 · 고 · 지 is handwritten into them in red pen, one syllable per cell.
2. A short note appears under them: what 원고지 is, how Ryan grew up writing on it, and why it fits the site.
3. When it closes (the × button, Esc, a click, scrolling away, or a 12s timer), the body fades and **the three heading cells shrink and fly into a small replay button centered under the sheet**: `[원][고][지] WHAT IS THIS GRID?`. The visitor watches the note turn into the button, so they know how to bring it back.
4. On later visits the note doesn't auto-play. The replay button is simply there.

## 2. Copy (final, from Ryan)

Heading (in cells): **원 고 지** + `won-go-ji`

Body, three paragraphs:

1. Korean manuscript paper. One syllable to a square, spaces included.
2. I learned to write on these as a kid, filling page after page with diary entries. The early ones were mostly drawings. Eventually, the words took over.
3. 원고 (won-go) means *draft*. It felt like a fitting place to begin: a life still being written, one square at a time, with plenty of room for what comes next.

*draft* is italic (only that word; the period after it may sit inside the `<em>`). Ryan dislikes em dashes in copy; don't introduce any.

Replay button label: `WHAT IS THIS GRID?` · close label: `CLOSE` + × icon.

## 3. Where it lives in the code

- `src/pages/index.astro` renders `renderDoc(homeDoc())` and runs `initLightboxes()`.
- `src/cms/render/pages/home.ts` builds the hero: `renderHero` → `.hero` (currently `role="img"`) → `.hero-open` (button) → `.hero-stage` (`container-type: inline-size`) → `.hero-piece` per canvas item, then `.hero-hint`. `heroPiece()` places items with `refPxToPercent` (`REFERENCE_WIDTH = 1344`, in `src/cms/schema.ts`): `left/width` in %, `top` in `cqw`.
- Hero items come from `src/content/pages/home.json`, band `b_hero`. The grid is **its own item** (`i_grid`, `x 0, y 48, 1344×732`), so it can be dimmed by itself. Subjects that stay in full color: `i_01_first_swing`, `i_brush_choi`, `i_brush_jin`, `i_brush_hyeok`.
- Styles: `src/styles/global.css` (`.hero*`, `.hero-hint`, the `(pointer: coarse), (max-width: 1024px)` media query, `prefers-reduced-motion` block, dark tokens on `:root[data-theme='dark']`).
- Lightbox wiring: `src/cms/render/lightbox.ts` (`initHeroLightbox`, `CAN_ZOOM` query). On desktop the hero click is inert; on touch/≤1024px a tap opens the lightbox.
- Fonts: the Google Fonts `<link>` in `src/layouts/Base.astro`. localStorage pattern (wrapped in try/catch): the theme script in the same file.

## 4. Visual spec

All coordinates are in **stage space** (1344 wide; the grid's top-left is at `x 0, y 48`). Convert with `refPxToPercent` exactly like `heroPiece` does, so the note scales with the grid.

### Note (desktop overlay)
- Block top-left at **(240, 60)**, so the heading cells land exactly on grid cells: columns 5–7, first row.
- **Heading row**: three 48×48 cells at x 240 / 288 / 336 (size them in `cqw` so they stay locked to the grid: 48/1344 = 3.5714cqw). Each cell is filled `#FFFFFF`, with a 1px `#EE9EA3` border (shared edges, no double lines). The syllable is Nanum Pen Script 54px / line-height 48px, `#D7261E`, centered. Then `won-go-ji` follows: Nanum Pen Script 30px, `#D7261E`, 12px left padding, vertically centered on the row.
- **Body**: 10px below the heading row, width 580 (at 1344). Three paragraphs, 10px apart. Inter 400, 16px/24px, letter-spacing −0.01em, color `#1A1A1A`, `word-break: keep-all` (stops 그림일기-style words from splitting), `text-shadow: 0 0 2px #fff, 0 0 4px #fff, 0 0 6px #fff`. Font sizes may clamp (e.g. `clamp(14px, 1.19cqw, 16px)`); the heading cells must not clamp.
- **Close row**: 16px below the body. `CLOSE` + × (10px icon, the same path as the lightbox close), Bricolage Grotesque 500, 10px/16px, +0.08em, `#6B6B6B`, 7px gap. Next to it, 12px away, a 62×2 timer track. The red `#D7261E` bar inside shrinks from 62 to 0 over the hold.
- **The sheet is white in both themes**, so the note uses fixed colors, **not** `var(--ink)`/`var(--muted)` (those flip in dark mode).

### Stepped-back state (while the note is up)
- `i_grid` → opacity **0.38**.
- Every other piece except the four subjects → opacity **0.10** + `filter: grayscale(1)`. This includes `i_11_clapperboard` and `i_08_cricket`.
- Subjects stay at 1.

### Replay button (after)
- Its own element **below `.hero`**, a sibling like `.hero-hint`, centered horizontally, about 10px below the grid's bottom edge (stage y ≈ 790). It's a real `<button>` with a tap target ≥ 44px.
- Content: three 20×20 cells (1px `#F3B9BC` borders, `#FFFFFF` fill, Nanum Pen Script 22px/20px `#D7261E`), a 10px gap, then `WHAT IS THIS GRID?` in Bricolage Grotesque 500 11px/16px +0.08em `var(--muted)`.
- It sits on the page background, so in dark mode the cells keep their white fill (a scrap of the sheet) and the label uses `--muted`.
- Hover: the label turns `#D7261E`.
- Rendered hidden by default; JS reveals it. With no JS, there's no button and no note.

### Mobile / caption mode — `(pointer: coarse), (max-width: 1024px)` (same as `CAN_ZOOM`)
- No overlay on the grid (cells are ~12px there). The grid and pieces still step back exactly as on desktop.
- A **caption** opens under the sheet in place of the hint row, expanding from 0 height over 300ms (the `grid-template-rows: 0fr → 1fr` trick). Padding 16px 24px. Heading: 30px cells (34px glyphs) + `won-go-ji` 24px. Body: Inter 400 14px/22px, 8px between paragraphs, the same copy. Then the same close row.
- After: one centered row with `TAP THE GRID TO ENLARGE` · a 1×10px `#E4E4E4` rule · the replay button (16px cells, 18px glyphs, 8px label to match the existing hint). 14px gaps.

## 5. Motion spec

Easing is `cubic-bezier(.65,0,.35,1)` unless noted. Times are from the trigger.

**Build (≈1.4s)**
| t | What |
| --- | --- |
| 0–500ms | grid → 0.38; pieces → 0.10 + grayscale (ease-out). The three heading cells' outlines + white fill fade in |
| 300–780ms | 원, 고, 지 write on: `clip-path: inset(0 100% 0 0) → inset(0 0 0 0)`, 120ms each, 60ms apart |
| ~780ms | `won-go-ji` fades in (200ms) |
| 900–1400ms | the three paragraphs, then the close row: opacity 0 → 1, translateY 6px → 0, 300ms each, 60ms stagger |

**Hold**: 12s. The red timer bar shrinks linearly. The timer **pauses** while the pointer is over the hero or note, or focus is inside the note, and resumes when it leaves.

**Close (≈1s)**, the same for every way out:
| t | What |
| --- | --- |
| 0–200ms | body, close row and `won-go-ji` fade out |
| 100–700ms | **the heading cells fly into the replay button's cells** (FLIP: measure both rects, animate translate + scale 1 → 20/48 on a slight curve; animate x and y on separate nested wrappers with different easings, e.g. x ease-in, y ease-out, so the path arcs). `cubic-bezier(.5,0,.2,1)` |
| 200–800ms | grid and pieces return to full, staggered left to right by each piece's x (delay ≈ x/1344 × 200ms) |
| 400–700ms | button label fades in; on landing the flying cells are swapped for the real button's cells |
| 700–1000ms | a 1.5px red underline draws under the label (scaleX 0→1 from the left), holds ~1.2s, then fades. **This only happens on the collapse**, not on later page loads |

**Replay** (button click): the reverse. The button's cells fly up to the heading position, the stage steps back at the same time, then the body and close row build as above. The button hides while the note is open.

**Reduced motion** (`prefers-reduced-motion: reduce`): no write-on, no flight, no stagger. The note and the stepped-back state appear in one 200ms fade; on close everything fades back and the button fades in.

## 6. Behaviour rules

- **First visit only**: key `wongoji-note-seen` in localStorage, read and written inside try/catch like the theme code. Set it when the note **starts** playing. If storage throws (private mode), treat it as a first visit: the note plays and the button still works.
- **Trigger** (first visit), whichever comes first:
  - 3s after the hero is ≥ 50% in view (IntersectionObserver; the clock pauses while it isn't), or
  - desktop only: the pointer resting on the grid for 600ms.
  - Caption mode uses the 3s rule only.
- **Return visits**: no auto-play; the replay button is visible from page load.
- **Dismiss**: CLOSE ×, Esc, a click anywhere on the sheet (desktop), the hold ending, or the hero dropping below 50% visible. If it closes by scrolling away, skip the flight (the button may be off screen): just fade and show the button.
- **Lightbox (touch)**: a tap on the grid still opens the lightbox and never starts the note. If the note is open when the lightbox opens, close the note instantly, with no flight.
- Don't move focus when the note auto-appears. It must not trap focus. Tab reaches CLOSE.

## 7. Implementation notes and gotchas

1. **Accessibility structure.** `.hero` is currently `role="img"`, and `role="img"` makes its descendants presentational, so a note inside `.hero` would be invisible to screen readers. Recommended:
   - Move `role="img"` + the `aria-label` from `.hero` onto `.hero-stage`, and make `.hero` a plain `position: relative` container.
   - Render the note as a sibling of `.hero-open` inside `.hero`, in its own absolutely positioned layer (`inset: 0` over the stage area, `container-type: inline-size` so `cqw` resolves against the stage width, `pointer-events: none` except on the note).
   - Make the note an `<aside aria-labelledby=…>` with real text.
   - Keep the lightbox's focus return (`returnFocusTo: () => hero`) working. `.hero` keeps `tabindex="-1"`.
2. **Don't render the note into the lightbox.** `renderHeroLightbox` reuses `heroStage`; keep the note out of the stage markup.
3. **Clipping.** `.hero` has `clip-path: inset(0 -100vmax)`, which clips anything that leaves it vertically. The flight goes from inside `.hero` to the button below it, so animate a **`position: fixed` clone** of the three cells appended to `<body>`, then remove it.
4. **Markup.** Mark pieces with `data-item="<id>"` in `heroPiece` so CSS/JS can tell the grid, the subjects and the rest apart. Drive the states with classes on `.hero` (e.g. `is-noting`, `is-returning`) rather than inline styles per piece.
5. **Fonts** (`Base.astro`):
   - Add a separate `<link>` for `Nanum Pen Script` with a `text=` subset covering `원고지won-gji` (URL-encoded) and `display=swap`.
   - Add **Inter italic 400** (`1,400`) to the existing Inter request. Today only `1,300` loads, so *draft* would be synthesized.
6. **Where the copy lives.** Put it in one module, e.g. `src/cms/render/pages/home-note.ts`, exporting the copy and the markup builder; add the browser behaviour as `initHomeNote()` next to `initLightboxes()` in `index.astro`. Making the copy editable in the CMS (home.json) is a nice follow-up; it's not required here, so don't change the doc schema for it.
7. **The editor uses the same renderer.** The CMS editor (Vercel) previews the homepage through `renderHome` too. The note markup must therefore be inert and hidden without the site's script (hidden by default, revealed only by `initHomeNote()`), so the editor preview looks exactly as it does today. Check it.
8. Repo rules that apply here (from `AGENTS.md` / `cms/AGENTS.md`):
   - The renderer must never throw.
   - Everything in the output goes through `escape.ts`.
   - **Never hand-edit `src/content/pages/**`.** Read the item ids from `home.json`; don't change it.
   - Relative imports with `.ts` extensions, `import type` for types.
   - Measure, don't assert: verify alignment with `getBoundingClientRect` in a real browser, not by reading CSS.
9. Match the repo's style: long explanatory block comments that say *why*, as in `home.ts` and `lightbox.ts`. Nothing here needs a dependency.

## 8. Verification

- `npm run build` and `npm run cms:check` pass, plus the "before you say you are done" list in `cms/AGENTS.md` §9 (at minimum `node src/cms/fixtures/verify.ts`, `node src/cms/render/selftest.ts`, and `node src/cms/app/shell/verify-typography.mjs`, since this touches CSS). All 27 suites passed on 2026-10-13, so any failure is from this change.
- Prefix `git` and `node` with `DEVELOPER_DIR=/Library/Developer/CommandLineTools` on this machine.
- **Measure the alignment**: in the browser at 1440px, the three heading cells' `getBoundingClientRect()` should coincide with the grid cells at columns 5–7, first row (to within 1px), and still do at 1100px wide.
- `npm run dev` → http://localhost:4321/ and check:
  - **1440px, first visit** (clear `wongoji-note-seen`): auto-plays at 3s; hover-to-trigger works; the build matches artboards 1 → 2; the hold timer pauses on hover; every dismiss path ends in the flight into the button (artboard 3) and the resting state matches artboard 4; the replay button replays.
  - **Reload**: no auto-play, and the button is present.
  - **390px / touch emulation**: caption mode matches the two mobile artboards; a tap on the grid opens the lightbox and doesn't start the note.
  - **Dark mode**: the note stays readable on the white sheet; the button reads on the dark page.
  - **Reduced motion** (DevTools emulation): fades only.
  - **Keyboard**: Esc closes; Tab reaches CLOSE and the replay button; focus is never stolen.
  - **Screen reader / accessibility tree**: the illustration is announced once, and the note text is reachable.
  - **localStorage blocked**: no errors.
- Screenshot desktop and mobile states next to the Paper artboards.

## 9. Out of scope, and git

Out of scope: making the copy editable in the CMS, any change to the illustration pieces themselves, and deploying.

Git: work on a branch (e.g. `wongoji-note`). **Never commit or push without Ryan asking**: a commit to `main` deploys jinhyuk.org. Ryan edits through the CMS while you work, so `main` moves often (`CMS: …` commits). Before rebasing, check for file overlap and never resolve a content file in your own favour.

## 10. As built

Where the build departs from the sections above, and why. Each one was measured in a browser.

- **Scrolling away on a phone.** Section 6 closes the note when the hero drops below 50% visible. On a phone the note is a caption UNDER the hero, so a reader scrolling to read it takes the hero below half first: at 390x844, 248px of scroll left 40% of the hero and all of the caption on screen, and the note closed mid-read. In caption mode it closes only when the hero AND the caption are both under 50% visible. Over the grid (desktop) the rule is as written.
- **The caption in dark mode.** The caption sits on the page background, not on the white sheet, so the fixed `#1A1A1A` would vanish on `#0f0f0f`. Under the sheet the text uses `#1A1A1A` in light and `--ink` in dark, and the close row uses `--muted`. Its squares keep a white fill, like the replay button. The overlay on the sheet keeps the fixed colours of section 4.
- **Screen readers.** Chrome does not hide the children of `role="img"` (or of the enlarge `<button>`): before this change the tree read the grid's alt twice and then all 22 scene names. The hero's pieces are now `aria-hidden`, so the illustration is announced once; their alt text stays in the markup for the editor and the lightbox. The heading's three squares are read by Chrome as "원 고 지", three syllables, so they are `aria-hidden` and a visually hidden "원고지" names the note as one word: the landmark is "원고지 won-go-ji".
- **The replay button's place.** In Paper the intro is at the same height with and without the button, so on a desktop it sits in a zero-height row in the gap above `.intro`, its 44px target made from padding and negative margin. Its squares land at stage y 790.
- **Paper's motion-spec notes, where they disagree with this doc:** the doc was followed. The note is outside `.hero-stage` (the lightbox reuses the stage), the copy is in `src/cms/render/pages/home-note.ts` rather than `home.json`, and it plays at 50% in view rather than "fully" (a 789px hero is never fully in view on a laptop screen).
- **Timing.** The build and close follow section 5's numbers exactly. Paper's frames are storyboards: at +350ms the build's drawings are about a third of the way back (section 5 returns them over 200 to 800ms), and at 700ms 원 and 고 are written and 지 is a third written (300, 480, 660ms starts).

The checks: the note section of `src/cms/render/selftest.ts` (the markup, offline) and `src/cms/render/verify-home-note.mjs` (everything in section 8, in a browser, on a real build; registered in `npm run cms:check:browser`).
