/**
 * src/cms/app/records/harness/harness.tsx
 *
 * WS-E's standalone harness. Mounts the real `FilmEditor` and the real
 * `AlbumEditor` over `file://` with a FAKE upload function, no server, no API
 * client and no other workstream. `./build.mjs` bundles it; `./drive.mjs`
 * drives it in headless Chrome with the page forced offline, asserts the JSON
 * the editors emit, and writes the screenshots.
 *
 * The fixtures are injected at build time as strings (`__FILMS_JSON__`,
 * `__ALBUMS_JSON__`) rather than fetched, because a `file://` page cannot
 * fetch. They still go through WS-A's validators, so the harness fails loudly
 * if a fixture and the schema ever disagree.
 *
 * `window.__wse` is the handle `drive.mjs` uses. It is a test seam; nothing in
 * `src/cms/app/records/` knows it exists.
 */

import { StrictMode, useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  formatIssues,
  validateAlbum,
  validateFilm,
  validateFilmographyJson,
  validatePhotographyJson,
} from '../../../schema.ts';
import type { Album, Film } from '../../../schema.ts';
import { AlbumEditor } from '../AlbumEditor.tsx';
import { FilmEditor } from '../FilmEditor.tsx';
import { blankAlbum, blankFilm } from '../index.ts';
import type { UploadMedia, UploadOptions } from '../types.ts';

/** Injected by ./build.mjs. */
declare const __FILMS_JSON__: string;
declare const __ALBUMS_JSON__: string;
/** A `file://` URL for the repo's `public/` directory. */
declare const __PUBLIC_BASE__: string;

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const filmography = validateFilmographyJson(__FILMS_JSON__);
if (!filmography.ok) {
  throw new Error(`filmography.json does not validate:\n${formatIssues(filmography.issues)}`);
}
const photography = validatePhotographyJson(__ALBUMS_JSON__);
if (!photography.ok) {
  throw new Error(`photography.json does not validate:\n${formatIssues(photography.issues)}`);
}

const FILMS = filmography.data.films;
const ALBUMS = photography.data.albums;

const START_FILM: Film = FILMS[0] ?? blankFilm();
const START_ALBUM: Album = blankAlbum({ id: 'album_harness', title: 'Summer in Seoul' });
/** WS-A's six-photo album, for the screenshot that shows a full grid. */
const FULL_ALBUM: Album = ALBUMS[0] ?? START_ALBUM;

/* -------------------------------------------------------------------------- */
/* Media resolution, so a file:// page draws real pictures                     */
/* -------------------------------------------------------------------------- */

/**
 * `/projects/...` and `/filmography/...` exist under `public/`. A YouTube
 * thumbnail URL is mapped to the poster frame that is already in the repo for
 * that video id, which is how the fallback path draws something with the page
 * offline.
 */
function resolveMediaSrc(src: string): string {
  const youtube = src.match(/^https:\/\/i\.ytimg\.com\/vi\/([^/]+)\//);
  if (youtube !== null) return `${__PUBLIC_BASE__}/filmography/${youtube[1]}.jpg`;
  if (src.startsWith('/')) return `${__PUBLIC_BASE__}${src}`;
  return src;
}

/* -------------------------------------------------------------------------- */
/* The fake upload                                                             */
/* -------------------------------------------------------------------------- */

/** Real files in `public/`, so an "uploaded" photo is a photograph. */
const ASSETS = [2, 6, 8, 10, 12, 14].map((block) => ({
  src: `/projects/track-daily-habit-tracker/blocks/${block}/value/src.png`,
  w: 1206,
  h: 2622,
}));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type UploadCall = {
  name: string;
  attempt: number;
  outcome: 'ok' | 'failed';
  src?: string;
};

const calls: UploadCall[] = [];
const attempts = new Map<string, number>();

/**
 * Stands in for `POST /api/cms/media/...`. Reports progress in steps so the
 * per-file bars are real, and refuses any file whose name contains "fail" the
 * FIRST time it is asked, so a retry can succeed and prove the failed file
 * still lands in its original place.
 */
const fakeUpload: UploadMedia = async (file: File, options?: UploadOptions) => {
  const attempt = (attempts.get(file.name) ?? 0) + 1;
  attempts.set(file.name, attempt);

  for (const fraction of [0.15, 0.45, 0.75]) {
    await sleep(45);
    if (options?.signal?.aborted === true) throw new Error('aborted');
    options?.onProgress?.(fraction);
  }
  await sleep(45);

  if (/fail/i.test(file.name) && attempt === 1) {
    calls.push({ name: file.name, attempt, outcome: 'failed' });
    throw new Error('the upload endpoint said no (fake)');
  }

  // Deterministic: "03-whatever.png" is always the third asset, so the driver
  // can assert the order the photos ended up in.
  const digits = file.name.match(/(\d+)/);
  const index = digits === null ? calls.length : Number(digits[1]) - 1;
  const asset = ASSETS[((index % ASSETS.length) + ASSETS.length) % ASSETS.length] ?? ASSETS[0];
  if (asset === undefined) throw new Error('no assets');
  options?.onProgress?.(1);
  calls.push({ name: file.name, attempt, outcome: 'ok', src: asset.src });
  return { src: asset.src, w: asset.w, h: asset.h };
};

/* -------------------------------------------------------------------------- */
/* The harness page                                                            */
/* -------------------------------------------------------------------------- */

type Tab = 'film' | 'album';
type Notice = { level: 'info' | 'error'; message: string };

const notices: Notice[] = [];

let setTabExternally: ((tab: Tab) => void) | null = null;
let setFilmExternally: ((film: Film) => void) | null = null;
let setAlbumExternally: ((album: Album) => void) | null = null;
let readFilm: (() => Film) | null = null;
let readAlbum: (() => Album) | null = null;

function Harness() {
  const [tab, setTab] = useState<Tab>('film');
  const [film, setFilm] = useState<Film>(START_FILM);
  const [album, setAlbum] = useState<Album>(START_ALBUM);
  const [, bump] = useState(0);

  setTabExternally = setTab;
  setFilmExternally = setFilm;
  setAlbumExternally = setAlbum;
  readFilm = () => film;
  readAlbum = () => album;

  const notice = useCallback(
    (level: 'info' | 'error', message: string) => {
      notices.push({ level, message });
      bump((value) => value + 1);
    },
    [bump],
  );

  const last = useMemo(() => notices[notices.length - 1] ?? null, [notices.length]);

  return (
    <div className="harness">
      <nav className="harness__bar">
        <button
          type="button"
          className={tab === 'film' ? 'harness__tab harness__tab--on' : 'harness__tab'}
          data-testid="tab-film"
          onClick={() => setTab('film')}
        >
          Film editor
        </button>
        <button
          type="button"
          className={tab === 'album' ? 'harness__tab harness__tab--on' : 'harness__tab'}
          data-testid="tab-album"
          onClick={() => setTab('album')}
        >
          Album editor
        </button>
        <span className="harness__spacer" />
        <span className="harness__notice" data-testid="last-notice">
          {last === null ? 'no notices' : `${last.level}: ${last.message}`}
        </span>
      </nav>

      <div className="harness__stage">
        {tab === 'film' ? (
          <FilmEditor
            record={film}
            onChange={setFilm}
            uploadMedia={fakeUpload}
            resolveMediaSrc={resolveMediaSrc}
            onNotice={notice}
          />
        ) : (
          <AlbumEditor
            record={album}
            onChange={setAlbum}
            uploadMedia={fakeUpload}
            resolveMediaSrc={resolveMediaSrc}
            onNotice={notice}
          />
        )}
      </div>
    </div>
  );
}

const container = document.getElementById('root');
if (container === null) throw new Error('no #root in the harness page');
createRoot(container).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);

/* -------------------------------------------------------------------------- */
/* Test seam                                                                   */
/* -------------------------------------------------------------------------- */

const seam = {
  calls,
  notices,
  fixtures: { films: FILMS, albums: ALBUMS },

  show(tab: Tab): void {
    setTabExternally?.(tab);
  },
  setFilm(film: Film): void {
    setFilmExternally?.(film);
  },
  setAlbum(album: Album): void {
    setAlbumExternally?.(album);
  },
  loadFullAlbum(): void {
    setAlbumExternally?.(FULL_ALBUM);
  },
  loadBlankFilm(): void {
    setFilmExternally?.(blankFilm({ id: 'film_blank' }));
  },
  film(): Film | null {
    return readFilm?.() ?? null;
  },
  album(): Album | null {
    return readAlbum?.() ?? null;
  },
  filmJson(): string {
    return JSON.stringify(readFilm?.() ?? null);
  },
  albumJson(): string {
    return JSON.stringify(readAlbum?.() ?? null);
  },

  /** One flat object the driver can assert against in a single evaluate. */
  probe() {
    const currentFilm = readFilm?.() ?? null;
    const currentAlbum = readAlbum?.() ?? null;
    return {
      film:
        currentFilm === null
          ? null
          : {
              id: currentFilm.id,
              youtubeId: currentFilm.youtubeId,
              title: currentFilm.title,
              kind: currentFilm.kind,
              year: currentFilm.year,
              note: currentFilm.note ?? null,
              poster: currentFilm.poster ?? null,
              keys: Object.keys(currentFilm),
              valid: validateFilm(currentFilm).ok,
            },
      album:
        currentAlbum === null
          ? null
          : {
              id: currentAlbum.id,
              slug: currentAlbum.slug,
              title: currentAlbum.title,
              year: currentAlbum.year,
              summary: currentAlbum.summary ?? null,
              cover: currentAlbum.cover ?? null,
              keys: Object.keys(currentAlbum),
              photoIds: currentAlbum.photos.map((photo) => photo.id),
              photoSrcs: currentAlbum.photos.map((photo) => photo.src),
              alts: currentAlbum.photos.map((photo) => photo.alt ?? null),
              captions: currentAlbum.photos.map((photo) => photo.caption ?? null),
              dims: currentAlbum.photos.map((photo) =>
                photo.w === undefined || photo.h === undefined ? null : [photo.w, photo.h],
              ),
              valid: validateAlbum(currentAlbum).ok,
            },
      uploads: calls.map((call) => `${call.name}#${call.attempt}:${call.outcome}`),
      notices: notices.map((entry) => `${entry.level}: ${entry.message}`),
    };
  },
};

(window as unknown as { __wse: typeof seam }).__wse = seam;
