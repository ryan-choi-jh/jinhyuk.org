/**
 * src/cms/app/canvas/harness/App.tsx
 *
 * WS-4's standalone harness. No shell, no API, no network: the fixture is
 * inlined at build time by ./build.mjs and the only requests the page makes
 * are for the fixture's own images, served off disk by ./server.mjs.
 *
 * It exists to answer one question honestly: do the numbers that come out of
 * <CanvasEditor> match what the pointer did, at every scale. So the live item
 * JSON sits beside the canvas, the pointer's reference-px position is shown as
 * it moves, and the result is re-validated against the WS-0 schema on every
 * change.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { REFERENCE_WIDTH, validateDoc } from '../../../schema.ts';
import type { CanvasBand, CanvasItem, Doc } from '../../../schema.ts';
import { CanvasEditor } from '../CanvasEditor.tsx';
import type { ChangeMeta } from '../CanvasEditor.tsx';
import { clientToRef } from '../geometry.ts';

/** Injected by ./build.mjs, which reads src/cms/fixtures/dense.json off disk. */
declare const __FIXTURE_JSON__: string;

const fixture = JSON.parse(__FIXTURE_JSON__) as Doc;

/**
 * The harness keeps the WHOLE band list, not just the canvas ones, so the live
 * validation below is validating a real document. Dropping the prose bands
 * would make band 0 an overlay, which the schema rightly rejects.
 */
const canvasIndexes: number[] = fixture.bands
  .map((band, index) => (band.type === 'canvas' ? index : -1))
  .filter((index) => index >= 0);

const SCALES = [1, 0.85, 0.7, 0.5];

type LogEntry = { n: number; reason: string; transient: boolean; ids: number };

export function App() {
  const [bandIndex, setBandIndex] = useState(0);
  const [scale, setScale] = useState(1);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [parentScaled, setParentScaled] = useState(false);
  const [snapThreshold, setSnapThreshold] = useState(6);
  const [bands, setBands] = useState<Doc['bands']>(fixture.bands);
  const [selection, setSelection] = useState<string[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const counter = useRef(0);

  const docIndex = canvasIndexes[bandIndex];
  const band = bands[docIndex] as CanvasBand;

  const onChange = useCallback(
    (items: CanvasItem[], meta: ChangeMeta) => {
      counter.current += 1;
      const n = counter.current;
      setBands((current) =>
        current.map((candidate, index) =>
          index === docIndex && candidate.type === 'canvas' ? { ...candidate, items } : candidate,
        ),
      );
      setLog((current) =>
        [{ n, reason: meta.reason, transient: meta.transient, ids: items.length }, ...current].slice(0, 12),
      );
    },
    [docIndex],
  );

  const reset = useCallback(() => {
    setBands(fixture.bands);
    setSelection([]);
    setLog([]);
    counter.current = 0;
  }, []);

  /** Re-validate on every change: the editor must never emit an invalid band. */
  const validation = useMemo(() => {
    const doc: Doc = { ...fixture, bands };
    const result = validateDoc(doc);
    return result.ok ? { ok: true as const, text: 'valid against src/cms/schema.ts' } : { ok: false as const, text: result.issues.map((i) => `${i.path}: ${i.message}`).join('\n') };
  }, [bands]);

  /* The pointer readout. Proves the client -> reference conversion at a glance:
     at any scale, the number under the cursor is the number the item gets. */
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const stage = document.querySelector('[data-cv-stage]');
      if (stage === null) return;
      const rect = stage.getBoundingClientRect();
      const ref = clientToRef(event.clientX, event.clientY, rect, scale);
      setPointer({ x: Math.round(ref.x * 10) / 10, y: Math.round(ref.y * 10) / 10 });
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [scale]);

  /* A handle for ./verify-browser.mjs. The harness is the only place this
     exists; <CanvasEditor> itself touches no globals. */
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__harness = {
      items: band.items,
      bandId: band.id,
      height: band.height,
      selection,
      scale,
      snapEnabled,
      changes: counter.current,
      parentScaled,
      valid: validation.ok,
    };
    (window as unknown as Record<string, unknown>).__harnessSet = (patch: Record<string, unknown>) => {
      if (typeof patch.scale === 'number') setScale(patch.scale);
      if (typeof patch.snapEnabled === 'boolean') setSnapEnabled(patch.snapEnabled);
      if (typeof patch.parentScaled === 'boolean') setParentScaled(patch.parentScaled);
      if (typeof patch.bandIndex === 'number') setBandIndex(patch.bandIndex);
      if (Array.isArray(patch.selection)) setSelection(patch.selection as string[]);
    };
    (window as unknown as Record<string, unknown>).__harnessReset = reset;
  }, [band, selection, scale, snapEnabled, parentScaled, validation.ok, reset]);

  return (
    <div className="h-root">
      <aside className="h-panel h-left">
        <h1>CanvasEditor harness</h1>
        <p className="h-note">
          WS-4, standalone. Fixture <code>src/cms/fixtures/dense.json</code>, inlined at build time. No
          shell, no API.
        </p>

        <label className="h-field">
          <span>Band</span>
          <select
            value={bandIndex}
            onChange={(event) => {
              setBandIndex(Number(event.target.value));
              setSelection([]);
            }}
          >
            {canvasIndexes.map((index, position) => {
              const candidate = bands[index] as CanvasBand;
              return (
                <option key={candidate.id} value={position}>
                  {candidate.id} ({candidate.items.length} items, h {candidate.height})
                </option>
              );
            })}
          </select>
        </label>

        <div className="h-field">
          <span>Scale</span>
          <div className="h-scales">
            {SCALES.map((value) => (
              <button
                key={value}
                type="button"
                data-scale={value}
                className={value === scale ? 'on' : undefined}
                onClick={() => setScale(value)}
              >
                {value.toFixed(2)}
              </button>
            ))}
          </div>
          <input
            type="range"
            min={0.3}
            max={1.2}
            step={0.01}
            value={scale}
            onChange={(event) => setScale(Number(event.target.value))}
          />
          <output>
            scale {scale.toFixed(2)} &middot; stage {Math.round(REFERENCE_WIDTH * scale)}px on screen for{' '}
            {REFERENCE_WIDTH} reference px
          </output>
        </div>

        <label className="h-check">
          <input type="checkbox" checked={snapEnabled} onChange={(event) => setSnapEnabled(event.target.checked)} />
          <span>Snapping</span>
        </label>
        <label className="h-check">
          <input
            type="checkbox"
            checked={parentScaled}
            onChange={(event) => setParentScaled(event.target.checked)}
          />
          <span>
            Parent applies the scale <code>(applyTransform=false)</code>
          </span>
        </label>
        <label className="h-field">
          <span>Snap radius ({snapThreshold} screen px)</span>
          <input
            type="range"
            min={0}
            max={20}
            step={1}
            value={snapThreshold}
            onChange={(event) => setSnapThreshold(Number(event.target.value))}
          />
        </label>

        <button type="button" className="h-reset" onClick={reset}>
          Reset to fixture
        </button>

        <dl className="h-keys">
          <dt>drag</dt><dd>move</dd>
          <dt>corner</dt><dd>resize &middot; shift keeps ratio</dd>
          <dt>top handle</dt><dd>rotate &middot; shift 15&deg; steps</dd>
          <dt>shift-click</dt><dd>add to selection</dd>
          <dt>drag empty</dt><dd>marquee</dd>
          <dt>arrows</dt><dd>nudge 1px &middot; shift 10px</dd>
          <dt>alt</dt><dd>suspend snapping mid-drag</dd>
          <dt>shift-drag</dt><dd>lock to one axis</dd>
          <dt>[ ]</dt><dd>back / forward &middot; cmd for front / back</dd>
          <dt>delete</dt><dd>remove selection</dd>
          <dt>cmd-a</dt><dd>select all &middot; esc clears</dd>
        </dl>
      </aside>

      <main className="h-stage">
        <div className="h-stage-inner">
          {parentScaled ? (
            // The other integration mode: an ancestor owns the transform and
            // the component is told the scale only so its maths is right.
            <div style={{ width: REFERENCE_WIDTH * scale, height: band.height * scale }}>
              <div
                style={{
                  width: REFERENCE_WIDTH,
                  height: band.height,
                  transform: `scale(${scale})`,
                  transformOrigin: '0 0',
                }}
              >
                <CanvasEditor
                  items={band.items}
                  height={band.height}
                  scale={scale}
                  applyTransform={false}
                  onChange={onChange}
                  selection={selection}
                  onSelectionChange={setSelection}
                  snapEnabled={snapEnabled}
                  snapThreshold={snapThreshold}
                />
              </div>
            </div>
          ) : (
            <CanvasEditor
              items={band.items}
              height={band.height}
              scale={scale}
              onChange={onChange}
              selection={selection}
              onSelectionChange={setSelection}
              snapEnabled={snapEnabled}
              snapThreshold={snapThreshold}
            />
          )}
        </div>
      </main>

      <aside className="h-panel h-right">
        <div className="h-readout">
          <div>
            <span>pointer</span>
            <strong>
              {pointer === null ? '--' : `${pointer.x}, ${pointer.y}`} <em>ref px</em>
            </strong>
          </div>
          <div>
            <span>selection</span>
            <strong>{selection.length === 0 ? 'none' : selection.join(', ')}</strong>
          </div>
          <div>
            <span>changes</span>
            <strong>{counter.current}</strong>
          </div>
        </div>

        <div className={validation.ok ? 'h-valid ok' : 'h-valid bad'}>{validation.text}</div>

        <h2>items</h2>
        <pre data-harness-json>{JSON.stringify(band.items, null, 2)}</pre>

        <h2>changes</h2>
        <ul className="h-log">
          {log.map((entry) => (
            <li key={entry.n}>
              <code>{entry.n}</code> {entry.reason}
              {entry.transient ? <em> transient</em> : <strong> commit</strong>}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
