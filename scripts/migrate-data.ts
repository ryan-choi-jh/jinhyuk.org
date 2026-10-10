/**
 * scripts/migrate-data.ts
 *
 * WS-F MIGRATION, 3 of 3. The two surfaces that are TypeScript source today.
 *
 *   src/data/filmography.ts   ->   src/content/data/filmography.json
 *   src/data/photography.ts   ->   src/content/data/photography.json
 *
 * The sources are read by importing them, not by parsing them: Node runs
 * TypeScript directly here, so `films` and `albums` arrive as the exact values
 * the site build sees. A regex over the source could mis-read an escape or an
 * entry it has never seen; an import cannot.
 *
 * FILMOGRAPHY, per docs/cms-contracts.md §12
 *
 *  - Order is editorial ("newest first") and is preserved exactly.
 *  - Each entry's `id` is the *video* id: it becomes `youtubeId`, and the
 *    record gets its own stable `id`, derived from the title so the file is
 *    readable and the conversion is deterministic. An `id` already committed
 *    in the output is kept, keyed by `youtubeId`, so re-running never churns
 *    an id that something else may already point at.
 *  - The poster convention `public/filmography/<video id>.jpg` becomes an
 *    explicit `poster`. All four files exist; the migration points at them
 *    where they are rather than moving them, so the live page's pictures are
 *    the migrated page's pictures. Moving them under `/media/filmography/` is
 *    a later commit. A missing file is fatal, because the fallback — YouTube's
 *    own thumbnail — is a different picture fetched from a third party.
 *
 * PHOTOGRAPHY
 *
 *  - `albums` is empty and always has been. The migration is `{"albums": []}`.
 *    Inventing an album would be inventing content. The empty-state
 *    illustration lives in `src/pages/photography/index.astro` and stays
 *    there; `--verify` asserts the live page really is in its empty state, so
 *    "empty" is a finding and not an assumption.
 *
 * It also finishes docs/cms-contracts.md §13.2: phase 1 wrote
 * `src/content/pages/<slug>.json` and the registry now says
 * `src/content/pages/projects/<slug>.json`. The file is copied one directory
 * deeper (never moved — deleting phase 1's output is a cutover decision, not
 * this script's). `--no-relocate-projects` turns that off.
 *
 * Modes
 *   node scripts/migrate-data.ts              convert and write
 *   node scripts/migrate-data.ts --verify     live-vs-migrated diff + report
 *   node scripts/migrate-data.ts --selftest   synthetic records, no network
 *   node scripts/migrate-data.ts --check      fail if committed JSON is stale
 *   node scripts/migrate-data.ts --dry-run    convert, validate, write nothing
 *
 * Flags: --offline, --refresh, --quiet, --no-report, --no-relocate-projects,
 *        --origin=<url>, --live-dir=<dir>.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  filmPosterSrc,
  formatIssues,
  slugify,
  validateDoc,
  validateFilmography,
  validatePhotography,
  youtubeThumbUrl,
} from '../src/cms/schema.ts';
import type { Film, Filmography, Photography } from '../src/cms/schema.ts';
import { CONTENT_ROOT, contentPathFor, requireSection } from '../src/cms/sections.ts';

import {
  Checks,
  MODE,
  PROJECT,
  changed,
  decode,
  diffLines,
  fatal,
  fetchLive,
  finish,
  findSubtree,
  findSubtrees,
  mdCell,
  note,
  readJsonIfPresent,
  say,
  shout,
  squash,
  statusLine,
  upsertReportSection,
  writeJsonFile,
  type Loss,
} from './migrate-lib.ts';

const FILMOGRAPHY = requireSection('filmography');
const PHOTOGRAPHY = requireSection('photography');

const FILM_SOURCE = join(PROJECT, 'src/data/filmography.ts');
const PHOTO_SOURCE = join(PROJECT, 'src/data/photography.ts');
const FILM_OUT = join(PROJECT, contentPathFor(FILMOGRAPHY));
const PHOTO_OUT = join(PROJECT, contentPathFor(PHOTOGRAPHY));
const PUBLIC = join(PROJECT, 'public');
const RELOCATE = !process.argv.includes('--no-relocate-projects');

/* ========================================================================== */
/* Filmography                                                                */
/* ========================================================================== */

/** The shape `src/data/filmography.ts` exports today. */
type LiveFilm = { id: string; title: string; note?: string; kind: string; year: string };

const KNOWN_FILM_KEYS = new Set(['id', 'title', 'note', 'kind', 'year']);

/**
 * A readable, deterministic record id from the title: `film_the_space_race`.
 * Deterministic matters more than pretty — a random id would mean the file
 * changed on every run, and `--check` could never pass.
 */
export function filmIdFor(title: string, youtubeId: string, taken: Set<string>): string {
  const base = slugify(title).replace(/-/g, '_');
  const stem = base === '' ? `film_${youtubeId}` : `film_${base}`;
  if (!taken.has(stem)) return stem;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${stem}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `film_${youtubeId}`;
}

/** Record ids already committed, keyed by video id, so ids never churn. */
function committedFilmIds(): Map<string, string> {
  const existing = readJsonIfPresent(FILM_OUT) as { films?: unknown } | null;
  const map = new Map<string, string>();
  const films = existing?.films;
  if (!Array.isArray(films)) return map;
  for (const raw of films) {
    const film = raw as { id?: unknown; youtubeId?: unknown };
    if (typeof film.id === 'string' && typeof film.youtubeId === 'string') map.set(film.youtubeId, film.id);
  }
  return map;
}

export function convertFilms(
  source: LiveFilm[],
  losses: Loss[],
  posterExists: (src: string) => boolean,
  /**
   * Record ids already committed, keyed by video id. Passed in rather than read
   * from disk in here, so the only thing that touches the committed file is
   * `migrate()` and a test is hermetic.
   */
  reused: Map<string, string>,
): Filmography {
  const taken = new Set<string>();
  const films: Film[] = [];

  source.forEach((entry, index) => {
    const where = `src/data/filmography.ts[${index}] (${entry.id})`;
    for (const key of Object.keys(entry)) {
      if (!KNOWN_FILM_KEYS.has(key)) {
        fatal(losses, where, `an unknown field with no home in Film: ${key}=${JSON.stringify((entry as Record<string, unknown>)[key])}`);
      }
    }

    const youtubeId = entry.id;
    const id = reused.get(youtubeId) ?? filmIdFor(entry.title, youtubeId, taken);
    taken.add(id);

    const film: Film = {
      id,
      youtubeId,
      title: entry.title,
      kind: entry.kind,
      year: entry.year,
    };
    if (entry.note !== undefined && entry.note !== '') film.note = entry.note;

    // The poster convention, made explicit. The file is on disk today and the
    // live page loads it; if it were missing, `filmPosterSrc` would silently
    // fall back to YouTube's thumbnail, which is a different picture from a
    // third party. That is a fatal difference, not a fallback.
    const poster = `/filmography/${youtubeId}.jpg`;
    if (posterExists(poster)) film.poster = poster;
    else {
      fatal(
        losses,
        where,
        `the poster the live page shows, public${poster}, is not on disk; without it the page would fall back to ${youtubeThumbUrl(youtubeId)}`,
      );
    }

    films.push(film);
  });

  if (films.length !== source.length) {
    fatal(losses, 'src/data/filmography.ts', `${source.length} films in, ${films.length} out`);
  }
  return { films };
}

/* ========================================================================== */
/* Photography                                                                */
/* ========================================================================== */

type LiveAlbum = { title: string; year: string; cover?: string };

export function convertAlbums(source: LiveAlbum[], losses: Loss[]): Photography {
  if (source.length > 0) {
    // The brief says the array is empty and the page shows an empty state. If
    // somebody added one while this was being written, refuse rather than
    // invent a slug, an id and a photo list for it.
    fatal(
      losses,
      'src/data/photography.ts',
      `the album list is no longer empty (${source.length} entr${source.length === 1 ? 'y' : 'ies'}): ` +
        'an Album now needs an id, a slug and a photo list, which this migration cannot invent. ' +
        'Add it in the CMS instead, or extend this converter deliberately.',
    );
    return { albums: [] };
  }
  note(
    losses,
    'src/data/photography.ts',
    'the album list is empty, so the migration is a valid empty collection: {"albums": []}',
  );
  return { albums: [] };
}

/* ========================================================================== */
/* Phase 1 project pages, one directory deeper (contracts §13.2)              */
/* ========================================================================== */

type Relocation = { from: string; to: string; outcome: string };

function relocateProjectPages(losses: Loss[]): Relocation[] {
  if (!RELOCATE) return [];
  const projects = requireSection('projects');
  const flatDir = join(PROJECT, CONTENT_ROOT, 'pages');
  if (!existsSync(flatDir)) return [];

  const done: Relocation[] = [];
  for (const name of readdirSync(flatDir).sort()) {
    if (!name.endsWith('.json') || name === 'home.json') continue;
    const slug = name.slice(0, -5);
    const value = readJsonIfPresent(join(flatDir, name));
    const validated = validateDoc(value);
    if (!validated.ok) {
      note(losses, `${CONTENT_ROOT}/pages/${name}`, `left where it is: it does not validate as a Doc (${formatIssues(validated.issues).split('\n')[0] ?? ''})`);
      continue;
    }
    const to = contentPathFor(projects, validated.doc.meta.slug === slug ? slug : validated.doc.meta.slug);
    const outcome = writeJsonFile(join(PROJECT, to), validated.doc);
    done.push({ from: `${CONTENT_ROOT}/pages/${name}`, to, outcome });
    say(`${outcome.padEnd(11)} ${to}  (copy of ${CONTENT_ROOT}/pages/${name})`);
  }
  return done;
}

/* ========================================================================== */
/* Write                                                                      */
/* ========================================================================== */

type Conversion = {
  source: { films: LiveFilm[]; albums: LiveAlbum[] };
  filmography: Filmography;
  photography: Photography;
  losses: Loss[];
  relocations: Relocation[];
  outcomes: { filmography: string; photography: string };
};

async function migrate(): Promise<{ conversion: Conversion; ok: boolean }> {
  const losses: Loss[] = [];

  const filmModule = (await import(FILM_SOURCE)) as { films?: unknown };
  const photoModule = (await import(PHOTO_SOURCE)) as { albums?: unknown };
  if (!Array.isArray(filmModule.films)) {
    fatal(losses, 'src/data/filmography.ts', 'does not export a `films` array');
  }
  if (!Array.isArray(photoModule.albums)) {
    fatal(losses, 'src/data/photography.ts', 'does not export an `albums` array');
  }

  const sourceFilms = (Array.isArray(filmModule.films) ? filmModule.films : []) as LiveFilm[];
  const sourceAlbums = (Array.isArray(photoModule.albums) ? photoModule.albums : []) as LiveAlbum[];

  const filmography = convertFilms(
    sourceFilms,
    losses,
    (src) => existsSync(join(PUBLIC, src.replace(/^\//, ''))),
    committedFilmIds(),
  );
  const photography = convertAlbums(sourceAlbums, losses);

  for (const loss of losses) shout(`${loss.fatal ? 'FATAL' : 'note '} ${loss.where}: ${loss.what}`);

  let ok = !losses.some((loss) => loss.fatal);
  const outcomes = { filmography: 'not written', photography: 'not written' };

  const filmValid = validateFilmography(filmography);
  if (!filmValid.ok) {
    shout(`FATAL filmography does not validate:\n${formatIssues(filmValid.issues)}`);
    ok = false;
  } else if (ok) {
    outcomes.filmography = writeJsonFile(FILM_OUT, filmography);
    say(`${outcomes.filmography.padEnd(11)} ${contentPathFor(FILMOGRAPHY)}`);
    if (outcomes.filmography === 'stale') ok = false;
  }

  const photoValid = validatePhotography(photography);
  if (!photoValid.ok) {
    shout(`FATAL photography does not validate:\n${formatIssues(photoValid.issues)}`);
    ok = false;
  } else if (ok) {
    outcomes.photography = writeJsonFile(PHOTO_OUT, photography);
    say(`${outcomes.photography.padEnd(11)} ${contentPathFor(PHOTOGRAPHY)}`);
    if (outcomes.photography === 'stale') ok = false;
  }

  const relocations = ok ? relocateProjectPages(losses) : [];
  if (relocations.some((relocation) => relocation.outcome === 'stale')) ok = false;

  return {
    conversion: { source: { films: sourceFilms, albums: sourceAlbums }, filmography, photography, losses, relocations, outcomes },
    ok,
  };
}

/* ========================================================================== */
/* Verify                                                                     */
/* ========================================================================== */

type LiveCard = { youtubeId: string; poster: string; title: string; note: string; meta: string };

function readCards(html: string): LiveCard[] {
  const list = findSubtree(html, { tag: 'ul', cls: 'cards' });
  if (list === null) return [];
  return findSubtrees(list.inner, { tag: 'li', cls: 'card' }).map((card) => ({
    youtubeId: decode(/data-video-id="([^"]*)"/.exec(card.inner)?.[1] ?? ''),
    poster: decode(/<img[^>]*\ssrc="([^"]*)"/.exec(card.inner)?.[1] ?? ''),
    title: squash(findSubtree(card.inner, { cls: 'card-title' })?.inner ?? ''),
    note: squash(findSubtree(card.inner, { cls: 'card-note' })?.inner ?? ''),
    meta: squash(findSubtree(card.inner, { cls: 'card-meta' })?.inner ?? ''),
  }));
}

async function verifyFilmography(conversion: Conversion, checks: Checks): Promise<string[]> {
  const live = await fetchLive(FILMOGRAPHY.indexUrl);
  say(`\nfilmography: ${live.url} (${live.from}, ${live.html.length} bytes)`);

  const main = findSubtree(live.html, { tag: 'main' });
  const cards = readCards(main?.inner ?? '');
  const films = conversion.filmography.films;

  checks.add(
    `the live page shows ${cards.length} films and the migration has ${films.length}`,
    cards.length === films.length && cards.length > 0,
    `live ${cards.length}, migrated ${films.length}`,
  );

  // Order is editorial: compare as ordered lists of every field at once, so a
  // reordering fails even when every individual film is present.
  const liveRows = cards.map((card) => [card.youtubeId, card.title, card.note, card.meta, card.poster].join(' | '));
  const migratedRows = films.map((film) => [film.youtubeId, film.title, film.note ?? '', `${film.kind} · ${film.year}`, filmPosterSrc(film)].join(' | '));
  checks.same('every film: video id, title, note, "KIND · YEAR" and poster, in the live order', liveRows, migratedRows);

  // ...and against the TypeScript source, not only against the live page.
  const sourceRows = conversion.source.films.map((film) => [film.id, film.title, film.note ?? '', `${film.kind} · ${film.year}`, `/filmography/${film.id}.jpg`].join(' | '));
  checks.same('every film in `src/data/filmography.ts`, field for field, in source order', sourceRows, migratedRows);

  checks.add(
    'every poster the migration points at is a file in `public/`',
    films.every((film) => film.poster !== undefined && existsSync(join(PUBLIC, film.poster.replace(/^\//, '')))),
    films.map((film) => `${film.poster ?? '(none)'}`).join(', '),
  );
  checks.add(
    'no film falls back to a YouTube thumbnail (a different picture, from a third party)',
    films.every((film) => film.poster !== undefined && !filmPosterSrc(film).startsWith('http')),
    `${films.filter((film) => film.poster === undefined).length} without a poster`,
  );
  checks.add(
    'every record id is new, stable and not the video id',
    films.every((film) => film.id !== film.youtubeId) && new Set(films.map((film) => film.id)).size === films.length,
    films.map((film) => `${film.id} <- ${film.youtubeId}`).join(', '),
  );
  const filmValid = validateFilmography(conversion.filmography);
  checks.add('the migrated collection validates', filmValid.ok, filmValid.ok ? 'ok' : formatIssues(filmValid.issues));

  const lines: string[] = [];
  lines.push(
    `Baseline: ${live.url}, \`main\` extracted, every \`li.card\` reduced to its video id, title, note, ` +
      'small-caps meta line and poster `src`.',
  );
  lines.push('');
  lines.push('| # | live card | migrated record | same |');
  lines.push('|---|---|---|---|');
  liveRows.forEach((row, index) => {
    const migrated = migratedRows[index] ?? '(missing)';
    lines.push(`| ${index + 1} | ${mdCell(row)} | ${mdCell(migrated)} | ${row === migrated ? 'yes' : '**no**'} |`);
  });
  lines.push('');
  lines.push(
    `Record ids: ${films.map((film) => `\`${film.id}\` <- \`${film.youtubeId}\``).join(', ')}. ` +
      'Derived from the title, so the file is readable and the conversion is deterministic; an id already committed is ' +
      'reused, keyed by video id, so re-running never changes one.',
  );
  lines.push('');
  return lines;
}

async function verifyPhotography(conversion: Conversion, checks: Checks): Promise<string[]> {
  const live = await fetchLive(PHOTOGRAPHY.indexUrl);
  say(`\nphotography: ${live.url} (${live.from}, ${live.html.length} bytes)`);

  const main = findSubtree(live.html, { tag: 'main' });
  const inner = main?.inner ?? '';
  const emptyState = findSubtree(inner, { cls: 'empty-state' });
  const grid = findSubtree(inner, { cls: 'cards' });
  const albumLinks = findSubtrees(inner, { tag: 'a' }).filter((anchor) => /href="\/photography\/[^"]+"/.test(anchor.outer));

  checks.add('the live photography page is in its empty state', emptyState !== null, emptyState === null ? 'no `.empty-state`' : 'found `.empty-state`');
  checks.add('the live page shows no album grid', grid === null, grid === null ? 'no `.cards`' : 'a grid is present');
  checks.add('the live page links to no album page', albumLinks.length === 0, `${albumLinks.length} link(s)`);
  checks.add(
    'the migration is a valid empty collection',
    conversion.photography.albums.length === 0 && validatePhotography(conversion.photography).ok,
    `${conversion.photography.albums.length} albums`,
  );
  checks.add(
    '`src/data/photography.ts` is still empty, so nothing was invented',
    conversion.source.albums.length === 0,
    `${conversion.source.albums.length} album(s) in the source`,
  );

  /** The words only: the empty-state note carries `<br>` tags for its line breaks. */
  const textOnly = (html: string): string => squash(html.replace(/<[^>]*>/g, ' '));
  const label = textOnly(findSubtree(inner, { cls: 'empty-label' })?.inner ?? '');
  const note_ = textOnly(findSubtree(inner, { cls: 'empty-note' })?.inner ?? '');

  return [
    `Baseline: ${live.url}. The page is in its empty state: the illustration ` +
      '`/photography/placeholder.webp`, the label ' +
      `"${label}" and the note "${note_}". None of that is content — it is in ` +
      '`src/pages/photography/index.astro` — and docs/cms-contracts.md §12 says it stays there, shown by WS-B while ' +
      '`albums` is empty, which is what the live page does.',
    '',
    'Migrated: `{"albums": []}`. A valid empty collection, which is what the brief asks for in place of invented content.',
    '',
  ];
}

async function verify(conversion: Conversion): Promise<boolean> {
  const filmChecks = new Checks();
  const filmLines = await verifyFilmography(conversion, filmChecks);
  const photoChecks = new Checks();
  const photoLines = await verifyPhotography(conversion, photoChecks);

  const filmReport: string[] = [statusLine(filmChecks.passed ? 'PASS' : 'FAIL', filmChecks.rows.length), ''];
  filmReport.push(...filmLines);
  filmReport.push('### 3.1 Nothing was lost', '');
  filmReport.push(filmChecks.table(), '');
  filmReport.push('### 3.2 Every difference, and why', '');
  filmReport.push(
    '**3.2.1 `id` is no longer the video id.** `src/data/filmography.ts` used one field for both the record and the ' +
      'video. The schema separates them (docs/cms-contracts.md §12) so that re-uploading a film to a new YouTube URL ' +
      'does not orphan its poster or its place in the order. The video id is carried across unchanged as `youtubeId`; ' +
      'the new `id` is derived from the title.',
    '',
  );
  filmReport.push(
    '**3.2.2 `poster` is explicit.** The convention `public/filmography/<video id>.jpg` was knowledge held in a ' +
      'comment. Every film now carries the path, the files stay where they are, and the live page and the migrated ' +
      'page load the same four pictures. Moving them under `/media/filmography/<record id>/` (decision 3.5) is tidier ' +
      'and is a second commit, not a blocker. A missing file is fatal rather than a fallback, because the fallback is a ' +
      "different picture fetched from YouTube.",
    '',
  );
  filmReport.push(
    '**3.2.3 An empty `note` becomes no `note` key.** `The Space Race (Trailer)` has no note in the source and gets ' +
      'none in the JSON. The field is `.optional()`, and the live card renders no `.card-note` span for it.',
    '',
  );
  filmReport.push(
    '**3.2.4 The collection file has no `version` key.** docs/cms-contracts.md §13.7: §4 gives the literal shape ' +
      '`{ films: Film[] }` and every object is `.strict()`, so adding one would make the brief\'s own shape invalid.',
    '',
  );
  const filmLosses = conversion.losses.filter((loss) => loss.where.includes('filmography'));
  if (filmLosses.length > 0) {
    filmReport.push('### 3.3 What the converter recorded', '');
    filmReport.push('| where | severity | what |', '|---|---|---|');
    for (const loss of filmLosses) {
      filmReport.push(`| \`${loss.where}\` | ${loss.fatal ? '**fatal**' : 'note'} | ${mdCell(loss.what)} |`);
    }
    filmReport.push('');
  }

  const photoReport: string[] = [statusLine(photoChecks.passed ? 'PASS' : 'FAIL', photoChecks.rows.length), ''];
  photoReport.push(...photoLines);
  photoReport.push('### 4.1 Nothing was lost', '');
  photoReport.push(photoChecks.table(), '');
  photoReport.push('### 4.2 Every difference, and why', '');
  photoReport.push(
    '**4.2.1 Nothing was converted, because there is nothing to convert.** The source exports `albums: []`. The ' +
      'converter refuses to run on a non-empty list rather than invent the `id`, `slug` and `photos` an `Album` now ' +
      'needs: it is fatal, with a message pointing at the CMS. So if an album is added to the TypeScript file before ' +
      'cutover, this script stops instead of silently half-migrating it.',
    '',
  );
  photoReport.push(
    "**4.2.2 The album page at `/photography/<slug>/` is new site surface** (docs/cms-sections.md 3.4) and has no live " +
      'page to diff against. There is nothing for this migration to preserve there; WS-B builds it and WS-E fills it.',
    '',
  );
  const photoLosses = conversion.losses.filter((loss) => loss.where.includes('photography'));
  if (photoLosses.length > 0) {
    photoReport.push('### 4.3 What the converter recorded', '');
    photoReport.push('| where | severity | what |', '|---|---|---|');
    for (const loss of photoLosses) {
      photoReport.push(`| \`${loss.where}\` | ${loss.fatal ? '**fatal**' : 'note'} | ${mdCell(loss.what)} |`);
    }
    photoReport.push('');
  }

  const notes: string[] = [statusLine('PASS', 0), ''];
  notes.push(
    'Three things this phase deliberately did not do. None of them loses content; all three need an owner before ' +
      'cutover.',
    '',
  );
  notes.push(
    '**5.1 Nothing was deleted.** `src/content/home.yaml`, `src/content/writing/*.md`, `src/data/filmography.ts` and ' +
      '`src/data/photography.ts` are all still there and the live site still builds from them. Deletion is a cutover ' +
      'step. Until then the YAML, the markdown and the JSON are two copies of the same content and can drift: whoever ' +
      're-runs these scripts at cutover gets the then-current source.',
    '',
  );
  if (conversion.relocations.length > 0) {
    notes.push(
      `**5.2 Phase 1's project page was copied, not moved** (docs/cms-contracts.md §13.2). ` +
        conversion.relocations.map((relocation) => `\`${relocation.from}\` -> \`${relocation.to}\` (${relocation.outcome})`).join('; ') +
        '. A byte-identical copy at the path the registry names, with the original left in place, because phase 1\'s ' +
        'server (`src/cms/server/config.ts`, `PAGES_DIR`) still reads the flat path and deleting its output mid-flight ' +
        'would break it. The flat file should go at cutover. Run with `--no-relocate-projects` to skip this.',
      '',
    );
  } else {
    notes.push(
      "**5.2 Phase 1's project page was not relocated.** docs/cms-contracts.md §13.2 moves " +
        '`src/content/pages/<slug>.json` to `src/content/pages/projects/<slug>.json`. Either `--no-relocate-projects` ' +
        'was passed or there was nothing to copy.',
      '',
    );
  }
  notes.push(
    '**5.3 Media stayed where it is.** Decision 3.5 wants one pipeline, `public/media/<section>/<slug>/`. The hero is ' +
      'still `/home/hero.webp` and the four posters are still `/filmography/<video id>.jpg`, which is what the live ' +
      'pages load. Re-pointing them is a file move plus a content edit, and doing it in the same commit as the ' +
      'migration would mean the diff could no longer be checked against the live pages.',
    '',
  );

  upsertReportSection('filmography', filmReport.join('\n'));
  upsertReportSection('photography', photoReport.join('\n'));
  const written = upsertReportSection('notes', notes.join('\n'));
  if (written !== null) say(`\nreport: ${written}`);

  return filmChecks.passed && photoChecks.passed;
}

/* ========================================================================== */
/* Selftest                                                                   */
/* ========================================================================== */

function selftest(): boolean {
  const checks = new Checks();
  const always = (): boolean => true;
  /** No ids committed yet: the selftest must not depend on what is on disk. */
  const NO_IDS = new Map<string, string>();

  const losses: Loss[] = [];
  const films = convertFilms(
    [
      { id: 'EudrajWcwwg', title: 'Untitled', note: 'A note.', kind: 'SHORT FILM', year: '2019' },
      { id: '2jiXj6uOuDs', title: 'The Space Race (Trailer)', kind: 'TRAILER', year: '2019' },
    ],
    losses,
    always,
    NO_IDS,
  );
  checks.add(
    'order is preserved and every field carried across',
    JSON.stringify(films) ===
      JSON.stringify({
        films: [
          {
            id: 'film_untitled',
            youtubeId: 'EudrajWcwwg',
            title: 'Untitled',
            kind: 'SHORT FILM',
            year: '2019',
            note: 'A note.',
            poster: '/filmography/EudrajWcwwg.jpg',
          },
          {
            id: 'film_the_space_race_trailer',
            youtubeId: '2jiXj6uOuDs',
            title: 'The Space Race (Trailer)',
            kind: 'TRAILER',
            year: '2019',
            poster: '/filmography/2jiXj6uOuDs.jpg',
          },
        ],
      }),
    JSON.stringify(films),
  );
  checks.add('a film with no note gets no note key', films.films[1]?.note === undefined, JSON.stringify(films.films[1]));
  checks.add('the synthetic collection validates', validateFilmography(films).ok, JSON.stringify(validateFilmography(films).ok));
  checks.add('no loss for a clean conversion', losses.length === 0, JSON.stringify(losses));

  const missingPoster: Loss[] = [];
  convertFilms([{ id: 'EudrajWcwwg', title: 'A', kind: 'SHORT FILM', year: '2019' }], missingPoster, () => false, NO_IDS);
  checks.add(
    'a missing poster file is fatal, not a YouTube fallback',
    missingPoster.some((loss) => loss.fatal),
    JSON.stringify(missingPoster.map((loss) => loss.what.slice(0, 60))),
  );

  const unknownField: Loss[] = [];
  convertFilms(
    [{ id: 'EudrajWcwwg', title: 'A', kind: 'SHORT FILM', year: '2019', director: 'Someone' } as unknown as LiveFilm],
    unknownField,
    always,
    NO_IDS,
  );
  checks.add('an unknown source field is fatal, not dropped', unknownField.some((loss) => loss.fatal), JSON.stringify(unknownField.map((l) => l.what.slice(0, 60))));

  const collide: Loss[] = [];
  const twins = convertFilms(
    [
      { id: 'EudrajWcwwg', title: 'Untitled', kind: 'SHORT FILM', year: '2019' },
      { id: '2jiXj6uOuDs', title: 'Untitled', kind: 'SHORT FILM', year: '2020' },
    ],
    collide,
    always,
    NO_IDS,
  );
  checks.add(
    'two films with the same title get different ids',
    twins.films[0]?.id === 'film_untitled' && twins.films[1]?.id === 'film_untitled_2' && validateFilmography(twins).ok,
    JSON.stringify(twins.films.map((film) => film.id)),
  );

  const hangul: Loss[] = [];
  const unnameable = convertFilms([{ id: 'EudrajWcwwg', title: '제목', kind: 'SHORT FILM', year: '2019' }], hangul, always, NO_IDS);
  checks.add(
    'a title that slugifies to nothing falls back to the video id',
    unnameable.films[0]?.id === 'film_EudrajWcwwg' && validateFilmography(unnameable).ok,
    JSON.stringify(unnameable.films[0]?.id),
  );

  const reuseLosses: Loss[] = [];
  const reused = convertFilms(
    [{ id: 'EudrajWcwwg', title: 'A New Title', kind: 'SHORT FILM', year: '2019' }],
    reuseLosses,
    always,
    new Map([['EudrajWcwwg', 'film_an_old_id']]),
  );
  checks.add(
    'a record id already committed is reused, so renaming a film never changes its id',
    reused.films[0]?.id === 'film_an_old_id' && reused.films[0]?.title === 'A New Title',
    JSON.stringify(reused.films[0]),
  );

  const emptyLosses: Loss[] = [];
  const albums = convertAlbums([], emptyLosses);
  checks.add(
    'an empty album list becomes a valid empty collection',
    JSON.stringify(albums) === '{"albums":[]}' && validatePhotography(albums).ok,
    JSON.stringify(albums),
  );
  checks.add('and the emptiness is recorded rather than assumed', emptyLosses.length === 1 && !emptyLosses[0]!.fatal, JSON.stringify(emptyLosses));

  const nonEmpty: Loss[] = [];
  convertAlbums([{ title: 'Ocean Beach', year: '2026', cover: '/photography/ocean-beach/cover.jpg' }], nonEmpty);
  checks.add(
    'a non-empty album list is fatal rather than half-migrated',
    nonEmpty.some((loss) => loss.fatal),
    JSON.stringify(nonEmpty.map((loss) => loss.what.slice(0, 70))),
  );

  // Order is editorial, so the comparison has to be order-sensitive. Asserted
  // rather than assumed: permute the rows and require the diff to notice.
  const row = (film: Film): string => [film.youtubeId, film.title, film.note ?? '', `${film.kind} · ${film.year}`, filmPosterSrc(film)].join(' | ');
  const rows = films.films.map(row);
  checks.add(
    'a reordered collection is caught by the row diff',
    changed(diffLines(rows, [...rows].reverse())).length > 0,
    `${changed(diffLines(rows, [...rows].reverse())).length} difference(s)`,
  );
  const wrongYear = films.films.map((film, index) => row(index === 0 ? { ...film, year: '2020' } : film));
  checks.add(
    'a changed year is caught by the row diff',
    changed(diffLines(rows, wrongYear)).length > 0,
    `${changed(diffLines(rows, wrongYear)).length} difference(s)`,
  );

  const cards = readCards(
    '<ul class="cards"><li class="card"><button data-video-id="abcdefghijk"></button>' +
      '<img src="/filmography/abcdefghijk.jpg" alt=""><div class="card-text">' +
      '<span class="card-title">A Film</span><span class="card-note">A note.</span>' +
      '<span class="card-meta">SHORT FILM · 2019</span></div></li></ul>',
  );
  checks.add(
    'the live card reader pulls every field out of the markup',
    JSON.stringify(cards) === JSON.stringify([{ youtubeId: 'abcdefghijk', poster: '/filmography/abcdefghijk.jpg', title: 'A Film', note: 'A note.', meta: 'SHORT FILM · 2019' }]),
    JSON.stringify(cards),
  );

  return checks.passed;
}

/* ========================================================================== */
/* main                                                                       */
/* ========================================================================== */

if (MODE.selftest) {
  finish('migrate-data --selftest', selftest());
}

const result = await migrate();
if (MODE.verify) {
  const ok = await verify(result.conversion);
  finish('migrate-data --verify', ok && result.ok);
}
finish('migrate-data', result.ok);
