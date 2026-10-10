/**
 * src/cms/app/library/LibraryBrowser.tsx
 *
 * One browsable drawer holding both halves of the library:
 *
 *   - stored assets, the illustrations drawn in Paper and exported, plus the
 *     photographs and screenshots already in public/;
 *   - generated shapes, the parametric annotation drawings from
 *     src/cms/assets/ (squiggle, arrow, line, box, ring).
 *
 * Search by name or tag, filter by category or by kind, open one and insert it
 * into whatever canvas band the host has open. A shape's colour, stroke width,
 * seed and box are live controls, and the preview redraws as they move, so the
 * squiggle that lands on the page is the one that was chosen rather than one
 * that then has to be fixed.
 *
 * The component owns no document state and fetches nothing. It takes a
 * catalogue and an `onInsert`, and it hands back a `CanvasItem`. That is the
 * whole contract, which is what lets it be mounted on any page.
 *
 * ---------------------------------------------------------------------------
 * Two things a reader will wonder about
 *
 * 1. The seed control steps an ID, not a number.
 *    `CanvasItem` has no seed field; a shape's wobble is `seedFromId(item.id)`.
 *    So the control walks a deterministic sequence of candidate item ids and
 *    previews each one. Insert and that exact id goes onto the page, so the
 *    drawing is identical, byte for byte. The long version is at the foot of
 *    ./shape-adapter.ts.
 *
 *    One consequence is visible in the UI: inserting the same shape twice
 *    steps the seed on, because two items in one document may not share an id.
 *    The second squiggle is therefore a different squiggle, which is what you
 *    want anyway.
 *
 * 2. Artwork is fitted into a fixed 4:3 tile with percentage widths rather
 *    than with `object-fit`, because the generated SVG is
 *    `preserveAspectRatio="none"` and will take any box it is given. The two
 *    lines of arithmetic in `fitStyle` are what keep a 420x12 rule from being
 *    drawn as a square.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import seedCatalogue from './catalogue.seed.json';
import {
  categoriesOf,
  filterEntries,
  formatBytes,
  humanise,
  loadCatalogue,
  previewAspect,
  previewSrcFor,
} from './catalogue.ts';
import type { KindFilter } from './catalogue.ts';
import { canvasItemFromEntry, insertSizeFor } from './insert.ts';
import type { Origin } from './insert.ts';
import { isAssetEntry } from './schema.ts';
import type { AssetEntry, LibraryEntry, ShapeEntry } from './schema.ts';
import {
  REF_WIDTH,
  drawShape,
  freshSeedBase,
  idForSeedStep,
  seedFromId,
  seedLabel,
} from './shape-adapter.ts';
import type { CanvasItem } from './shape-adapter.ts';
import { STROKE_MAX, STROKE_MIN, STROKE_STEP, SWATCHES } from './shapes.ts';
import { STAGE_ASPECT, TILE_ASPECT, useLibraryStyles } from './styles.ts';

/* -------------------------------------------------------------------------- */
/* Props                                                                       */
/* -------------------------------------------------------------------------- */

export type LibraryBrowserProps = {
  /**
   * Called with a complete, schema-valid `CanvasItem`. The host decides which
   * band it goes into and may renumber `z`; it must NOT change `id` on a shape
   * item, because the id is what carries the drawing.
   */
  onInsert: (item: CanvasItem) => void;
  /**
   * A catalogue file's contents. Anything at all is accepted: a malformed
   * entry greys out and is reported in the footer rather than emptying the
   * drawer. Defaults to ./catalogue.seed.json.
   */
  catalogue?: unknown;
  /** Already-loaded entries. Wins over `catalogue` when both are given. */
  entries?: readonly LibraryEntry[];
  /** Top-left of the inserted item, in reference px. Default: centred, y = 0. */
  origin?: Origin;
  /** Reference width to size against. Default: REFERENCE_WIDTH (1344). */
  refWidth?: number;
  /** Shown as a close button in the header when provided. Escape calls it too. */
  onClose?: () => void;
  title?: string;
  initialText?: string;
  initialCategory?: string;
  initialKind?: KindFilter;
  /** Focus the search field on mount. Default true. */
  autoFocus?: boolean;
  className?: string;
};

/* -------------------------------------------------------------------------- */
/* Shape drafts                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The live state of one shape's controls. Held per entry and kept while the
 * library is open, so flipping between the squiggle and the arrow and back
 * does not lose the colour that was just picked.
 */
type ShapeDraft = {
  width: number;
  height: number;
  color: string;
  strokeWidth: number;
  /** null means no fill. There is no "none" sentinel in the document model. */
  fill: string | null;
  radius: number;
  /** Root of this draft's seed sequence, and how far along it we are. */
  base: string;
  step: number;
};

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function initialDraft(entry: ShapeEntry, base: string): ShapeDraft {
  return {
    width: entry.defaults.width,
    height: entry.defaults.height,
    color: entry.defaults.color,
    strokeWidth: entry.defaults.strokeWidth,
    fill: entry.defaults.fill ?? null,
    radius: entry.defaults.radius ?? 0,
    base,
    step: 0,
  };
}

/**
 * The item id at step `step`. Step 0 is the preset's own `seedId` when it has
 * one, so the grid tile and the detail panel show the same drawing the moment
 * an entry is opened.
 */
function seedIdAt(entry: ShapeEntry, base: string, step: number): string {
  if (step === 0 && entry.defaults.seedId !== undefined) return entry.defaults.seedId;
  return idForSeedStep(base, step);
}

/* -------------------------------------------------------------------------- */
/* Fitting artwork into a fixed tile                                           */
/* -------------------------------------------------------------------------- */

/**
 * Size a box of aspect `aspect` to fit inside a box of aspect `tile`, in
 * percentages of the tile. Two lines, no measurement, no layout thrash.
 */
function fitStyle(aspect: number, tile: number): CSSProperties {
  if (!Number.isFinite(aspect) || aspect <= 0) return { width: '100%', height: '100%' };
  return aspect >= tile
    ? { width: '100%', height: `${(tile / aspect) * 100}%` }
    : { width: `${(aspect / tile) * 100}%`, height: '100%' };
}

/* -------------------------------------------------------------------------- */
/* Previews                                                                    */
/* -------------------------------------------------------------------------- */

function ShapePreview({
  entry,
  draft,
  tile,
}: {
  entry: ShapeEntry;
  draft: ShapeDraft;
  tile: number;
}): ReactNode {
  const itemId = seedIdAt(entry, draft.base, draft.step);
  const svg = useMemo(() => {
    const spec = {
      shape: entry.generator,
      width: draft.width,
      height: draft.height,
      color: draft.color,
      strokeWidth: draft.strokeWidth,
      seed: seedFromId(itemId),
      ...(draft.fill !== null && (entry.generator === 'rect' || entry.generator === 'ellipse')
        ? { fill: draft.fill }
        : {}),
      ...(draft.radius > 0 && entry.generator === 'rect' ? { radius: draft.radius } : {}),
    };
    return drawShape(spec);
  }, [
    entry.generator,
    draft.width,
    draft.height,
    draft.color,
    draft.strokeWidth,
    draft.fill,
    draft.radius,
    itemId,
  ]);

  return (
    <div
      className="cms-lib-fit"
      style={fitStyle(draft.width / draft.height, tile)}
      data-lib-shape={entry.generator}
      data-lib-seed-id={itemId}
      // The generator's contract (docs/cms-contracts.md 5.3) is one root <svg>
      // with no ids, no <defs>, no <style>, no script, and no raw input echoed
      // into the output. That is what makes this assignment safe.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** Which ground a thumbnail sits on. A black squiggle needs paper. */
function groundFor(entry: LibraryEntry): string {
  if (!isAssetEntry(entry)) return 'cms-lib-thumb--paper';
  return entry.transparent === true ? 'cms-lib-thumb--alpha' : 'cms-lib-thumb--panel';
}

/* -------------------------------------------------------------------------- */
/* A tile                                                                      */
/* -------------------------------------------------------------------------- */

function Card({
  entry,
  draft,
  selected,
  onSelect,
  onInsert,
}: {
  entry: LibraryEntry;
  draft: ShapeDraft | null;
  selected: boolean;
  onSelect: () => void;
  onInsert: () => void;
}): ReactNode {
  const meta = isAssetEntry(entry)
    ? `${entry.width} x ${entry.height}`
    : `${Math.round(entry.defaults.width)} x ${Math.round(entry.defaults.height)}`;

  return (
    <button
      type="button"
      className={`cms-lib-card${selected ? ' cms-lib-card--on' : ''}`}
      onClick={onSelect}
      onDoubleClick={onInsert}
      aria-pressed={selected}
      data-lib-card={entry.id}
      data-lib-kind={entry.kind}
      data-lib-category={entry.category}
      title={`${entry.name}. Double-click to insert.`}
    >
      <span className={`cms-lib-thumb ${groundFor(entry)}`}>
        {isAssetEntry(entry) ? (
          <img
            src={previewSrcFor(entry)}
            alt=""
            loading="lazy"
            decoding="async"
            width={entry.preview?.w ?? entry.width}
            height={entry.preview?.h ?? entry.height}
          />
        ) : draft !== null ? (
          <ShapePreview entry={entry} draft={draft} tile={TILE_ASPECT} />
        ) : null}
        {isAssetEntry(entry) && entry.transparent === true ? (
          <span className="cms-lib-card__badge">alpha</span>
        ) : null}
      </span>
      <span className="cms-lib-card__body">
        <span className="cms-lib-card__name">{entry.name}</span>
        <span className="cms-lib-card__meta">
          {humanise(entry.category)} · {meta}
        </span>
      </span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Small control pieces                                                        */
/* -------------------------------------------------------------------------- */

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="cms-lib-row">
      <span className="cms-lib-row__label">{label}</span>
      <span className="cms-lib-row__value">{children}</span>
    </div>
  );
}

function Swatches({
  value,
  onPick,
  allowNone = false,
  name,
}: {
  value: string | null;
  onPick: (next: string | null) => void;
  allowNone?: boolean;
  name: string;
}): ReactNode {
  return (
    <span className="cms-lib-swatches">
      {allowNone ? (
        <button
          type="button"
          className="cms-lib-swatch cms-lib-swatch--none"
          aria-pressed={value === null}
          aria-label="no fill"
          title="no fill"
          onClick={() => onPick(null)}
          data-lib-swatch={`${name}:none`}
        />
      ) : null}
      {SWATCHES.map((swatch) => (
        <button
          key={swatch.name}
          type="button"
          className="cms-lib-swatch"
          style={{ background: swatch.value }}
          aria-pressed={value !== null && value.toLowerCase() === swatch.value.toLowerCase()}
          aria-label={swatch.name}
          title={`${swatch.name} ${swatch.value}`}
          onClick={() => onPick(swatch.value)}
          data-lib-swatch={`${name}:${swatch.name}`}
        />
      ))}
    </span>
  );
}

function HexInput({
  value,
  onCommit,
  testId,
}: {
  value: string;
  onCommit: (next: string) => void;
  testId: string;
}): ReactNode {
  const [text, setText] = useState(value);
  const lastExternal = useRef(value);

  // Follow the swatches when they move, without fighting the user's typing.
  if (lastExternal.current !== value) {
    lastExternal.current = value;
    if (text !== value) setText(value);
  }

  const valid = HEX_RE.test(text);
  return (
    <input
      className={`cms-lib-input cms-lib-input--hex${valid ? '' : ' cms-lib-input--bad'}`}
      value={text}
      spellCheck={false}
      aria-invalid={!valid}
      data-lib-hex={testId}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (HEX_RE.test(next)) {
          lastExternal.current = next;
          onCommit(next);
        }
      }}
    />
  );
}

function NumberInput({
  value,
  min,
  max,
  step = 1,
  onCommit,
  testId,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (next: number) => void;
  testId: string;
}): ReactNode {
  return (
    <input
      className="cms-lib-num"
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      data-lib-num={testId}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (!Number.isFinite(next)) return;
        onCommit(Math.min(max, Math.max(min, next)));
      }}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* The detail panel                                                            */
/* -------------------------------------------------------------------------- */

function AssetDetail({ entry, refWidth }: { entry: AssetEntry; refWidth: number }): ReactNode {
  const size = insertSizeFor(entry, refWidth);
  return (
    <div className="cms-lib-rows" data-lib-asset-detail={entry.id}>
      <Row label="Real size">
        {entry.width} x {entry.height} px
      </Row>
      <Row label="Inserts at">
        {size.w} x {size.h} ref px
        <span style={{ color: 'var(--cms-muted, #8d969f)' }}>
          {' '}
          ({Math.round((size.w / refWidth) * 100)}% of {refWidth})
        </span>
      </Row>
      <Row label="File">
        <span className="cms-lib-row__value--path" title={entry.src}>
          {entry.src}
        </span>
      </Row>
      <Row label="Format">
        {(entry.format ?? 'unknown').toUpperCase()}
        {entry.bytes !== undefined ? ` · ${formatBytes(entry.bytes)}` : ''}
        {entry.transparent === true ? ' · transparent' : ''}
      </Row>
      {entry.preview !== undefined ? (
        <Row label="Thumbnail">
          {entry.preview.w} x {entry.preview.h}
        </Row>
      ) : null}
    </div>
  );
}

function ShapeDetail({
  entry,
  draft,
  patch,
}: {
  entry: ShapeEntry;
  draft: ShapeDraft;
  patch: (next: Partial<ShapeDraft>) => void;
}): ReactNode {
  const itemId = seedIdAt(entry, draft.base, draft.step);
  const supportsFill = entry.generator === 'rect' || entry.generator === 'ellipse';

  return (
    <div className="cms-lib-rows" data-lib-shape-detail={entry.id}>
      <Row label="Colour">
        <span className="cms-lib-row__pair">
          <Swatches
            name="color"
            value={draft.color}
            onPick={(next) => patch({ color: next ?? draft.color })}
          />
          <HexInput value={draft.color} testId="color" onCommit={(next) => patch({ color: next })} />
        </span>
      </Row>

      <Row label="Stroke">
        <span className="cms-lib-row__pair">
          <input
            className="cms-lib-range"
            type="range"
            min={STROKE_MIN}
            max={STROKE_MAX}
            step={STROKE_STEP}
            value={draft.strokeWidth}
            data-lib-stroke
            onChange={(event) => patch({ strokeWidth: Number(event.target.value) })}
          />
          <NumberInput
            value={draft.strokeWidth}
            min={STROKE_MIN}
            max={STROKE_MAX}
            step={STROKE_STEP}
            testId="stroke"
            onCommit={(next) => patch({ strokeWidth: next })}
          />
        </span>
      </Row>

      <Row label="Seed">
        <span className="cms-lib-step">
          <button
            type="button"
            className="cms-lib-step__btn"
            onClick={() => patch({ step: Math.max(0, draft.step - 1) })}
            disabled={draft.step === 0}
            aria-label="previous seed"
            data-lib-seed-prev
          >
            {'‹'}
          </button>
          <button
            type="button"
            className="cms-lib-step__btn"
            onClick={() => patch({ step: draft.step + 1 })}
            aria-label="next seed"
            data-lib-seed-next
          >
            {'›'}
          </button>
          <button
            type="button"
            className="cms-lib-step__btn"
            onClick={() => patch({ base: freshSeedBase(), step: 1 })}
            aria-label="shuffle seed"
            title="shuffle"
            data-lib-seed-shuffle
          >
            {'↻'}
          </button>
          <span className="cms-lib-step__value" data-lib-seed={seedLabel(itemId)}>
            {seedLabel(itemId)}
          </span>
        </span>
      </Row>

      <Row label="Box">
        <span className="cms-lib-row__pair">
          <NumberInput
            value={Math.round(draft.width)}
            min={8}
            max={REF_WIDTH}
            testId="width"
            onCommit={(next) => patch({ width: next })}
          />
          <span style={{ color: 'var(--cms-muted, #8d969f)' }}>x</span>
          <NumberInput
            value={Math.round(draft.height)}
            min={2}
            max={1200}
            testId="height"
            onCommit={(next) => patch({ height: next })}
          />
        </span>
      </Row>

      {supportsFill ? (
        <Row label="Fill">
          <span className="cms-lib-row__pair">
            <Swatches name="fill" value={draft.fill} allowNone onPick={(next) => patch({ fill: next })} />
            {draft.fill !== null ? (
              <HexInput value={draft.fill} testId="fill" onCommit={(next) => patch({ fill: next })} />
            ) : null}
          </span>
        </Row>
      ) : null}

      {entry.generator === 'rect' ? (
        <Row label="Radius">
          <NumberInput
            value={Math.round(draft.radius)}
            min={0}
            max={200}
            testId="radius"
            onCommit={(next) => patch({ radius: next })}
          />
        </Row>
      ) : null}

      <p className="cms-lib-hint">
        The seed is carried by the item id, so the drawing above is exactly what lands on the page.
        Inserting twice steps the seed on, because two items may not share an id.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The browser                                                                 */
/* -------------------------------------------------------------------------- */

export function LibraryBrowser({
  onInsert,
  catalogue,
  entries: givenEntries,
  origin,
  refWidth = REF_WIDTH,
  onClose,
  title = 'Library',
  initialText = '',
  initialCategory = 'all',
  initialKind = 'all',
  autoFocus = true,
  className,
}: LibraryBrowserProps): ReactNode {
  useLibraryStyles();

  const loaded = useMemo(() => {
    if (givenEntries !== undefined) return { entries: [...givenEntries], problems: [] as string[] };
    return loadCatalogue(catalogue ?? seedCatalogue);
  }, [givenEntries, catalogue]);

  const all = loaded.entries;

  const [text, setText] = useState(initialText);
  const [category, setCategory] = useState(initialCategory);
  const [kind, setKind] = useState<KindFilter>(initialKind);
  const [drafts, setDrafts] = useState<Record<string, ShapeDraft>>({});
  const [selectedId, setSelectedId] = useState<string | null>(() => all[0]?.id ?? null);
  const issued = useRef<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement | null>(null);

  const visible = useMemo(() => filterEntries(all, { text, category, kind }), [all, text, category, kind]);
  const cats = useMemo(() => categoriesOf(all, { text, kind }), [all, text, kind]);

  const selected = useMemo(
    () => all.find((entry) => entry.id === selectedId) ?? null,
    [all, selectedId],
  );

  /**
   * One seed base per mount, salted per entry, so two different shapes never
   * walk the same id sequence and the back arrow is reproducible.
   */
  const mountBase = useRef<string>(freshSeedBase());

  const draftOf = useCallback(
    (entry: ShapeEntry): ShapeDraft =>
      drafts[entry.id] ?? initialDraft(entry, `${mountBase.current}${entry.id}`),
    [drafts],
  );

  const patchDraft = useCallback(
    (entry: ShapeEntry, next: Partial<ShapeDraft>) => {
      setDrafts((current) => {
        const base = current[entry.id] ?? initialDraft(entry, `${mountBase.current}${entry.id}`);
        return { ...current, [entry.id]: { ...base, ...next } };
      });
    },
    [],
  );

  useEffect(() => {
    if (autoFocus) searchRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (onClose === undefined) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const insert = useCallback(
    (entry: LibraryEntry) => {
      if (isAssetEntry(entry)) {
        onInsert(canvasItemFromEntry(entry, { refWidth, origin }));
        return;
      }

      const draft = draftOf(entry);
      // Walk forward until the id has not already been handed out this
      // session. Two items in one document may not share an id, and a shape's
      // id is its drawing, so the only honest move is to step the seed and
      // show what actually went in.
      let step = draft.step;
      let id = seedIdAt(entry, draft.base, step);
      while (issued.current.has(id)) {
        step += 1;
        id = seedIdAt(entry, draft.base, step);
      }
      issued.current.add(id);

      onInsert(
        canvasItemFromEntry(entry, {
          id,
          refWidth,
          origin,
          size: { w: Math.round(draft.width), h: Math.round(draft.height) },
          shape: {
            color: draft.color,
            strokeWidth: draft.strokeWidth,
            ...(draft.fill !== null ? { fill: draft.fill } : {}),
            ...(draft.radius > 0 ? { radius: draft.radius } : {}),
          },
        }),
      );

      if (step !== draft.step) patchDraft(entry, { step });
    },
    [draftOf, onInsert, origin, patchDraft, refWidth],
  );

  const selectedSize = selected === null ? null : insertSizeFor(selected, refWidth);
  const selectedDraft = selected !== null && !isAssetEntry(selected) ? draftOf(selected) : null;

  return (
    <section
      className={className === undefined ? 'cms-lib' : `cms-lib ${className}`}
      data-lib-root
      aria-label="Component library"
    >
      <header className="cms-lib__head">
        <h2 className="cms-lib__title">{title}</h2>

        <span className="cms-lib__search">
          <input
            ref={searchRef}
            value={text}
            placeholder="Search name or tag"
            spellCheck={false}
            aria-label="Search the library"
            data-lib-search
            onChange={(event) => setText(event.target.value)}
          />
          {text !== '' ? (
            <button
              type="button"
              className="cms-lib__clear"
              aria-label="clear search"
              data-lib-search-clear
              onClick={() => {
                setText('');
                searchRef.current?.focus();
              }}
            >
              {'×'}
            </button>
          ) : null}
        </span>

        <span className="cms-lib__seg" role="group" aria-label="Kind">
          {(['all', 'asset', 'shape'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={kind === option}
              data-lib-kind-filter={option}
              onClick={() => setKind(option)}
            >
              {option === 'all' ? 'All' : option === 'asset' ? 'Assets' : 'Shapes'}
            </button>
          ))}
        </span>

        {onClose !== undefined ? (
          <button type="button" className="cms-lib__close" aria-label="close library" onClick={onClose}>
            {'×'}
          </button>
        ) : null}
      </header>

      <div className="cms-lib__cats" role="group" aria-label="Category">
        <button
          type="button"
          className="cms-lib__chip"
          aria-pressed={category === 'all'}
          data-lib-chip="all"
          onClick={() => setCategory('all')}
        >
          Everything
          <span className="cms-lib__chip-n">{cats.reduce((total, one) => total + one.count, 0)}</span>
        </button>
        {cats.map((one) => (
          <button
            key={one.id}
            type="button"
            className={`cms-lib__chip${one.count === 0 ? ' cms-lib__chip--empty' : ''}`}
            aria-pressed={category === one.id}
            data-lib-chip={one.id}
            onClick={() => setCategory(category === one.id ? 'all' : one.id)}
          >
            {humanise(one.id)}
            <span className="cms-lib__chip-n">{one.count}</span>
          </button>
        ))}
      </div>

      <div className="cms-lib__body">
        <div className="cms-lib__grid" data-lib-grid>
          {visible.length === 0 ? (
            <p className="cms-lib__empty">
              Nothing matches <b>{text === '' ? humanise(category) : text}</b>.
            </p>
          ) : (
            visible.map((entry) => (
              <Card
                key={entry.id}
                entry={entry}
                draft={isAssetEntry(entry) ? null : draftOf(entry)}
                selected={entry.id === selectedId}
                onSelect={() => setSelectedId(entry.id)}
                onInsert={() => insert(entry)}
              />
            ))
          )}
        </div>

        <aside className="cms-lib__detail" data-lib-detail={selected?.id ?? ''}>
          {selected === null ? (
            <p className="cms-lib__detail-empty">Pick something on the left.</p>
          ) : (
            <>
              <div className={`cms-lib-stage ${groundFor(selected)}`} data-lib-stage>
                {isAssetEntry(selected) ? (
                  <img
                    src={previewSrcFor(selected)}
                    alt={selected.name}
                    width={selected.preview?.w ?? selected.width}
                    height={selected.preview?.h ?? selected.height}
                  />
                ) : selectedDraft !== null ? (
                  <ShapePreview entry={selected} draft={selectedDraft} tile={STAGE_ASPECT} />
                ) : null}
              </div>

              <div className="cms-lib-detail__head">
                <h3 className="cms-lib-detail__name">{selected.name}</h3>
                <p className="cms-lib-detail__sub">
                  {isAssetEntry(selected) ? 'Stored asset' : `Generated · ${selected.generator}`} ·{' '}
                  {humanise(selected.category)}
                </p>
                {selected.note !== undefined ? (
                  <p className="cms-lib-detail__note">{selected.note}</p>
                ) : null}
                {selected.tags.length > 0 ? (
                  <div className="cms-lib-detail__tags">
                    {selected.tags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className="cms-lib-tag"
                        title={`search for "${tag}"`}
                        data-lib-tag={tag}
                        onClick={() => {
                          setText(tag);
                          setCategory('all');
                          setKind('all');
                        }}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              {isAssetEntry(selected) ? (
                <AssetDetail entry={selected} refWidth={refWidth} />
              ) : selectedDraft !== null ? (
                <ShapeDetail
                  entry={selected}
                  draft={selectedDraft}
                  patch={(next) => patchDraft(selected, next)}
                />
              ) : null}

              <div className="cms-lib-detail__foot">
                <button
                  type="button"
                  className="cms-lib-insert"
                  data-lib-insert={selected.id}
                  onClick={() => insert(selected)}
                >
                  Insert
                  <span className="cms-lib-insert__size">
                    {selectedDraft !== null
                      ? `${Math.round(selectedDraft.width)} x ${Math.round(selectedDraft.height)}`
                      : `${selectedSize?.w} x ${selectedSize?.h}`}
                  </span>
                </button>
              </div>
            </>
          )}
        </aside>
      </div>

      <footer className="cms-lib__foot">
        <span data-lib-count={visible.length}>
          {visible.length} of {all.length}
        </span>
        <span>
          {all.filter((entry) => entry.kind === 'asset').length} assets ·{' '}
          {all.filter((entry) => entry.kind === 'shape').length} shapes
        </span>
        {loaded.problems.length > 0 ? (
          <span className="cms-lib__problems" title={loaded.problems.join('\n')} data-lib-problems={loaded.problems.length}>
            {loaded.problems.length} catalogue problem{loaded.problems.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </footer>
    </section>
  );
}

export default LibraryBrowser;
