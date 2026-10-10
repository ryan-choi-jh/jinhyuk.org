/**
 * src/cms/fixtures/verify.ts
 *
 * WS-0's standalone proof, extended by WS-A for phase 2. Loads every fixture
 * through its validator, checks the guarantees the other workstreams are
 * allowed to rely on, and exits non-zero if any of it is untrue. No build, no
 * server, no other workstream.
 *
 * Three parts, in order:
 *   1. the five document fixtures, through validateDoc
 *   2. the section registry in src/cms/sections.ts
 *   3. the two record collections, filmography.json and photography.json
 *
 *   npm run cms:verify
 *   # or: node src/cms/fixtures/verify.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DocMetaSchema,
  MOBILE_BREAKPOINT,
  REFERENCE_WIDTH,
  SECTION_IDS,
  albumCoverPhoto,
  albumCoverSrc,
  filmPosterSrc,
  formatIssues,
  isCanvasBand,
  isFilmography,
  isProseBand,
  newAlbum,
  newFilm,
  resolveAnchor,
  seedFromId,
  shapeSpecFromItem,
  slugify,
  validateAlbum,
  validateDoc,
  validateDocJson,
  validateFilm,
  validateFilmography,
  validateFilmographyJson,
  validatePhotography,
  validatePhotographyJson,
  youtubeEmbedUrl,
  youtubeIdFromInput,
} from '../schema.ts';
import type { CanvasItem, Doc, SectionId } from '../schema.ts';
import {
  SECTIONS,
  cmsUrlFor,
  contentDirFor,
  contentPathFor,
  documentSections,
  draftDirFor,
  draftPathFor,
  getSection,
  mediaDirFor,
  mediaSrcFor,
  needsSlug,
  recordSections,
  requireSection,
  siteUrlFor,
  slugFromFilename,
  toDraftPath,
} from '../sections.ts';
import type { RecordsDef } from '../sections.ts';

/**
 * The document corpus. `essay.json` and `home.json` joined it in phase 2: WS-B
 * renders them, WS-F migrates onto them.
 */
const FIXTURES = ['simple.json', 'canvas.json', 'dense.json', 'essay.json', 'home.json'] as const;

const publicDir = fileURLToPath(new URL('../../../public/', import.meta.url));

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`    ok    ${label}${detail ? ` (${detail})` : ''}`);
  } else {
    failures += 1;
    console.log(`    FAIL  ${label}${detail ? ` (${detail})` : ''}`);
  }
}

function canvasItems(doc: Doc): CanvasItem[] {
  return doc.bands.filter(isCanvasBand).flatMap((band) => band.items);
}

function fixtureText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');
}

/** A site-absolute src has to point at a file that really exists under public/. */
function srcExists(src: string): boolean {
  if (!src.startsWith('/')) return true;
  return existsSync(new URL(`.${src}`, `file://${publicDir}`));
}

function overlaps(a: CanvasItem, b: CanvasItem): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

console.log(`WS-0 fixture verification`);
console.log(`reference width ${REFERENCE_WIDTH}px, mobile breakpoint ${MOBILE_BREAKPOINT}px\n`);

const docs = new Map<string, Doc>();

for (const name of FIXTURES) {
  console.log(`${name}`);

  const result = validateDocJson(fixtureText(name));

  if (!result.ok) {
    failures += 1;
    console.log(`    FAIL  validateDoc`);
    console.log(
      formatIssues(result.issues)
        .split('\n')
        .map((line) => `          ${line}`)
        .join('\n'),
    );
    console.log('');
    continue;
  }

  const doc = result.doc;
  docs.set(name, doc);

  const prose = doc.bands.filter(isProseBand);
  const canvases = doc.bands.filter(isCanvasBand);
  const items = canvasItems(doc);
  const blocks = prose.flatMap((band) => band.blocks);

  check(
    'validateDoc',
    true,
    `${doc.bands.length} bands, ${blocks.length} prose blocks, ${items.length} canvas items`,
  );

  // Re-validating the parsed output must agree with validating the raw text.
  check('revalidates after parse', validateDoc(doc).ok);

  // Every media src must point at a file that really exists under public/,
  // so a renderer screenshot shows a picture instead of a broken image.
  for (const item of items) {
    if (item.src === undefined) continue;
    check(`src exists: ${item.src}`, srcExists(item.src));
  }
  if (doc.meta.cover !== undefined) {
    check(`cover exists: ${doc.meta.cover}`, srcExists(doc.meta.cover));
  }

  // Prose content is always an array of TipTap nodes, never a bare node.
  check(
    'prose content is always an array',
    blocks.every((block) => Array.isArray(block.content)),
  );

  // Geometry stays inside the reference width, or a screenshot will scroll.
  const tooWide = items.filter((item) => item.x < 0 || item.x + item.w > REFERENCE_WIDTH);
  check(
    `items fit within ${REFERENCE_WIDTH}px`,
    tooWide.length === 0,
    tooWide.map((item) => item.id).join(', '),
  );

  // Non-overlay canvas bands must reserve enough height for their own items.
  for (const band of canvases) {
    if (band.overlay === true) continue;
    const needed = Math.max(0, ...band.items.map((item) => item.y + item.h));
    check(`band ${band.id} reserves its content`, band.height >= needed, `${band.height} >= ${needed}`);
  }

  // Every anchor resolves, and every shape converts to a ShapeSpec with a
  // stable, non-random seed.
  for (const item of items) {
    if (item.anchor !== undefined) {
      const target = resolveAnchor(doc, item.anchor);
      check(
        `anchor ${item.id} -> ${item.anchor.bandId}/${item.anchor.blockId}`,
        target !== null,
        target === null ? 'does not resolve' : `kind ${target.block.kind}`,
      );
    }
    if (item.kind === 'shape') {
      const spec = shapeSpecFromItem(item);
      check(
        `shapeSpec ${item.id}`,
        spec !== null && spec.seed === seedFromId(item.id) && spec.strokeWidth > 0,
        spec === null ? 'null' : `${spec.shape}, seed ${spec.seed}`,
      );
    }
  }

  console.log('');
}

/* Coverage: the fixtures have to actually contain the hard cases, or they are
   not worth building six workstreams against. */
console.log('coverage');

const simple = docs.get('simple.json');
const canvas = docs.get('canvas.json');
const dense = docs.get('dense.json');

check(`all ${FIXTURES.length} document fixtures loaded`, docs.size === FIXTURES.length);

if (simple !== undefined) {
  const kinds = new Set(simple.bands.filter(isProseBand).flatMap((b) => b.blocks.map((x) => x.kind)));
  const marks = new Set(
    JSON.stringify(simple)
      .match(/"type":"(bold|italic|link|textStyle)"/g)
      ?.map((m) => m.slice(8, -1)) ?? [],
  );
  check('simple: prose only', simple.bands.every(isProseBand));
  check('simple: has heading, quote, list', kinds.has('h2') && kinds.has('quote') && kinds.has('ul'));
  check('simple: block kinds', kinds.size >= 5, [...kinds].join(' '));
  check('simple: marks', marks.size === 4, [...marks].join(' '));
}

if (canvas !== undefined) {
  const bands = canvas.bands.filter(isCanvasBand);
  const items = canvasItems(canvas);
  check('canvas: exactly one canvas band', bands.length === 1);
  check('canvas: two images', items.filter((i) => i.kind === 'image').length === 2);
  check('canvas: one squiggle', items.filter((i) => i.shape === 'squiggle').length === 1);
  check('canvas: has prose too', canvas.bands.some(isProseBand));
}

if (dense !== undefined) {
  const canvases = dense.bands.filter(isCanvasBand);
  const items = canvasItems(dense);
  const shapes = new Set(items.flatMap((i) => (i.shape === undefined ? [] : [i.shape])));
  const overlayBands = canvases.filter((b) => b.overlay === true);
  const rotatedMedia = items.filter((i) => i.kind !== 'shape' && (i.rotate ?? 0) !== 0);
  const anchored = items.filter((i) => i.anchor !== undefined);

  check('dense: has an overlay band', overlayBands.length >= 1);
  check('dense: overlay is never band 0', dense.bands[0] !== undefined && !(isCanvasBand(dense.bands[0]) && dense.bands[0].overlay === true));
  check('dense: rotated media', rotatedMedia.length >= 1, `${rotatedMedia.length} items`);
  check('dense: several shapes', shapes.size >= 4, [...shapes].join(' '));
  check('dense: anchored connector', anchored.length >= 1 && anchored.every((i) => resolveAnchor(dense, i.anchor!) !== null));

  const four = canvases.find((band) => band.items.length === 4 && band.items.every((i) => i.kind === 'image'));
  let overlapping = 0;
  if (four !== undefined) {
    for (let a = 0; a < four.items.length; a += 1) {
      for (let b = a + 1; b < four.items.length; b += 1) {
        if (overlaps(four.items[a]!, four.items[b]!)) overlapping += 1;
      }
    }
  }
  check('dense: a canvas of four overlapping items', four !== undefined && overlapping >= 3, `${overlapping} overlapping pairs`);
}

/* Negative control: validateDoc has to actually reject things. */
console.log('\nnegative controls');
const negatives: [string, unknown][] = [
  ['not an object', 42],
  ['wrong version', { version: 2, meta: { title: 'a', slug: 'a', date: '2026-01-01' }, bands: [] }],
  ['bad slug', { version: 1, meta: { title: 'a', slug: 'Not A Slug', date: '2026-01-01' }, bands: [] }],
  ['impossible date', { version: 1, meta: { title: 'a', slug: 'a', date: '2026-02-30' }, bands: [] }],
  [
    'unknown key',
    { version: 1, meta: { title: 'a', slug: 'a', date: '2026-01-01' }, bands: [], draft: true },
  ],
  [
    'duplicate id',
    {
      version: 1,
      meta: { title: 'a', slug: 'a', date: '2026-01-01' },
      bands: [
        { id: 'dup', type: 'prose', blocks: [{ id: 'dup', kind: 'p', content: [] }] },
      ],
    },
  ],
  [
    'missing prose content',
    {
      version: 1,
      meta: { title: 'a', slug: 'a', date: '2026-01-01' },
      bands: [{ id: 'b', type: 'prose', blocks: [{ id: 'p', kind: 'p' }] }],
    },
  ],
  [
    'overlay as first band',
    {
      version: 1,
      meta: { title: 'a', slug: 'a', date: '2026-01-01' },
      bands: [{ id: 'b', type: 'canvas', height: 100, overlay: true, items: [] }],
    },
  ],
  [
    'shape without shape kind',
    {
      version: 1,
      meta: { title: 'a', slug: 'a', date: '2026-01-01' },
      bands: [
        {
          id: 'b',
          type: 'canvas',
          height: 100,
          items: [{ id: 'i', kind: 'shape', x: 0, y: 0, w: 10, h: 10 }],
        },
      ],
    },
  ],
  [
    'image without src',
    {
      version: 1,
      meta: { title: 'a', slug: 'a', date: '2026-01-01' },
      bands: [
        {
          id: 'b',
          type: 'canvas',
          height: 100,
          items: [{ id: 'i', kind: 'image', x: 0, y: 0, w: 10, h: 10 }],
        },
      ],
    },
  ],
  [
    'zero width item',
    {
      version: 1,
      meta: { title: 'a', slug: 'a', date: '2026-01-01' },
      bands: [
        {
          id: 'b',
          type: 'canvas',
          height: 100,
          items: [{ id: 'i', kind: 'image', src: '/a.png', x: 0, y: 0, w: 0, h: 10 }],
        },
      ],
    },
  ],
  [
    'fractional z',
    {
      version: 1,
      meta: { title: 'a', slug: 'a', date: '2026-01-01' },
      bands: [
        {
          id: 'b',
          type: 'canvas',
          height: 100,
          items: [{ id: 'i', kind: 'image', src: '/a.png', x: 0, y: 0, w: 10, h: 10, z: 1.5 }],
        },
      ],
    },
  ],
];

for (const [label, value] of negatives) {
  check(`rejects: ${label}`, validateDoc(value).ok === false);
}
check('rejects: invalid JSON text', validateDocJson('{nope').ok === false);


/* ========================================================================== */
/* PHASE 2 (docs/cms-sections.md): the section registry and the two record    */
/* collections. Everything above this line is phase 1 and must still pass.    */
/* ========================================================================== */

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

console.log('\nsection registry');

check(
  'every section in SECTION_IDS, in order',
  SECTIONS.length === SECTION_IDS.length && SECTIONS.every((s, i) => s.id === SECTION_IDS[i]),
  SECTIONS.map((s) => s.id).join(' '),
);
check('getSection rejects a non-section', getSection('nope') === null);
check('isDocumentSection + isRecordSection partition', documentSections().length === 3 && recordSections().length === 2);

for (const section of SECTIONS) {
  check(`${section.id}: getSection round-trips`, getSection(section.id) === section);
  check(
    `${section.id}: draftPath mirrors contentPath`,
    section.draftPath === toDraftPath(section.contentPath),
    section.draftPath,
  );
  check(
    `${section.id}: only a document collection needs a slug`,
    needsSlug(section.contentPath) === (section.storage === 'document' && section.shape === 'collection'),
  );
  check(
    `${section.id}: ${section.storage} editor`,
    (section.storage === 'records') === (section.records !== null),
    section.records === null ? 'document' : `records.${section.records.key}`,
  );
  check(`${section.id}: cmsUrl`, section.cmsUrl === `/cms/${section.id}`, section.cmsUrl);
}

/* The literal file layout docs/cms-sections.md 4 promises. If this table ever
   disagrees with the registry, the registry is the bug: WS-C and WS-F both
   build paths from it. */
const PATHS: [SectionId, string | null, string, string, string][] = [
  ['home', null, 'src/content/pages/home.json', 'src/content/drafts/pages/home.json', 'public/media/home'],
  ['projects', 'track-daily-habit-tracker', 'src/content/pages/projects/track-daily-habit-tracker.json', 'src/content/drafts/pages/projects/track-daily-habit-tracker.json', 'public/media/projects/track-daily-habit-tracker'],
  ['essays', 'chasing-the-workaround', 'src/content/pages/essays/chasing-the-workaround.json', 'src/content/drafts/pages/essays/chasing-the-workaround.json', 'public/media/essays/chasing-the-workaround'],
  ['filmography', 'film_getaway', 'src/content/data/filmography.json', 'src/content/drafts/data/filmography.json', 'public/media/filmography/film_getaway'],
  ['photography', 'first-build', 'src/content/data/photography.json', 'src/content/drafts/data/photography.json', 'public/media/photography/first-build'],
];

for (const [id, slug, content, draft, media] of PATHS) {
  const section = requireSection(id);
  check(`${id}: content path`, contentPathFor(section, slug) === content, contentPathFor(section, slug));
  check(`${id}: draft path`, draftPathFor(section, slug) === draft, draftPathFor(section, slug));
  check(`${id}: media dir`, mediaDirFor(section, slug) === media, mediaDirFor(section, slug));
}

check(
  'essays: media src',
  mediaSrcFor(requireSection('essays'), 'chasing-the-workaround', 'shot.png') ===
    '/media/essays/chasing-the-workaround/shot.png',
);
check(
  'projects: content dir is listable',
  contentDirFor(requireSection('projects')) === 'src/content/pages/projects' &&
    draftDirFor(requireSection('projects')) === 'src/content/drafts/pages/projects',
);
check('slugFromFilename', slugFromFilename('my-essay.json') === 'my-essay' && slugFromFilename('README.md') === null);

/* Site URLs. The album page is new surface; a film has no page of its own. */
check('photography: album URL', siteUrlFor(requireSection('photography'), 'first-build') === '/photography/first-build/');
check('essays: essay URL', siteUrlFor(requireSection('essays'), 'chasing-the-workaround') === '/essays/chasing-the-workaround/');
check('filmography: no entry URL', siteUrlFor(requireSection('filmography'), 'film_getaway') === null);
check('home: no entry URL', siteUrlFor(requireSection('home')) === null);
check('home: cmsUrlFor ignores a slug', cmsUrlFor(requireSection('home'), 'x') === '/cms/home');
check('essays: cmsUrlFor', cmsUrlFor(requireSection('essays'), 'x') === '/cms/essays/x');

/* fillSlug is the only place a slug reaches a file path, so it is the
   traversal guard. These have to throw, not sanitise. */
check('fillSlug refuses ../', throws(() => contentPathFor(requireSection('essays'), '../../../etc/passwd')));
check('fillSlug refuses a slash', throws(() => contentPathFor(requireSection('essays'), 'a/b')));
check('fillSlug refuses nothing at all', throws(() => contentPathFor(requireSection('essays'))));
check('fillSlug refuses an empty slug', throws(() => contentPathFor(requireSection('essays'), '')));
check('toDraftPath refuses a path outside src/content', throws(() => toDraftPath('public/media/x.png')));
check('toDraftPath refuses a draft path', throws(() => toDraftPath('src/content/drafts/pages/home.json')));

/* -------------------------------------------------------------------------- */

console.log('\nfilmography.json');

const filmographyResult = validateFilmographyJson(fixtureText('filmography.json'));

if (!filmographyResult.ok) {
  failures += 1;
  console.log('    FAIL  validateFilmography');
  console.log(formatIssues(filmographyResult.issues).split('\n').map((l) => `          ${l}`).join('\n'));
} else {
  const filmography = filmographyResult.data;
  const filmSection = requireSection('filmography');
  const def = filmSection.records as RecordsDef;

  check('validateFilmography', true, `${filmography.films.length} films`);
  check('the registry validates the same file', def.validateFile(filmography).ok);
  check('several films', filmography.films.length >= 4);
  check('unique ids', new Set(filmography.films.map((f) => f.id)).size === filmography.films.length);

  for (const film of filmography.films) {
    if (film.poster !== undefined) check(`poster exists: ${film.poster}`, srcExists(film.poster));
    check(
      `youtubeId round-trips: ${film.youtubeId}`,
      youtubeIdFromInput(`https://www.youtube.com/watch?v=${film.youtubeId}&t=3s`) === film.youtubeId &&
        youtubeIdFromInput(`https://youtu.be/${film.youtubeId}`) === film.youtubeId &&
        youtubeIdFromInput(youtubeEmbedUrl(film.youtubeId)) === film.youtubeId &&
        youtubeIdFromInput(film.youtubeId) === film.youtubeId,
    );
  }

  // The fallback has to be exercised by the corpus, not just by the code.
  const withPoster = filmography.films.filter((f) => f.poster !== undefined);
  const withoutPoster = filmography.films.filter((f) => f.poster === undefined);
  check('a film with an uploaded poster', withPoster.length >= 1 && withPoster.every((f) => filmPosterSrc(f) === f.poster));
  check(
    'a film with no poster, falling back to YouTube',
    withoutPoster.length >= 1 && withoutPoster.every((f) => filmPosterSrc(f).startsWith('https://i.ytimg.com/vi/')),
    withoutPoster.map((f) => f.id).join(', '),
  );
  check('a film with a note, and one without', filmography.films.some((f) => f.note !== undefined) && filmography.films.some((f) => f.note === undefined));
  check('more than one kind', new Set(filmography.films.map((f) => f.kind)).size >= 2);

  // Reordering is read, permute, write back. Nothing else.
  const reversed = def.withEntries(filmography, [...def.entries(filmography)].reverse());
  const revalidated = def.validateFile(reversed);
  check(
    'reorder is a permutation that still validates',
    revalidated.ok && isFilmography(revalidated.data) &&
      revalidated.data.films[0]?.id === filmography.films[filmography.films.length - 1]?.id,
  );

  const rows = def.summarise(filmography);
  check(
    'summarise: one row per film, keyed by id',
    rows.length === filmography.films.length &&
      rows.every((row, i) => row.key === filmography.films[i]?.id && row.title !== '' && row.subtitle !== '' && row.thumb !== null),
    rows.map((r) => r.subtitle).join(' | '),
  );
  check('empty() is an empty collection', def.validateFile(def.empty()).ok && def.entries(def.empty()).length === 0);
  check('newFilm() is invalid until it has a video', validateFilm(newFilm()).ok === false);
  check('newFilm() with a video validates', validateFilm(newFilm({ youtubeId: 'EudrajWcwwg' })).ok);
}

/* -------------------------------------------------------------------------- */

console.log('\nphotography.json');

const photographyResult = validatePhotographyJson(fixtureText('photography.json'));

if (!photographyResult.ok) {
  failures += 1;
  console.log('    FAIL  validatePhotography');
  console.log(formatIssues(photographyResult.issues).split('\n').map((l) => `          ${l}`).join('\n'));
} else {
  const photography = photographyResult.data;
  const photoSection = requireSection('photography');
  const def = photoSection.records as RecordsDef;

  const photos = photography.albums.flatMap((a) => a.photos);
  check('validatePhotography', true, `${photography.albums.length} albums, ${photos.length} photos`);
  check('the registry validates the same file', def.validateFile(photography).ok);
  check('exactly two albums', photography.albums.length === 2);
  check('unique album ids', new Set(photography.albums.map((a) => a.id)).size === photography.albums.length);
  check('unique album slugs', new Set(photography.albums.map((a) => a.slug)).size === photography.albums.length);
  check('unique photo ids across the file', new Set(photos.map((p) => p.id)).size === photos.length);

  for (const photo of photos) check(`photo src exists: ${photo.src}`, srcExists(photo.src));

  // One album with six photos and a chosen cover that is NOT the first photo,
  // so "chosen" and "fallback" are different code paths in the corpus.
  const chosen = photography.albums.find((a) => a.cover !== undefined);
  check('an album with six photos', chosen !== undefined && chosen.photos.length === 6, chosen === undefined ? 'none' : `${chosen.slug}, ${chosen.photos.length}`);
  if (chosen !== undefined) {
    const cover = albumCoverPhoto(chosen);
    check('its cover is the chosen photo', cover !== null && cover.id === chosen.cover, `${cover?.id}`);
    check('its cover is not the first photo', chosen.cover !== chosen.photos[0]?.id);
    check('albumCoverSrc agrees', albumCoverSrc(chosen) === cover?.src);
    check('a summary', chosen.summary !== undefined && chosen.summary !== '');
  }

  // One album with a single photo and no cover, so the fallback is exercised.
  const fallback = photography.albums.find((a) => a.cover === undefined);
  check('an album with one photo and no cover', fallback !== undefined && fallback.photos.length === 1, fallback === undefined ? 'none' : fallback.slug);
  if (fallback !== undefined) {
    const cover = albumCoverPhoto(fallback);
    check('its cover falls back to the first photo', cover !== null && cover.id === fallback.photos[0]?.id, `${cover?.id}`);
  }

  // Optional fields have to be optional in the corpus too.
  check('a photo with intrinsic dimensions', photos.some((p) => p.w !== undefined && p.h !== undefined));
  check('a photo with none', photos.some((p) => p.w === undefined && p.h === undefined));
  check('a photo with no alt', photos.some((p) => p.alt === undefined));
  check('a photo with a caption, and one without', photos.some((p) => p.caption !== undefined) && photos.some((p) => p.caption === undefined));

  const rows = def.summarise(photography);
  check(
    'summarise: one row per album, keyed by slug',
    rows.length === photography.albums.length &&
      rows.every((row, i) => row.key === photography.albums[i]?.slug && row.thumb !== null),
    rows.map((r) => r.subtitle).join(' | '),
  );
  check(
    'every album slug resolves to a page',
    photography.albums.every((a) => siteUrlFor(photoSection, a.slug) === `/photography/${a.slug}/`),
  );
  const reversed = def.withEntries(photography, [...def.entries(photography)].reverse());
  check('reorder still validates', def.validateFile(reversed).ok);
  check('empty() is an empty collection', def.validateFile(def.empty()).ok);
  check('newAlbum() validates as it stands', validateAlbum(newAlbum()).ok);
  check('newAlbum() derives a slug from the title', newAlbum({ title: 'Ocean Beach, 2024' }).slug === 'ocean-beach-2024');
  check('slugify survives a title with nothing slugifiable', slugify('최진혁') === '');
}

/* -------------------------------------------------------------------------- */

console.log('\nsection-aware documents');

/* Backward compatibility. Three phase 1 files reach into
   DocMetaSchema.shape.slug, which only works while DocMeta stays a plain
   ZodObject — so the `section` cross-check lives on DocSchema, not on the meta
   schema. And a document written before `section` existed must still validate. */
check(
  'DocMetaSchema.shape.slug is still reachable',
  DocMetaSchema.shape.slug.safeParse('a-slug').success &&
    !DocMetaSchema.shape.slug.safeParse('Not A Slug').success,
);
check(
  'a phase 1 document with no section still validates',
  validateDoc({ version: 1, meta: { title: 'a', slug: 'a', date: '2026-01-01' }, bands: [] }).ok,
);

const essay = docs.get('essay.json');
const home = docs.get('home.json');

if (essay !== undefined) {
  check('essay: section is essays', essay.meta.section === 'essays');
  check('essay: has buttons', (essay.meta.buttons ?? []).length >= 1, (essay.meta.buttons ?? []).map((b) => b.href).join(' '));
  check('essay: a mailto button survives validation', (essay.meta.buttons ?? []).some((b) => b.href.startsWith('mailto:')));
  check('essay: has a canvas band, per decision 3.1', essay.bands.some(isCanvasBand));
  check('essay: has a quote (the TL;DR)', essay.bands.filter(isProseBand).flatMap((b) => b.blocks).some((b) => b.kind === 'quote'));
}

if (home !== undefined) {
  check('home: section is home', home.meta.section === 'home');
  check('home: the hero is a canvas item', home.bands.filter(isCanvasBand).flatMap((b) => b.items).some((i) => i.src === '/home/hero.webp'));
  check('home: three intro paragraphs', home.bands.filter(isProseBand).flatMap((b) => b.blocks).filter((b) => b.kind === 'p').length === 3);
  check(
    'home: the film titles keep their italics',
    JSON.stringify(home).includes('"type":"italic"'),
  );
  check('home: no buttons', home.meta.buttons === undefined);
}

/* -------------------------------------------------------------------------- */

console.log('\nphase 2 negative controls');

const docNegatives: [string, unknown][] = [
  [
    'a Doc in a record section',
    { version: 1, meta: { title: 'a', slug: 'a', date: '2026-01-01', section: 'filmography' }, bands: [] },
  ],
  [
    'a Doc in a section that does not exist',
    { version: 1, meta: { title: 'a', slug: 'a', date: '2026-01-01', section: 'blog' }, bands: [] },
  ],
  [
    'a button with no label',
    { version: 1, meta: { title: 'a', slug: 'a', date: '2026-01-01', buttons: [{ label: '', href: '/x' }] }, bands: [] },
  ],
  [
    'a button with a javascript: href',
    { version: 1, meta: { title: 'a', slug: 'a', date: '2026-01-01', buttons: [{ label: 'x', href: 'javascript:alert(1)' }] }, bands: [] },
  ],
  [
    'a button with an unknown key',
    { version: 1, meta: { title: 'a', slug: 'a', date: '2026-01-01', buttons: [{ label: 'x', href: '/x', target: '_blank' }] }, bands: [] },
  ],
];

for (const [label, value] of docNegatives) check(`rejects: ${label}`, validateDoc(value).ok === false);

check('accepts: a mailto button', validateDoc({ version: 1, meta: { title: 'a', slug: 'a', date: '2026-01-01', section: 'essays', buttons: [{ label: 'Coffee on me', href: 'mailto:a@b.com' }] }, bands: [] }).ok);

const filmNegatives: [string, unknown][] = [
  ['not an object', 42],
  ['no films key', {}],
  ['an unknown key', { films: [], note: 'hi' }],
  ['films not an array', { films: {} }],
  [
    'a youtubeId that is a URL',
    { films: [{ id: 'f1', youtubeId: 'https://youtu.be/EudrajWcwwg', title: 'a', kind: 'SHORT FILM', year: '2019' }] },
  ],
  [
    'a youtubeId of the wrong length',
    { films: [{ id: 'f1', youtubeId: 'short', title: 'a', kind: 'SHORT FILM', year: '2019' }] },
  ],
  [
    'an empty title',
    { films: [{ id: 'f1', youtubeId: 'EudrajWcwwg', title: '', kind: 'SHORT FILM', year: '2019' }] },
  ],
  [
    'a year that is not a year',
    { films: [{ id: 'f1', youtubeId: 'EudrajWcwwg', title: 'a', kind: 'SHORT FILM', year: 'nineteen' }] },
  ],
  [
    'a relative poster path',
    { films: [{ id: 'f1', youtubeId: 'EudrajWcwwg', title: 'a', kind: 'SHORT FILM', year: '2019', poster: 'poster.jpg' }] },
  ],
  [
    'two films with the same id',
    {
      films: [
        { id: 'f1', youtubeId: 'EudrajWcwwg', title: 'a', kind: 'SHORT FILM', year: '2019' },
        { id: 'f1', youtubeId: '6SUlwRLFuCc', title: 'b', kind: 'TRAILER', year: '2019' },
      ],
    },
  ],
];

for (const [label, value] of filmNegatives) check(`rejects film: ${label}`, validateFilmography(value).ok === false);
check('accepts: a year range', validateFilmography({ films: [{ id: 'f1', youtubeId: 'EudrajWcwwg', title: 'a', kind: 'SHORT FILM', year: '2018-2019' }] }).ok);

const albumNegatives: [string, unknown][] = [
  ['no albums key', {}],
  ['an unknown key', { albums: [], cover: 'x' }],
  [
    'a cover that is not one of its photos',
    { albums: [{ id: 'a1', slug: 'a', title: 'A', year: '2026', cover: 'ph_gone', photos: [{ id: 'ph_1', src: '/a.png' }] }] },
  ],
  [
    'two photos with the same id',
    { albums: [{ id: 'a1', slug: 'a', title: 'A', year: '2026', photos: [{ id: 'ph_1', src: '/a.png' }, { id: 'ph_1', src: '/b.png' }] }] },
  ],
  [
    'two albums on the same slug',
    {
      albums: [
        { id: 'a1', slug: 'same', title: 'A', year: '2026', photos: [] },
        { id: 'a2', slug: 'same', title: 'B', year: '2026', photos: [] },
      ],
    },
  ],
  [
    'a slug that is not kebab-case',
    { albums: [{ id: 'a1', slug: 'Not A Slug', title: 'A', year: '2026', photos: [] }] },
  ],
  [
    'a photo width with no height',
    { albums: [{ id: 'a1', slug: 'a', title: 'A', year: '2026', photos: [{ id: 'ph_1', src: '/a.png', w: 1200 }] }] },
  ],
  [
    'a fractional photo width',
    { albums: [{ id: 'a1', slug: 'a', title: 'A', year: '2026', photos: [{ id: 'ph_1', src: '/a.png', w: 1200.5, h: 918 }] }] },
  ],
  [
    'an unknown key on a photo',
    { albums: [{ id: 'a1', slug: 'a', title: 'A', year: '2026', photos: [{ id: 'ph_1', src: '/a.png', credit: 'me' }] }] },
  ],
];

for (const [label, value] of albumNegatives) check(`rejects album: ${label}`, validatePhotography(value).ok === false);
check('accepts: an album with no photos yet', validatePhotography({ albums: [{ id: 'a1', slug: 'a', title: 'A', year: '2026', photos: [] }] }).ok);
check('rejects: invalid JSON text', validateFilmographyJson('{nope').ok === false && validatePhotographyJson('{nope').ok === false);

/* youtubeIdFromInput has to reject as well as extract. */
check('youtubeIdFromInput rejects a non-YouTube URL', youtubeIdFromInput('https://vimeo.com/123456') === null);
check('youtubeIdFromInput rejects empty input', youtubeIdFromInput('   ') === null);
check('youtubeIdFromInput rejects a watch URL with no v', youtubeIdFromInput('https://www.youtube.com/watch?t=3') === null);
check('youtubeIdFromInput takes a /shorts/ URL', youtubeIdFromInput('https://youtube.com/shorts/EudrajWcwwg') === 'EudrajWcwwg');
check('youtubeIdFromInput takes an m. URL', youtubeIdFromInput('https://m.youtube.com/watch?v=EudrajWcwwg') === 'EudrajWcwwg');

console.log('');
if (failures === 0) {
  console.log('PASS  every fixture validates and every guarantee holds');
  process.exit(0);
}
console.log(`FAIL  ${failures} check(s) failed`);
process.exit(1);
