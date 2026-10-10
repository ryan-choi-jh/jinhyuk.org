/**
 * src/cms/app/records/film-edits.ts
 *
 * WS-E. Every edit a film editor can make, as a pure function from `Film` to
 * `Film`. No React, no DOM, no fetch, so `../records/verify.ts` can assert the
 * exact emitted JSON under bare node and the component is left with nothing to
 * do but render.
 *
 * Two rules every function here keeps:
 *
 *  1. **Canonical output.** Keys come out in the order `FilmSchema` declares
 *     them, and an optional field that is empty or blank is ABSENT rather than
 *     `""`. The schema would accept `note: ""` (it is a plain optional string),
 *     but writing one puts noise in the committed JSON and makes a diff lie.
 *  2. **Never emit an invalid id.** `youtubeId` is only ever written from
 *     `youtubeIdFromInput`, so a half-pasted URL stays in the editor's local
 *     text state and never reaches the record.
 */

import {
  filmPosterSrc,
  newFilm,
  validateFilm,
  youtubeIdFromInput,
  youtubeThumbUrl,
} from '../../schema.ts';
import type { Film, YouTubeThumbQuality } from '../../schema.ts';

/* -------------------------------------------------------------------------- */
/* Canonical form                                                              */
/* -------------------------------------------------------------------------- */

/** Blank is absent. A string of spaces is a user who typed nothing. */
export function optionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim() === '' ? undefined : value;
}

/**
 * The same film with `FilmSchema`'s key order and no empty optionals. Every
 * exported edit ends with this, so two editors that reach the same state emit
 * byte-identical JSON.
 */
export function canonicalFilm(film: Film): Film {
  const note = optionalText(film.note);
  const poster = optionalText(film.poster);
  const next: Film = {
    id: film.id,
    youtubeId: film.youtubeId,
    title: film.title,
    ...(note === undefined ? {} : { note }),
    kind: film.kind,
    year: film.year,
    ...(poster === undefined ? {} : { poster }),
  };
  return next;
}

/** Merge a patch and canonicalise. The one way a text field is committed. */
export function patchFilm(film: Film, patch: Partial<Film>): Film {
  return canonicalFilm({ ...film, ...patch });
}

/* -------------------------------------------------------------------------- */
/* The YouTube field                                                           */
/* -------------------------------------------------------------------------- */

export type YouTubeReading = {
  /** What the user typed, unchanged. */
  raw: string;
  /** The 11-character id, or null when there is none in there. */
  id: string | null;
  /**
   *   empty  nothing typed yet, which is a new film rather than a mistake
   *   ok     an id came out of it
   *   bad    text that is not a YouTube link
   */
  status: 'empty' | 'ok' | 'bad';
};

/**
 * Read a pasted YouTube URL. The parsing itself is the schema's
 * `youtubeIdFromInput` (docs/cms-contracts.md 10.1) so this editor and WS-F's
 * migration cannot disagree about what counts as an id.
 */
export function readYouTubeInput(raw: string): YouTubeReading {
  if (raw.trim() === '') return { raw, id: null, status: 'empty' };
  const id = youtubeIdFromInput(raw);
  return { raw, id, status: id === null ? 'bad' : 'ok' };
}

/**
 * Apply a pasted URL. The film only changes when an id came out of the text;
 * `changed: false` with `status: 'bad'` is the editor's cue to say "that is not
 * a YouTube link" and keep the text on screen.
 *
 * A film that has a poster keeps it: `id` and `youtubeId` are separate exactly
 * so re-pointing a record at a new upload does not orphan its poster (10.1).
 */
export function applyYouTubeInput(
  film: Film,
  raw: string,
): { film: Film; reading: YouTubeReading; changed: boolean } {
  const reading = readYouTubeInput(raw);
  if (reading.id === null || reading.id === film.youtubeId) {
    return { film, reading, changed: false };
  }
  return { film: patchFilm(film, { youtubeId: reading.id }), reading, changed: true };
}

/** The text the YouTube field should show for a film nobody has typed into yet. */
export function youTubeInputValue(film: Film): string {
  return film.youtubeId === '' ? '' : film.youtubeId;
}

/* -------------------------------------------------------------------------- */
/* The poster frame                                                            */
/* -------------------------------------------------------------------------- */

/** Where a film's poster is coming from, which the editor labels on the stage. */
export type PosterOrigin = 'uploaded' | 'youtube' | 'none';

export function posterOrigin(film: Film): PosterOrigin {
  if (optionalText(film.poster) !== undefined) return 'uploaded';
  return film.youtubeId === '' ? 'none' : 'youtube';
}

/**
 * The image to draw, or null when there is neither an upload nor a video to
 * fall back on. `filmPosterSrc` is the schema's one implementation of the
 * fallback, so the editor, the index tile and the site cannot disagree.
 */
export function posterSrc(film: Film): string | null {
  if (posterOrigin(film) === 'none') return null;
  return filmPosterSrc(film);
}

/** An uploaded poster replaces whatever was there. */
export function setFilmPoster(film: Film, src: string): Film {
  return patchFilm(film, { poster: src });
}

/** Back to YouTube's own frame, which is what an absent `poster` means. */
export function clearFilmPoster(film: Film): Film {
  return patchFilm(film, { poster: undefined });
}

/**
 * Freeze YouTube's thumbnail into `poster` as an explicit value. Useful when
 * the video is later re-uploaded under a new id and the old frame is the one
 * worth keeping. A no-op for a film with no video yet.
 */
export function pinYouTubePoster(
  film: Film,
  quality: YouTubeThumbQuality = 'maxresdefault',
): Film {
  if (film.youtubeId === '') return film;
  return setFilmPoster(film, youtubeThumbUrl(film.youtubeId, quality));
}

/* -------------------------------------------------------------------------- */
/* Per-field problems                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One line to show under a field, or null when it is fine. Deliberately
 * hand-written per field rather than derived from a zod issue path: the
 * messages a person reads while typing are not the messages a validator writes
 * for a log. `validateFilm` is still the gate before a save.
 */
export function filmFieldProblem(film: Film, name: string): string | null {
  switch (name) {
    case 'youtubeId':
      return film.youtubeId === '' ? 'Paste a YouTube link: a film needs its video.' : null;
    case 'title':
      return film.title.trim() === '' ? 'A film needs a title.' : null;
    case 'kind':
      return film.kind.trim() === '' ? 'A kind is the small-caps label, like SHORT FILM.' : null;
    case 'year':
      return yearProblem(film.year);
    default:
      return null;
  }
}

/** Shared with the album editor: both have a `year` field with the same rule. */
export function yearProblem(year: string): string | null {
  if (year.trim() === '') return 'A year, like 2019.';
  if (!/^\d{4}(?:[-–]\d{4})?$/.test(year)) return 'Four digits, or a range like 2018-2019.';
  return null;
}

/** True when `validateFilm` would accept this record as it stands. */
export function isFilmComplete(film: Film): boolean {
  return validateFilm(film).ok;
}

/** A fresh film, canonical. `newFilm()` is invalid until it has a video (10.4). */
export function blankFilm(overrides: Partial<Film> = {}): Film {
  return canonicalFilm(newFilm(overrides));
}
