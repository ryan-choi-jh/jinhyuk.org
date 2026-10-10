/**
 * src/cms/render/canvas.ts
 *
 * WS-1. Canvas bands: free placement, overlay bands, connector hooks.
 *
 * Geometry (docs/cms-rebuild.md 3.3). Everything is authored in reference
 * pixels against REFERENCE_WIDTH, and converted through the schema's own
 * `refPxToPercent` so there is one formula in the project:
 *
 *   x  ->  left, as a percentage of the content width
 *   w  ->  width, as a percentage of the content width
 *   y  ->  top, in `cqw` against `.doc`
 *   h  ->  `aspect-ratio` on the media frame
 *
 * `cqw` needs a word. 1cqw is 1% of `.doc`'s inline size, so `top` in cqw is
 * the same number as `left` in %, resolved against the same box. At the
 * reference width it is exactly the stored pixel value, and at any other width
 * the whole arrangement scales uniformly instead of shearing: tops stay
 * proportional to widths, so four overlapping screenshots keep overlapping and
 * an anchored connector keeps pointing where it was drawn. Each declaration
 * ships the literal px value first as a fallback, so a browser without
 * container query units falls back to the stored pixels rather than to nothing.
 * This is a deliberate, declared departure from the schema's note that "y and h
 * stay in px"; see the report.
 *
 * No DOM, no React, no Astro.
 */

import { refPxToPercent, resolveAnchor, seedFromId } from '../schema.ts';
import type { CanvasBand, CanvasItem, Doc } from '../schema.ts';
import { attr, css, escapeAttr, escapeText, joinParts, safeUrl } from './escape.ts';
import { renderShapeSvg } from './shapes.ts';

/* -------------------------------------------------------------------------- */
/* Embeds                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A pasted video link turned into something an iframe can load. Same hosts and
 * same nocookie choice as the existing site's `embedFor` in
 * src/lib/project-doc.ts, duplicated rather than imported so the renderer has
 * no dependency outside src/cms/ and survives WS-11 deleting that file.
 */
export function embedSrc(raw: string): string | null {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const id = url.searchParams.get('v');
      if (id !== null && id !== '') return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`;
    }
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1);
      if (id !== '') return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`;
    }
    if (host === 'vimeo.com') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      if (id !== undefined) return `https://player.vimeo.com/video/${encodeURIComponent(id)}`;
    }
  } catch {
    // Not a url we can embed. Fall through.
  }
  return null;
}

const IFRAME_ALLOW =
  'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';

/* -------------------------------------------------------------------------- */
/* One item                                                                   */
/* -------------------------------------------------------------------------- */

/** The positioned box. See the geometry note at the top of the file. */
function itemStyle(item: CanvasItem): string {
  const parts = [
    `left:${css(refPxToPercent(item.x))}%`,
    `top:${css(item.y)}px`,
    `top:${css(refPxToPercent(item.y))}cqw`,
    `width:${css(refPxToPercent(item.w))}%`,
  ];
  // `rotate: 0` is not a rotation; leaving the transform off keeps the element
  // off the compositor and out of the way of the mobile stack.
  if (item.rotate !== undefined && item.rotate !== 0) {
    parts.push(`transform:rotate(${css(item.rotate)}deg)`);
  }
  if (item.z !== undefined) parts.push(`z-index:${Math.trunc(item.z)}`);
  return parts.join(';');
}

/**
 * The media frame. `aspect-ratio` rather than a pixel height, so the authored
 * shape survives at every width and the box has its final size before the image
 * has loaded. That last part matters twice: the page does not reflow as images
 * arrive, and the connector script measures the right box on its first pass.
 */
function frameStyle(item: CanvasItem): string {
  return `aspect-ratio:${css(item.w)} / ${css(item.h)}`;
}

/** The contents of an item's frame, or '' when there is nothing renderable. */
function itemBody(item: CanvasItem): string {
  if (item.kind === 'shape') return renderShapeSvg(item);

  const src = safeUrl(item.src);
  if (src === null) return '';

  switch (item.kind) {
    case 'image':
      return `<img${attr('src', src)}${attr('alt', item.alt ?? '')} loading="lazy" decoding="async" />`;

    case 'video':
      return `<video${attr('src', src)} controls playsinline preload="metadata"></video>`;

    case 'embed': {
      const embed = embedSrc(src) ?? src;
      const title = item.caption ?? item.alt ?? 'Embedded video';
      return (
        `<iframe${attr('src', embed)}${attr('title', title)} loading="lazy"` +
        ` allow="${escapeAttr(IFRAME_ALLOW)}" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`
      );
    }

    default:
      return '';
  }
}

/**
 * The attributes the connector script looks for. Only emitted when the anchor
 * resolves: a dangling anchor is legal (contracts 2.2) and the renderer's job
 * is to skip the connector, not to complain.
 *
 * The seed travels in the markup so the client script never has to import the
 * schema, which would drag zod into the browser bundle to read one number.
 */
function anchorAttrs(item: CanvasItem, doc: Doc): string {
  if (item.anchor === undefined) return '';
  if (resolveAnchor(doc, item.anchor) === null) return '';
  return (
    attr('data-anchor-band', item.anchor.bandId) +
    attr('data-anchor-block', item.anchor.blockId) +
    attr('data-connector-seed', seedFromId(item.id)) +
    (item.color !== undefined ? attr('data-connector-color', item.color) : '')
  );
}

/**
 * One canvas item. A `<figure>` for media, because a caption is a figcaption;
 * a `<div>` for a shape, which is decoration.
 */
export function renderCanvasItem(item: CanvasItem, doc: Doc): string {
  const body = itemBody(item);
  if (body === '') return '';

  const tag = item.kind === 'shape' ? 'div' : 'figure';
  const caption =
    item.caption !== undefined && item.caption !== ''
      ? `<figcaption class="doc-caption">${escapeText(item.caption)}</figcaption>`
      : '';

  return (
    `<${tag} class="doc-item doc-item--${item.kind}"` +
    attr('data-item-id', item.id) +
    anchorAttrs(item, doc) +
    ` style="${itemStyle(item)}">` +
    `<div class="doc-frame" style="${frameStyle(item)}">${body}</div>` +
    caption +
    `</${tag}>`
  );
}

/* -------------------------------------------------------------------------- */
/* One band                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A canvas band.
 *
 * Items are emitted in document order, not in z order: document order is what
 * the mobile stack reads (3.4), and `z-index` already decides what sits on top
 * on a wide screen. Sorting here would quietly reorder the phone layout.
 *
 * An overlay band (2.2) reserves no vertical space and sits over the band
 * before it. That is done in the stylesheet, by taking the band out of flow
 * inside its `.doc-group`; `height` still ships, because it is the coordinate
 * box the editor draws in and the fallback for browsers without `cqw`.
 */
export function renderCanvasBand(band: CanvasBand, doc: Doc): string {
  const items = joinParts(band.items.map((item) => renderCanvasItem(item, doc)));
  const overlay = band.overlay === true;
  const height = `height:${css(band.height)}px;height:${css(refPxToPercent(band.height))}cqw`;

  return (
    `<div class="doc-band doc-band--canvas${overlay ? ' doc-band--overlay' : ''}"` +
    attr('data-band-id', band.id) +
    (overlay ? ' data-overlay="true"' : '') +
    ` style="${height}">${items}</div>`
  );
}
