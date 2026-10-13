# Edge cases worth turning into features

**F2, F8, F9 and most of F10 are done**, because fixing the twenty bugs
needed them: the five dead keys now work and have their own harness, Fit
accounts for rotation, the typography guard covers marks and the masthead,
and all 27 suites are green. What is left below is the work that is still
worth doing, F1 first.

The sweep's findings that are not really bugs. Each one is somewhere the
editor behaves exactly as designed and the design is the problem. Ordered by
how often you will hit it.

Size is a rough half-day unit: **S** is an afternoon, **M** is a day or two,
**L** is a week.

---

## F1. Space between blocks  ·  M  ·  the one that keeps coming up

**The problem.** There is no way to ask for space. The only tool is an empty
row, and an empty row is genuinely unpredictable:

- it is **35px tall in the CMS and 0px on the page**;
- it changes the page in **6 of 36** block pairings, always right after a
  heading, and never by more than 23px;
- **three of them do exactly what one does**, because sibling margins
  collapse into a single gap.

(The full 36-cell measurement is in [`consistency.md`](consistency.md).)

So the mental model everyone brings from a word processor, "press Enter twice
for more air", is not available, and the CMS shows you a blank line that the
reader will never see.

**The fix.** Three parts.

1. **A `space` field on a prose block.** Optional, a closed set, absent means
   today's behaviour: `{ space?: 'none' | 'small' | 'medium' | 'large' }`
   rendered as a class on the block, `doc-space--small` and so on, with the
   values in `doc.css` next to the block margins. Because margins collapse,
   define it as **"the gap above this block is at least N"**, which is both
   what CSS will actually do and what an author means. A number field would
   invite 23px and 24px two paragraphs apart.
2. **The control goes in the inspector**, under the selected block, and in the
   floating toolbar as a single cycling button if that proves too far away.
3. **Stop the editor lying about empty rows.** An empty block gets a quiet
   label in the outline and on the surface saying how much space it actually
   adds on the page, which is usually "none". Plus a "remove empty rows"
   action on the band, so cleaning up a pasted document is one click.

**Why a field and not a spacer block.** A spacer is content with no content:
it needs a kind, a renderer case, a toolbar button, a converter entry and an
outline row, and it can be left behind when the block it was spacing is
deleted. A field travels with the block it belongs to.

---

## F2. Keyboard parity  ·  DONE 2026-10-13

Measured against the real editor. Every one of these is a key that works in
every other editor and does nothing here, because each block is its own
ProseMirror instance pinned to one node.

| Key | Where | What happens now | What should happen |
| --- | --- | --- | --- |
| `Enter` | empty last list item | nothing; you are stuck in the list | end the list, start a paragraph |
| `Delete` | end of a block | nothing | the next block joins this one |
| `ArrowDown` | last line of a block | focus stays put | caret moves into the next block |
| `ArrowUp` | first line of a block | focus stays put | caret moves into the previous block |
| `Cmd-S` | anywhere in a block | the browser's Save-page dialog | save the draft |

All five are small. The machinery already exists: `onSplit`, `onMergeUp` and
the `caretRequests` map in `src/cms/app/index.tsx` are exactly the pattern,
and this adds two more callers of it. Cmd-S is a one-line reorder in
`use-shortcuts.ts`.

Details and file references in [`bugs.md`](bugs.md) B5 to B8.

---

## F3. Nothing saves itself  ·  M

**The problem.** There is no autosave. A draft exists only when you press
Save. Combined with F2's Cmd-S, a browser crash or a closed tab loses
everything since the last deliberate save. The unsaved-changes guard warns
you on the way out, which is the last line of defence, not the first.

Server-side autosave is the wrong answer here: every save is a git commit,
and every commit to `main` triggers a full site rebuild (see F11).

**The fix.** A local snapshot. Write the document to IndexedDB on a short
debounce, keyed by section and entry. On open, if a local snapshot is newer
than what the server returned, show a banner: "You have unsaved changes in
this browser from 11:42. Restore them / Discard them." Never restore
silently, and never send it anywhere.

That also covers the case the guard cannot: a crash, a battery, a closed
laptop.

---

## F4. A pre-publish checklist  ·  S

**The problem.** Publish validates the schema and nothing else. Seven of the
32 published images on the site have no alt text, all on the Track project
page. The field is right there in the inspector; nothing ever mentioned it.

**The fix.** A short list in the Publish button's confirm step, each item
clickable to the thing it is about:

- images with no alt text
- empty rows (and what each one actually does, per F1)
- headings whose ids collide, or which have none (see [`bugs.md`](bugs.md) B3)
- links pointing at a draft, or at a path that is not a page
- a summary or a date left at its placeholder

Warnings, not blocks. Publishing anyway is one more click.

---

## F5. You cannot rename or delete a page  ·  M

**The problem.** The slug field is read-only, deliberately, with a good
explanation: "renaming a page is a move, not an edit". Delete is disabled on
document collections with the reason given in `entry-list.tsx`: the API table
has no endpoint for it. Both are honest, and both mean the CMS cannot finish a
job you started in it.

**The fix.** Two endpoints, each doing the whole job server side so it cannot
half-happen:

- **Rename**: write the new path, delete the old, and leave a redirect so the
  old URL keeps working. `src/pages/writing/[...slug].astro` is already the
  pattern for that.
- **Delete**: remove the published file and the draft, and say in the confirm
  dialog what will 404.

Media under `public/media/<section>/<old-slug>/` moves with the rename, or the
`src`s are rewritten. Whichever, it has to be one commit.

---

## F6. Dark mode and phone width are invisible from the editor  ·  S

**The problem.** The editing surface is always light and always the desktop
measure. Preview has both switches. Nothing makes you go to Preview, so a
colour chosen in the CMS can be unreadable on the dark site and nobody finds
out.

**The fix.** Cheapest version: put the two switches on the surface itself,
reusing Preview's own parameters. They are `data-theme` on the root and a
width on the stage, both of which the surface already has the machinery for.
Failing that, the Publish checklist (F4) gets a "you have not looked at this
in dark mode" line, which is worse but nearly free.

---

## F7. Unused media piles up  ·  mostly DONE 2026-10-13

Deleting an item removes the reference, not the file. There is no delete
endpoint, by design. `public/media/` only grows.

`node src/cms/server/unused-media.mjs` is the report: it reads every
published document and record, collects every `/media/` reference, and lists
what nothing points at, with the `git rm` to remove them. It reads drafts
too, and keeps anything a draft claims, because deleting a file your
unpublished draft needs is the one thing it must never encourage. It also
reports the opposite problem, a reference with no file behind it, which is a
broken image on a live page.

Today it says nothing is unused: four files, 6.4MB, all referenced.

**What is left**, if ever: a button in the CMS. The report is deliberately
not one, and running it before a tidy-up is enough.

---

## F8. Fit crops a rotated item  ·  DONE 2026-10-13

`canvasContentHeight` measures `y + h`. A 400 by 100 item at 90° occupies
400px and it reports 200. Use the rotated bounding box.
[`bugs.md`](bugs.md) B11.

---

## F9. The typography guard only checks block kinds  ·  DONE 2026-10-13

`verify-typography.mjs` compares the editor and the page for paragraph, h2,
h3, quote, callout and lists. It passes, and it still missed two real drifts
this sweep found: bold is 600 in the editor and 400 on the page, and a link
inside a callout is underlined in the wrong grey.

**The fix.** Extend the same harness to marks (`strong`, `em`, `a`, `mark`,
the coloured span) and to the masthead (`.project-link`, `.doc-visit`,
`.lead`). The rig is already built; this is a longer `BLOCKS` array and a
document that contains one of everything.

---

## F10. One command to run the checks  ·  S  ·  the green half is done

**The problem.** Twenty-six suites, invoked by hand, with `npm run cms:verify`
covering one of them. Five are red, and not one of them for a product reason:
stale assertions, a guard that cannot parse `@keyframes`, a harness still
using phase 1 paths, a harness blocked by the welcome overlay, and a pixel
check comparing fixtures against a site whose content has moved on. Details
in [`bugs.md`](bugs.md) B17.

The pattern is the real problem: **everything that runs in ten seconds
passes, and everything slow or awkward to run is broken.** Nobody runs the
slow ones, so nothing they would catch is caught, and the two whole-system
e2e harnesses, the only checks that exercise sign-in through save through
publish, have both been dead for months.

**Step 1 is done.** All five are fixed and all 27 suites pass. The WS-8 e2e
asks the registry for its paths now rather than writing them out, which is
what stops it falling behind again.

**What is left.** Two scripts in `package.json`: `cms:check` for the nine
offline suites, about ten seconds together, and `cms:check:browser` for the
rest. Then CI can run `cms:check` on every push, and red means red.

---

## F11. Saving a draft rebuilds and redeploys the whole site  ·  S

`.github/workflows/deploy.yml` triggers on every push to `main` with no path
filter. A draft save writes `src/content/drafts/…`, which the site build
ignores entirely, and still costs a full build and a Pages deploy. It also
makes the deploy chip report "building" after an action that changed nothing
anyone can see.

**The fix.** `paths-ignore: ['src/content/drafts/**']` on the push trigger.
One line. Worth checking against the chip's `superseded` logic, which exists
precisely because a second push cancels the first run.

---

## F12. Heading links  ·  S

Two headings with the same words get the same `id` today
([`bugs.md`](bugs.md) B3). Once that is fixed, the obvious companion is the
thing the ids are for: a hover affordance on a published heading that copies
its link. The site had those ids before the cutover and nothing has ever
surfaced them.
