/**
 * src/cms/assets/harness.tsx
 *
 * WS-6's standalone harness for the picker. No shell, no API, no other
 * workstream: mount the picker, insert some assets, and watch every one of
 * them get validated against WS-0's schema as a real CanvasItem.
 *
 *   node src/cms/assets/build-harness.ts   # bundles to .build/harness.html
 *   open src/cms/assets/.build/harness.html
 */

import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { validateDoc } from '../schema.ts';
import type { CanvasItem } from '../schema.ts';
import AssetPicker from './AssetPicker.tsx';
import { draftFromItem, draftToItem, draftToSpec } from './draft.ts';
import type { ShapeDraft } from './draft.ts';
import { generateShape } from './shapes.ts';

const UI = {
  ink: '#111111',
  muted: '#6b6b6b',
  faint: '#9a9a9a',
  rule: '#e4e4e4',
  wash: '#fafafa',
  green: '#5cb98a',
  accent: '#ff5722',
  sans: "'Inter', system-ui, -apple-system, sans-serif",
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

/** Wraps the placed items in a document so the real validator can judge them. */
function validate(items: CanvasItem[]): { ok: boolean; detail: string } {
  const result = validateDoc({
    version: 1,
    meta: { title: 'Harness', slug: 'harness', date: '2026-10-08' },
    bands: [{ id: 'b_harness', type: 'canvas', height: 800, items }],
  });
  return result.ok
    ? { ok: true, detail: `${items.length} item${items.length === 1 ? '' : 's'} validate` }
    : { ok: false, detail: result.issues.map((issue) => `${issue.path}: ${issue.message}`).join(' · ') };
}

function App() {
  const [items, setItems] = useState<CanvasItem[]>([]);
  const [live, setLive] = useState<ShapeDraft | null>(null);

  const place = (draft: ShapeDraft): void => {
    setItems((current) => [
      draftToItem(draft, { x: 40 + current.length * 24, y: 40, z: current.length }),
      ...current,
    ]);
  };

  const status = validate(items);

  return (
    <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start' }}>
      <div style={{ width: 340, flex: '0 0 auto' }}>
        <AssetPicker onInsert={place} onChange={setLive} onCancel={() => setItems([])} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          id="status"
          style={{
            fontFamily: UI.mono,
            fontSize: 12,
            padding: '10px 12px',
            borderRadius: 6,
            border: `1px solid ${status.ok ? UI.rule : UI.accent}`,
            background: status.ok ? UI.wash : '#fff4f0',
            color: status.ok ? UI.ink : UI.accent,
            marginBottom: 18,
          }}
        >
          {items.length === 0
            ? 'validateDoc: nothing placed yet. Insert an asset.'
            : `validateDoc: ${status.ok ? 'ok' : 'FAILED'} — ${status.detail}`}
        </div>

        {live !== null ? (
          <div style={{ marginBottom: 22 }}>
            <div style={{ fontFamily: UI.mono, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: UI.faint, marginBottom: 8 }}>
              Live draft, as generateShape sees it
            </div>
            <pre
              id="live-spec"
              style={{
                fontFamily: UI.mono,
                fontSize: 11,
                color: UI.muted,
                background: UI.wash,
                border: `1px solid ${UI.rule}`,
                borderRadius: 6,
                padding: 10,
                margin: 0,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
              }}
            >
              {JSON.stringify(draftToSpec(live))}
            </pre>
          </div>
        ) : null}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
          {items.map((item) => {
            // item -> draft -> spec -> svg, the same round trip WS-4 will make
            // when it reopens the picker on something already on the canvas.
            const back = draftFromItem(item);
            if (back === null) return null;
            const shrink = Math.min(1, 300 / item.w);
            return (
              <figure key={item.id} style={{ margin: 0 }}>
                <div
                  style={{
                    width: Math.round(item.w * shrink),
                    height: Math.round(item.h * shrink),
                    outline: `1px dashed ${UI.rule}`,
                    lineHeight: 0,
                  }}
                  dangerouslySetInnerHTML={{ __html: generateShape(draftToSpec(back)) }}
                />
                <figcaption style={{ fontFamily: UI.mono, fontSize: 10, color: UI.faint, marginTop: 6 }}>
                  {item.id} · {item.shape} {item.w}x{item.h}
                </figcaption>
              </figure>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const host = document.getElementById('root');
if (host !== null) createRoot(host).render(<App />);
