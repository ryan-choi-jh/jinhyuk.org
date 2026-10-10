/**
 * src/cms/assets/AssetPicker.tsx
 *
 * WS-6. Choose an asset and configure it before it goes on the canvas.
 *
 *   import AssetPicker from '../assets/AssetPicker.tsx';
 *   import { draftToItem } from '../assets/draft.ts';
 *
 *   <AssetPicker onInsert={(draft) => place(draftToItem(draft, { x, y }))} />
 *
 * Not part of the frozen contract (docs/cms-contracts.md section 5.1 freezes
 * `shapes.ts` only), so WS-8 can ask for a different shape here and get it.
 *
 * Three decisions worth knowing about:
 *
 *  - Everything is inline styles. WS-1 owns the site stylesheet and WS-3 owns
 *    the shell's; a component that ships its own global CSS would collide with
 *    both. The trade is no pseudo-classes, so hover is React state.
 *  - The preview is the real `generateShape` output at the real aspect ratio,
 *    not an icon. What you see is the string that gets written to the page.
 *  - "Another" mints a new candidate id rather than a free-floating seed,
 *    because the seed has to survive insertion. See draft.ts.
 */

import { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { SHAPE_KINDS, generateShape } from './shapes.ts';
import { SITE_PALETTE, tint } from './palette.ts';
import type { Swatch } from './palette.ts';
import {
  DEFAULT_SIZE,
  draftToSpec,
  fillAllowed,
  newDraft,
  normaliseDraft,
  radiusAllowed,
  reseed,
  withShape,
} from './draft.ts';
import type { ShapeDraft } from './draft.ts';

export type AssetPickerProps = {
  /** Called with the configured draft. Turn it into a CanvasItem with draftToItem. */
  onInsert: (draft: ShapeDraft) => void;
  /** Fired on every change, for using the picker as an inspector on a live item. */
  onChange?: (draft: ShapeDraft) => void;
  onCancel?: () => void;
  initial?: Partial<ShapeDraft>;
  palette?: readonly Swatch[];
  insertLabel?: string;
  /** Preview stage, in CSS px. The drawing is scaled to fit it, aspect kept. */
  stage?: { width: number; height: number };
  /**
   * Mint a fresh candidate id after every insert, so two inserts cannot
   * produce two items with the same id. Turn it off when the picker is being
   * used as an inspector on one existing item.
   */
  reseedOnInsert?: boolean;
};

const UI = {
  ink: '#111111',
  muted: '#6b6b6b',
  faint: '#9a9a9a',
  rule: '#e4e4e4',
  paper: '#ffffff',
  wash: '#fafafa',
  accent: '#ff5722',
  sans: "'Inter', system-ui, -apple-system, sans-serif",
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

const labelStyle: CSSProperties = {
  fontFamily: UI.mono,
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: UI.faint,
  display: 'block',
  marginBottom: 7,
};

const rowStyle: CSSProperties = { padding: '13px 14px', borderTop: `1px solid ${UI.rule}` };

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>
        {label}
        {hint !== undefined ? <span style={{ color: UI.muted, marginLeft: 8 }}>{hint}</span> : null}
      </span>
      {children}
    </div>
  );
}

/** One generateShape result, sized to its box. */
function Drawing({ svg, width, height }: { svg: string; width: number; height: number }) {
  return (
    <div
      style={{ width, height, lineHeight: 0 }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function AssetPicker({
  onInsert,
  onChange,
  onCancel,
  initial,
  palette = SITE_PALETTE,
  insertLabel = 'Insert',
  reseedOnInsert = true,
  stage = { width: 288, height: 168 },
}: AssetPickerProps) {
  const [draft, setDraft] = useState<ShapeDraft>(() =>
    newDraft(initial?.shape ?? 'squiggle', initial),
  );
  const [hover, setHover] = useState<string | null>(null);
  const [sized, setSized] = useState(false);

  const update = (next: ShapeDraft): void => {
    const clean = normaliseDraft(next);
    setDraft(clean);
    onChange?.(clean);
  };

  const spec = useMemo(() => draftToSpec(draft), [draft]);
  const svg = useMemo(() => generateShape(spec), [spec]);

  // Tab previews share the draft's seed, so they show what switching would give.
  const tabs = useMemo(
    () =>
      SHAPE_KINDS.map((kind) => ({
        kind,
        svg: generateShape({
          ...draftToSpec(withShape(draft, kind, false)),
          color: kind === draft.shape ? draft.color : UI.faint,
          strokeWidth: 2,
          width: 54,
          height: 26,
        }),
      })),
    [draft],
  );

  const scale = Math.min(stage.width / draft.w, stage.height / draft.h, 1);
  const maxRadius = Math.max(1, Math.round(Math.min(draft.w, draft.h) / 2));

  const chip = (active: boolean, key: string): CSSProperties => ({
    border: `1px solid ${active ? UI.ink : hover === key ? UI.faint : UI.rule}`,
    background: active ? UI.ink : UI.paper,
    color: active ? UI.paper : UI.ink,
    borderRadius: 5,
    cursor: 'pointer',
    padding: 0,
    font: 'inherit',
  });

  return (
    <div
      id="picker-shell"
      style={{
        width: '100%',
        minWidth: 280,
        maxWidth: 340,
        background: UI.paper,
        border: `1px solid ${UI.rule}`,
        borderRadius: 8,
        fontFamily: UI.sans,
        color: UI.ink,
        overflow: 'hidden',
      }}
    >
      {/* Kind */}
      <div style={{ padding: '13px 14px' }}>
        <span style={labelStyle}>Asset</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {tabs.map(({ kind, svg: thumb }) => (
            <button
              key={kind}
              type="button"
              title={kind}
              aria-pressed={kind === draft.shape}
              onMouseEnter={() => setHover(kind)}
              onMouseLeave={() => setHover(null)}
              onClick={() => update(withShape(draft, kind, sized))}
              style={{
                ...chip(kind === draft.shape, kind),
                flex: 1,
                height: 42,
                display: 'grid',
                placeItems: 'center',
                background: kind === draft.shape ? UI.wash : UI.paper,
                borderColor: kind === draft.shape ? UI.ink : hover === kind ? UI.faint : UI.rule,
              }}
            >
              <Drawing svg={thumb} width={54} height={26} />
            </button>
          ))}
        </div>
      </div>

      {/* Preview */}
      <div
        style={{
          ...rowStyle,
          background: UI.wash,
          display: 'grid',
          placeItems: 'center',
          minHeight: stage.height + 26,
        }}
      >
        <Drawing svg={svg} width={Math.round(draft.w * scale)} height={Math.round(draft.h * scale)} />
      </div>

      {/* Colour */}
      <Field label="Colour" hint={draft.color}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {palette.map((swatch) => (
            <button
              key={swatch.name}
              type="button"
              title={`${swatch.name} ${swatch.value}`}
              aria-pressed={draft.color.toLowerCase() === swatch.value.toLowerCase()}
              onClick={() =>
                update({
                  ...draft,
                  color: swatch.value,
                  fill: draft.fill !== undefined ? tint(swatch.value) : undefined,
                })
              }
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                background: swatch.value,
                cursor: 'pointer',
                border:
                  draft.color.toLowerCase() === swatch.value.toLowerCase()
                    ? `2px solid ${UI.ink}`
                    : `1px solid ${UI.rule}`,
                boxShadow:
                  draft.color.toLowerCase() === swatch.value.toLowerCase()
                    ? `0 0 0 2px ${UI.paper} inset`
                    : 'none',
              }}
            />
          ))}
          <input
            type="color"
            aria-label="Custom colour"
            value={draft.color.slice(0, 7)}
            onChange={(event) => update({ ...draft, color: event.target.value })}
            style={{
              width: 26,
              height: 22,
              padding: 0,
              border: `1px solid ${UI.rule}`,
              borderRadius: 4,
              background: UI.paper,
              cursor: 'pointer',
            }}
          />
        </div>
      </Field>

      {/* Fill */}
      {fillAllowed(draft.shape) ? (
        <Field label="Fill" hint={draft.fill ?? 'none'}>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['none', 'tint', 'solid'] as const).map((mode) => {
              const active =
                mode === 'none'
                  ? draft.fill === undefined
                  : mode === 'tint'
                    ? draft.fill === tint(draft.color)
                    : draft.fill !== undefined && draft.fill === draft.color;
              return (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={active}
                  onMouseEnter={() => setHover(`fill-${mode}`)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() =>
                    update({
                      ...draft,
                      fill:
                        mode === 'none'
                          ? undefined
                          : mode === 'tint'
                            ? tint(draft.color)
                            : draft.color,
                    })
                  }
                  style={{
                    ...chip(active, `fill-${mode}`),
                    padding: '5px 11px',
                    fontSize: 12,
                  }}
                >
                  {mode}
                </button>
              );
            })}
          </div>
        </Field>
      ) : null}

      {/* Stroke */}
      <Field label="Stroke" hint={`${draft.strokeWidth}px`}>
        <input
          type="range"
          min={0.5}
          max={12}
          step={0.5}
          value={draft.strokeWidth}
          aria-label="Stroke width"
          onChange={(event) => update({ ...draft, strokeWidth: Number(event.target.value) })}
          style={{ width: '100%', accentColor: UI.ink }}
        />
      </Field>

      {/* Radius */}
      {radiusAllowed(draft.shape) ? (
        <Field label="Corner" hint={`${Math.round(draft.radius ?? 0)}px`}>
          <input
            type="range"
            min={0}
            max={maxRadius}
            step={1}
            value={Math.min(draft.radius ?? 0, maxRadius)}
            aria-label="Corner radius"
            onChange={(event) => update({ ...draft, radius: Number(event.target.value) })}
            style={{ width: '100%', accentColor: UI.ink }}
          />
        </Field>
      ) : null}

      {/* Size */}
      <Field label="Size" hint="reference px">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {(['w', 'h'] as const).map((axis) => (
            <label key={axis} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
              <span style={{ fontFamily: UI.mono, fontSize: 11, color: UI.faint }}>{axis}</span>
              <input
                type="number"
                min={1}
                max={2000}
                value={Math.round(draft[axis])}
                aria-label={axis === 'w' ? 'Width' : 'Height'}
                onChange={(event) => {
                  setSized(true);
                  update({ ...draft, [axis]: Math.max(1, Number(event.target.value) || 1) });
                }}
                style={{
                  width: '100%',
                  minWidth: 0,
                  font: `12px ${UI.mono}`,
                  padding: '5px 7px',
                  border: `1px solid ${UI.rule}`,
                  borderRadius: 5,
                  color: UI.ink,
                  background: UI.paper,
                }}
              />
            </label>
          ))}
          <button
            type="button"
            onMouseEnter={() => setHover('reset')}
            onMouseLeave={() => setHover(null)}
            onClick={() => {
              setSized(false);
              update({ ...draft, ...DEFAULT_SIZE[draft.shape] });
            }}
            style={{ ...chip(false, 'reset'), padding: '5px 9px', fontSize: 12, color: UI.muted }}
          >
            reset
          </button>
        </div>
      </Field>

      {/* Seed */}
      <Field label="Wobble" hint={`seed ${draft.id}`}>
        <button
          type="button"
          onMouseEnter={() => setHover('reseed')}
          onMouseLeave={() => setHover(null)}
          onClick={() => update(reseed(draft))}
          style={{ ...chip(false, 'reseed'), padding: '6px 12px', fontSize: 12, width: '100%' }}
        >
          Draw another
        </button>
      </Field>

      {/* Footer */}
      <div
        style={{
          ...rowStyle,
          display: 'flex',
          gap: 8,
          justifyContent: 'flex-end',
          background: UI.wash,
        }}
      >
        {onCancel !== undefined ? (
          <button
            type="button"
            onMouseEnter={() => setHover('cancel')}
            onMouseLeave={() => setHover(null)}
            onClick={onCancel}
            style={{ ...chip(false, 'cancel'), padding: '7px 14px', fontSize: 13, color: UI.muted }}
          >
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          onMouseEnter={() => setHover('insert')}
          onMouseLeave={() => setHover(null)}
          onClick={() => {
            onInsert(normaliseDraft(draft));
            // A new candidate id, because the one just inserted now belongs to
            // an item on the canvas and ids are unique document-wide. Without
            // this, inserting twice produces two items with the same id and
            // the document stops validating. The side effect is intended: the
            // next asset is a new drawing, not a copy of the last one.
            if (reseedOnInsert) update(reseed(draft));
          }}
          style={{
            ...chip(true, 'insert'),
            padding: '7px 16px',
            fontSize: 13,
            background: hover === 'insert' ? UI.accent : UI.ink,
            borderColor: hover === 'insert' ? UI.accent : UI.ink,
          }}
        >
          {insertLabel}
        </button>
      </div>
    </div>
  );
}

export default AssetPicker;
