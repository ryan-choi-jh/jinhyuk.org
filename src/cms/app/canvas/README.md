# WS-4 — Canvas interaction

`<CanvasEditor>`: direct manipulation of one canvas band's items. Move, resize
from any corner, rotate, restack, multi-select, nudge, snap. Pure interaction —
it fetches nothing, knows nothing about bands beyond `items` and `height`, and
does not style the page.

Owned files: `src/cms/app/canvas/**`. Nothing else is touched.

## Using it

```tsx
import { CanvasEditor } from '../canvas/index.ts';

<CanvasEditor
  items={band.items}              // CanvasItem[] from src/cms/schema.ts
  height={band.height}            // the band's coordinate box, reference px
  scale={stageScale}              // 1 = actual size
  onChange={(items, meta) => ...} // meta.transient is true inside a drag
  renderShape={(item) => {        // WS-6; omit and a documented stand-in draws
    const spec = shapeSpecFromItem(item);
    return spec === null ? null : generateShape(spec);
  }}
/>
```

The stage is laid out at `REFERENCE_WIDTH` (1344) and scaled by `scale`.
**By default this component applies that transform itself**, so the parent
passes the number and does not scale it. If an ancestor already scales the
whole page, pass `applyTransform={false}` and keep passing the same `scale`,
because the pointer maths still needs it. Both modes are verified.

Other props: `selection` / `onSelectionChange` (controlled selection),
`snapEnabled`, `snapThreshold` (screen px), `readOnly`, `className`.

`onChange` fires on every frame of a drag with `meta.transient === true`, then
once more at the end with `transient: false`. An undo stack should coalesce the
transient ones and push a single entry on the commit.

## Controls

| | |
|---|---|
| drag | move |
| corner handle | resize, `shift` keeps the ratio |
| top handle | rotate about the centre, `shift` snaps to 15° |
| shift-click | add to / remove from the selection |
| drag empty space | marquee, `shift` adds to the selection |
| arrows | nudge 1px, `shift` 10px |
| `alt` while dragging | suspend snapping |
| `shift` while dragging | lock to one axis |
| `[` `]` | send backward / bring forward, with `cmd` to back / front |
| `delete` | remove the selection |
| `cmd-a` / `esc` | select all / abandon a drag, then clear the selection |

## Verifying it, alone

Two halves. Both run with no shell, no API and nothing installed.

```bash
node src/cms/app/canvas/verify-geometry.ts            # 196 checks, bare node
node src/cms/app/canvas/harness/verify-browser.mjs    #  70 checks, Chromium
```

`verify-geometry.ts` drives the real gesture functions from real client
coordinates through a faked stage rect and asserts exact numbers.
`verify-browser.mjs` builds the harness, serves it on 127.0.0.1, and drives the
component itself with real pointer input, leaving screenshots in
`harness/.out/screens/`.

Every gesture is checked at scale 1.00 and 0.70 two ways: the same drag
expressed in **reference** px must give identical numbers at both scales, and
the same drag expressed in **screen** px must differ by exactly `1 / scale`.
That is the drift bug the brief warns about, from both sides.

To drive it by hand:

```bash
node src/cms/app/canvas/harness/server.mjs            # builds, then serves
```

## Shape of the code

| File | What it is |
|---|---|
| `geometry.ts` | Pure maths. Scale conversion, rotation, resize about a pinned corner, rounding. |
| `snap.ts` | Pure snapping. Targets, the chosen offset, and the guides that became true. |
| `items.ts` | Pure operations on a `CanvasItem[]`. Nudge, delete, z-order. |
| `interaction.ts` | The gesture state machine. Pure, reference px only, no DOM. |
| `CanvasEditor.tsx` | The React component: pointer and keyboard plumbing, selection, chrome. |
| `shape-fallback.ts` | A documented stand-in for WS-6's generator. Replaced by `renderShape`. |
| `harness/` | The standalone page and its two verification scripts. |

Three invariants worth keeping:

1. **A pointer number crosses into reference space exactly once**, through
   `clientToRef`, which divides by the scale. Nothing downstream knows the
   scale except the snap radius and the on-screen handle size, which are
   screen-px quantities on purpose.
2. **Every frame of a gesture is computed from the gesture's start state plus
   the current pointer**, never from the previous frame, so a long drag cannot
   accumulate error and releasing a modifier undoes its effect.
3. **The items array is never reordered.** Document order is what the renderer
   stacks from below 900px (`docs/cms-rebuild.md` 3.4); stacking is `z` only,
   normalised to a contiguous `0..n-1` so it cannot grow without bound.
