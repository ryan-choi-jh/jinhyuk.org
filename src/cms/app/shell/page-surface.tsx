/**
 * src/cms/app/shell/page-surface.tsx
 *
 * WS-3. The middle pane: the page.
 *
 * Geometry, which is the whole point of this file. The surface is the PAGE —
 * `PAGE_WIDTH` (1440) CSS px, scaled with a CSS transform to fit the pane —
 * and `.cms-surface__inner` insets it by `PAGE_GUTTER` (48) on each side,
 * leaving a `REFERENCE_WIDTH` (1344) content column in the middle. Those are
 * `--page` and `--gutter` from the site's own stylesheet, so the paper down
 * each edge is the paper a reader sees rather than a decorative border.
 *
 * Inside that column, one CSS px is one reference px, and a canvas item at
 * `x: 672` sits at 672px with no conversion anywhere. The price is that a
 * mounted canvas editor has to divide client-coordinate deltas by `scale`;
 * that number is handed to it in `CanvasBandSlotProps.scale`. The gutters cost
 * nothing on top of that: the column is 1344 wide either way, and a canvas
 * item is positioned within the column, so adding the margins moved no item.
 *
 * Band stacking follows docs/cms-rebuild.md 2.2. A canvas band with
 * `overlay: true` reserves no vertical space and is drawn over the band before
 * it, which is how media ends up beside a paragraph.
 *
 * What this file does NOT do: lay the page out the way the published site
 * does. WS-1 owns that, and the preview (WS-7) is where you check it. This is
 * an editing surface that is close enough to position things against.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { PAGE_WIDTH, REFERENCE_WIDTH, seedFromId } from '../../schema.ts';
import { renderDocHead, renderProjectHead } from '../../render/index.ts';
import { drawDocConnectors, watchDocConnectors } from '../../render/connectors.ts';
import type { Band, CanvasBand, CanvasItem, Doc, ProseBand, ProseBlock } from '../../schema.ts';
// The nav and the footer around the page are the real ones, from
// src/content/data/site.json. See the note where they are rendered.
import { SiteChromeView } from '../chrome/chrome-view.tsx';
import { blockPlainText } from '../state/doc-ops.ts';
import { isBandSelected, isBlockSelected, isItemSelected, selectedItemIds } from '../state/selection.ts';
import type { Selection } from '../state/selection.ts';
import type { DocStore } from '../state/store.ts';
import type { EditorShellSlots } from './slots.ts';

/** `'fit'` scales the page down to the pane; a number is an explicit factor. */
export type Zoom = 'fit' | number;

export type PageSurfaceProps = {
  store: DocStore;
  doc: Doc;
  selection: Selection;
  zoom: Zoom;
  slots: EditorShellSlots;
  resolveMediaSrc: (src: string) => string;
};

export function PageSurface({ store, doc, selection, zoom, slots, resolveMediaSrc }: PageSurfaceProps) {
  const measureRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState(PAGE_WIDTH);
  const [surfaceHeight, setSurfaceHeight] = useState(0);

  useEffect(() => {
    const element = measureRef.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setAvailable(entry.contentRect.width);
    });
    observer.observe(element);
    setAvailable(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = surfaceRef.current;
    if (element === null) return;
    setSurfaceHeight(element.offsetHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setSurfaceHeight(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
    // Once: the observer reports every later change in the page's own height.
  }, []);

  // Against PAGE_WIDTH, not REFERENCE_WIDTH: what is being fitted is the whole
  // sheet, gutters included. Fitting the column alone would push the two
  // margins off the sides of the pane, which is the thing they are here to
  // show.
  // Connectors, drawn by the page's own script over the editing surface.
  //
  // Two effects because there are two reasons to redraw. `watchDocConnectors`
  // covers the ones the script knows about — images arriving, webfonts
  // settling, the window and the pane resizing — and is installed once. The
  // second covers the one it cannot see: a React render, which is what moving
  // or resizing an item produces. It is throttled to a frame, so dragging an
  // item redraws the curve at most once per frame rather than once per
  // pointer event.
  //
  // The svg lives inside the scaled surface and `drawDocConnectors` measures
  // in client pixels, so its viewBox comes out scaled by exactly the same
  // factor as the element it sits in. The two cancel, and the curve lands in
  // the right place at every zoom.
  useEffect(() => {
    const element = innerRef.current;
    if (element === null) return;
    return watchDocConnectors(element);
  }, []);

  useEffect(() => {
    const element = innerRef.current;
    if (element === null) return;
    const frame = requestAnimationFrame(() => drawDocConnectors(element));
    return () => cancelAnimationFrame(frame);
  });

  const scale = zoom === 'fit' ? Math.min(1, available / PAGE_WIDTH) : zoom;
  const groups = groupBands(doc.bands);

  return (
    <div className="cms-surface-scroll" data-testid="page-surface" data-scale={scale.toFixed(4)}>
      <div className="cms-surface-measure" ref={measureRef}>
        <div
          className="cms-surface-frame"
          style={{ width: PAGE_WIDTH * scale, height: surfaceHeight * scale }}
        >
          <div className="cms-surface" ref={surfaceRef} style={{ transform: `scale(${scale})` }}>
            <div className="cms-surface__inner" ref={innerRef}>
              {/* The connector overlay. Same element, same class and the same
                  script as the published page: `drawDocConnectors` finds this
                  svg, the anchored items by `.doc-item[data-anchor-block]`,
                  and the paragraphs by `data-block-id`, all of which the
                  surface now emits. Until this existed, an anchored item
                  looked inert in the editor and the curve only appeared in
                  Preview, which is a strange way to find out it worked. */}
              <svg className="doc-connectors" aria-hidden="true" focusable="false" />
              <SiteChromeView where="top" section={doc.meta.section} />
              <DocHead doc={doc} />
              {groups.map((group) => (
                <div className="cms-group" key={group.host.id}>
                  <BandBox
                    store={store}
                    doc={doc}
                    band={group.host}
                    selection={selection}
                    slots={slots}
                    scale={scale}
                    resolveMediaSrc={resolveMediaSrc}
                  />
                  {group.overlays.map((overlay) => (
                    <BandBox
                      key={overlay.id}
                      store={store}
                      doc={doc}
                      band={overlay}
                      selection={selection}
                      slots={slots}
                      scale={scale}
                      resolveMediaSrc={resolveMediaSrc}
                    />
                  ))}
                </div>
              ))}
              {doc.bands.length === 0 && (
                <p className="cms-surface__empty">
                  This page has no bands. Add one from the outline on the left.
                </p>
              )}
              <SiteChromeView where="bottom" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Grouping                                                                    */
/* -------------------------------------------------------------------------- */

type Group = { host: Band; overlays: CanvasBand[] };

/**
 * An overlay band belongs to the band before it. Several overlays in a row all
 * attach to the same host, which is what "sits over the band before it" means
 * once the one before it also takes no space.
 */
export function groupBands(bands: readonly Band[]): Group[] {
  const groups: Group[] = [];
  for (const band of bands) {
    const isOverlay = band.type === 'canvas' && band.overlay === true;
    const last = groups[groups.length - 1];
    if (isOverlay && last !== undefined) {
      last.overlays.push(band as CanvasBand);
      continue;
    }
    groups.push({ host: band, overlays: [] });
  }
  return groups;
}

/* -------------------------------------------------------------------------- */
/* One band                                                                    */
/* -------------------------------------------------------------------------- */

type BandBoxProps = {
  store: DocStore;
  doc: Doc;
  band: Band;
  selection: Selection;
  slots: EditorShellSlots;
  scale: number;
  resolveMediaSrc: (src: string) => string;
};

/**
 * The masthead: the title, the date, the Visit row and the standfirst.
 *
 * None of that is a band, so until now the surface began at the first
 * paragraph and a project opened in the editor was missing the four things a
 * reader sees first. It is drawn from the page renderers themselves —
 * `renderProjectHead` for a project, `renderDocHead` for an essay — rather
 * than rebuilt in JSX, because the whole point is that it is the same
 * masthead, and a second implementation would start drifting on the first
 * change to either.
 *
 * Inert, like the nav and the footer around it: these fields are edited in the
 * inspector, and a live `target="_blank"` link inside an editing surface is a
 * way to lose your place, not a feature.
 *
 * Home has no masthead here. Its title is the bold `.name` line INSIDE the
 * intro, under the illustration rather than above it, so it is drawn by the
 * intro band instead — see `isHomeIntro` below.
 */
function DocHead({ doc }: { doc: Doc }) {
  const section = doc.meta.section;
  const html =
    section === 'projects'
      ? renderProjectHead(doc)
      : section === 'essays'
        ? renderDocHead(doc)
        : null;
  if (html === null) return null;
  return (
    <div
      className="cms-surface__head"
      data-testid="surface-doc-head"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function BandBox({ store, doc, band, selection, slots, scale, resolveMediaSrc }: BandBoxProps) {
  const selected = isBandSelected(selection, band.id);
  const isOverlay = band.type === 'canvas' && band.overlay === true;
  const index = doc.bands.findIndex((candidate) => candidate.id === band.id);

  // The homepage's FIRST prose band is not an ordinary document column: it is
  // `.intro`, which src/cms/render/pages/home.ts builds at a 1184px measure
  // with 24px between paragraphs rather than 720px with 28px. Any prose band
  // after it does go through the ordinary pipeline, so this marks the one band
  // that is the intro and not simply "prose on the homepage".
  const isHomeIntro =
    doc.meta.section === 'home' &&
    band.type === 'prose' &&
    doc.bands.find((candidate) => candidate.type === 'prose')?.id === band.id;

  const className = [
    'cms-band-box',
    band.type === 'prose' ? 'cms-band-box--prose' : 'cms-band-box--canvas',
    isHomeIntro ? 'cms-band-box--intro' : '',
    isOverlay ? 'cms-band-box--overlay' : '',
    selected ? 'cms-band-box--selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  /**
   * The box the items actually occupy, in the band's own reference pixels,
   * or null when there is nothing to hug — an empty overlay, or a band that
   * is not an overlay at all and whose full box IS its footprint.
   */
  const overlayBounds: CSSProperties | null = (() => {
    if (!isOverlay) return null;
    const items = (band as CanvasBand).items;
    if (items.length === 0) return null;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const item of items) {
      left = Math.min(left, item.x);
      top = Math.min(top, item.y);
      right = Math.max(right, item.x + item.w);
      bottom = Math.max(bottom, item.y + item.h);
    }
    if (!Number.isFinite(left) || right <= left || bottom <= top) return null;
    return { left, top, width: right - left, height: bottom - top };
  })();

  const style: CSSProperties = isOverlay
    ? { height: (band as CanvasBand).height }
    : band.type === 'canvas'
      ? { height: band.height }
      : {};

  return (
    <div
      className={className}
      style={style}
      data-band-id={band.id}
      data-band-type={band.type}
      data-testid={`surface-band-${band.id}`}
      onMouseDown={() => store.selectBand(band.id)}
    >
      {selected &&
        (overlayBounds === null ? (
          <span className="cms-band-box__label">
            band {index + 1}
            {isOverlay ? ' · overlay' : ''}
          </span>
        ) : (
          /* An overlay band reserves NO space on the page: it is a layer over
             the band above, and the only thing it actually occupies is its
             items. Outlining the whole layer drew a box the size of the
             paragraph it floats over, which says something untrue about the
             band and is the first thing you notice when you select one. So
             the frame goes round the items instead. The layer underneath is
             still the full coordinate space — an item's x and y have to keep
             meaning what they mean on the page — it just stops being drawn. */
          <span
            className="cms-band-box__frame"
            data-testid={`surface-band-frame-${band.id}`}
            style={overlayBounds}
          >
            <span className="cms-band-box__label">
              band {index + 1} · overlay
            </span>
          </span>
        ))}
      {band.type === 'prose' ? (
        <ProseBandBody
          store={store}
          band={band}
          bandIndex={index}
          selection={selection}
          slots={slots}
          introName={isHomeIntro ? doc.meta.title : null}
        />
      ) : (
        <CanvasBandBody
          store={store}
          band={band}
          bandIndex={index}
          selection={selection}
          slots={slots}
          scale={scale}
          resolveMediaSrc={resolveMediaSrc}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Prose band                                                                  */
/* -------------------------------------------------------------------------- */

function ProseBandBody({
  store,
  band,
  bandIndex,
  selection,
  slots,
  introName,
}: {
  store: DocStore;
  band: ProseBand;
  bandIndex: number;
  selection: Selection;
  slots: EditorShellSlots;
  /**
   * The homepage's bold name line, which lives INSIDE the intro rather than
   * above the page (`.intro .name` in global.css, written by `renderIntro`).
   * Null everywhere else. It is `meta.title`, not a block, so it is not
   * editable here; the Title field in the inspector is where it changes.
   */
  introName: string | null;
}) {
  return (
    <div className="cms-prose-col">
      {introName !== null && (
        <p className="cms-surface__name" aria-hidden="true" data-testid="surface-intro-name">
          {introName}
        </p>
      )}
      {band.blocks.map((block, blockIndex) => {
        const selected = isBlockSelected(selection, band.id, block.id);
        const select = (): void => store.selectBlock(band.id, block.id);
        const onChange = (content: unknown[]): void =>
          store.setBlockContent(band.id, block.id, content);

        return (
          <div
            key={block.id}
            data-block-id={block.id}
            data-testid={`surface-block-${block.id}`}
            onMouseDown={(event) => {
              event.stopPropagation();
              select();
            }}
          >
            {slots.renderProseBlock === undefined ? (
              <ProseBlockPlaceholder block={block} selected={selected} />
            ) : (
              <div className="cms-slot-host">
                {slots.renderProseBlock({
                  store,
                  band,
                  bandIndex,
                  block,
                  blockIndex,
                  selected,
                  onChange,
                  onSelect: select,
                })}
              </div>
            )}
          </div>
        );
      })}
      {band.blocks.length === 0 && <p className="cms-ph-empty">Empty text band.</p>}
    </div>
  );
}

/**
 * Read-only prose, for when WS-5's editor is not mounted. Plain text only: the
 * marks are deliberately not rendered, because how prose looks is WS-1's
 * decision and guessing here would invite drift.
 */
function ProseBlockPlaceholder({ block, selected }: { block: ProseBlock; selected: boolean }) {
  const text = blockPlainText(block);
  const body: ReactNode = text === '' ? <span className="cms-ph-empty">empty {block.kind}</span> : text;

  const inner = ((): ReactNode => {
    switch (block.kind) {
      case 'h2':
        return <h2 className="cms-ph-h2">{body}</h2>;
      case 'h3':
        return <h3 className="cms-ph-h3">{body}</h3>;
      case 'quote':
        return <blockquote className="cms-ph-quote">{body}</blockquote>;
      case 'ul':
        return (
          <ul className="cms-ph-list">
            {listTexts(block).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        );
      case 'ol':
        return (
          <ol className="cms-ph-list">
            {listTexts(block).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ol>
        );
      default:
        return <p className="cms-ph-p">{body}</p>;
    }
  })();

  return (
    <div className={selected ? 'cms-ph-block cms-ph-block--selected' : 'cms-ph-block'}>
      <span className="cms-ph-block__kind">{block.kind}</span>
      {inner}
    </div>
  );
}

function listTexts(block: ProseBlock): string[] {
  const out: string[] = [];
  for (const raw of block.content) {
    const node = raw as { content?: unknown[] };
    if (node === null || typeof node !== 'object') continue;
    out.push(
      blockPlainText({
        id: block.id,
        kind: 'p',
        content: Array.isArray(node.content) ? node.content : [],
      }),
    );
  }
  return out.length > 0 ? out : [''];
}

/* -------------------------------------------------------------------------- */
/* Canvas band                                                                 */
/* -------------------------------------------------------------------------- */

function CanvasBandBody({
  store,
  band,
  bandIndex,
  selection,
  slots,
  scale,
  resolveMediaSrc,
}: {
  store: DocStore;
  band: CanvasBand;
  bandIndex: number;
  selection: Selection;
  slots: EditorShellSlots;
  scale: number;
  resolveMediaSrc: (src: string) => string;
}) {
  const ids = selectedItemIds(selection, band.id);

  return (
    <div
      className={band.items.length === 0 ? 'cms-stage cms-stage--empty' : 'cms-stage'}
      style={{ height: band.height }}
      data-stage-band-id={band.id}
      data-testid={`surface-stage-${band.id}`}
    >
      {slots.renderCanvasBand === undefined ? (
        <>
          {band.items.map((item) => (
            <CanvasItemPlaceholder
              key={item.id}
              item={item}
              selected={isItemSelected(selection, band.id, item.id)}
              resolveMediaSrc={resolveMediaSrc}
              onSelect={() => store.selectItems(band.id, [item.id])}
            />
          ))}
          <div className="cms-stage__frame" />
          <span className="cms-slot-note">canvas slot</span>
        </>
      ) : (
        <div className="cms-slot-host cms-slot-host--canvas">
          {slots.renderCanvasBand({
            store,
            band,
            bandIndex,
            items: band.items,
            selectedItemIds: ids,
            stageWidth: REFERENCE_WIDTH,
            stageHeight: band.height,
            referenceWidth: REFERENCE_WIDTH,
            scale,
            onChange: (items: CanvasItem[]) => store.setCanvasItems(band.id, items),
            onSelectItems: (itemIds: string[]) => store.selectItems(band.id, itemIds),
            resolveMediaSrc,
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Read-only item, for when WS-4's editor is not mounted. Media is drawn with a
 * real `<img>`; a shape gets a crude outline rather than WS-6's generator,
 * which the shell is not allowed to import (it is WS-1's and WS-4's shared
 * module, and this is a placeholder, not a renderer).
 */
function CanvasItemPlaceholder({
  item,
  selected,
  resolveMediaSrc,
  onSelect,
}: {
  item: CanvasItem;
  selected: boolean;
  resolveMediaSrc: (src: string) => string;
  onSelect: () => void;
}) {
  const style: CSSProperties = {
    left: item.x,
    top: item.y,
    width: item.w,
    height: item.h,
    zIndex: item.z,
  };
  if (item.rotate !== undefined && item.rotate !== 0) style.transform = `rotate(${item.rotate}deg)`;

  return (
    <div
      /* `doc-item` so the page's connector script can find this, exactly as
         it finds the real canvas editor's items. See the note in
         ../canvas/CanvasEditor.tsx; the class carries no styling here. */
      className={[
        'cms-ph-item',
        selected ? 'cms-ph-item--selected' : '',
        item.anchor === undefined ? '' : 'doc-item',
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
      data-item-id={item.id}
      data-anchor-block={item.anchor?.blockId}
      data-connector-seed={seedFromId(item.id)}
      data-connector-color={item.color}
      data-testid={`surface-item-${item.id}`}
      onMouseDown={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      <div className="cms-ph-item__box">
        {item.kind === 'image' && item.src !== undefined && (
          <img className="cms-ph-item__img" src={resolveMediaSrc(item.src)} alt={item.alt ?? ''} />
        )}
        {item.kind === 'shape' && <ShapeOutline item={item} />}
        {(item.kind === 'video' || item.kind === 'embed') && (
          <span className="cms-ph-item__alt">{item.src}</span>
        )}
      </div>
      <span className="cms-ph-item__label">
        {item.kind === 'shape' ? (item.shape ?? 'shape') : item.kind}
        {item.anchor !== undefined ? ' · anchored' : ''}
      </span>
    </div>
  );
}

function ShapeOutline({ item }: { item: CanvasItem }) {
  const color = item.color ?? '#111111';
  const width = item.strokeWidth ?? 2;
  const common = {
    stroke: color,
    strokeWidth: width,
    fill: item.fill ?? 'none',
    strokeLinecap: 'round' as const,
  };
  return (
    <svg
      viewBox={`0 0 ${item.w} ${item.h}`}
      width="100%"
      height="100%"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {item.shape === 'rect' && (
        <rect
          x={width / 2}
          y={width / 2}
          width={Math.max(0, item.w - width)}
          height={Math.max(0, item.h - width)}
          rx={item.radius ?? 0}
          {...common}
        />
      )}
      {item.shape === 'ellipse' && (
        <ellipse
          cx={item.w / 2}
          cy={item.h / 2}
          rx={Math.max(0, item.w / 2 - width / 2)}
          ry={Math.max(0, item.h / 2 - width / 2)}
          {...common}
        />
      )}
      {item.shape === 'line' && (
        <line x1={0} y1={item.h / 2} x2={item.w} y2={item.h / 2} {...common} fill="none" />
      )}
      {item.shape === 'arrow' && (
        <g {...common} fill="none">
          <path d={`M 0 ${item.h} C ${item.w * 0.4} ${item.h} ${item.w * 0.5} 0 ${item.w} 4`} />
          <path d={`M ${item.w - 18} 0 L ${item.w} 4 L ${item.w - 14} 16`} />
        </g>
      )}
      {item.shape === 'squiggle' && (
        <path
          d={`M 0 ${item.h / 2} Q ${item.w * 0.17} 0 ${item.w * 0.34} ${item.h / 2} T ${item.w * 0.68} ${item.h / 2} T ${item.w} ${item.h / 2}`}
          {...common}
          fill="none"
        />
      )}
    </svg>
  );
}

/*
 * THE NAV AND THE FOOTER around the page used to be drawn here, from a
 * hardcoded list of four invented labels and five grey squares. They are
 * content now — `src/content/data/site.json`, edited in the CMS under Home —
 * so the scenery is `../chrome/chrome-view.tsx`, reading the same file the
 * published page does, with the same icons. It is still inert
 * (`aria-hidden`, `pointer-events: none` in ./styles.ts): scenery, not
 * navigation. The real markup lives in src/layouts/Base.astro; this mirrors
 * its shape, and ./styles.ts mirrors global.css for the type.
 */
