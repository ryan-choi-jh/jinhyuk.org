/**
 * src/cms/app/index.tsx
 *
 * WS-8 EDITOR INTEGRATION. The real application: one file that makes six
 * separately built pieces into a thing a person can use.
 *
 *   WS-2  src/cms/server/client.ts     the API, over HTTP, as a real client
 *   WS-3  src/cms/app/shell/           the frame, the store, undo, dirty
 *   WS-4  src/cms/app/canvas/          dragging, resizing, rotating, snapping
 *   WS-5  src/cms/app/prose/           TipTap, per block
 *   WS-6  src/cms/assets/              the shape generators and the picker
 *   WS-7  src/cms/preview/             where Preview goes
 *
 * This file owns the wiring and nothing else. Where a component needed a
 * behaviour it did not have, the behaviour is added here, in this layer, and
 * is commented with which seam it closes. No file belonging to another
 * workstream is edited.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR SEAMS, in the order they bit
 * ---------------------------------------------------------------------------
 *
 * 1. PROSE EMITS A BLOCK, THE SLOT TAKES CONTENT. WS-5's editor returns a
 *    whole `ProseBlock` because its toolbar owns block kind; WS-3's slot takes
 *    `content` only and owns kind through `store.setBlockKind`, which converts
 *    the text with WS-3's own converter. Doing both in sequence is two undo
 *    steps and two conversions, the second overwriting the first. So the whole
 *    block goes in through one `store.update` (../integration/doc-edits.ts),
 *    which is the escape hatch WS-3 documents for exactly this.
 *
 * 2. THE STAGE IS ALREADY SCALED. WS-3's page surface scales an ancestor with
 *    a CSS transform, and WS-4's canvas scales itself by default. Both at once
 *    would square the zoom. `applyTransform={false}` with the same `scale`
 *    number is the documented combination; the pointer maths still divides by
 *    it.
 *
 * 3. WS-4 RENDERS `item.src` DIRECTLY. WS-3's slot hands over
 *    `resolveMediaSrc`, which exists because media the author just uploaded is
 *    in git but not in this deployment's `public/`, but WS-4's component has
 *    no prop for it. Rather than reach into WS-4, items are projected on the
 *    way in and un-projected on the way out (../integration/media.ts): the
 *    component only ever writes geometry, so restoring each `src` by id is
 *    exact.
 *
 * 4. SHAS ARE NOT IN WS-3's MODEL. WS-2's writes take a blob-sha expectation
 *    so a concurrent commit is a 409 instead of a silent overwrite, and WS-3's
 *    `CmsApi` has no idea shas exist. The bookkeeping lives in the adapter
 *    (../integration/api.ts), seeded by the route that already read the page.
 */

import {
  StrictMode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { REFERENCE_WIDTH, shapeSpecFromItem } from '../schema.ts';
import type { CanvasBand, CanvasItem, Doc, ProseBlock, SectionId } from '../schema.ts';
import type { RecordSectionDef } from '../sections.ts';
import { generateShape } from '../assets/shapes.ts';
import AssetPicker from '../assets/AssetPicker.tsx';
// The guide and the component library were built outside the section
// workflow, so nothing mounted them. They are self-contained; this file is
// the only place that knows they exist.
import { GuideButton, GuideOverlay, useGuide } from './guide/index.ts';
import { LibraryBrowser } from './library/index.ts';
import { draftToItem } from '../assets/draft.ts';
import type { ShapeDraft } from '../assets/draft.ts';
import { previewHref } from '../preview/state.ts';
import type { MediaUpload } from '../server/client.ts';

import { CanvasEditor } from './canvas/index.ts';
import { ProseEditor } from './prose/index.ts';
import { EditorShell, SiteShell } from './shell/index.ts';
import type {
  CanvasBandSlotProps,
  InspectorSlotProps,
  ProseBlockSlotProps,
  RecordEditorSlotProps,
  RecordToolbarSlotProps,
  ToolbarSlotProps,
} from './shell/index.ts';
import { recordEditorSlot } from './records/index.ts';
import {
  createBrowserNavigator,
  createDocStore,
  createSiteStore,
  mediaSlugFor,
  selectBlock,
  selectItems,
  useDocStoreSelector,
  useSiteStoreState,
} from './state/index.ts';
import type { DocStore, Navigator as AppNavigator, PageSummary, SiteStore } from './state/index.ts';

import { conflictMessage, createCmsApi } from './integration/api.ts';
import type { CmsApiAdapter, SlugShas } from './integration/api.ts';
import { createSiteApi } from './integration/site-api.ts';
import type { EntryShas, SiteApiAdapter, SiteUploadOptions } from './integration/site-api.ts';
import { addCanvasItemAt, firstCanvasBand, replaceProseBlock } from './integration/doc-edits.ts';
import {
  freshItemId,
  itemKindForFile,
  makeMediaResolver,
  mediaItem,
  nextZ,
  placeCentred,
  projectItemSrc,
  restoreItemSrc,
  takenIds,
  unsupportedFileMessage,
} from './integration/media.ts';
import type { Point } from './integration/media.ts';
import { useIntegrationStyles } from './integration/styles.ts';

/* -------------------------------------------------------------------------- */
/* Props: what the route hands over                                            */
/* -------------------------------------------------------------------------- */

export type CmsEditorProps = {
  /** The URL slug. Must equal `doc.meta.slug` or WS-2 refuses the write. */
  slug: string;
  /** The document to edit: the draft if there is one, else the published page. */
  doc: Doc;
  /** The published page, for reference and for discarding a draft. */
  published?: Doc | null;
  hasDraft?: boolean;
  /**
   * Blob shas the route already read, so the first save carries an expectation
   * instead of trusting whatever is in the repo by the time it lands.
   */
  shas?: Partial<SlugShas>;
  /** `owner/name` and the branch being edited, for resolving `/media/` srcs. */
  repo?: string | null;
  branch?: string | null;
  /** True when this slug has no page yet and `doc` is a blank starter. */
  isNew?: boolean;
  /** Point the client at another origin. Only used by the offline harness. */
  baseUrl?: string;
  /** Swap the transport. Only used by the offline harness. */
  fetchImpl?: typeof fetch;
  /** Skip the auth call on mount. Only used by the offline harness. */
  checkAuthOnMount?: boolean;
};

/* -------------------------------------------------------------------------- */
/* Integration context                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What the slots need from whichever host mounted them.
 *
 * WS-G: there are now two hosts — `<CmsEditor>`, the phase 1 single-document
 * editor, and `<CmsApp>`, the whole-site application. The slots below are
 * shared between them unchanged, so everything host-specific is behind this
 * one object rather than duplicated per host.
 *
 * `upload` is the interesting member. Phase 1 bound it to one slug; the site
 * app binds it to whichever entry is open, read at call time from the site
 * store. Either way the slot passes a file and gets WS-C's whole upload back.
 */
type Integration = {
  /** Upload into the open entry's own media directory. */
  upload: (file: File, filename?: string) => Promise<MediaUpload>;
  /** Where to send the browser to sign in again, when the session has gone. */
  loginUrl: string | null;
  /** Discard local state and take what is in the repo. */
  reload: () => void;
  /**
   * Phase 1's single-page host only: the one-slug adapter, its store and its
   * slug, which is what the page switcher in the toolbar is built from. Null
   * inside `<CmsApp>`, where the sidebar and the entry list do that job and a
   * second switcher would be two ways to go to two different places.
   */
  legacy: { api: CmsApiAdapter; store: DocStore; slug: string } | null;
};

const IntegrationContext = createContext<Integration | null>(null);

function useIntegration(): Integration {
  const value = useContext(IntegrationContext);
  if (value === null) throw new Error('useIntegration outside <CmsEditor> or <CmsApp>');
  return value;
}

/* -------------------------------------------------------------------------- */
/* The app                                                                     */
/* -------------------------------------------------------------------------- */

export function CmsEditor(props: CmsEditorProps) {
  useIntegrationStyles();

  const [loginUrl, setLoginUrl] = useState<string | null>(null);

  // The adapter and the store are built once. Both are mutable objects with
  // their own identity; rebuilding either on a re-render would throw away the
  // undo history and the sha bookkeeping.
  const [{ api, store }] = useState(() => {
    // `onConflict` fires from inside a call the store itself made, so it
    // cannot close over a store that does not exist yet. One box, filled in
    // two lines later, rather than a module-level variable.
    const box: { store: DocStore | null } = { store: null };
    const adapter = createCmsApi({
      ...(props.baseUrl === undefined ? {} : { baseUrl: props.baseUrl }),
      ...(props.fetchImpl === undefined ? {} : { fetch: props.fetchImpl }),
      initial: { [props.slug]: props.shas ?? { draftSha: null, publishedSha: null } },
      onSignedOut: (url) => setLoginUrl(url),
      onConflict: (_conflict, message) => {
        // The store already shows "Save failed: <message>" from the rejection.
        // This replaces it with the same sentence plus the one thing WS-2
        // cannot know: what to do about it in this editor.
        //
        // The setTimeout is not a flourish. This callback fires inside the
        // rejected call, and the store writes its own notice in the `catch`
        // that follows, which is a microtask later. Notifying synchronously
        // would be overwritten; a macrotask lands after it.
        setTimeout(() => box.store?.notify('error', conflictMessage(message)), 0);
      },
    });
    const created = createDocStore({
      api: adapter,
      doc: props.doc,
      published: props.published ?? null,
      hasDraft: props.hasDraft ?? false,
    });
    box.store = created;
    return { api: adapter, store: created };
  });

  const reload = useCallback(() => {
    const state = store.getState();
    if (state.dirty && typeof window !== 'undefined') {
      const go = window.confirm(
        'Reload from the repository? Unsaved changes in this tab will be lost.',
      );
      if (!go) return;
    }
    void store.loadPage(state.slug);
  }, [store]);

  const auth = useDocStoreSelector(store, (state) => state.auth);
  const repo = (auth as { repo?: string } | null)?.repo ?? props.repo ?? null;
  const branch = (auth as { branch?: string } | null)?.branch ?? props.branch ?? null;

  const resolveMediaSrc = useMemo(() => makeMediaResolver(repo, branch), [repo, branch]);

  const integration = useMemo<Integration>(
    () => ({
      upload: (file, filename) => api.uploadMediaDetailed(props.slug, file, filename ?? file.name),
      loginUrl,
      reload,
      legacy: { api, store, slug: props.slug },
    }),
    [api, store, props.slug, loginUrl, reload],
  );

  // A brand-new page says so once, rather than looking like a page that lost
  // its content.
  const announced = useRef(false);
  useEffect(() => {
    if (announced.current || props.isNew !== true) return;
    announced.current = true;
    store.notify(
      'info',
      `No page “${props.slug}” yet. Saving will create src/content/drafts/${props.slug}.json; publishing will create the page.`,
    );
  }, [props.isNew, props.slug, store]);

  return (
    <IntegrationContext.Provider value={integration}>
      <EditorShell
        store={store}
        resolveMediaSrc={resolveMediaSrc}
        previewUrl={(slug) => previewHref(slug, { version: 'draft' })}
        checkAuthOnMount={props.checkAuthOnMount ?? true}
        renderProseBlock={renderProseBlock}
        renderCanvasBand={renderCanvasBand}
        renderInspectorExtra={renderInspectorExtra}
        renderToolbarExtra={renderToolbarExtra}
      />
    </IntegrationContext.Provider>
  );
}

/* -------------------------------------------------------------------------- */
/* Slot: prose (WS-5 into WS-3)                                                */
/* -------------------------------------------------------------------------- */

const renderProseBlock = (props: ProseBlockSlotProps): ReactNode => (
  <ProseSlot key={props.block.id} {...props} />
);

function ProseSlot({ store, band, block, onSelect }: ProseBlockSlotProps) {
  const handleChange = useCallback(
    (next: ProseBlock) => {
      const kindChanged = next.kind !== block.kind;
      store.update((doc) => replaceProseBlock(doc, band.id, next), {
        label: kindChanged ? `set block to ${next.kind}` : 'edit text',
        // Typing coalesces into one undo step; a kind change is its own step,
        // so ⌘Z after converting a paragraph to a heading undoes the
        // conversion and not the sentence before it.
        coalesceKey: kindChanged ? undefined : `prose:${block.id}`,
        selection: selectBlock(band.id, block.id),
      });
    },
    [store, band.id, block.id, block.kind],
  );

  const handleFocus = useCallback(
    (focused: boolean) => {
      if (focused) onSelect();
    },
    [onSelect],
  );

  return (
    <ProseEditor
      block={block}
      onChange={handleChange}
      onFocusChange={handleFocus}
      // WS-5's toolbar owns kind, and `handleChange` writes kind and content
      // in one step, so the six kind buttons are kept. WS-3's outline and
      // inspector change the same field through the store; both end up in the
      // same place, so they cannot disagree.
      showKindControls
      onContentError={(message) => store.notify('error', `Text block: ${message}`)}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Slot: canvas (WS-4 into WS-3), plus drop-to-upload                          */
/* -------------------------------------------------------------------------- */

const renderCanvasBand = (props: CanvasBandSlotProps): ReactNode => (
  <CanvasSlot key={props.band.id} {...props} />
);

/** WS-6's generator, wired exactly as docs/cms-contracts.md 5.2 says. */
function drawShape(item: CanvasItem): string | null {
  const spec = shapeSpecFromItem(item);
  return spec === null ? null : generateShape(spec);
}

function CanvasSlot({
  store,
  band,
  items,
  selectedItemIds,
  stageHeight,
  scale,
  onChange,
  onSelectItems,
  resolveMediaSrc,
}: CanvasBandSlotProps) {
  const { upload: uploadFile } = useIntegration();
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);

  // SEAM 3. Project `src` for display, restore it on the way back out.
  const shown = useMemo(() => projectItemSrc(items, resolveMediaSrc), [items, resolveMediaSrc]);
  const handleChange = useCallback(
    (next: CanvasItem[]) => onChange(restoreItemSrc(next, items)),
    [onChange, items],
  );

  const selection = useMemo(() => [...selectedItemIds], [selectedItemIds]);

  /** A pointer position in the band's own reference px. */
  const pointToRef = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const host = hostRef.current;
      if (host === null) return null;
      // getBoundingClientRect() is the SCALED box (WS-3's slot contract says
      // so), hence the division. One place, like WS-4's clientToRef.
      const rect = host.getBoundingClientRect();
      const factor = scale === 0 ? 1 : scale;
      return { x: (clientX - rect.left) / factor, y: (clientY - rect.top) / factor };
    },
    [scale],
  );

  const upload = useCallback(
    async (files: readonly File[], at: Point | null) => {
      const accepted: { file: File; kind: 'image' | 'video' }[] = [];
      for (const file of files) {
        const kind = itemKindForFile(file.name, file.type);
        if (kind === null) {
          store.notify('error', unsupportedFileMessage(file.name));
          continue;
        }
        accepted.push({ file, kind });
      }
      if (accepted.length === 0) return;

      setBusy(true);
      try {
        let step = 0;
        for (const { file, kind } of accepted) {
          const result = await uploadFile(file, file.name);
          const id = freshItemId(store.getState().doc);
          // Several files dropped at once cascade from the drop point rather
          // than landing exactly on top of each other.
          const where =
            at === null ? null : { x: at.x + step * 28, y: at.y + step * 28 };
          store.update(
            (doc) =>
              addCanvasItemAt(doc, band.id, (target) =>
                mediaItem(id, kind, result, target, where, step),
              ),
            {
              label: 'add media',
              selection: selectItems(band.id, [id]),
              notice:
                result.dimensions === 'fallback'
                  ? `${file.name} added. Its real size could not be read from the file, so it was placed at 1280×720; resize it or type the numbers in the inspector.`
                  : `${file.name} added at ${result.w}×${result.h}.`,
            },
          );
          step += 1;
        }
      } catch (error) {
        store.notify('error', `Upload failed: ${messageOf(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [band.id, store, uploadFile],
  );

  return (
    <div
      ref={hostRef}
      className="ws8-canvas"
      data-dropping={dropping ? 'true' : 'false'}
      data-busy={busy ? 'true' : 'false'}
      data-ws8-canvas={band.id}
      // A drag carrying files is the only thing this intercepts. Dragging an
      // item is a pointer gesture inside WS-4 and never a DragEvent, so the
      // two cannot be confused.
      onDragOver={(event) => {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={(event) => {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        setDropping(false);
        const at = pointToRef(event.clientX, event.clientY);
        void upload([...event.dataTransfer.files], at);
      }}
    >
      <CanvasEditor
        items={shown}
        height={stageHeight}
        // SEAM 2: the page surface already scales an ancestor.
        scale={scale}
        applyTransform={false}
        selection={selection}
        onSelectionChange={onSelectItems}
        onChange={handleChange}
        renderShape={drawShape}
      />
    </div>
  );
}

function hasFiles(transfer: DataTransfer | null): boolean {
  if (transfer === null) return false;
  if (transfer.files.length > 0) return true;
  return [...transfer.types].includes('Files');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------------- */
/* Slot: inspector extra — upload a file, insert an asset                      */
/* -------------------------------------------------------------------------- */

const renderInspectorExtra = (props: InspectorSlotProps): ReactNode => <InsertPanel {...props} />;

function InsertPanel({ store, state, resolved }: InspectorSlotProps) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [videoLink, setVideoLink] = useState('');
  const { upload: uploadFile } = useIntegration();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Which canvas gets it. Whatever is selected, if that is a canvas; failing
  // that the first canvas band in the document, named so it is never a
  // surprise where an insert went.
  const selected: CanvasBand | null =
    resolved.kind === 'item'
      ? resolved.band
      : resolved.kind === 'band' && resolved.band.type === 'canvas'
        ? resolved.band
        : null;
  const fallback = selected === null ? firstCanvasBand(state.doc) : null;
  const target = selected ?? fallback;
  const targetIndex =
    target === null ? -1 : state.doc.bands.findIndex((band) => band.id === target.id);

  // The library hands over a finished CanvasItem rather than a shape draft,
  // so this only has to place it and keep its id unique. A shape's id carries
  // its hand-drawn seed, so it is preserved unless it genuinely collides.
  const insertFromLibrary = useCallback(
    (item: CanvasItem) => {
      if (target === null) return;
      const taken = takenIds(state.doc);
      const collided = taken.has(item.id);
      const id = collided ? freshItemId(state.doc) : item.id;
      store.update(
        (doc) =>
          addCanvasItemAt(doc, target.id, (band) => {
            const box = placeCentred(
              { w: item.w, h: item.h },
              { width: REFERENCE_WIDTH, height: band.height },
              step,
            );
            return { ...item, id, x: box.x, y: box.y, z: nextZ(band.items) };
          }),
        {
          label: 'insert from library',
          selection: selectItems(target.id, [id]),
          notice: collided
            ? 'Inserted, redrawn: the id it was previewed with is already used on this page.'
            : 'Inserted from the library.',
        },
      );
      setLibraryOpen(false);
    },
    [target, state.doc, store, step],
  );

  // A pasted video link becomes an `embed` item. Everything downstream of this
  // already worked: the renderer rewrites a YouTube or Vimeo URL to its embed
  // form and the canvas shows it. There was simply no way to make one.
  const insertVideoLink = useCallback(() => {
    const raw = videoLink.trim();
    if (raw === '' || target === null) return;
    let ok = false;
    try {
      const host = new URL(raw).hostname.replace(/^www\./, '');
      ok = ['youtube.com', 'm.youtube.com', 'youtu.be', 'vimeo.com', 'player.vimeo.com'].includes(host);
    } catch {
      ok = false;
    }
    if (!ok) return;

    const id = freshItemId(state.doc);
    store.update(
      (doc) =>
        addCanvasItemAt(doc, target.id, (band) => {
          // 16:9 at a readable size, the same proportion the film posters use.
          const w = 640;
          const h = Math.round((w * 9) / 16);
          const box = placeCentred({ w, h }, { width: REFERENCE_WIDTH, height: band.height }, step);
          return {
            id,
            kind: 'embed' as const,
            src: raw,
            x: box.x,
            y: box.y,
            w,
            h,
            z: nextZ(band.items),
          };
        }),
      {
        label: 'insert video link',
        selection: selectItems(target.id, [id]),
        notice: 'Inserted a video. It plays on the published page.',
      },
    );
    setVideoLink('');
  }, [videoLink, target, state.doc, store, step]);

  const insertShape = useCallback(
    (draft: ShapeDraft) => {
      if (target === null) return;
      // WS-6's draft carries the id its wobble seed is derived from, so the
      // drawing the author just previewed is the one that lands. Only a real
      // collision overrides it, and then it says so.
      const taken = takenIds(state.doc);
      const collided = taken.has(draft.id);
      const id = collided ? freshItemId(state.doc) : draft.id;
      store.update(
        (doc) =>
          addCanvasItemAt(doc, target.id, (band) => {
            const box = placeCentred(
              { w: draft.w, h: draft.h },
              { width: REFERENCE_WIDTH, height: band.height },
              step,
            );
            return draftToItem(
              { ...draft, id },
              { x: box.x, y: box.y, z: nextZ(band.items) },
            );
          }),
        {
          label: `insert ${draft.shape}`,
          selection: selectItems(target.id, [id]),
          notice: collided
            ? `Inserted a ${draft.shape}, redrawn: the id it was previewed with is already used in this page.`
            : `Inserted a ${draft.shape}.`,
        },
      );
      setStep((value) => value + 1);
    },
    [state.doc, step, store, target],
  );

  const uploadFromInput = useCallback(
    async (files: FileList | null) => {
      if (files === null || files.length === 0 || target === null) return;
      setBusy(true);
      try {
        let index = step;
        for (const file of [...files]) {
          const kind = itemKindForFile(file.name, file.type);
          if (kind === null) {
            store.notify('error', unsupportedFileMessage(file.name));
            continue;
          }
          const result = await uploadFile(file, file.name);
          const id = freshItemId(store.getState().doc);
          store.update(
            (doc) =>
              addCanvasItemAt(doc, target.id, (band) =>
                mediaItem(id, kind, result, band, null, index),
              ),
            {
              label: 'add media',
              selection: selectItems(target.id, [id]),
              notice: `${file.name} added at ${result.w}×${result.h}.`,
            },
          );
          index += 1;
        }
        setStep(index);
      } catch (error) {
        store.notify('error', `Upload failed: ${messageOf(error)}`);
      } finally {
        setBusy(false);
        if (fileRef.current !== null) fileRef.current.value = '';
      }
    },
    [step, store, target, uploadFile],
  );

  if (target === null) {
    return (
      <div className="cms-section ws8-insert" data-testid="insert-panel" data-target="none">
        <span className="cms-section__head">Add</span>
        <div className="cms-hint">
          Media and assets live on a canvas band. This page has none: add one from the outline on
          the left, then select it.
        </div>
      </div>
    );
  }

  return (
    <div className="cms-section ws8-insert" data-testid="insert-panel" data-target={target.id}>
      <span className="cms-section__head">
        Add to band {targetIndex + 1}
        {fallback !== null ? ' (first canvas)' : ''}
      </span>

      <label className="ws8-file">
        Upload an image or a video
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".png,.jpg,.jpeg,.webp,.gif,.avif,.svg,.mp4,.mov,.webm"
          data-testid="insert-upload"
          disabled={busy}
          onChange={(event) => void uploadFromInput(event.target.files)}
        />
      </label>
      <div className="cms-hint">
        {busy ? 'Uploading…' : 'Or drop a file straight onto the canvas.'}
      </div>

      <label className="ws8-file">
        Or paste a video link
        <input
          type="url"
          value={videoLink}
          placeholder="YouTube or Vimeo"
          data-testid="insert-video-link"
          onChange={(event) => setVideoLink(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              insertVideoLink();
            }
          }}
        />
      </label>
      <button
        type="button"
        className="cms-btn cms-btn--tiny"
        data-testid="insert-video-link-go"
        disabled={videoLink.trim() === ''}
        onClick={insertVideoLink}
      >
        Add the video
      </button>

      <button
        type="button"
        className="cms-btn cms-btn--tiny"
        data-testid="insert-asset-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Hide asset library' : 'Insert an asset…'}
      </button>

      {open && (
        <div className="ws8-plate" data-testid="insert-asset-picker">
          <AssetPicker onInsert={insertShape} insertLabel="Insert" />
        </div>
      )}

      <button
        type="button"
        className="cms-btn cms-btn--tiny"
        data-testid="insert-library-toggle"
        aria-expanded={libraryOpen}
        onClick={() => setLibraryOpen((value) => !value)}
      >
        {libraryOpen ? 'Hide the library' : 'Insert from the library…'}
      </button>

      {libraryOpen && (
        <div className="ws8-plate ws8-plate--library" data-testid="insert-library">
          <LibraryBrowser onInsert={insertFromLibrary} onClose={() => setLibraryOpen(false)} />
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Slot: toolbar extra — who, which page, reload                               */
/* -------------------------------------------------------------------------- */

const renderToolbarExtra = (props: ToolbarSlotProps): ReactNode => <ToolbarExtras {...props} />;

function ToolbarExtras(props: ToolbarSlotProps) {
  const { legacy } = useIntegration();
  const guide = useGuide();
  // Inside `<CmsApp>` the sidebar and the entry list are the page switcher,
  // and the site bar already shows who is signed in, so this slot is only the
  // Reload button there.
  return (
    <>
      <GuideButton onClick={guide.toggle} active={guide.open} />
      <GuideOverlay open={guide.open} onClose={guide.hide} />
      {legacy === null ? (
        <SiteToolbarExtras {...props} />
      ) : (
        <LegacyToolbarExtras {...props} api={legacy.api} />
      )}
    </>
  );
}

function LegacyToolbarExtras({
  store,
  state,
  api,
}: ToolbarSlotProps & { api: CmsApiAdapter }) {
  const { loginUrl, reload } = useIntegration();
  const [pages, setPages] = useState<PageSummary[] | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .listPages()
      .then((list) => {
        if (alive) setPages(list);
      })
      // A failed listing is not worth a notice: the editor still works on the
      // page it has, and the chip already says whether we are signed in.
      .catch(() => {
        if (alive) setPages([]);
      });
    return () => {
      alive = false;
    };
  }, [api]);

  // Three states, not two. Until `authStatus()` has answered, "not signed in"
  // would be a guess, and the one it would get wrong is the normal case.
  const authKnown = state.auth !== null;
  const signedIn = state.auth?.signedIn === true;
  const login = state.auth?.login;
  const status = api.lastStatus();

  const go = (slug: string): void => {
    if (slug === state.slug) return;
    if (state.dirty && typeof window !== 'undefined') {
      const ok = window.confirm('Leave this page? Unsaved changes will be lost.');
      if (!ok) return;
    }
    if (typeof location !== 'undefined') location.assign(`/cms/${encodeURIComponent(slug)}`);
  };

  const known = pages ?? [];
  const listed = known.some((page) => page.slug === state.slug)
    ? known
    : [{ slug: state.slug, title: state.doc.meta.title, hasDraft: state.hasDraft }, ...known];

  return (
    <span className="ws8-toolbar" data-testid="toolbar-extra">
      <span
        className={!authKnown || signedIn ? 'ws8-who' : 'ws8-who ws8-who--out'}
        data-testid="auth-chip"
        data-signed-in={!authKnown ? 'unknown' : signedIn ? 'true' : 'false'}
        title={
          status === null
            ? undefined
            : `${status.repo} on ${status.branch}; this editor accepts ${status.expects}`
        }
      >
        <span className="ws8-who__dot" />
        {!authKnown ? (
          'checking GitHub…'
        ) : signedIn ? (
          <>
            {login ?? 'signed in'}
            {status === null ? '' : ` · ${status.branch}`}
          </>
        ) : (
          <a href={loginUrl ?? api.loginUrl()} data-testid="auth-signin">
            Sign in to GitHub
          </a>
        )}
      </span>

      <select
        className="cms-select ws8-pages"
        data-testid="page-switcher"
        value={state.slug}
        onChange={(event) => go(event.target.value)}
      >
        {listed.map((page) => (
          <option key={page.slug} value={page.slug}>
            {page.title}
            {page.hasDraft ? ' ·' : ''}
          </option>
        ))}
      </select>

      <button
        type="button"
        className="cms-btn cms-btn--tiny"
        data-testid="reload"
        title="Throw away local state and read the page again from the repository"
        disabled={state.phase !== 'idle'}
        onClick={reload}
      >
        Reload
      </button>
    </span>
  );
}

/* ========================================================================== */
/* WS-G: THE WHOLE SITE                                                        */
/* ========================================================================== */

/**
 * ---------------------------------------------------------------------------
 * WS-G INTEGRATION. One application covering all five sections.
 * ---------------------------------------------------------------------------
 *
 *   WS-A  src/cms/sections.ts            the registry everything branches on
 *   WS-B  src/cms/render/                what the site looks like (not here)
 *   WS-C  src/cms/server/client.ts       the API, for every section
 *   WS-D  src/cms/app/shell/site-*       sidebar, entry list, dispatch
 *   WS-E  src/cms/app/records/           the film and album editors
 *   WS-H  src/cms/preview/               where Preview goes
 *
 * `<CmsEditor>` above is phase 1 and is untouched: it still mounts WS-3's
 * `<EditorShell>` directly for one slug. `<CmsApp>` below mounts WS-D's
 * `<SiteShell>`, which mounts that same `<EditorShell>` for home, projects and
 * essays and WS-E's record editor for filmography and photography. The four
 * phase 1 slots are the same functions in both, which is the point: a canvas
 * band inside an essay behaves exactly as a canvas band inside a project,
 * because it is the same code with a different upload directory behind it.
 *
 * THE SEAMS THIS LAYER CLOSES, in the order they bit.
 *
 * 5. THE SLOTS WERE BOUND TO ONE SLUG. Phase 1's canvas and inspector slots
 *    called `api.uploadMediaDetailed(slug, …)` with the slug they were
 *    constructed with. There is no such slug now: the open entry changes under
 *    them, and the upload directory is `(section, key)` rather than `slug`
 *    (docs/cms-contracts.md 9.3). So the context member is a bound `upload`
 *    function, read from the site store AT CALL TIME. Binding it at render
 *    time would have let a slow upload land in the previous entry's directory.
 *
 * 6. WS-E WANTS PROGRESS AND CANCELLATION; WS-D's SLOT DROPS BOTH. WS-E's
 *    `uploadMedia` is `(file, { onProgress, signal })`, which is what makes its
 *    per-file bars determinate and lets it abort on unmount. WS-D's
 *    `RecordEditorSlotProps.uploadMedia` is `(file) => …` — no options — so
 *    going through it would silently throw them away. The record slot here
 *    therefore substitutes its own uploader, bound to the same section and key
 *    WS-D computed, which reaches `XMLHttpRequest` in ./integration/site-api.ts.
 *    Nothing in either workstream is edited; the host passes a better function.
 *
 * 7. ONE AUTH ANSWER, TWO STORES. `<SiteShell>` refreshes auth on the site
 *    store, and the nested `<EditorShell>` refreshes it again on the document
 *    store, because phase 1's toolbar reads `state.auth` from the document
 *    store. Both land on the same adapter, so this is one extra GET per opened
 *    entry and not a correctness problem; `repo` and `branch` for the media
 *    resolver are taken from whichever has answered.
 *
 * 8. THE RECORD EDITOR'S ROOT CLASS IS THE SHELL'S ROOT CLASS. WS-D's
 *    `<RecordView>` roots itself at `.cms-rec` and so does WS-E's
 *    `<RecordEditor>`, and WS-D gives `.cms-rec` `height: 100%`. Nested, that
 *    makes the inner editor exactly as tall as the scroll container and its
 *    content overflows invisibly. One rule in ./integration/styles.ts' sibling
 *    (`SITE_APP_CSS` below) un-does the inherited height for a nested root.
 *    Reported, because the collision belongs in one of their files.
 */

export type CmsAppProps = {
  /** `owner/name` and the branch being edited, for resolving `/media/` srcs. */
  repo?: string | null;
  branch?: string | null;
  /** Point the client at another origin. Only used by a harness. */
  baseUrl?: string;
  /** Swap the transport. Only used by a harness. */
  fetchImpl?: typeof fetch;
  /** Drive routing without `history`. Only used by a harness. */
  navigator?: AppNavigator;
  /** Seeded sha bookkeeping, keyed `home` / `essays/<slug>`. */
  shas?: Readonly<Record<string, Partial<EntryShas>>>;
};

type SiteApiBundle = { api: SiteApiAdapter; loginUrl: string | null };

const SiteApiContext = createContext<SiteApiBundle | null>(null);

function useSiteApi(): SiteApiBundle {
  const value = useContext(SiteApiContext);
  if (value === null) throw new Error('useSiteApi outside <CmsApp>');
  return value;
}

export function CmsApp(props: CmsAppProps) {
  useIntegrationStyles();
  useSiteAppStyles();

  const [loginUrl, setLoginUrl] = useState<string | null>(null);

  // Built once, like phase 1's pair and for the same reason: both are mutable
  // objects with their own identity, and rebuilding either would throw away
  // the undo history, the record collections and the sha bookkeeping.
  const [{ api, store }] = useState(() => {
    const box: { store: SiteStore | null } = { store: null };
    const adapter = createSiteApi({
      ...(props.baseUrl === undefined ? {} : { baseUrl: props.baseUrl }),
      ...(props.fetchImpl === undefined ? {} : { fetch: props.fetchImpl }),
      ...(props.shas === undefined ? {} : { initial: props.shas }),
      onSignedOut: (url) => setLoginUrl(url),
      onConflict: (_conflict, message) => {
        // Same reason for the macrotask as phase 1: this fires inside the
        // rejected call, and the store that made it writes its own notice a
        // microtask later.
        setTimeout(() => box.store?.notify('error', conflictMessage(message)), 0);
      },
    });
    const created = createSiteStore({
      api: adapter,
      navigator: props.navigator ?? createBrowserNavigator(),
    });
    box.store = created;
    return { api: adapter, store: created };
  });

  const state = useSiteStoreState(store);

  // WS-C's /auth/status carries repo and branch; WS-D's AuthStatus type only
  // names the two fields it uses, so the other two are read off the same
  // object. Falling back to the props means the resolver is right on the first
  // paint, before the call has answered.
  const wire = state.auth as { repo?: string; branch?: string } | null;
  const repo = wire?.repo ?? api.lastStatus()?.repo ?? props.repo ?? null;
  const branch = wire?.branch ?? api.lastStatus()?.branch ?? props.branch ?? null;
  const resolveMediaSrc = useMemo(() => makeMediaResolver(repo, branch), [repo, branch]);

  /* SEAM 5: bound at call time, not at render time. */
  const upload = useCallback(
    (file: File, filename?: string): Promise<MediaUpload> => {
      const editor = store.getState().editor;
      if (editor === null) {
        return Promise.reject(
          new Error('Nothing is open, so there is nowhere to put that file.'),
        );
      }
      return api.uploadDetailed(
        editor.section.id,
        mediaSlugFor(editor.section, editor.entryKey),
        file,
        filename ?? file.name,
      );
    },
    [api, store],
  );

  /** Throw away local state for the open entry and read it again from the repo. */
  const reload = useCallback(() => {
    const editor = store.getState().editor;
    if (editor === null) return;
    if (editor.store.getState().dirty && typeof window !== 'undefined') {
      const go = window.confirm(
        'Reload from the repository? Unsaved changes in this tab will be lost.',
      );
      if (!go) return;
    }
    if (editor.kind === 'document') {
      void editor.store.loadPage(editor.store.getState().slug);
    } else {
      void editor.store.load();
    }
  }, [store]);

  /*
   * WS-H's preview address is `<section>` or `<section>/<key>`, but phase 1's
   * `previewUrl` slot is handed a slug and nothing else. The section comes
   * from the open editor, at call time, for the same reason the upload does.
   */
  const previewUrl = useCallback(
    (slug: string): string => {
      const editor = store.getState().editor;
      if (editor === null) return previewHref(slug, { version: 'draft' });
      const key = editor.section.shape === 'singleton' ? null : slug;
      return previewHref(previewPath(editor.section.id, key), { version: 'draft' });
    },
    [store],
  );

  const integration = useMemo<Integration>(
    () => ({ upload, loginUrl, reload, legacy: null }),
    [upload, loginUrl, reload],
  );

  const apiBundle = useMemo<SiteApiBundle>(() => ({ api, loginUrl }), [api, loginUrl]);

  return (
    <SiteApiContext.Provider value={apiBundle}>
      <IntegrationContext.Provider value={integration}>
        <SiteShell
          store={store}
          resolveMediaSrc={resolveMediaSrc}
          previewUrl={previewUrl}
          recordPreviewUrl={recordPreviewUrl}
          renderProseBlock={renderProseBlock}
          renderCanvasBand={renderCanvasBand}
          renderInspectorExtra={renderInspectorExtra}
          renderToolbarExtra={renderToolbarExtra}
          renderRecordEditor={renderRecordEditor}
          renderRecordToolbarExtra={renderRecordToolbarExtra}
        />
      </IntegrationContext.Provider>
    </SiteApiContext.Provider>
  );
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * WS-H's preview address: `<section>`, or `<section>/<key>` where the entry
 * has a page of its own. One string-building rule for both editors.
 */
function previewPath(section: SectionId, entryKey: string | null): string {
  return entryKey === null || entryKey === '' ? section : `${section}/${entryKey}`;
}

/**
 * Where Preview goes for a record.
 *
 * WS-D's default is `/preview/<page>?draft=1`, which is not a route in this
 * repository — WS-H's is `/cms/preview/<section>[/<key>]`. `section.entryUrl`
 * is what knows whether this kind of record has a page at all: a film plays on
 * the filmography index and has none, an album has `/photography/<slug>/`
 * (docs/cms-sections.md 3.4). So the rule is the registry's, not a section
 * name written here.
 */
function recordPreviewUrl(section: RecordSectionDef, entryKey: string | null): string {
  const key = section.entryUrl === null ? null : entryKey;
  return previewHref(previewPath(section.id, key), { version: 'draft' });
}

/* -------------------------------------------------------------------------- */
/* Slot: the record editors (WS-E into WS-D)                                   */
/* -------------------------------------------------------------------------- */

/**
 * Keyed on the record's own id, NOT on `entryKey`. An album's entry key is its
 * slug, and the slug follows the title until it is pinned, so keying on the
 * key would remount the editor on the first keystroke in the title field and
 * take the caret with it. The record id never changes.
 */
const renderRecordEditor = (props: RecordEditorSlotProps): ReactNode => (
  <RecordSlot key={`${props.section.id}:${props.entry.id}`} {...props} />
);

function RecordSlot(props: RecordEditorSlotProps) {
  const { api } = useSiteApi();
  const { section, entryKey, store } = props;

  /*
   * SEAM 6. WS-D's slot hands over `uploadMedia(file)`; WS-E's editors want
   * `uploadMedia(file, { onProgress, signal })`. The section and the key are
   * exactly the ones WS-D computed, so this is the same destination —
   * `public/media/<section>/<key>/` — reached by a function that can report
   * progress and be cancelled.
   */
  const uploadMedia = useCallback(
    (file: File, options?: SiteUploadOptions) =>
      api.uploadDetailed(section.id, entryKey, file, file.name, options ?? {}),
    [api, section.id, entryKey],
  );

  /* WS-E reports a failed upload or a deleted photo; WS-D's status line shows it. */
  const onNotice = useCallback(
    (level: 'info' | 'error', message: string) => store.notify(level, message),
    [store],
  );

  return recordEditorSlot({ ...props, uploadMedia, onNotice });
}

/* -------------------------------------------------------------------------- */
/* Slot: the record toolbar — reload, and the live page                        */
/* -------------------------------------------------------------------------- */

const renderRecordToolbarExtra = (props: RecordToolbarSlotProps): ReactNode => (
  <RecordToolbarExtras {...props} />
);

function RecordToolbarExtras({ store, state }: RecordToolbarSlotProps) {
  const { reload } = useIntegration();
  return (
    <span className="ws8-toolbar" data-testid="record-toolbar-extra">
      {state.issues.length > 0 && (
        <span className="ws8-who ws8-who--out" data-testid="record-invalid">
          <span className="ws8-who__dot" />
          {state.issues.length} problem{state.issues.length === 1 ? '' : 's'}
        </span>
      )}
      <button
        type="button"
        className="cms-btn cms-btn--tiny"
        data-testid="reload"
        title="Throw away local state and read the collection again from the repository"
        disabled={state.phase !== 'idle'}
        onClick={reload}
      >
        Reload
      </button>
      <button
        type="button"
        className="cms-btn cms-btn--tiny"
        data-testid="discard-draft"
        title="Delete the draft file and go back to what is published"
        disabled={state.phase !== 'idle' || !state.hasDraft}
        onClick={() => {
          if (
            typeof window !== 'undefined' &&
            !window.confirm('Discard the draft of this collection and take what is published?')
          ) {
            return;
          }
          void store.discardDraft();
        }}
      >
        Discard draft
      </button>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Slot: the document toolbar, inside the site shell                           */
/* -------------------------------------------------------------------------- */

function SiteToolbarExtras({ state }: ToolbarSlotProps) {
  const { api, loginUrl } = useSiteApi();
  const { reload } = useIntegration();
  const signedOut = state.auth !== null && state.auth.signedIn === false;

  return (
    <span className="ws8-toolbar" data-testid="toolbar-extra">
      {signedOut && (
        <span className="ws8-who ws8-who--out" data-testid="auth-chip" data-signed-in="false">
          <span className="ws8-who__dot" />
          <a href={loginUrl ?? api.loginUrl()} data-testid="auth-signin">
            Sign in to GitHub
          </a>
        </span>
      )}
      <button
        type="button"
        className="cms-btn cms-btn--tiny"
        data-testid="reload"
        title="Throw away local state and read this entry again from the repository"
        disabled={state.phase !== 'idle'}
        onClick={reload}
      >
        Reload
      </button>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* The one style rule this layer owns                                          */
/* -------------------------------------------------------------------------- */

/**
 * SEAM 8. WS-D's shell and WS-E's editors both root themselves at `.cms-rec`
 * and both name their children `.cms-rec__*`, and the two sets of class names
 * overlap in five places: `__body`, `__field`, `__label`, `__req`, `__thumb`.
 * Nested — which is exactly how they are meant to be used — WS-D's rules for
 * its own read-only stub leak into WS-E's tree on every property WS-E does
 * not itself set, which the cascade cannot resolve because the selectors are
 * identical.
 *
 * Two of the leaks are visible and one of them is a real break:
 *
 *   .cms-rec       WS-D's `height: 100%` makes the nested editor exactly the
 *                  height of the scroll viewport, so its content is clipped
 *                  instead of scrolled.
 *   .cms-rec__body WS-E's padding inside WS-D's already-padded `__inner` is a
 *                  double gutter.
 *   .cms-rec__thumb  WS-D's stub thumbnail is `width: 72px; height: 52px`,
 *                  which WS-E does not override because WS-E sizes by
 *                  `aspect-ratio` instead. Every photograph in the album grid
 *                  therefore collapses to a 72x52 chip in the corner of its
 *                  tile, and the "Cover" badge lands on top of the star that
 *                  pins the cover. Measured, not guessed: site-e2e.mjs checks
 *                  that the star is the element at its own centre.
 *   .cms-rec__field  WS-D's `padding` and `background` are inherited by every
 *                  field in the record editor.
 *
 * These rules undo only what leaks, scoped to a record editor mounted inside
 * the shell, so neither workstream's standalone harness changes. The real fix
 * is a rename in one of their files; reported in contractDeviations.
 */
const SITE_APP_STYLE_ID = 'cms-site-app-styles';
const SITE_APP_CSS = `
.cms-rec .cms-rec { height: auto; min-height: 0; background: transparent; }
.cms-rec .cms-rec > .cms-rec__body { padding: 0; overflow: visible; }
.cms-rec .cms-rec .cms-rec__thumb {
  width: auto;
  height: auto;
  border: 0;
  border-radius: 0;
}
.cms-rec .cms-rec .cms-rec__field { padding: 0; background: none; }
`;

function useSiteAppStyles(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(SITE_APP_STYLE_ID) !== null) return;
    const style = document.createElement('style');
    style.id = SITE_APP_STYLE_ID;
    style.textContent = SITE_APP_CSS;
    // Last, so it wins over both stylesheets it is correcting.
    document.head.append(style);
  }, []);
}

/* -------------------------------------------------------------------------- */
/* Mounting                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Used by the offline harness and available to anything that wants the editor
 * without Astro's island runtime. The route renders `<CmsEditor>` as a
 * `client:only` island instead, which is the same tree.
 */
export function mountCmsEditor(container: Element, props: CmsEditorProps): void {
  createRoot(container).render(
    <StrictMode>
      <CmsEditor {...props} />
    </StrictMode>,
  );
}

/**
 * The whole-site application, for anything that wants it without Astro's
 * island runtime. `src/cms/app/routes/site.astro` renders `<CmsApp>` as a
 * `client:only` island instead, which is the same tree.
 */
export function mountCmsApp(container: Element, props: CmsAppProps = {}): void {
  createRoot(container).render(
    <StrictMode>
      <CmsApp {...props} />
    </StrictMode>,
  );
}

export default CmsEditor;
