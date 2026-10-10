/**
 * src/cms/app/records/album-edits.ts
 *
 * WS-E. Every edit the album editor can make, as a pure function from `Album`
 * to `Album`. Same two rules as `./film-edits.ts` — canonical key order, no
 * empty optionals — plus the three cross-field rules the schema enforces
 * (docs/cms-contracts.md 10.2), which are easier to keep right in one place
 * than in a component:
 *
 *  1. `w` and `h` travel together: both or neither, never half a pair.
 *  2. Photo ids are unique within the album.
 *  3. `cover` is the id of a photo in THIS album, so deleting the cover photo
 *     has to clear `cover` IN THE SAME EDIT. Every removal here does.
 *
 * Reordering is the whole mechanism for order (docs/cms-contracts.md 9.4):
 * read the array, permute it, write it back. There is no separate format and
 * no index stored on a photo.
 */

import { albumCoverPhoto, newAlbum, newId, newPhoto, slugify, validateAlbum } from '../../schema.ts';
import type { Album, Photo } from '../../schema.ts';

import { optionalText, yearProblem } from './film-edits.ts';
import type { UploadedMedia } from './types.ts';

export { optionalText, yearProblem };

/* -------------------------------------------------------------------------- */
/* Canonical form                                                              */
/* -------------------------------------------------------------------------- */

/** A whole number of pixels, or undefined. Half a pair is dropped by `canonicalPhoto`. */
function pixels(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  const whole = Math.round(value);
  return whole > 0 ? whole : undefined;
}

/** `PhotoSchema`'s key order, no empty optionals, `w`/`h` only as a pair. */
export function canonicalPhoto(photo: Photo): Photo {
  const alt = optionalText(photo.alt);
  const caption = optionalText(photo.caption);
  const w = pixels(photo.w);
  const h = pixels(photo.h);
  const pair = w !== undefined && h !== undefined;
  return {
    id: photo.id,
    src: photo.src,
    ...(alt === undefined ? {} : { alt }),
    ...(caption === undefined ? {} : { caption }),
    ...(pair ? { w, h } : {}),
  };
}

/**
 * `AlbumSchema`'s key order, no empty optionals, and a `cover` that is
 * guaranteed to name a photo that is actually here.
 */
export function canonicalAlbum(album: Album): Album {
  const photos = album.photos.map(canonicalPhoto);
  const ids = new Set(photos.map((photo) => photo.id));
  const chosen = optionalText(album.cover);
  const cover = chosen !== undefined && ids.has(chosen) ? chosen : undefined;
  const summary = optionalText(album.summary);
  return {
    id: album.id,
    slug: album.slug,
    title: album.title,
    year: album.year,
    ...(cover === undefined ? {} : { cover }),
    ...(summary === undefined ? {} : { summary }),
    photos,
  };
}

/** Merge a patch and canonicalise. The one way a header field is committed. */
export function patchAlbum(album: Album, patch: Partial<Album>): Album {
  return canonicalAlbum({ ...album, ...patch });
}

/* -------------------------------------------------------------------------- */
/* Slug                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The slug an album's title suggests. Falls back to the record id when the
 * title slugifies to nothing — a title of only Hangul or only punctuation —
 * which is exactly what `newAlbum` does (docs/cms-contracts.md 10.4).
 */
export function suggestSlug(title: string, recordId: string): string {
  const derived = slugify(title);
  return derived === '' ? recordId.replace(/_/g, '-') : derived;
}

/** True when the slug is still the one the title would suggest. */
export function slugFollowsTitle(album: Album): boolean {
  return album.slug === suggestSlug(album.title, album.id);
}

/**
 * Retitle, carrying the slug along only while the owner has not pinned one of
 * their own. A published album's address does not move because its title was
 * reworded.
 */
export function setAlbumTitle(album: Album, title: string): Album {
  const follow = slugFollowsTitle(album);
  const slug = follow ? suggestSlug(title, album.id) : album.slug;
  return patchAlbum(album, { title, slug });
}

/* -------------------------------------------------------------------------- */
/* Photos: adding                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One upload result becomes one photo. `newPhoto` is the schema's factory, so
 * the `ph` id prefix and the `w`/`h` pairing rule live in one place; dimensions
 * are only passed on when BOTH arrived as usable numbers.
 */
export function photoFromUpload(upload: UploadedMedia, overrides: Partial<Photo> = {}): Photo {
  const w = pixels(upload.w);
  const h = pixels(upload.h);
  const dimensions = w !== undefined && h !== undefined ? { w, h } : undefined;
  return canonicalPhoto(newPhoto(upload.src, dimensions, overrides));
}

const clampIndex = (index: number, length: number): number =>
  Math.min(Math.max(Math.trunc(index), 0), length);

/**
 * Insert photos at `index`, renaming any id that would collide so rule 2
 * cannot be broken by pasting a photo twice.
 */
export function insertPhotosAt(album: Album, photos: readonly Photo[], index: number): Album {
  if (photos.length === 0) return canonicalAlbum(album);
  const taken = new Set(album.photos.map((photo) => photo.id));
  const fresh = photos.map((photo) => {
    let candidate = photo;
    while (taken.has(candidate.id)) candidate = { ...candidate, id: newId('ph') };
    taken.add(candidate.id);
    return canonicalPhoto(candidate);
  });
  const at = clampIndex(index, album.photos.length);
  const next = [...album.photos.slice(0, at), ...fresh, ...album.photos.slice(at)];
  return patchAlbum(album, { photos: next });
}

export function appendPhotos(album: Album, photos: readonly Photo[]): Album {
  return insertPhotosAt(album, photos, album.photos.length);
}

/* -------------------------------------------------------------------------- */
/* Photos: order                                                               */
/* -------------------------------------------------------------------------- */

/** Move one element. Out-of-range indices are clamped rather than throwing. */
export function reorderPhotos(photos: readonly Photo[], from: number, to: number): Photo[] {
  const next = [...photos];
  if (next.length === 0) return next;
  const source = Math.min(Math.max(Math.trunc(from), 0), next.length - 1);
  const target = Math.min(Math.max(Math.trunc(to), 0), next.length - 1);
  if (source === target) return next;
  const [moved] = next.splice(source, 1);
  if (moved === undefined) return next;
  next.splice(target, 0, moved);
  return next;
}

export function indexOfPhoto(album: Album, photoId: string): number {
  return album.photos.findIndex((photo) => photo.id === photoId);
}

export function movePhoto(album: Album, from: number, to: number): Album {
  return patchAlbum(album, { photos: reorderPhotos(album.photos, from, to) });
}

/** The keyboard path for reordering: one step left or right. */
export function movePhotoBy(album: Album, photoId: string, delta: number): Album {
  const from = indexOfPhoto(album, photoId);
  if (from < 0) return canonicalAlbum(album);
  const to = from + delta;
  if (to < 0 || to > album.photos.length - 1) return canonicalAlbum(album);
  return movePhoto(album, from, to);
}

/* -------------------------------------------------------------------------- */
/* Photos: the cover                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The photo actually on the tile: the chosen one, else the first, else null.
 * `albumCoverPhoto` is the schema's single implementation of that fallback.
 */
export function effectiveCoverId(album: Album): string | null {
  return albumCoverPhoto(album)?.id ?? null;
}

/** True when this photo is the one being shown as the cover. */
export function isCover(album: Album, photoId: string): boolean {
  return effectiveCoverId(album) === photoId;
}

/** True when `cover` is written down, as opposed to falling back to the first photo. */
export function hasPinnedCover(album: Album): boolean {
  const chosen = optionalText(album.cover);
  return chosen !== undefined && album.photos.some((photo) => photo.id === chosen);
}

/** Pin a cover. A photo that is not in this album is ignored, never written. */
export function setCover(album: Album, photoId: string): Album {
  if (indexOfPhoto(album, photoId) < 0) return canonicalAlbum(album);
  return patchAlbum(album, { cover: photoId });
}

/** Back to "whatever is first", which is what an absent `cover` means. */
export function clearCover(album: Album): Album {
  return patchAlbum(album, { cover: undefined });
}

/**
 * The star on a tile. Clicking a photo that is not the cover pins it; clicking
 * the pinned cover unpins it, so the album goes back to following its first
 * photo.
 */
export function toggleCover(album: Album, photoId: string): Album {
  if (hasPinnedCover(album) && optionalText(album.cover) === photoId) return clearCover(album);
  return setCover(album, photoId);
}

/* -------------------------------------------------------------------------- */
/* Photos: per-photo text                                                      */
/* -------------------------------------------------------------------------- */

function mapPhoto(album: Album, photoId: string, fn: (photo: Photo) => Photo): Album {
  let hit = false;
  const photos = album.photos.map((photo) => {
    if (photo.id !== photoId) return photo;
    hit = true;
    return fn(photo);
  });
  if (!hit) return canonicalAlbum(album);
  return patchAlbum(album, { photos });
}

export function setPhotoAlt(album: Album, photoId: string, alt: string): Album {
  return mapPhoto(album, photoId, (photo) => ({ ...photo, alt }));
}

export function setPhotoCaption(album: Album, photoId: string, caption: string): Album {
  return mapPhoto(album, photoId, (photo) => ({ ...photo, caption }));
}

/* -------------------------------------------------------------------------- */
/* Photos: deleting, and putting it back                                       */
/* -------------------------------------------------------------------------- */

/**
 * Everything needed to undo one deletion: the photo, where it was, and whether
 * it was the pinned cover. Held by the editor, not by the record.
 */
export type PhotoRemoval = {
  photo: Photo;
  index: number;
  /** The album's `cover` before the deletion, so an undo restores the choice. */
  coverWas: string | undefined;
};

/**
 * Remove one photo. When it was the pinned cover, `cover` is cleared in the
 * same edit — rule 3: a cover pointing at a deleted photo is a broken tile,
 * not a recoverable fallback, and `canonicalAlbum` enforces it.
 */
export function removePhoto(
  album: Album,
  photoId: string,
): { album: Album; removal: PhotoRemoval | null } {
  const index = indexOfPhoto(album, photoId);
  const photo = album.photos[index];
  if (index < 0 || photo === undefined) return { album: canonicalAlbum(album), removal: null };
  const photos = album.photos.filter((candidate) => candidate.id !== photoId);
  const coverWas = optionalText(album.cover);
  const cover = coverWas === photoId ? undefined : coverWas;
  return {
    album: patchAlbum(album, { photos, cover }),
    removal: { photo: canonicalPhoto(photo), index, coverWas },
  };
}

/** Put a removed photo back where it was, cover choice and all. */
export function restorePhoto(album: Album, removal: PhotoRemoval): Album {
  const restored = insertPhotosAt(album, [removal.photo], removal.index);
  if (removal.coverWas === undefined) return restored;
  return patchAlbum(restored, { cover: removal.coverWas });
}

/* -------------------------------------------------------------------------- */
/* Per-field problems                                                          */
/* -------------------------------------------------------------------------- */

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function albumFieldProblem(album: Album, name: string): string | null {
  switch (name) {
    case 'title':
      return album.title.trim() === '' ? 'An album needs a title.' : null;
    case 'slug':
      if (album.slug.trim() === '') return 'An address, like summer-in-seoul.';
      if (!SLUG_RE.test(album.slug)) {
        return 'Lowercase letters, numbers and single hyphens only.';
      }
      return null;
    case 'year':
      return yearProblem(album.year);
    case 'photos':
      return album.photos.length === 0 ? 'No photos yet. An empty album still saves.' : null;
    default:
      return null;
  }
}

/** Advisory, not an error: an album with nothing in it is valid (10.2). */
export function photosProblemIsAdvisory(name: string): boolean {
  return name === 'photos';
}

export function isAlbumComplete(album: Album): boolean {
  return validateAlbum(album).ok;
}

/** How many photos are missing alt text, for the header's one-line nudge. */
export function missingAltCount(album: Album): number {
  return album.photos.filter((photo) => optionalText(photo.alt) === undefined).length;
}

export function blankAlbum(overrides: Partial<Album> = {}): Album {
  return canonicalAlbum(newAlbum(overrides));
}
