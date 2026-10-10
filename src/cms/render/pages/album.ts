/**
 * src/cms/render/pages/album.ts
 *
 * WS-B. The album page at `/photography/<slug>/` — the one new surface in
 * phase 2 (docs/cms-sections.md 3.4). Everything else this workstream touches
 * is an existing page changing where its content comes from; this is the only
 * page that did not exist yesterday, so it is the only place where a design
 * decision was available to make.
 *
 * What it is made of, all of it borrowed:
 *
 *   masthead    `.masthead` + `h1`, as every index page opens. The year sits
 *               under it in the accent nav face, which is `.post-meta` on an
 *               essay and `.card-meta` on a tile. The summary is `.lead`, the
 *               italic standfirst a project and an essay already use.
 *   the grid    a justified gallery: rows of roughly equal height, each photo
 *               at its own aspect ratio, nothing cropped. This is the one
 *               thing with no precedent on the site, and it is the brief's
 *               "a photo grid that respects varying aspect ratios".
 *   the lightbox  `.lightbox`, `.lightbox-stage`, `.lightbox-close`,
 *               `.lightbox-hint` and `body.is-locked`, which is the overlay
 *               `src/pages/index.astro` already uses for the hero, with
 *               arrows added because an album has more than one picture.
 *
 * How the justified grid works, because it is one line of CSS and one inline
 * custom property and it is not obvious:
 *
 *   each photo  flex-grow: <ar>;  flex-basis: calc(<ar> * --album-row)
 *
 * A row's items all resolve to a width proportional to their aspect ratio, so
 * `height = width / ar` comes out the same for every item in that row: rows
 * line up without anyone being cropped, and document order is preserved, which
 * column-based masonry would have thrown away. `--album-row` is the height a
 * row aims for. The `::after` in the stylesheet soaks up the slack on the last
 * row, so a lone final photo stays its own size instead of stretching to the
 * full width.
 *
 * No DOM, no React, no Astro.
 */

import { albumCoverPhoto } from '../../schema.ts';
import type { Album, Photo } from '../../schema.ts';
import { attr, css, escapeText, joinParts, safeUrl } from '../escape.ts';

/**
 * The ratio the stylesheet falls back to in `var(--ar, 1.5)`, for markup that
 * somehow carries neither the custom property nor `album-photo--unsized`. The
 * renderer never guesses: a photo with no intrinsic size gets the unsized
 * class instead, and is capped to the row height rather than laid out from a
 * ratio it does not have. `w` and `h` are optional and travel together
 * (contracts 10.2), so this is a real case and not defensive padding.
 */
export const DEFAULT_ASPECT = 3 / 2;

function aspectOf(photo: Photo): number | null {
  if (photo.w === undefined || photo.h === undefined) return null;
  if (photo.w <= 0 || photo.h <= 0) return null;
  return photo.w / photo.h;
}

/** The dialog's id, scoped to the album so two can share a page. */
export function albumLightboxId(album: Album): string {
  return `album-lightbox-${album.slug}`;
}

/* -------------------------------------------------------------------------- */
/* Masthead                                                                   */
/* -------------------------------------------------------------------------- */

export function renderAlbumHead(album: Album): string {
  const summary =
    album.summary === undefined || album.summary === ''
      ? ''
      : `<p class="lead album-lead">${escapeText(album.summary)}</p>`;
  return (
    '<div class="masthead album-head">' +
    `<h1>${escapeText(album.title)}</h1>` +
    `<p class="album-meta">${escapeText(album.year)}</p>` +
    summary +
    '</div>'
  );
}

/* -------------------------------------------------------------------------- */
/* The grid                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One photo.
 *
 * `--ar` drives the flex sizing; `aspect-ratio` on the image reserves the box
 * before the file arrives so the page does not reflow as photographs land.
 * Both are omitted when the intrinsic size is unknown, and the image then
 * takes its natural height once it loads — honest, if slightly jumpy, which is
 * better than cropping a photograph to a ratio nobody authored.
 *
 * The button is what opens the overlay. A `<button>` and not a bare image, so
 * it is reachable by keyboard and announces itself; without script it does
 * nothing, and the photograph is still there to look at.
 */
export function renderAlbumPhoto(photo: Photo, index: number, album: Album): string {
  const src = safeUrl(photo.src);
  if (src === null) return '';

  const aspect = aspectOf(photo);
  const sized = aspect !== null;
  const style = sized ? ` style="--ar:${css(aspect)}"` : '';
  const ratio = sized ? ` style="aspect-ratio:${css(photo.w!)} / ${css(photo.h!)}"` : '';

  const alt = photo.alt ?? '';
  const label = alt === '' ? `Enlarge photograph ${index + 1}` : `Enlarge: ${alt}`;
  const caption =
    photo.caption === undefined || photo.caption === ''
      ? ''
      : `<figcaption class="album-caption">${escapeText(photo.caption)}</figcaption>`;

  return (
    `<figure class="album-photo${sized ? '' : ' album-photo--unsized'}"` +
    attr('data-photo-id', photo.id) +
    `${style}>` +
    '<button class="album-open" type="button"' +
    attr('data-album-index', index) +
    attr('aria-label', label) +
    attr('aria-controls', albumLightboxId(album)) +
    '>' +
    `<img${attr('src', src)}${attr('alt', alt)}` +
    attr('width', photo.w) +
    attr('height', photo.h) +
    ' loading="lazy" decoding="async"' +
    ratio +
    ' />' +
    '</button>' +
    caption +
    '</figure>'
  );
}

export function renderAlbumGrid(album: Album): string {
  if (album.photos.length === 0) {
    return '<p class="empty">No photographs in this album yet.</p>';
  }
  const photos = joinParts(
    album.photos.map((photo, index) => renderAlbumPhoto(photo, index, album)),
  );
  if (photos === '') return '<p class="empty">No photographs in this album yet.</p>';
  return (
    '<div class="album-grid"' +
    attr('data-lightbox', albumLightboxId(album)) +
    attr('data-album-slug', album.slug) +
    `>${photos}</div>`
  );
}

/* -------------------------------------------------------------------------- */
/* The lightbox                                                               */
/* -------------------------------------------------------------------------- */

const CLOSE_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path d="M3 3l10 10M13 3L3 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />' +
  '</svg>';

/** A chevron, drawn the same weight as the close mark. */
function chevron(direction: 'left' | 'right'): string {
  const path = direction === 'left' ? 'M10.5 3L5 8l5.5 5' : 'M5.5 3L11 8l-5.5 5';
  return (
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    `<path d="${path}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />` +
    '</svg>'
  );
}

/**
 * The overlay. One per album, empty until something is clicked: the stage's
 * `src` is filled in by `src/cms/render/lightbox.ts`, so the page ships no
 * second copy of every photograph.
 *
 * The arrows and the counter are only emitted when there is more than one
 * photograph. A single-photo album gets exactly the hero's overlay, hint and
 * all, which is the pattern this is reusing.
 */
export function renderAlbumLightbox(album: Album): string {
  const many = album.photos.length > 1;
  // Not the hero's "DRAG & PINCH": an album photograph is fitted to the window
  // rather than shown at 72vh and panned across, so there is nothing to drag.
  const hint = many ? '&larr; &rarr; TO BROWSE' : 'ESC TO CLOSE';

  return (
    `<div class="lightbox album-lightbox"${attr('id', albumLightboxId(album))}` +
    ' tabindex="-1" role="dialog" aria-modal="true" aria-label="Photograph, enlarged">' +
    '<div class="lightbox-stage"><img src="" alt="" /></div>' +
    (many
      ? `<span class="lightbox-count" aria-hidden="true">1 / ${album.photos.length}</span>`
      : '') +
    '<button class="lightbox-close" type="button" aria-label="Close">' +
    CLOSE_SVG +
    '</button>' +
    (many
      ? '<button class="lightbox-prev" type="button" aria-label="Previous photograph">' +
        chevron('left') +
        '</button>' +
        '<button class="lightbox-next" type="button" aria-label="Next photograph">' +
        chevron('right') +
        '</button>'
      : '') +
    `<span class="lightbox-hint">${hint}</span>` +
    '</div>'
  );
}

/* -------------------------------------------------------------------------- */
/* renderAlbumPage                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The album page body: masthead, grid, overlay.
 *
 * Several top-level elements, like the homepage and for the same reason: the
 * overlay is `position: fixed` and must resolve against the viewport, so it
 * cannot go inside anything that establishes containment.
 */
export function renderAlbumPage(album: Album): string {
  return joinParts([renderAlbumHead(album), renderAlbumGrid(album), renderAlbumLightbox(album)]);
}

/**
 * What the `<head>` of the page should say, so WS-G's page does not have to
 * invent it. `description` falls back to something true rather than to the
 * title, because a meta description that repeats the title is worse than none.
 */
export function albumPageMeta(album: Album): { title: string; description: string } {
  const count = album.photos.length;
  return {
    title: album.title,
    description:
      album.summary ??
      `${count} photograph${count === 1 ? '' : 's'} by Ryan Choi, ${album.year}.`,
  };
}

/** Every album that should get a page. One place for WS-G's getStaticPaths. */
export function albumPagePaths(albums: readonly Album[]): { slug: string; album: Album }[] {
  return albums.map((album) => ({ slug: album.slug, album }));
}

/** Re-exported so a page building both surfaces imports one module. */
export { albumCoverPhoto };
