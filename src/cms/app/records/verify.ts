/**
 * src/cms/app/records/verify.ts
 *
 * WS-E's standalone proof of the editing logic. No React, no DOM, no browser,
 * no server: it steps the pure functions in `./film-edits.ts`,
 * `./album-edits.ts` and `./uploads.ts` and asserts the exact JSON they emit,
 * including key order, because a committed content file is a diff somebody has
 * to read.
 *
 *   node src/cms/app/records/verify.ts
 *
 * The browser half of the proof — the real components, driven with synthesised
 * input — is `./harness/drive.mjs`. Both exit non-zero on failure.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  formatIssues,
  validateAlbum,
  validateFilm,
  validateFilmographyJson,
  validatePhotographyJson,
  youtubeEmbedUrl,
  youtubeThumbUrl,
} from '../../schema.ts';
import type { Album, Film, Photo } from '../../schema.ts';
import { requireSection } from '../../sections.ts';

import {
  albumFieldProblem,
  blankAlbum,
  canonicalAlbum,
  canonicalPhoto,
  clearCover,
  effectiveCoverId,
  hasPinnedCover,
  insertPhotosAt,
  isCover,
  missingAltCount,
  movePhoto,
  movePhotoBy,
  patchAlbum,
  photoFromUpload,
  removePhoto,
  reorderPhotos,
  restorePhoto,
  setAlbumTitle,
  setCover,
  setPhotoAlt,
  setPhotoCaption,
  slugFollowsTitle,
  suggestSlug,
  toggleCover,
} from './album-edits.ts';
import {
  applyYouTubeInput,
  blankFilm,
  canonicalFilm,
  clearFilmPoster,
  filmFieldProblem,
  patchFilm,
  pinYouTubePoster,
  posterOrigin,
  posterSrc,
  readYouTubeInput,
  setFilmPoster,
} from './film-edits.ts';
import { fieldGroup, recordFieldsFor, splitFields } from './field-plan.ts';
import {
  CONCURRENCY,
  insertIndexFor,
  isIdle,
  isPhotoFile,
  makeTasks,
  patchTask,
  pruneSettled,
  startable,
  summarise,
  uploadStatusLine,
  visibleTasks,
} from './uploads.ts';
import type { UploadTask } from './uploads.ts';

let failures = 0;

function section(name: string): void {
  console.log(`\n${name}`);
}

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`    ok    ${label}${detail === '' ? '' : ` (${detail})`}`);
  } else {
    failures += 1;
    console.log(`    FAIL  ${label}${detail === '' ? '' : ` (${detail})`}`);
  }
}

function equal(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, a === b ? '' : `got ${a} want ${b}`);
}

function valid(label: string, album: Album): void {
  const result = validateAlbum(album);
  check(label, result.ok, result.ok ? '' : formatIssues(result.issues));
}

function validFilm(label: string, film: Film): void {
  const result = validateFilm(film);
  check(label, result.ok, result.ok ? '' : formatIssues(result.issues));
}

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), 'utf8');

console.log('WS-E record editor verification (pure logic, no browser)');

/* ========================================================================== */
section("WS-A's fixtures are what the editors are handed");

const filmography = validateFilmographyJson(fixture('filmography.json'));
const photography = validatePhotographyJson(fixture('photography.json'));
check('filmography.json validates', filmography.ok);
check('photography.json validates', photography.ok);
if (!filmography.ok || !photography.ok) {
  console.log('\nFAIL  cannot proceed without the fixtures');
  process.exit(1);
}

const films = filmography.data.films;
const albums = photography.data.albums;
const firstFilm = films[0];
const trailer = films[2];
const firstAlbum = albums[0];
if (firstFilm === undefined || trailer === undefined || firstAlbum === undefined) {
  console.log('\nFAIL  the fixtures lost an entry');
  process.exit(1);
}

check('a film with an uploaded poster', firstFilm.poster !== undefined, firstFilm.id);
check('a film with no poster, to exercise the fallback', trailer.poster === undefined, trailer.id);
check('an album with a chosen cover', firstAlbum.cover !== undefined, firstAlbum.cover ?? '');
check('six photos in it', firstAlbum.photos.length === 6, String(firstAlbum.photos.length));

/* ========================================================================== */
section('the registry drives the editors, and the field union is exhaustive');

const filmFieldDefs = recordFieldsFor('filmography');
const albumFieldDefs = recordFieldsFor('photography');

equal(
  'filmography fields, in registry order',
  filmFieldDefs.map((field) => field.name),
  ['youtubeId', 'title', 'kind', 'year', 'note', 'poster'],
);
equal(
  'photography fields, in registry order',
  albumFieldDefs.map((field) => field.name),
  ['title', 'slug', 'year', 'summary', 'photos', 'cover'],
);
equal(
  'every field type is classified',
  [...filmFieldDefs, ...albumFieldDefs].map((field) => fieldGroup(field.type)).filter((group) => group !== 'text' && group !== 'media'),
  [],
);
equal(
  'the film editor draws these as plain fields',
  splitFields(filmFieldDefs).text.map((field) => field.name),
  ['title', 'kind', 'year', 'note'],
);
equal(
  'and routes these to a media control',
  splitFields(filmFieldDefs).media.map((field) => field.name),
  ['youtubeId', 'poster'],
);
equal(
  'the album editor draws these as plain fields',
  splitFields(albumFieldDefs).text.map((field) => field.name),
  ['title', 'slug', 'year', 'summary'],
);
equal(
  'and routes these to a media control',
  splitFields(albumFieldDefs).media.map((field) => field.name),
  ['photos', 'cover'],
);
check(
  'every field name is a real key on its record',
  albumFieldDefs.every((field) => field.name in firstAlbum) &&
    filmFieldDefs.filter((field) => field.required).every((field) => field.name in firstFilm),
);
check(
  'the photography section is where the album URL comes from',
  requireSection('photography').entryUrl === '/photography/:slug/',
);

/* ========================================================================== */
section('a film: pasting a link');

const fresh = blankFilm({ id: 'film_new' });
validFilm('a blank film is NOT valid until it has a video', { ...fresh, youtubeId: 'EudrajWcwwg' });
check('a blank film is rejected as it stands', validateFilm(fresh).ok === false);
equal('and the editor says why', filmFieldProblem(fresh, 'youtubeId'), 'Paste a YouTube link: a film needs its video.');

const pastes: [string, string | null][] = [
  ['https://www.youtube.com/watch?v=EudrajWcwwg', 'EudrajWcwwg'],
  ['https://www.youtube.com/watch?v=EudrajWcwwg&t=42s&list=PL1', 'EudrajWcwwg'],
  ['https://youtu.be/EudrajWcwwg', 'EudrajWcwwg'],
  ['https://youtu.be/EudrajWcwwg?t=90', 'EudrajWcwwg'],
  ['https://www.youtube-nocookie.com/embed/EudrajWcwwg?rel=0', 'EudrajWcwwg'],
  ['https://m.youtube.com/watch?v=EudrajWcwwg', 'EudrajWcwwg'],
  ['youtube.com/shorts/EudrajWcwwg', 'EudrajWcwwg'],
  ['  EudrajWcwwg  ', 'EudrajWcwwg'],
  ['https://vimeo.com/123456', null],
  ['not a link at all', null],
  ['https://www.youtube.com/watch?t=3', null],
];

for (const [input, expected] of pastes) {
  const applied = applyYouTubeInput(fresh, input);
  const got = applied.changed ? applied.film.youtubeId : null;
  check(
    `paste ${JSON.stringify(input.trim().slice(0, 44))}`,
    got === expected,
    got === null ? `no id, status ${applied.reading.status}` : got,
  );
}

const badPaste = applyYouTubeInput(firstFilm, 'https://vimeo.com/1');
check('a link that is not YouTube never reaches the record', badPaste.film === firstFilm);
equal('and is reported as bad', badPaste.reading.status, 'bad');
equal('an empty box is not a mistake', readYouTubeInput('   ').status, 'empty');

const repointed = applyYouTubeInput(firstFilm, 'https://youtu.be/6SUlwRLFuCc');
check('repointing at a new video keeps the poster', repointed.film.poster === firstFilm.poster);
equal('and changes only the id', { ...repointed.film, youtubeId: firstFilm.youtubeId }, firstFilm);
validFilm('still valid after repointing', repointed.film);

/* ========================================================================== */
section('a film: the poster frame');

equal('an uploaded poster is the film\'s own', posterOrigin(firstFilm), 'uploaded');
equal('no poster falls back to YouTube', posterOrigin(trailer), 'youtube');
equal('no video, no poster', posterOrigin(fresh), 'none');
equal('the fallback src is YouTube\'s thumbnail', posterSrc(trailer), youtubeThumbUrl(trailer.youtubeId));
equal('a film with nothing has no poster src', posterSrc(fresh), null);

const pinned = pinYouTubePoster(trailer);
equal('pinning writes the thumbnail in', pinned.poster, youtubeThumbUrl(trailer.youtubeId));
validFilm('a pinned poster validates (https src)', pinned);
equal('pinning is a no-op with no video', pinYouTubePoster(fresh), fresh);

const uploadedPoster = setFilmPoster(trailer, '/media/filmography/film_space_race_trailer/frame.jpg');
equal('an upload replaces it', uploadedPoster.poster, '/media/filmography/film_space_race_trailer/frame.jpg');
equal('clearing goes back to YouTube', clearFilmPoster(uploadedPoster), trailer);
validFilm('an uploaded poster validates', uploadedPoster);

/* ========================================================================== */
section('a film: the JSON that comes out');

const typed = patchFilm(
  patchFilm(patchFilm(fresh, { youtubeId: 'EudrajWcwwg' }), { title: 'Untitled' }),
  { note: '   ', kind: 'SHORT FILM', year: '2019' },
);
equal(
  'blank optionals are absent, not ""',
  JSON.stringify(typed),
  JSON.stringify({
    id: 'film_new',
    youtubeId: 'EudrajWcwwg',
    title: 'Untitled',
    kind: 'SHORT FILM',
    year: '2019',
  }),
);
equal(
  'keys come out in schema order whatever order they were set in',
  Object.keys(canonicalFilm({ ...typed, poster: '/p.jpg', note: 'a note' })),
  ['id', 'youtubeId', 'title', 'note', 'kind', 'year', 'poster'],
);
validFilm('a film typed through the editor validates', typed);
equal('the fixture round-trips through canonicalFilm unchanged', canonicalFilm(firstFilm), firstFilm);
equal(
  'the editor and the site build the same embed URL',
  youtubeEmbedUrl(typed.youtubeId, { autoplay: true }),
  'https://www.youtube-nocookie.com/embed/EudrajWcwwg?autoplay=1&rel=0',
);

const yearProblems: [string, boolean][] = [
  ['2019', false],
  ['2018-2019', false],
  ['', true],
  ['19', true],
  ['2019-', true],
  ['twenty', true],
];
for (const [year, bad] of yearProblems) {
  check(`year ${JSON.stringify(year)}`, (filmFieldProblem({ ...typed, year }, 'year') !== null) === bad);
}

/* ========================================================================== */
section('an album: the header');

const blank = blankAlbum({ id: 'album_new', title: 'Summer in Seoul' });
valid('a blank album is valid with no photos at all', blank);
equal('its slug comes from its title', blank.slug, 'summer-in-seoul');
equal('an untypeable title falls back to the id', blankAlbum({ id: 'album_x', title: '한글' }).slug, 'album-x');
check('a fresh slug follows its title', slugFollowsTitle(blank));

const retitled = setAlbumTitle(blank, 'Winter in Seoul');
equal('retitling carries the slug along while it was never pinned', retitled.slug, 'winter-in-seoul');
const pinnedSlug = patchAlbum(retitled, { slug: 'seoul' });
equal(
  'but a pinned slug stays put when the title changes',
  setAlbumTitle(pinnedSlug, 'Seoul, Again').slug,
  'seoul',
);
check('and the editor can still suggest one', suggestSlug('Seoul, Again', 'album_new') === 'seoul-again');
equal('a bad slug is reported', albumFieldProblem({ ...blank, slug: 'Not A Slug' }, 'slug'), 'Lowercase letters, numbers and single hyphens only.');
equal('an empty album is advisory, not an error', albumFieldProblem(blank, 'photos'), 'No photos yet. An empty album still saves.');
equal('a blank summary is dropped', patchAlbum(blank, { summary: '  ' }).summary, undefined);
equal(
  'album keys come out in schema order',
  Object.keys(canonicalAlbum({ ...firstAlbum })),
  ['id', 'slug', 'title', 'year', 'cover', 'summary', 'photos'],
);

/* ========================================================================== */
section('an album: photos in, in the order they were chosen');

const uploads = [
  { src: '/media/photography/summer-in-seoul/01.jpg', w: 2000, h: 1333 },
  { src: '/media/photography/summer-in-seoul/02.jpg', w: 2000, h: 1333 },
  { src: '/media/photography/summer-in-seoul/03.jpg', w: 1500, h: 2000 },
];
const madePhotos = uploads.map((upload, index) =>
  photoFromUpload(upload, { id: `ph_test_${index + 1}` }),
);
equal(
  'an upload becomes a photo with both intrinsic dimensions',
  madePhotos[0],
  { id: 'ph_test_1', src: '/media/photography/summer-in-seoul/01.jpg', w: 2000, h: 1333 },
);
equal(
  'half a dimension pair is dropped rather than written',
  photoFromUpload({ src: '/a.png', w: 1200 }, { id: 'ph_half' }),
  { id: 'ph_half', src: '/a.png' },
);
equal(
  'a fractional dimension is rounded to whole pixels',
  photoFromUpload({ src: '/a.png', w: 1200.4, h: 918.6 }, { id: 'ph_round' }),
  { id: 'ph_round', src: '/a.png', w: 1200, h: 919 },
);

const withThree = insertPhotosAt(blank, madePhotos, blank.photos.length);
valid('three photos appended', withThree);
equal('in order', withThree.photos.map((photo) => photo.id), ['ph_test_1', 'ph_test_2', 'ph_test_3']);

const duplicated = insertPhotosAt(withThree, [madePhotos[0] as Photo], 1);
valid('inserting the same photo twice stays valid', duplicated);
check(
  'because the colliding id is renamed',
  new Set(duplicated.photos.map((photo) => photo.id)).size === 4,
  duplicated.photos.map((photo) => photo.id).join(','),
);
equal('and it lands where it was dropped', duplicated.photos[1]?.src, madePhotos[0]?.src);

/* ========================================================================== */
section('an album: reordering is read, permute, write back');

equal('reorderPhotos moves one element', reorderPhotos([1, 2, 3, 4] as unknown as Photo[], 0, 2), [2, 3, 1, 4]);
equal('out-of-range indices clamp', reorderPhotos([1, 2, 3] as unknown as Photo[], 0, 99), [2, 3, 1]);
equal('an empty album cannot be reordered into a crash', reorderPhotos([], 1, 0), []);

const moved = movePhoto(withThree, 2, 0);
equal('dragging the third to the front', moved.photos.map((photo) => photo.id), ['ph_test_3', 'ph_test_1', 'ph_test_2']);
valid('still valid after a drag', moved);
equal('the arrow buttons move one step', movePhotoBy(moved, 'ph_test_3', 1).photos.map((p) => p.id), ['ph_test_1', 'ph_test_3', 'ph_test_2']);
equal('and refuse to walk off the end', movePhotoBy(moved, 'ph_test_3', -1), moved);
equal('a photo that is not here is ignored', movePhotoBy(moved, 'ph_nope', 1), moved);

/* ========================================================================== */
section('an album: the cover');

equal('with no choice, the cover is the first photo', effectiveCoverId(withThree), 'ph_test_1');
check('and it is not pinned', !hasPinnedCover(withThree));
const covered = setCover(withThree, 'ph_test_3');
equal('starring a tile pins it', covered.cover, 'ph_test_3');
check('the star is on the right tile', isCover(covered, 'ph_test_3') && !isCover(covered, 'ph_test_1'));
valid('a pinned cover validates', covered);
equal('reordering does not move a pinned cover', movePhoto(covered, 0, 2).cover, 'ph_test_3');
equal('but an unpinned cover follows the first photo', effectiveCoverId(movePhoto(withThree, 2, 0)), 'ph_test_3');
equal('starring the pinned cover unpins it', toggleCover(covered, 'ph_test_3').cover, undefined);
equal('starring another tile moves the pin', toggleCover(covered, 'ph_test_2').cover, 'ph_test_2');
equal('clearing goes back to the first photo', clearCover(covered).cover, undefined);
equal('a cover that is not in this album is never written', setCover(withThree, 'ph_elsewhere').cover, undefined);
equal(
  'and a dangling cover is dropped on the way out',
  canonicalAlbum({ ...withThree, cover: 'ph_gone' }).cover,
  undefined,
);

/* ========================================================================== */
section('an album: deleting, and putting it back');

const deletion = removePhoto(covered, 'ph_test_3');
valid('deleting the cover photo leaves a valid album', deletion.album);
equal('the photo is gone', deletion.album.photos.map((photo) => photo.id), ['ph_test_1', 'ph_test_2']);
equal('and `cover` was cleared in the same edit', deletion.album.cover, undefined);
equal('the removal remembers where it was', [deletion.removal?.index, deletion.removal?.coverWas], [2, 'ph_test_3']);

const undone = restorePhoto(deletion.album, deletion.removal as never);
equal('undo puts it back where it was', undone.photos.map((photo) => photo.id), ['ph_test_1', 'ph_test_2', 'ph_test_3']);
equal('and restores the cover choice', undone.cover, 'ph_test_3');
equal('undo is exactly the album before the delete', undone, covered);
valid('and it validates', undone);

const middle = removePhoto(covered, 'ph_test_1');
equal('deleting a non-cover photo keeps the cover', middle.album.cover, 'ph_test_3');
equal('deleting something that is not here does nothing', removePhoto(covered, 'ph_nope').album, covered);
equal('restoring into a shorter album clamps', restorePhoto(blank, { photo: madePhotos[0] as Photo, index: 9, coverWas: undefined }).photos.length, 1);

/* ========================================================================== */
section('an album: alt text and captions, edited on the tile');

const described = setPhotoCaption(
  setPhotoAlt(withThree, 'ph_test_1', 'A tiled roof against a white sky'),
  'ph_test_1',
  'Bukchon, morning.',
);
equal(
  'both land on the photo in schema order',
  Object.keys(described.photos[0] ?? {}),
  ['id', 'src', 'alt', 'caption', 'w', 'h'],
);
valid('and the album still validates', described);
equal('clearing alt text removes the key', setPhotoAlt(described, 'ph_test_1', '  ').photos[0]?.alt, undefined);
equal('the nudge counts photos without alt text', missingAltCount(described), 2);
equal('the fixture album counts its own (one photo has none)', missingAltCount(firstAlbum), 1);
equal('the fixture album round-trips unchanged', canonicalAlbum(firstAlbum), firstAlbum);
equal(
  'a photo with no dimensions stays that way',
  canonicalPhoto({ id: 'ph_x', src: '/a.png' }),
  { id: 'ph_x', src: '/a.png' },
);

/* ========================================================================== */
section('six files in one drag: the upload queue machine');

/**
 * The same sequence the hook runs, stepped by hand: start up to CONCURRENCY,
 * complete in whatever order, insert each result at `insertIndexFor`. This is
 * the claim that matters — "six photos in one drag, in the order I chose them"
 * — and it has to hold when they finish out of order and one of them fails.
 */
function runBatch(
  album: Album,
  names: readonly string[],
  finishOrder: readonly number[],
  failing: readonly number[],
): { album: Album; tasks: UploadTask[] } {
  let tasks = makeTasks(
    names.map((name) => ({ name, size: 1000 })),
    { nextOrder: 0, anchor: album.photos.length },
  );
  let current = album;

  const start = (): void => {
    for (const task of startable(tasks, CONCURRENCY)) {
      tasks = patchTask(tasks, task.key, { status: 'uploading', progress: 0 });
    }
  };

  start();
  for (const index of finishOrder) {
    const task = tasks[index];
    if (task === undefined) throw new Error(`no task ${index}`);
    if (task.status !== 'uploading') throw new Error(`task ${index} was not in flight`);
    if (failing.includes(index)) {
      tasks = patchTask(tasks, task.key, { status: 'failed', error: 'the server said no' });
    } else {
      const live = tasks.find((candidate) => candidate.key === task.key) as UploadTask;
      const at = insertIndexFor(tasks, live);
      current = insertPhotosAt(
        current,
        [photoFromUpload({ src: `/media/photography/a/${task.name}`, w: 1200, h: 800 }, { id: `ph_${task.order}` })],
        at,
      );
      tasks = patchTask(tasks, task.key, { status: 'done', progress: 1 });
    }
    start();
  }
  return { album: current, tasks };
}

const six = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg', 'f.jpg'];

const inOrder = runBatch(blank, six, [0, 1, 2, 3, 4, 5], []);
equal(
  'finishing in order: selection order',
  inOrder.album.photos.map((photo) => photo.src.split('/').pop()),
  six,
);
valid('and the album validates', inOrder.album);

const jumbled = runBatch(blank, six, [2, 0, 1, 5, 3, 4], []);
equal(
  'finishing out of order: STILL selection order',
  jumbled.album.photos.map((photo) => photo.src.split('/').pop()),
  six,
);
check('only three were ever in flight at once', CONCURRENCY === 3);

const withFailure = runBatch(blank, six, [1, 0, 2, 4, 3, 5], [2]);
equal(
  'one failure does not stop or reshuffle the rest',
  withFailure.album.photos.map((photo) => photo.src.split('/').pop()),
  ['a.jpg', 'b.jpg', 'd.jpg', 'e.jpg', 'f.jpg'],
);
equal('the failed task is still on screen', visibleTasks(withFailure.tasks).map((task) => task.name), ['c.jpg']);
equal('and it is reported', summarise(withFailure.tasks).failed, 1);
equal('with a line to show', uploadStatusLine(summarise(withFailure.tasks)), '1 of 6 did not upload.');
check('the queue is idle once everything settled', isIdle(withFailure.tasks));
equal('finished tasks are pruned, failures are not', pruneSettled(withFailure.tasks).map((task) => task.name), ['c.jpg']);

const added = runBatch(inOrder.album, ['g.jpg', 'h.jpg'], [1, 0], []);
equal(
  'a second batch lands after the first',
  added.album.photos.map((photo) => photo.src.split('/').pop()),
  [...six, 'g.jpg', 'h.jpg'],
);

equal(
  'mid-batch, the bar is somewhere in the middle',
  (() => {
    let tasks = makeTasks(six.map((name) => ({ name })), { nextOrder: 0, anchor: 0 });
    for (const task of startable(tasks, CONCURRENCY)) {
      tasks = patchTask(tasks, task.key, { status: 'uploading', progress: 0.5 });
    }
    const summary = summarise(tasks);
    return [summary.active, Number(summary.fraction.toFixed(3)), uploadStatusLine(summary)];
  })(),
  [3, 0.25, 'Uploading 3 of 6…'],
);

/* ========================================================================== */
section('what the queue will and will not take');

const fileNames: [string, boolean][] = [
  ['photo.jpg', true],
  ['PHOTO.JPEG', true],
  ['shot.png', true],
  ['frame.webp', true],
  ['drawing.svg', true],
  ['clip.mp4', false],
  ['notes.pdf', false],
  ['nameless', false],
];
for (const [name, ok] of fileNames) {
  check(`${ok ? 'takes' : 'refuses'} ${name}`, isPhotoFile({ name }) === ok);
}

/* ========================================================================== */
section('a whole album, built the way the editor builds one');

let built = blankAlbum({ id: 'album_demo', title: 'First Build' });
built = patchAlbum(built, { year: '2026', summary: 'Six frames.' });
const batch = runBatch(built, ['01.jpg', '02.jpg', '03.jpg'], [1, 2, 0], []);
built = batch.album;
built = setPhotoAlt(built, built.photos[0]?.id ?? '', 'The welcome screen');
built = setPhotoCaption(built, built.photos[0]?.id ?? '', 'Where it opens.');
built = movePhoto(built, 2, 0);
built = setCover(built, built.photos[1]?.id ?? '');
const dropped = removePhoto(built, built.photos[0]?.id ?? '');
built = dropped.album;
built = restorePhoto(built, dropped.removal as never);

valid('it validates', built);
equal(
  'and its JSON is exactly this',
  JSON.parse(JSON.stringify(built)),
  {
    id: 'album_demo',
    slug: 'first-build',
    title: 'First Build',
    year: '2026',
    cover: 'ph_0',
    summary: 'Six frames.',
    photos: [
      { id: 'ph_2', src: '/media/photography/a/03.jpg', w: 1200, h: 800 },
      {
        id: 'ph_0',
        src: '/media/photography/a/01.jpg',
        alt: 'The welcome screen',
        caption: 'Where it opens.',
        w: 1200,
        h: 800,
      },
      { id: 'ph_1', src: '/media/photography/a/02.jpg', w: 1200, h: 800 },
    ],
  },
);

console.log('');
if (failures === 0) {
  console.log('PASS  every record-editing guarantee holds');
  process.exit(0);
}
console.log(`FAIL  ${failures} check(s) failed`);
process.exit(1);
