/**
 * src/cms/render/pages/index.ts
 *
 * WS-B. One import for every surface of the site.
 *
 *   home          renderDoc(doc)                 — via ../index.ts
 *   essays        renderDoc(doc)                 — via ../index.ts
 *   essays index  renderLedgerPage(items, 'essays')
 *   projects      renderDoc(doc)                 — via ../index.ts
 *   projects idx  renderLedgerPage(items, 'projects')
 *   filmography   renderFilmography(films)
 *   photography   renderPhotography(albums)
 *   album page    renderAlbumPage(album)
 *
 * Everything here is pure: a string in, a string out, no DOM and no framework,
 * the same contract `renderDoc` has (docs/cms-contracts.md 4). The two pieces
 * that cannot be static are in `../video.ts` and `../lightbox.ts`.
 */

export { renderDocButtons } from './buttons.ts';
export {
  renderHero,
  renderHeroLightbox,
  renderHomeWith,
  renderIntro,
  splitHome,
} from './home.ts';
export type { HomeParts } from './home.ts';
export { renderFilm, renderFilmList, renderFilmography } from './filmography.ts';
export {
  albumHref,
  renderAlbumList,
  renderAlbumTile,
  renderPhotography,
  renderPhotographyEmptyState,
} from './photography.ts';
export {
  DEFAULT_ASPECT,
  albumLightboxId,
  albumPageMeta,
  albumPagePaths,
  renderAlbumGrid,
  renderAlbumHead,
  renderAlbumLightbox,
  renderAlbumPage,
  renderAlbumPhoto,
} from './album.ts';
export {
  ledgerItemsFromDocs,
  ledgerItemsFromMetas,
  renderLedger,
  renderLedgerPage,
  sortNewestFirst,
} from './ledger.ts';
export type { LedgerItem, LedgerSectionId } from './ledger.ts';
export { formatLedgerDate, renderEmptyLine, renderMasthead } from './masthead.ts';
