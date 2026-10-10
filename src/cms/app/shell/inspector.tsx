/**
 * src/cms/app/shell/inspector.tsx
 *
 * WS-3. The right pane. Properties of whatever is selected: the page itself,
 * a band, a prose block, or a canvas item.
 *
 * It edits numbers and flags, which is the shell's job. It does not edit
 * geometry by dragging (WS-4) or text by typing into it (WS-5). Typing a
 * number here and dragging there both end up in the same store call, so they
 * cannot disagree.
 */


import { PROSE_BLOCK_KINDS, REFERENCE_WIDTH, SHAPE_KINDS } from '../../schema.ts';
import type { Anchor, CanvasBand, CanvasItem, Doc, ProseBand, ProseBlock, ProseBlockKind, ShapeKind } from '../../schema.ts';
import { blockPlainText } from '../state/doc-ops.ts';
import { resolveSelection } from '../state/selection.ts';
import type { Selection } from '../state/selection.ts';
import type { DocStore, DocStoreState } from '../state/store.ts';
import { CheckField, Field, NumberField, Section, SelectField, TextField } from './fields.tsx';
import type { EditorShellSlots } from './slots.ts';

export type InspectorProps = {
  store: DocStore;
  state: DocStoreState;
  slots: EditorShellSlots;
};

export function Inspector({ store, state, slots }: InspectorProps) {
  const { doc, selection } = state;
  const resolved = resolveSelection(doc, selection);

  return (
    <div className="cms-insp" data-testid="inspector" data-selection-kind={resolved.kind}>
      {state.issues.length > 0 && (
        <ul className="cms-issues" data-testid="inspector-issues">
          {state.issues.slice(0, 12).map((issue) => (
            <li key={`${issue.path}:${issue.message}`}>
              <code>{issue.path}</code> {issue.message}
            </li>
          ))}
        </ul>
      )}

      {resolved.kind !== 'none' && (
        <div className="cms-insp__crumb">
          <button
            type="button"
            className="cms-btn cms-btn--quiet cms-btn--tiny"
            data-testid="inspector-back"
            onClick={() => store.clearSelection()}
          >
            ← Page
          </button>
          <span className="cms-insp__title">{titleFor(resolved.kind)}</span>
        </div>
      )}

      {resolved.kind === 'none' && <PagePanel store={store} state={state} />}

      {resolved.kind === 'band' && (
        <BandPanel store={store} doc={doc} band={resolved.band} bandIndex={resolved.bandIndex} />
      )}

      {resolved.kind === 'block' && (
        <BlockPanel
          store={store}
          band={resolved.band}
          bandIndex={resolved.bandIndex}
          block={resolved.block}
          blockIndex={resolved.blockIndex}
        />
      )}

      {resolved.kind === 'item' && (
        <ItemPanel
          store={store}
          doc={doc}
          band={resolved.band}
          item={resolved.primary}
          extraSelected={resolved.items.length - 1}
        />
      )}

      {slots.renderInspectorExtra !== undefined &&
        slots.renderInspectorExtra({ store, state, selection, resolved })}
    </div>
  );
}

function titleFor(kind: 'band' | 'block' | 'item'): string {
  if (kind === 'band') return 'Band';
  if (kind === 'block') return 'Text block';
  return 'Canvas item';
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

function PagePanel({ store, state }: { store: DocStore; state: DocStoreState }) {
  const meta = state.doc.meta;
  return (
    <>
      <Section title="Page">
        <TextField label="Title" testId="meta-title" value={meta.title} onChange={(title) => store.updateMeta({ title })} />
        <Field label="Slug">
          <input className="cms-input" value={meta.slug} readOnly data-testid="meta-slug" />
        </Field>
        <div className="cms-hint">
          The slug is the file name under <code>src/content/</code>. Renaming a page is a move, not an
          edit, so it is not done here.
        </div>
        <TextField label="Date" type="date" value={meta.date} onChange={(date) => store.updateMeta({ date })} />
        <TextField
          label="Summary"
          wide
          value={meta.summary ?? ''}
          placeholder="optional"
          onChange={(summary) => store.updateMeta({ summary })}
        />
        <TextField
          label="Visit URL"
          wide
          value={meta.url ?? ''}
          placeholder="https://…"
          onChange={(url) => store.updateMeta({ url })}
        />
        <TextField
          label="Cover"
          wide
          value={meta.cover ?? ''}
          placeholder="/media/slug/cover.png"
          onChange={(cover) => store.updateMeta({ cover })}
        />
      </Section>

      <Section title="Draft">
        <div className="cms-hint" data-testid="draft-state">
          {state.hasDraft
            ? 'A draft exists. It is not on the live site until you publish.'
            : 'No draft on the server yet.'}
        </div>
        <div className="cms-row-actions">
          <button
            type="button"
            className="cms-btn cms-btn--tiny cms-btn--danger"
            disabled={!state.hasDraft || state.phase !== 'idle'}
            data-testid="discard-draft"
            onClick={() => void store.discardDraft()}
          >
            Discard draft
          </button>
          <button
            type="button"
            className="cms-btn cms-btn--tiny"
            data-testid="validate"
            onClick={() => store.validate()}
          >
            Validate
          </button>
        </div>
      </Section>

      <Section title="Document">
        <div className="cms-hint">
          {state.doc.bands.length} band{state.doc.bands.length === 1 ? '' : 's'} · reference width{' '}
          {REFERENCE_WIDTH}px
          {state.auth !== null && (
            <>
              <br />
              {state.auth.signedIn ? `Signed in as ${state.auth.login ?? 'unknown'}` : 'Not signed in'}
            </>
          )}
        </div>
      </Section>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Band                                                                       */
/* -------------------------------------------------------------------------- */

function BandPanel({
  store,
  doc,
  band,
  bandIndex,
}: {
  store: DocStore;
  doc: Doc;
  band: ProseBand | CanvasBand;
  bandIndex: number;
}) {
  return (
    <>
      <Section title={`Band ${bandIndex + 1} · ${band.type}`}>
        <div className="cms-row-actions">
          <button
            type="button"
            className="cms-btn cms-btn--tiny"
            disabled={bandIndex === 0}
            onClick={() => store.moveBand(band.id, bandIndex - 1)}
          >
            Move up
          </button>
          <button
            type="button"
            className="cms-btn cms-btn--tiny"
            disabled={bandIndex === doc.bands.length - 1}
            onClick={() => store.moveBand(band.id, bandIndex + 1)}
          >
            Move down
          </button>
          <button
            type="button"
            className="cms-btn cms-btn--tiny cms-btn--danger"
            data-testid="inspector-delete-band"
            onClick={() => store.deleteBand(band.id)}
          >
            Delete band
          </button>
        </div>
        <div className="cms-hint">
          id <code>{band.id}</code>
        </div>
      </Section>

      {band.type === 'canvas' ? (
        <Section title="Canvas">
          <NumberField
            label="Height"
            testId="band-height"
            value={band.height}
            step={10}
            onChange={(height) => {
              if (height !== undefined) store.setBandHeight(band.id, height);
            }}
          />
          <CheckField
            label="Overlay the band above"
            checked={band.overlay === true}
            disabled={bandIndex === 0}
            testId="overlay-toggle"
            hint={
              bandIndex === 0
                ? 'The first band cannot overlay; there is nothing above it.'
                : 'Reserves no vertical space. Items sit over the previous band.'
            }
            onChange={(next) => store.setBandOverlay(band.id, next)}
          />
          <div className="cms-hint">
            {band.items.length} item{band.items.length === 1 ? '' : 's'}. Select one on the page to edit
            it.
          </div>
        </Section>
      ) : (
        <Section title="Blocks">
          {band.blocks.map((block, index) => (
            <div key={block.id} className="cms-row-actions" style={{ alignItems: 'center' }}>
              <select
                className="cms-select"
                style={{ width: 72 }}
                value={block.kind}
                onChange={(event) =>
                  store.setBlockKind(band.id, block.id, event.target.value as ProseBlockKind)
                }
              >
                {PROSE_BLOCK_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="cms-btn cms-btn--quiet cms-btn--micro"
                title="Move up"
                disabled={index === 0}
                onClick={() => store.moveProseBlock(band.id, block.id, index - 1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="cms-btn cms-btn--quiet cms-btn--micro"
                title="Move down"
                disabled={index === band.blocks.length - 1}
                onClick={() => store.moveProseBlock(band.id, block.id, index + 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="cms-btn cms-btn--quiet cms-btn--micro cms-btn--danger"
                title="Delete block"
                onClick={() => store.deleteProseBlock(band.id, block.id)}
              >
                ✕
              </button>
              <button
                type="button"
                className="cms-btn cms-btn--quiet cms-btn--tiny"
                onClick={() => store.selectBlock(band.id, block.id)}
              >
                {truncate(blockPlainText(block), 18) || 'empty'}
              </button>
            </div>
          ))}
          <div className="cms-row-actions">
            {(['p', 'h2', 'h3', 'quote', 'ul', 'ol'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className="cms-btn cms-btn--tiny"
                data-testid={`add-block-${kind}`}
                onClick={() => store.insertProseBlock(band.id, band.blocks.length, kind)}
              >
                + {kind}
              </button>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Prose block                                                                 */
/* -------------------------------------------------------------------------- */

function BlockPanel({
  store,
  band,
  bandIndex,
  block,
  blockIndex,
}: {
  store: DocStore;
  band: ProseBand;
  bandIndex: number;
  block: ProseBlock;
  blockIndex: number;
}) {
  return (
    <>
      <Section title={`Block ${blockIndex + 1} of band ${bandIndex + 1}`}>
        <SelectField
          label="Kind"
          value={block.kind}
          options={PROSE_BLOCK_KINDS}
          onChange={(kind) => store.setBlockKind(band.id, block.id, kind)}
        />
        <div className="cms-hint">
          id <code>{block.id}</code>
        </div>
        <div className="cms-hint">{truncate(blockPlainText(block), 160) || 'empty'}</div>
        <div className="cms-row-actions">
          <button
            type="button"
            className="cms-btn cms-btn--tiny"
            disabled={blockIndex === 0}
            onClick={() => store.moveProseBlock(band.id, block.id, blockIndex - 1)}
          >
            Move up
          </button>
          <button
            type="button"
            className="cms-btn cms-btn--tiny"
            disabled={blockIndex === band.blocks.length - 1}
            onClick={() => store.moveProseBlock(band.id, block.id, blockIndex + 1)}
          >
            Move down
          </button>
          <button
            type="button"
            className="cms-btn cms-btn--tiny"
            onClick={() => store.insertProseBlock(band.id, blockIndex + 1, 'p')}
          >
            Insert after
          </button>
          <button
            type="button"
            className="cms-btn cms-btn--tiny cms-btn--danger"
            data-testid="inspector-delete-block"
            onClick={() => store.deleteProseBlock(band.id, block.id)}
          >
            Delete
          </button>
        </div>
      </Section>
      <Section title="Text">
        <div className="cms-hint">
          Editing happens on the page. WS-5&apos;s editor mounts into the block on the surface; with no
          editor mounted the text is shown read-only.
        </div>
      </Section>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Canvas item                                                                 */
/* -------------------------------------------------------------------------- */

function ItemPanel({
  store,
  doc,
  band,
  item,
  extraSelected,
}: {
  store: DocStore;
  doc: Doc;
  band: CanvasBand;
  item: CanvasItem;
  extraSelected: number;
}) {
  const set = (patch: Partial<CanvasItem>): void => store.updateCanvasItem(band.id, item.id, patch);
  const isShape = item.kind === 'shape';

  return (
    <>
      {extraSelected > 0 && (
        <div className="cms-hint">
          {extraSelected + 1} items selected. Editing the first one.
        </div>
      )}

      <Section title={`${isShape ? (item.shape ?? 'shape') : item.kind} · geometry`}>
        <div className="cms-grid2">
          <NumberField label="x" testId="item-x" value={item.x} onChange={(x) => x !== undefined && set({ x })} />
          <NumberField label="y" testId="item-y" value={item.y} onChange={(y) => y !== undefined && set({ y })} />
          <NumberField label="w" testId="item-w" value={item.w} onChange={(w) => w !== undefined && w > 0 && set({ w })} />
          <NumberField label="h" testId="item-h" value={item.h} onChange={(h) => h !== undefined && h > 0 && set({ h })} />
          <NumberField
            label="rotate"
            testId="item-rotate"
            value={item.rotate}
            allowEmpty
            emptyLabel="0"
            onChange={(rotate) => set({ rotate })}
          />
          <NumberField
            label="z"
            value={item.z}
            allowEmpty
            emptyLabel="auto"
            onChange={(z) => set({ z: z === undefined ? undefined : Math.round(z) })}
          />
        </div>
        <div className="cms-hint">
          Reference px against a {REFERENCE_WIDTH}px page. Band is {Math.round(band.height)}px tall.
        </div>
      </Section>

      {!isShape && (
        <Section title="Media">
          <TextField label="src" wide value={item.src ?? ''} onChange={(src) => set({ src })} />
          <TextField label="alt" wide value={item.alt ?? ''} onChange={(alt) => set({ alt })} />
          <TextField
            label="caption"
            wide
            value={item.caption ?? ''}
            onChange={(caption) => set({ caption })}
          />
        </Section>
      )}

      {isShape && (
        <Section title="Shape">
          <SelectField
            label="Shape"
            value={(item.shape ?? 'line') as ShapeKind}
            options={SHAPE_KINDS}
            onChange={(shape) => set({ shape })}
          />
          <TextField label="Colour" type="color" value={item.color ?? '#111111'} onChange={(color) => set({ color })} />
          {(item.shape === 'rect' || item.shape === 'ellipse') && (
            <TextField label="Fill" type="color" value={item.fill ?? '#ffffff'} onChange={(fill) => set({ fill })} />
          )}
          <NumberField
            label="Stroke"
            value={item.strokeWidth}
            allowEmpty
            emptyLabel="2"
            onChange={(strokeWidth) => set({ strokeWidth })}
          />
          {item.shape === 'rect' && (
            <NumberField
              label="Radius"
              value={item.radius}
              allowEmpty
              emptyLabel="0"
              onChange={(radius) => set({ radius })}
            />
          )}
          <div className="cms-hint">
            The wobble is seeded from the item id, so it is identical here, in the preview and on the
            published page.
          </div>
        </Section>
      )}

      <Section title="Anchor">
        <AnchorPicker doc={doc} value={item.anchor} onChange={(anchor) => set({ anchor })} />
      </Section>

      <Section title="Item">
        <div className="cms-hint">
          id <code>{item.id}</code>
        </div>
        <div className="cms-row-actions">
          <button
            type="button"
            className="cms-btn cms-btn--tiny cms-btn--danger"
            data-testid="inspector-delete-item"
            onClick={() => store.deleteCanvasItem(band.id, item.id)}
          >
            Delete item
          </button>
        </div>
      </Section>
    </>
  );
}

/**
 * An anchor ties an item to one prose block, which WS-1 draws as a hand-drawn
 * connector. A dangling anchor is legal (docs/cms-contracts.md 2.2), so the
 * picker shows the stored ids even when they no longer resolve.
 */
function AnchorPicker({
  doc,
  value,
  onChange,
}: {
  doc: Doc;
  value: Anchor | undefined;
  onChange: (next: Anchor | undefined) => void;
}) {
  const choices: { key: string; label: string; anchor: Anchor }[] = [];
  doc.bands.forEach((band, bandIndex) => {
    if (band.type !== 'prose') return;
    band.blocks.forEach((block) => {
      choices.push({
        key: `${band.id}:${block.id}`,
        label: `${bandIndex + 1}. ${block.kind} · ${truncate(blockPlainText(block), 24) || 'empty'}`,
        anchor: { bandId: band.id, blockId: block.id },
      });
    });
  });

  const current = value === undefined ? '' : `${value.bandId}:${value.blockId}`;
  const dangling = value !== undefined && !choices.some((choice) => choice.key === current);

  return (
    <>
      <Field label="Points at">
        <select
          className="cms-select"
          value={dangling ? '__dangling' : current}
          data-testid="anchor-select"
          onChange={(event) => {
            const next = event.target.value;
            if (next === '' || next === '__dangling') {
              onChange(undefined);
              return;
            }
            const choice = choices.find((candidate) => candidate.key === next);
            onChange(choice?.anchor);
          }}
        >
          <option value="">none</option>
          {dangling && <option value="__dangling">missing block (clear to remove)</option>}
          {choices.map((choice) => (
            <option key={choice.key} value={choice.key}>
              {choice.label}
            </option>
          ))}
        </select>
      </Field>
      {dangling && (
        <div className="cms-hint">
          Anchored to <code>{value?.blockId}</code>, which is not in the document. The connector is
          skipped, not an error.
        </div>
      )}
    </>
  );
}

function truncate(text: string, length: number): string {
  if (text.length <= length) return text;
  return `${text.slice(0, length - 1)}…`;
}

