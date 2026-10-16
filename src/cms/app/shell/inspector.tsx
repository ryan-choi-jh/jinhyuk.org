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


import { useRef, useState } from 'react';

import {
  BLOCK_SPACES,
  CALLOUT_TONES,
  DEFAULT_CALLOUT_TONE,
  PROSE_BLOCK_KINDS,
  REFERENCE_WIDTH,
  SHAPE_KINDS,
  slugProblem,
  slugToFollow,
} from '../../schema.ts';
import type { Anchor, BlockSpace, CanvasBand, CanvasItem, Doc, ProseBand, ProseBlock, ProseBlockKind, ShapeKind } from '../../schema.ts';
import { SPACE_SCALE } from '../../styles/spacing.ts';
import { drawsCover } from '../../render/index.ts';
import { isPhotoFile, rejectedFileMessage } from '../records/uploads.ts';
import { blockPlainText, emptyProseBlocks, mergeTargetFor } from '../state/doc-ops.ts';
import { resolveSelection } from '../state/selection.ts';
import type { Selection } from '../state/selection.ts';
import type { DocStore, DocStoreState } from '../state/store.ts';
import { CheckField, DateField, Field, NumberField, Section, SelectField, TextField } from './fields.tsx';
import { useOptionalSiteStore } from '../state/use-site-store.ts';
import type { EditorShellSlots } from './slots.ts';

/* -------------------------------------------------------------------------- */
/* Space above a block                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The sizes, with the default NAMED rather than blank.
 *
 * An empty first option would read as "no space", and the default is not no
 * space: it is whatever the two blocks either side already make between
 * them, which is 27px for two paragraphs and 8px after a heading.
 */
const SPACE_OPTIONS = [
  { value: 'default' as const, label: 'Default' },
  ...BLOCK_SPACES.map((space) => ({
    value: space,
    label: `${space[0]!.toUpperCase()}${space.slice(1)} · ${SPACE_SCALE[space].wide}px`,
  })),
];

/**
 * What the chosen size actually does, in words.
 *
 * It is a FLOOR and not an addition: the rule is a `margin-top`, it adjoins
 * the previous block's `margin-bottom`, and adjoining margins collapse to
 * the larger of the two. Saying "adds 48px" would be wrong, and would have
 * people stacking them to get more, which is exactly the misunderstanding
 * that empty rows caused and that this control exists to end.
 */
function spaceHint(space: BlockSpace | undefined): string {
  if (space === undefined) {
    return 'Whatever the blocks either side already make: 27px between paragraphs, 8px after a heading.';
  }
  const { wide, narrow } = SPACE_SCALE[space];
  return `At least ${wide}px above this block, ${narrow}px on a phone. A floor, not an addition: if what is above it already leaves more, the larger wins.`;
}

export type InspectorProps = {
  store: DocStore;
  state: DocStoreState;
  slots: EditorShellSlots;
  /** The shell's, so a just-uploaded cover's thumbnail loads. Identity by default. */
  resolveMediaSrc?: (src: string) => string;
};

const identity = (src: string): string => src;

export function Inspector({ store, state, slots, resolveMediaSrc = identity }: InspectorProps) {
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

      {resolved.kind === 'none' && <PagePanel store={store} state={state} resolveMediaSrc={resolveMediaSrc} />}

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

/**
 * The slug, and renaming it.
 *
 * It used to be a read-only box with a note saying renaming happens "in the
 * entry list on the left (the ✎ beside this page)". That is true and it is
 * not findable: the rail is collapsed most of the time, the pencil is small,
 * and the field you are looking at when you want to change the address is
 * this one. So the field does it.
 *
 * A RENAME IS NOT AN EDIT, and the button keeps saying so. Typing in the box
 * changes nothing; the move happens on the button, in one commit, and leaves
 * the old address redirecting if there was ever a page at it. That is why
 * this is not simply `onChange` into `updateMeta` — a slug typed one
 * character at a time would be five renames and five redirects.
 *
 * Offered only where the shell can do it: the site store is absent in the
 * standalone editor and in the harnesses, and `home` is a singleton whose
 * address is its section and cannot move.
 */
function SlugField({ store, state }: { store: DocStore; state: DocStoreState }) {
  const siteStore = useOptionalSiteStore();
  const meta = state.doc.meta;
  const [typed, setTyped] = useState(meta.slug);
  const [busy, setBusy] = useState(false);

  // Follow the document when it changes underneath — switching entries, or
  // the rename landing and the store reporting the new slug.
  const seen = useRef(meta.slug);
  if (seen.current !== meta.slug) {
    seen.current = meta.slug;
    if (typed !== meta.slug) setTyped(meta.slug);
  }

  // The store's own answer, not a guess from the section id: whether a
  // rename is possible depends on the API behind it having the method at
  // all, which `can()` already decides for the entry list's pencil.
  const singleton = meta.section === 'home';
  const canRename =
    siteStore !== null && meta.section !== undefined && siteStore.can(meta.section).rename;
  const wanted = typed.trim();
  const changed = wanted !== meta.slug;
  /*
   * The DOCUMENT's slug rule, which is lowercase kebab-case and has no
   * length limit. It was `IdSchema` — the rule for block and band ids,
   * which caps at 64 characters and allows uppercase and underscores. A
   * perfectly legal 69-character slug was therefore refused by the editor
   * and would have been accepted by the server, under a hint naming a rule
   * it had not broken. A client stricter than the server is how a legal
   * value becomes unreachable.
   */
  const problem = slugProblem(wanted);
  const legal = problem === null;

  // Still taking its address from its title: a page that has never been
  // published and that nobody has renamed. The same rule the save uses.
  const following = meta.slugFromTitle === true && state.published === null;
  const fromTitle = slugToFollow(state.doc, state.published);

  const rename = async (): Promise<void> => {
    if (siteStore === null || !changed || !legal || meta.section === undefined) return;
    setBusy(true);
    /*
     * Renaming by hand is how you take the address over: from here the slug
     * is yours and the title cannot move it again. That has to be recorded
     * on the DOCUMENT, so it survives a reload — getting it wrong by
     * forgetting would mean a published page's URL moving by itself.
     *
     * And it has to be written BEFORE the move, not after. `renameEntry`
     * throws this document's store away (it is keyed to a slug that no
     * longer exists) and a fresh one is built from the file on disk, so
     * anything set afterwards is set on a dead object. The first version
     * did exactly that and the address kept following the title.
     */
    if (following) {
      store.updateMeta({ slugFromTitle: false });
      if (!(await store.save())) {
        setBusy(false);
        return;
      }
    }
    const ok = await siteStore.renameEntry(meta.section, meta.slug, wanted);
    setBusy(false);
    if (!ok) setTyped(meta.slug);
  };

  return (
    <>
      <Field label="Slug">
        <div className="cms-slug">
          <input
            className="cms-input"
            value={typed}
            readOnly={!canRename}
            disabled={busy}
            data-testid="meta-slug"
            aria-label="Slug"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && changed && legal) void rename();
              if (event.key === 'Escape') setTyped(meta.slug);
            }}
          />
          {canRename && (
            <button
              type="button"
              className="cms-btn cms-btn--tiny"
              data-testid="meta-slug-rename"
              disabled={busy || !changed || !legal}
              onClick={() => void rename()}
            >
              {busy ? 'Renaming…' : 'Rename'}
            </button>
          )}
        </div>
      </Field>
      <div className="cms-hint" data-testid="meta-slug-hint">
        {singleton
          ? 'The homepage is at / and has no slug to change.'
          : !canRename
            ? 'The slug is the file name under src/content/, and the last part of the address.'
            : changed && problem !== null
              ? problem
              : changed
                ? `Renaming moves the file and the address in one commit. ${
                    state.published === null
                      ? 'This page has never been published, so nothing is redirecting anywhere.'
                      : `/${meta.section}/${meta.slug}/ will keep working, redirecting to the new address.`
                  }${following ? ' It also stops the address following the title.' : ''}`
                : following
                  ? fromTitle === null
                    ? 'Taken from the title, and it keeps up with it until this page is published. Rename to set it yourself.'
                    : `Taken from the title: saving moves this page to /${meta.section}/${fromTitle}/. It keeps up until the page is published.`
                  : 'The last part of the address, and the file name under src/content/. Changing it is a move, not an edit, so it happens on the button.'}
      </div>
    </>
  );
}

/**
 * The essay's cover: pick a picture, it is uploaded and becomes `meta.cover`;
 * describe it, and that becomes `meta.coverAlt`.
 *
 * Offered only where the masthead draws one (`drawsCover`, next to the
 * renderer), so a project or the homepage never collects a cover that would
 * appear nowhere. Before this it was a free-text path box on every page,
 * which nothing read.
 *
 * The upload goes through the document store's own API, the same call a
 * canvas image makes, so the file lands in this page's media folder and the
 * stub APIs the harnesses run on answer it too. The thumbnail goes through
 * `resolveMediaSrc` because a file uploaded a minute ago is on the branch and
 * in no build yet.
 *
 * The description is only asked for once there is a picture to describe;
 * `updateMeta` would drop one typed before, so a box for it would refuse
 * every keystroke.
 */
function CoverSection({
  store,
  state,
  resolveMediaSrc,
}: {
  store: DocStore;
  state: DocStoreState;
  resolveMediaSrc: (src: string) => string;
}) {
  const meta = state.doc.meta;
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // WHICH src failed, not a flag: undo can bring back a different cover, and
  // a flag left over from the last one would hide a picture that loads.
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const broken = meta.cover !== undefined && brokenSrc === meta.cover;

  const upload = async (file: File): Promise<void> => {
    if (!isPhotoFile(file)) {
      setProblem(rejectedFileMessage(file.name));
      return;
    }
    setProblem(null);
    setUploading(file.name);
    try {
      const result = await store.api.uploadMedia(state.slug, file);
      setSize({ w: result.w, h: result.h });
      store.updateMeta({ cover: result.src });
    } catch (error) {
      setProblem(`The cover did not upload: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setUploading(null);
    }
  };

  const busy = uploading !== null || state.phase !== 'idle';

  return (
    <Section title="Cover">
      {meta.cover !== undefined &&
        (broken ? (
          <div className="cms-hint cms-hint--error" data-testid="meta-cover-thumb">
            The image at {meta.cover} could not be loaded here.
          </div>
        ) : (
          <div className="cms-cover-thumb" data-testid="meta-cover-thumb">
            <img src={resolveMediaSrc(meta.cover)} alt="" onError={() => setBrokenSrc(meta.cover ?? null)} />
          </div>
        ))}
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        data-testid="meta-cover-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared at once, so choosing the same file again still fires.
          event.target.value = '';
          if (file !== undefined) void upload(file);
        }}
      />
      <div className="cms-row-actions">
        <button
          type="button"
          className="cms-btn cms-btn--tiny"
          data-testid="meta-cover-pick"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {meta.cover === undefined ? 'Upload a cover…' : 'Replace…'}
        </button>
        {meta.cover !== undefined && (
          <button
            type="button"
            className="cms-btn cms-btn--tiny cms-btn--danger"
            data-testid="meta-cover-remove"
            disabled={busy}
            onClick={() => {
              setSize(null);
              store.updateMeta({ cover: undefined });
            }}
          >
            Remove
          </button>
        )}
      </div>
      {uploading !== null && (
        <div className="cms-hint" data-testid="meta-cover-uploading">
          Uploading {uploading}…
        </div>
      )}
      {problem !== null && (
        <div className="cms-hint cms-hint--error" data-testid="meta-cover-problem">
          {problem}
        </div>
      )}
      {meta.cover !== undefined && (
        <TextField
          label="Description"
          wide
          testId="meta-cover-alt"
          value={meta.coverAlt ?? ''}
          placeholder="What the picture shows"
          onChange={(coverAlt) => store.updateMeta({ coverAlt })}
        />
      )}
      <div className="cms-hint" data-testid="meta-cover-help">
        {size !== null && size.w < REFERENCE_WIDTH
          ? `This one is ${size.w}px wide, narrower than the ${REFERENCE_WIDTH}px the page draws it at, so it will look soft. `
          : ''}
        Shown across the top of the essay as a 3.75:1 strip, which trims the top and bottom, and as the picture when
        the link is shared, cropped to about 1.9:1. Make it about 2:1 with the subject in a band across the middle
        and both crops keep it.
      </div>
    </Section>
  );
}

function PagePanel({
  store,
  state,
  resolveMediaSrc,
}: {
  store: DocStore;
  state: DocStoreState;
  resolveMediaSrc: (src: string) => string;
}) {
  const meta = state.doc.meta;
  return (
    <>
      <Section title="Page">
        <TextField label="Title" testId="meta-title" value={meta.title} onChange={(title) => store.updateMeta({ title })} />
        <SlugField store={store} state={state} />
        <DateField label="Date" testId="meta-date" value={meta.date} onChange={(date) => store.updateMeta({ date })} />
        <CheckField
          label="Hidden from the site"
          testId="meta-hidden"
          checked={meta.hidden === true}
          onChange={(hidden) => store.updateMeta({ hidden })}
        />
        <div className="cms-hint">
          {meta.hidden === true
            ? 'There is no page at this address while this is on: not listed, and not built, so the URL returns a 404. The file stays here and you can keep editing it; turning this off puts the page back.'
            : 'Take the page off the site without deleting it. It stays in this list and stays editable.'}
        </div>
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
          label="Link label"
          wide
          testId="meta-url-label"
          value={meta.urlLabel ?? ''}
          placeholder="Visit"
          onChange={(urlLabel) => store.updateMeta({ urlLabel: urlLabel === '' ? undefined : urlLabel })}
        />
      </Section>

      {drawsCover(meta.section) && <CoverSection store={store} state={state} resolveMediaSrc={resolveMediaSrc} />}

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
            onClick={() => store.validateAloud()}
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
  // Rows with no text in them: a full line in the editor, nothing on the
  // page. Counted here so the offer to clear them only appears when there is
  // something to clear.
  const emptyRows = band.type === 'prose' ? emptyProseBlocks(band).length : 0;
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
          <NumberField
            label="Space below"
            testId="band-pad-bottom"
            value={band.padBottom ?? 0}
            step={8}
            onChange={(padBottom) => {
              if (padBottom !== undefined) store.setBandPadBottom(band.id, Math.max(0, padBottom));
            }}
          />
          {/* The height follows the contents now (`fitted` in doc-ops), so
              there is no Fit button to press: moving or resizing anything
              re-measures the band. Typing a height still works and still
              matters on an empty canvas, which has nothing to measure.
              "Space below" is how you ask for room the fit will keep. */}
          {(() => {
            // Three bands each holding one picture can look like a single row
            // on the page, and until this the only way to get a picture out of
            // one and into another was to upload it again.
            const target = mergeTargetFor(doc, band.id);
            return (
              <button
                type="button"
                className="cms-btn cms-btn--tiny"
                data-testid="band-merge-up"
                disabled={target === null}
                title={
                  target === null
                    ? 'Nothing above this to merge into: the band above is not a canvas.'
                    : `Move these ${band.items.length} item${band.items.length === 1 ? '' : 's'} into the canvas above and remove this band. They keep their positions.`
                }
                onClick={() => store.mergeCanvasBandUp(band.id)}
              >
                Merge into the canvas above
              </button>
            );
          })()}
          <div className="cms-hint" data-testid="band-height-hint">
            {band.items.length === 0
              ? 'Nothing on this canvas yet, so the height is whatever you set here.'
              : 'Follows the contents: move or resize anything and the canvas ends at the lowest item.'}
          </div>
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
          {emptyRows > 0 && (
            <>
              <div className="cms-row-actions">
                <button
                  type="button"
                  className="cms-btn cms-btn--tiny"
                  data-testid="remove-empty-rows"
                  onClick={() => store.removeEmptyProseBlocks(band.id)}
                >
                  Remove {emptyRows} empty row{emptyRows === 1 ? '' : 's'}
                </button>
              </div>
              <div className="cms-hint">
                An empty row is a full line here and nothing at all on the page: its margins
                collapse into its neighbours&rsquo;. Use &ldquo;Space above&rdquo; on a block to
                ask for room.
              </div>
            </>
          )}
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
        {block.kind === 'callout' && (
          <>
            <SelectField
              label="Colour"
              testId="block-tone"
              value={block.tone ?? DEFAULT_CALLOUT_TONE}
              options={CALLOUT_TONES}
              // The default is stored as nothing, like every other optional.
              onChange={(tone) =>
                store.setBlockTone(band.id, block.id, tone === DEFAULT_CALLOUT_TONE ? undefined : tone)
              }
            />
            <div className="cms-hint">
              A paragraph set apart in a tinted box. Lighter than the text colours and the
              highlighter, because this is a ground behind a whole paragraph rather than a stroke
              behind a few words. Each colour has a light and a dark value, so the box follows the
              theme.
            </div>
          </>
        )}
        <SelectField
          label="Space above"
          testId="block-space"
          value={block.space ?? 'default'}
          options={SPACE_OPTIONS}
          disabled={bandIndex === 0 && blockIndex === 0}
          onChange={(space) =>
            store.setBlockSpace(band.id, block.id, space === 'default' ? undefined : space)
          }
        />
        <div className="cms-hint">
          {bandIndex === 0 && blockIndex === 0
            ? 'The first block of the page has nothing above it to be spaced from, and the masthead already leaves the room it needs.'
            : spaceHint(block.space)}
        </div>
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
          {item.caption !== undefined && item.caption !== '' && (
            <SelectField
              label="Align"
              value={item.captionAlign ?? 'left'}
              options={[
                { value: 'left' as const, label: 'Left' },
                { value: 'center' as const, label: 'Centre' },
                { value: 'right' as const, label: 'Right' },
              ]}
              // Left is the default, so it is stored as nothing rather than as
              // the word "left": the same reason `overlay` is absent when off.
              onChange={(captionAlign) =>
                set({ captionAlign: captionAlign === 'left' ? undefined : captionAlign })
              }
            />
          )}
          {item.kind === 'video' && (
            <>
              <TextField
                label="poster"
                wide
                testId="item-poster"
                value={item.poster ?? ''}
                placeholder="/media/slug/poster.jpg"
                onChange={(poster) => set({ poster: poster === '' ? undefined : poster })}
              />
              <div className="cms-hint">
                The still shown before play. Without one the player is a black rectangle. Match the
                video&rsquo;s aspect ratio, or it is cropped the same way the video is.
              </div>
            </>
          )}
          {item.kind === 'image' && (
            <>
              <CheckField
                label="Click to enlarge"
                testId="item-zoom"
                checked={item.zoom === true}
                // Off is stored as nothing, like `overlay`.
                onChange={(zoom) => set({ zoom: zoom ? true : undefined })}
              />
              <div className="cms-hint">
                For a figure that cannot be read where it sits: a diagram drawn for the full
                column, which on a phone becomes a full-width block. Opens at the size it was
                drawn at, so the reader pans rather than squints.
              </div>
            </>
          )}
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

