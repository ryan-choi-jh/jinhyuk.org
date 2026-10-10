/**
 * src/cms/render/pages/photography.ts
 *
 * WS-B. The photography index, from `src/content/data/photography.json`.
 *
 * Two states, both already in `src/pages/photography/index.astro`:
 *
 *  - no albums: the illustration and the "currently developing" note. This is
 *    what the page shows on the live site right now, because
 *    `src/data/photography.ts` is empty, so it is the state the pixel
 *    comparison in verify-sections.ts is run against. The copy, the two
 *    conditional `<br>`s and the `&rsquo;` are reproduced exactly; the line
 *    breaks matter, because whichever `<br>` is hidden collapses back to the
 *    space in the source.
 *  - albums: the `.cards--thirds` tile grid.
 *
 * One change, and it is the one phase 2 asks for. An album has a page now
 * (docs/cms-sections.md 3.4), so a tile is a link. The live tile is
 * `<li class="card">` holding a `div.card-media` and a `div.card-text`; a link
 * cannot be put on either of those without giving it a `display`, because
 * `.card-media`'s `aspect-ratio` does nothing on an inline box. So the whole
 * card becomes one `<a class="card-link">` that takes over `.card`'s flex
 * column — one declaration, in `src/cms/styles/sections.css`, and the computed
 * layout is identical: `.card` keeps its own `gap`, and with a single child
 * that gap no longer has anything to apply to.
 *
 * No DOM, no React, no Astro.
 */

import { albumCoverPhoto } from '../../schema.ts';
import type { Album } from '../../schema.ts';
import { attr, escapeText, joinParts, safeUrl } from '../escape.ts';
import { renderMasthead } from './masthead.ts';

/* -------------------------------------------------------------------------- */
/* The empty state                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Verbatim from `src/pages/photography/index.astro`. Static copy, so it is a
 * literal rather than an escaped value: `&rsquo;` has to reach the browser as
 * an entity, and `escapeText` would turn it into `&amp;rsquo;`.
 */
const EMPTY_STATE =
  '<div class="empty-state">' +
  '<img class="empty-art" src="/photography/placeholder.webp"' +
  ' alt="A drawing of Ryan Choi in a cable-knit sweater, camera raised to his eye,' +
  ' photographing hot air balloons over the rock spires of Cappadocia."' +
  ' width="1200" height="918" loading="lazy" decoding="async" />' +
  '<div class="empty-text">' +
  '<p class="empty-label">Currently developing</p>' +
  '<p class="empty-note">\n' +
  'An empty gallery is a bold artistic statement.<br class="brk-wide" />\n' +
  'Unfortunately, it wasn&rsquo;t intentional.<br class="brk-narrow" />\n' +
  'The film photos are on their way.\n' +
  '</p>' +
  '</div>' +
  '</div>';

export function renderPhotographyEmptyState(): string {
  return EMPTY_STATE;
}

/* -------------------------------------------------------------------------- */
/* The tiles                                                                  */
/* -------------------------------------------------------------------------- */

/** Where an album's page lives. One definition, shared with the album page. */
export function albumHref(album: Album): string {
  return `/photography/${album.slug}/`;
}

/**
 * One tile. The cover is `albumCoverPhoto`: the chosen photo, else the first,
 * else nothing — the same fallback the CMS list row uses, so the tile and the
 * sidebar can never show different pictures.
 *
 * `alt` is the album title, as the live page has it. Not the photo's own alt:
 * on an index the picture stands for the album, and a screen reader hearing
 * "The month view, most squares empty" where it expected "First Build" has
 * been told about the wrong thing.
 */
export function renderAlbumTile(album: Album): string {
  const cover = albumCoverPhoto(album);
  const src = cover === null ? null : safeUrl(cover.src);
  const image =
    src === null
      ? ''
      : `<img${attr('src', src)}${attr('alt', album.title)} loading="lazy" decoding="async" />`;

  return (
    '<li class="card">' +
    `<a class="card-link"${attr('href', albumHref(album))}>` +
    `<div class="card-media">${image}</div>` +
    '<div class="card-text">' +
    `<span class="card-title">${escapeText(album.title)}</span>` +
    `<span class="card-meta">${escapeText(album.year)}</span>` +
    '</div>' +
    '</a>' +
    '</li>'
  );
}

/** The grid. Three across on a wide screen, one on a phone — `.cards--thirds`. */
export function renderAlbumList(albums: readonly Album[]): string {
  if (albums.length === 0) return '';
  return `<ul class="cards cards--thirds">${joinParts(albums.map(renderAlbumTile))}</ul>`;
}

/**
 * The whole surface. Empty state or grid, exactly as the live page chooses
 * between them.
 */
export function renderPhotography(albums: readonly Album[]): string {
  const body = albums.length === 0 ? EMPTY_STATE : renderAlbumList(albums);
  return renderMasthead('Photography') + body;
}
