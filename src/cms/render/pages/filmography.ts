/**
 * src/cms/render/pages/filmography.ts
 *
 * WS-B. The filmography index, from `src/content/data/filmography.json`.
 *
 * The behaviour this preserves is the poster-frame facade in
 * `src/pages/filmography/index.astro`: four `<button class="video">` elements
 * showing a still, and the real YouTube player built only when one is clicked.
 * Four `<iframe>`s on first paint would be four players, four cookie banners
 * and about two megabytes to look at a page of stills. The click handler lives
 * in `src/cms/render/video.ts`.
 *
 * The markup is byte-for-byte what the live page emits, with two additions:
 *
 *   data-video-id   was `film.id`, which the old `src/data/filmography.ts`
 *                   overloaded as the YouTube id. The schema separates them
 *                   (contracts 10.1), so this is now `film.youtubeId`.
 *   data-embed      the whole autoplay embed URL, built here by
 *                   `youtubeEmbedUrl`. The client script reads it instead of
 *                   assembling a URL of its own, so there is one definition of
 *                   the embed and the script needs no import — importing the
 *                   schema would pull zod into the page to format one string.
 *
 * The poster is `filmPosterSrc`: the uploaded one, else YouTube's own
 * thumbnail. The live page has a local still for all four films; a film added
 * through the CMS without one falls back rather than showing a broken image.
 *
 * No DOM, no React, no Astro.
 */

import { filmPosterSrc, youtubeEmbedUrl } from '../../schema.ts';
import type { Film } from '../../schema.ts';
import { attr, escapeText, joinParts, safeUrl } from '../escape.ts';
import { renderMasthead } from './masthead.ts';

/** The play triangle, from src/pages/filmography/index.astro. */
const PLAY_SVG =
  '<svg viewBox="0 0 20 22" aria-hidden="true" focusable="false">' +
  '<path d="M19 11L1 21.4V0.6L19 11Z" fill="#111111" />' +
  '</svg>';

/**
 * The poster's intrinsic size, as the live page states it. Both an uploaded
 * poster and every YouTube thumbnail quality are 16:9, and `.video` already
 * carries `aspect-ratio: 16 / 9` with `object-fit: cover`, so these two numbers
 * only reserve the right shape before the still arrives.
 */
const POSTER_WIDTH = 1280;
const POSTER_HEIGHT = 720;

/**
 * One film. A film whose poster is not a usable URL still renders: the facade
 * is a 16:9 `--placeholder` box with the play mark on it, which is what the
 * page looks like for the half second before any still loads anyway.
 */
export function renderFilm(film: Film): string {
  const poster = safeUrl(filmPosterSrc(film));
  const label = `Play ${film.title}`;
  const note =
    film.note === undefined || film.note === ''
      ? ''
      : `<span class="card-note">${escapeText(film.note)}</span>`;

  const still =
    poster === null
      ? ''
      : `<img${attr('src', poster)} alt=""${attr('width', POSTER_WIDTH)}${attr('height', POSTER_HEIGHT)}` +
        ' loading="lazy" decoding="async" />';

  return (
    '<li class="card">' +
    '<button class="video" type="button"' +
    attr('data-video-id', film.youtubeId) +
    attr('data-embed', youtubeEmbedUrl(film.youtubeId, { autoplay: true })) +
    attr('aria-label', label) +
    '>' +
    still +
    `<span class="video-play">${PLAY_SVG}</span>` +
    '</button>' +
    '<div class="card-text">' +
    `<span class="card-title">${escapeText(film.title)}</span>` +
    note +
    `<span class="card-meta">${escapeText(`${film.kind} · ${film.year}`)}</span>` +
    '</div>' +
    '</li>'
  );
}

/** The grid. Two across on a wide screen, one on a phone — `.cards--halves`. */
export function renderFilmList(films: readonly Film[]): string {
  if (films.length === 0) return '';
  return `<ul class="cards cards--halves">${joinParts(films.map(renderFilm))}</ul>`;
}

/**
 * The whole surface, masthead included, so a preview or a harness can render
 * the page without an Astro file around it. WS-G's page can call
 * `renderFilmList` alone if it would rather keep its own masthead.
 *
 * An empty collection shows the site's own "nothing yet" line rather than an
 * empty grid, matching `src/pages/projects/index.astro` and
 * `src/pages/essays/index.astro`. The live filmography page has no empty
 * branch because it has never been empty.
 */
export function renderFilmography(films: readonly Film[]): string {
  const body =
    films.length === 0
      ? '<p class="empty">Nothing here yet. Soon.</p>'
      : renderFilmList(films);
  return renderMasthead('Filmography') + body;
}
