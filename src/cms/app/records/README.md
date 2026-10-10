# WS-E — record editors

Films and albums are records, not pages, so they get typed forms with good
media handling rather than a canvas (`docs/cms-sections.md` §2, §5).

```
src/cms/app/records/
  index.ts          the public surface; import from here and nowhere else
  RecordEditor.tsx  dispatches on section.records.key -> film | album
  FilmEditor.tsx    paste a YouTube URL, see the film, choose a poster frame
  AlbumEditor.tsx   title/slug/year/summary + the photo grid
  PhotoGrid.tsx     drag to reorder, cover star, per-tile alt and caption
  fields.tsx        form primitives (components)
  field-plan.ts     which control a RecordField gets; the exhaustive switch
  film-edits.ts     pure Film -> Film
  album-edits.ts    pure Album -> Album
  uploads.ts        the upload queue as pure data
  use-uploads.ts    the only file here that starts anything asynchronous
  styles.ts         the stylesheet, as a string
  verify.ts         node-only proof of the editing logic
  harness/          the real components in headless Chrome, with a fake upload
```

## Using them

```tsx
import { RecordEditor } from '../records/index.ts';

<RecordEditor
  section={section}                 // RecordSectionDef from src/cms/sections.ts
  record={entry}                    // Film | Album
  onChange={(next) => save(next)}   // a whole new record, on every edit
  uploadMedia={(file) => api.uploadMedia(section.id, key, file)}
/>;
```

`FilmEditor` and `AlbumEditor` are exported too, for a caller that already
knows which one it wants.

### The contract

- **Pure editing.** Nothing here fetches. `onChange` is called with a whole,
  canonical record — keys in schema order, empty optionals absent — and the
  caller decides what to do with it. Putting it back in the collection is
  `section.records.withEntries(file, entries.with(index, next))`, then
  `validateFile`, then `PUT /api/cms/records/:section`
  (`docs/cms-contracts.md` §9.4, §11).
- **`uploadMedia` is the only seam on the outside world.**
  `(file: File, options?: { onProgress?, signal? }) => Promise<{ src, w?, h? }>`.
  `MediaUpload` from `src/cms/server/client.ts` already satisfies it. The
  section and slug are bound by the caller; a record editor edits one record
  and does not know where it lives.
- **The fields come from the registry.** `section.records.fields` decides what
  is drawn and in what order; `field-plan.ts` switches exhaustively over
  `RecordFieldType`, so adding a type to `src/cms/sections.ts` is a compile
  error here rather than a field that quietly disappears.
- **The record never goes invalid mid-edit.** A half-typed YouTube URL stays in
  the component's own state; deleting the cover photo clears `cover` in the
  same edit; `w`/`h` are written as a pair or not at all.

### Props both editors take

| prop | required | what it is |
|---|---|---|
| `record` | yes | the `Film` or `Album` being edited |
| `onChange` | yes | called with the whole new record |
| `uploadMedia` | yes | see above |
| `fields` | no | defaults to the registry's |
| `resolveMediaSrc` | no | map a stored `src` to something loadable (the harness points `/media/...` at `file://`) |
| `disabled` | no | everything read-only while saving |
| `onNotice` | no | `(level, message)` for the shell's notice line |
| `headerExtra` | no | controls for the editor's header, e.g. a save button |

## Proving it

```
node src/cms/app/records/verify.ts              # the logic, under bare node
node src/cms/app/records/harness/drive.mjs      # the components, in Chrome
```

The second builds `harness/.out/harness.html`, opens it over `file://`, drives
the real editors with synthesised input (typing, a seven-file selection, a
pointer drag, clicks), asserts the emitted JSON, writes screenshots to
`harness/.out/shots/`, and ends by asserting the request log: no API call was
made, and the only network URL in the whole run is the YouTube embed, which the
run blocks.
