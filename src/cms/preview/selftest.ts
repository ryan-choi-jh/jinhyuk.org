/**
 * src/cms/preview/selftest.ts
 *
 * WS-7's logic tests. No browser, no server, no network, no GitHub:
 *
 *   node src/cms/preview/selftest.ts
 *
 * Everything in the preview that can be wrong without being visible lives in
 * state.ts and diff.ts, and this is where that is pinned down: which document
 * a URL resolves to, what the toolbar says differs, and that the breakpoint
 * and the reference width still come from WS-0 rather than from a number
 * somebody typed in here.
 *
 * The browser half -- the frame, the three widths, the 3.4 fallback -- is
 * verify.ts, which needs Chrome. This file runs anywhere.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  MOBILE_BREAKPOINT,
  REFERENCE_WIDTH,
  formatIssues,
  validateDoc,
  validateDocJson,
  validateFilmographyJson,
  validatePhotographyJson,
} from '../schema.ts';
import type { Album, Doc, Filmography, Photography } from '../schema.ts';
import {
  albumLightboxId,
  ledgerItemsFromMetas,
  renderAlbumPage,
  renderDoc,
  renderFilmography,
  renderLedgerPage,
  renderPhotography,
} from '../render/index.ts';
import { SECTIONS, getSection, isRecordSection, requireSection } from '../sections.ts';
import {
  bandLabel,
  diffAlbums,
  diffDocs,
  diffLedger,
  diffRecords,
  outlineOf,
  outlineOfAlbum,
  outlineOfRecords,
  plainText,
} from './diff.ts';
import { rewriteMediaForBranch } from './source.ts';
import {
  entrySelectorOf,
  ledgerSectionOf,
  parseFailureMessage,
  parseTargetPath,
  targetPath,
} from './target.ts';
import type { PreviewSurface } from './target.ts';
import {
  DEFAULT_WIDTH,
  MOBILE_BREAKPOINT_PX,
  PREVIEW_BASE,
  PREVIEW_WIDTHS,
  frameHref,
  isMobileWidth,
  legacyFramePath,
  loginHref,
  parseTheme,
  parseVersion,
  parseWidth,
  previewHref,
  resolveVersion,
} from './state.ts';

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (ok) {
    console.log(`    ok    ${label}${detail === '' ? '' : ` (${detail})`}`);
  } else {
    failures += 1;
    console.log(`    FAIL  ${label}${detail === '' ? '' : ` (${detail})`}`);
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, a === b ? '' : `got ${a}, want ${b}`);
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function fixture(name: string): Doc {
  const path = fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url));
  const result = validateDocJson(readFileSync(path, 'utf8'));
  if (!result.ok) throw new Error(`fixture ${name} does not validate:\n${formatIssues(result.issues)}`);
  return result.doc;
}

function clone(doc: Doc): Doc {
  return JSON.parse(JSON.stringify(doc)) as Doc;
}

/**
 * Every document the diff is tested against is a document the CMS would
 * accept. A diff that is only correct for shapes the schema rejects is not
 * worth having.
 */
function valid(label: string, doc: Doc): Doc {
  const result = validateDoc(doc);
  check(`${label} is a valid document`, result.ok, result.ok ? '' : formatIssues(result.issues));
  return doc;
}

console.log('WS-7 + WS-H preview selftest');

/* -------------------------------------------------------------------------- */
section('contract constants come from WS-0, not from here');
/* -------------------------------------------------------------------------- */

eq('MOBILE_BREAKPOINT_PX matches the schema', MOBILE_BREAKPOINT_PX, MOBILE_BREAKPOINT);
eq('the three presets are the three in the brief', [...PREVIEW_WIDTHS], [1440, 1100, 390]);
eq('the default is the designed page', DEFAULT_WIDTH, 1440);
check(
  '1440 leaves the reference width after global.css gutters',
  1440 - 2 * 48 === REFERENCE_WIDTH,
  `1440 - 96 = ${1440 - 96}, REFERENCE_WIDTH = ${REFERENCE_WIDTH}`,
);
eq('only 390 is below the breakpoint', PREVIEW_WIDTHS.map(isMobileWidth), [false, false, true]);

/* -------------------------------------------------------------------------- */
section('query parameters');
/* -------------------------------------------------------------------------- */

eq('w=1100 parses', parseWidth('1100'), 1100);
eq('w=390 parses', parseWidth('390'), 390);
eq('w=800 is not a preset and falls back', parseWidth('800'), 1440);
eq('a missing w falls back', parseWidth(null), 1440);
eq('nonsense w falls back', parseWidth('../../etc/passwd'), 1440);
eq('v=draft parses', parseVersion('draft'), 'draft');
eq('v=published parses', parseVersion('published'), 'published');
eq('v=live is not a version', parseVersion('live'), null);
eq('theme=dark parses', parseTheme('dark'), 'dark');
eq('theme=sepia is not a theme', parseTheme('sepia'), null);

/* -------------------------------------------------------------------------- */
section('which version a URL shows');
/* -------------------------------------------------------------------------- */

const both = { draft: true, published: true };
const draftOnly = { draft: true, published: false };
const publishedOnly = { draft: false, published: true };
const neither = { draft: false, published: false };

eq('no preference prefers the draft', resolveVersion(null, both), { version: 'draft', substituted: false });
eq('no preference with no draft', resolveVersion(null, publishedOnly), {
  version: 'published',
  substituted: false,
});
eq('no preference, nothing there', resolveVersion(null, neither), { version: null, substituted: false });
eq('asked for published, got published', resolveVersion('published', both), {
  version: 'published',
  substituted: false,
});
eq('asked for a draft that was just published', resolveVersion('draft', publishedOnly), {
  version: 'published',
  substituted: true,
});
eq('asked for a published page that does not exist yet', resolveVersion('published', draftOnly), {
  version: 'draft',
  substituted: true,
});
eq('asked for anything, nothing there', resolveVersion('draft', neither), {
  version: null,
  substituted: false,
});

/* -------------------------------------------------------------------------- */
section('links');
/* -------------------------------------------------------------------------- */

eq('bare preview link', previewHref('habit-tracker'), '/cms/preview/habit-tracker');
eq(
  'the default width is left out of the URL',
  previewHref('habit-tracker', { version: 'draft', width: 1440 }),
  '/cms/preview/habit-tracker?v=draft',
);
eq(
  'a non-default width is in the URL',
  previewHref('habit-tracker', { version: 'published', width: 390, theme: 'dark' }),
  '/cms/preview/habit-tracker?v=published&w=390&theme=dark',
);
eq(
  'the frame link carries no width, and the marker is in front of the path',
  frameHref('habit-tracker', { version: 'draft', width: 390 }),
  '/cms/preview/frame/habit-tracker?v=draft',
);
eq(
  'a sectioned path keeps its separating slash',
  frameHref('essays/chasing-the-workaround', { version: 'draft' }),
  '/cms/preview/frame/essays/chasing-the-workaround?v=draft',
);
eq('the base is under /cms', PREVIEW_BASE, '/cms/preview');
eq(
  'a path is escaped segment by segment, and .. cannot act as a path operator',
  previewHref('essays/../../api/cms/draft/x'),
  '/cms/preview/essays/%2E%2E/%2E%2E/api/cms/draft/x',
);
eq(
  'one segment with a slash in it stays one segment',
  previewHref('../../api/cms/draft/x'.replace(/\//g, '-')),
  '/cms/preview/..-..-api-cms-draft-x',
);
eq('an empty segment is dropped rather than doubling the slash', previewHref('home//'), '/cms/preview/home');
eq(
  'login comes back to where it started',
  loginHref('/cms/preview/a?v=draft&w=390'),
  '/api/cms/auth/login?return=%2Fcms%2Fpreview%2Fa%3Fv%3Ddraft%26w%3D390',
);

/* -------------------------------------------------------------------------- */
section('labels');
/* -------------------------------------------------------------------------- */

const simple = fixture('simple');
const canvas = fixture('canvas');
const dense = fixture('dense');

check('a prose band is labelled with its own first words', bandLabel(simple.bands[0]!).length > 10, bandLabel(simple.bands[0]!));
eq('a canvas band is labelled by what is in it', bandLabel(canvas.bands[1]!), 'squiggle, 2 images');
check(
  'an overlay band says so',
  bandLabel(dense.bands[1]!).startsWith('overlay, '),
  bandLabel(dense.bands[1]!),
);
eq('plainText walks a block\'s content array', plainText(simple.bands[0]!.type === 'prose' ? simple.bands[0]!.blocks[0]!.content : []).slice(0, 9), 'I started');
eq('plainText walks nested TipTap JSON', plainText([{ type: 'paragraph', content: [{ type: 'text', text: 'Hello there' }] }]), 'Hello there');
eq('plainText survives rubbish', plainText({ nope: true }), '');
eq('plainText truncates', plainText([{ type: 'text', text: 'x'.repeat(200) }], 10).length, 10);

/* -------------------------------------------------------------------------- */
section('the draft/published diff');
/* -------------------------------------------------------------------------- */

eq('nothing on either side is not "no changes"', diffDocs(null, null).comparable, false);
check('draft only says so', diffDocs(simple, null).summary.includes('never been published'), diffDocs(simple, null).summary);
check(
  'published only says so',
  diffDocs(null, simple).summary.includes('no draft'),
  diffDocs(null, simple).summary,
);

const identical = diffDocs(clone(dense), clone(dense));
check('identical documents', identical.identical && identical.counts.changed === 0, identical.summary);
eq('identical documents list every band as same', identical.counts.same, dense.bands.length);

// An edit inside one band. ProseBlock.content is the node's `content` ARRAY
// (schema 3.2), not the node, which is the mistake worth having a test about.
const edited = clone(dense);
(edited.bands[0] as { blocks: { content: unknown[] }[] }).blocks[0]!.content = [
  { type: 'text', text: 'Rewritten.' },
];
valid('an edited draft', edited);
const editedDiff = diffDocs(edited, dense);
eq('one edited band', editedDiff.counts, { added: 0, removed: 0, changed: 1, moved: 0, same: 5 });
check('the summary names it', editedDiff.summary.includes('1 band edited'), editedDiff.summary);
eq('the edited band is the one that changed', editedDiff.bands.find((b) => b.status === 'changed')?.id, dense.bands[0]!.id);

// A band added in the draft, and one removed from it.
const added = clone(dense);
added.bands.push({
  id: 'b_new_band',
  type: 'prose',
  blocks: [{ id: 'blk_new', kind: 'p', content: [{ type: 'text', text: 'New.' }] }],
});
valid('a draft with a band added', added);
const addedDiff = diffDocs(added, dense);
eq('one added band', addedDiff.counts.added, 1);
eq('the added band is last, in draft order', addedDiff.bands[addedDiff.bands.length - 1]?.id, 'b_new_band');

const removedDiff = diffDocs(dense, added);
eq('the same pair the other way round is a removal', removedDiff.counts.removed, 1);
eq(
  'a removed band is still listed',
  removedDiff.bands.find((b) => b.status === 'removed')?.id,
  'b_new_band',
);

// A reorder with no content change.
const moved = clone(dense);
const last = moved.bands.pop()!;
moved.bands.splice(2, 0, last);
valid('a reordered draft', moved);
const movedDiff = diffDocs(moved, dense);
check('a reorder is reported as moved, not edited', movedDiff.counts.changed === 0, JSON.stringify(movedDiff.counts));
// Dragging one band past three others must not be reported as four moves.
eq('one drag is one move', movedDiff.counts.moved, 1);
eq('and it names the band that was dragged', movedDiff.bands.find((b) => b.status === 'moved')?.id, last.id);

// Metadata only.
const retitled = clone(simple);
retitled.meta.title = 'A new title';
valid('a retitled draft', retitled);
const retitledDiff = diffDocs(retitled, simple);
eq('a changed title is not a changed band', retitledDiff.counts.changed, 0);
eq('a changed title is a meta change', retitledDiff.meta.map((m) => m.field), ['title']);
check('the summary mentions it', retitledDiff.summary.includes('title'), retitledDiff.summary);
check('and it is not called identical', !retitledDiff.identical);

eq('the outline of one document lists its bands', outlineOf(dense).length, dense.bands.length);
eq('the outline of nothing is empty', outlineOf(null).length, 0);

/* -------------------------------------------------------------------------- */
section('media on a branch');
/* -------------------------------------------------------------------------- */

const raw = 'https://raw.githubusercontent.com/ryan-choi-jh/jinhyuk.org/main/public/media/';
eq(
  'an uploaded image is pointed at the branch',
  rewriteMediaForBranch('<img src="/media/a/b.png" alt="x" />', 'main'),
  `<img src="${raw}a/b.png" alt="x" />`,
);
eq(
  'a video poster too',
  rewriteMediaForBranch('<video src="/media/a/c.mp4" poster="/media/a/c.jpg">', 'main'),
  `<video src="${raw}a/c.mp4" poster="${raw}a/c.jpg">`,
);
eq(
  'text that mentions /media/ is left alone',
  rewriteMediaForBranch('<p>look in /media/ for it</p>', 'main'),
  '<p>look in /media/ for it</p>',
);
eq(
  'an href is left alone, because the renderer never points one at media',
  rewriteMediaForBranch('<a href="/media/a/b.png">x</a>', 'main'),
  '<a href="/media/a/b.png">x</a>',
);
eq(
  'an external embed is left alone',
  rewriteMediaForBranch('<iframe src="https://player.vimeo.com/video/1"></iframe>', 'main'),
  '<iframe src="https://player.vimeo.com/video/1"></iframe>',
);
eq(
  'site media that is not CMS media is left alone',
  rewriteMediaForBranch('<img src="/projects/x/y.png" />', 'main'),
  '<img src="/projects/x/y.png" />',
);

/* -------------------------------------------------------------------------- */
section('what the frame route assumes about renderDoc');
/* -------------------------------------------------------------------------- */

for (const [name, doc] of [['simple', simple], ['canvas', canvas], ['dense', dense]] as const) {
  const html = renderDoc(doc);
  check(`${name}: renderDoc returns one .doc element`, html.startsWith('<div class="doc"') && html.endsWith('</div>'));
  check(`${name}: it carries the slug`, html.includes(`data-doc-slug="${doc.meta.slug}"`));
  // frame.astro drops this straight into the layout's slot with set:html, so
  // every band id the change panel can scroll to has to be in the markup.
  for (const band of doc.bands) {
    check(`${name}: band ${band.id} is addressable`, html.includes(`data-band-id="${band.id}"`));
  }
}

/* -------------------------------------------------------------------------- */
section('WS-H: every section resolves to a surface');
/* -------------------------------------------------------------------------- */

/**
 * The table below is the whole of the new addressing scheme, stated once as
 * data so a reader can see the five sections and six surfaces at a glance
 * rather than inferring them from six assertions.
 */
const TARGETS: readonly [string, string, string | null, PreviewSurface][] = [
  // path                      section        key              surface
  ['home', 'home', null, 'document'],
  ['essays', 'essays', null, 'ledger'],
  ['essays/my-essay', 'essays', 'my-essay', 'document'],
  ['projects', 'projects', null, 'ledger'],
  ['projects/habit-tracker', 'projects', 'habit-tracker', 'document'],
  ['filmography', 'filmography', null, 'films'],
  ['photography', 'photography', null, 'albums'],
  ['photography/first-build', 'photography', 'first-build', 'album'],
];

for (const [path, sectionId, key, surface] of TARGETS) {
  const parsed = parseTargetPath(path);
  check(`${path} resolves`, parsed.ok, parsed.ok ? '' : parsed.reason);
  if (!parsed.ok) continue;
  eq(`${path} is in section ${sectionId}`, parsed.target.section.id, sectionId);
  eq(`${path} has key ${JSON.stringify(key)}`, parsed.target.key, key);
  eq(`${path} is the ${surface} surface`, parsed.target.surface, surface);
  eq(`${path} round-trips through targetPath`, targetPath(parsed.target), path);
  check(`${path} has an entry selector`, entrySelectorOf(parsed.target).length > 0, entrySelectorOf(parsed.target));
}

eq('every section is reachable', TARGETS.filter(([, , key]) => key === null).length, SECTIONS.length);

/* Phase 1's bare slug, which is the one ambiguity the scheme has to resolve. */
const legacyParsed = parseTargetPath('track-daily-habit-tracker');
check('a bare slug still resolves', legacyParsed.ok);
if (legacyParsed.ok) {
  eq('to a project', legacyParsed.target.section.id, 'projects');
  eq('with that slug as its key', legacyParsed.target.key, 'track-daily-habit-tracker');
  eq('as a document', legacyParsed.target.surface, 'document');
  check('and is marked legacy', legacyParsed.target.legacy === true);
  eq(
    'its canonical path is the sectioned one',
    targetPath(legacyParsed.target),
    'projects/track-daily-habit-tracker',
  );
}

/* The refusals. Each one is a reason, not a default. */
const refusals: readonly [string, string][] = [
  ['', 'empty'],
  ['home/anything', 'no_entry_page'],
  ['filmography/film_untitled', 'no_entry_page'],
  ['nope/nope', 'unknown_section'],
  ['essays/a/b', 'too_deep'],
  ['essays/not a key', 'bad_key'],
  // A traversal is refused twice over: `..` is not an id, and a third segment
  // is one more than an address can have.
  ['essays/..', 'bad_key'],
  ['essays/../secret', 'too_deep'],
  ['essays/%2E%2E', 'bad_key'],
];
for (const [path, reason] of refusals) {
  const result = parseTargetPath(path);
  eq(`${JSON.stringify(path)} is refused as ${reason}`, result.ok ? 'ok' : result.reason, reason);
  if (!result.ok) {
    check(`${JSON.stringify(path)} explains itself`, parseFailureMessage(result.reason).length > 20);
  }
}

/**
 * The one hand-narrowed cast in target.ts. `LedgerSectionId` is WS-B's
 * 'essays' | 'projects' and `DocumentSectionId` is those plus 'home', so the
 * compiler cannot see that "a document section that is a collection" is
 * exactly the ledger set. If a fourth document section is ever added, this
 * fails here instead of mis-rendering an index page.
 */
for (const section of SECTIONS) {
  if (isRecordSection(section)) {
    eq(`${section.id} is a record section, so it has no ledger`, section.records.key !== undefined, true);
    continue;
  }
  const ledger = ledgerSectionOf(section);
  if (section.shape === 'collection') {
    check(`${section.id} has a ledger style`, ledger === 'essays' || ledger === 'projects', String(ledger));
  } else {
    eq(`${section.id} is a singleton and has none`, ledger, null);
  }
}

/* -------------------------------------------------------------------------- */
section('WS-H: phase 1 URLs still mean what they meant');
/* -------------------------------------------------------------------------- */

const isSection = (id: string): boolean => getSection(id) !== null;

eq(
  'the phase 1 frame URL is recognised',
  legacyFramePath(['habit-tracker', 'frame'], isSection),
  'habit-tracker',
);
eq(
  'but NOT when the first segment is a section, so an entry keyed "frame" is reachable',
  legacyFramePath(['essays', 'frame'], isSection),
  null,
);
eq('nor for anything else', legacyFramePath(['essays', 'my-essay'], isSection), null);
eq('nor for one segment', legacyFramePath(['frame'], isSection), null);
check(
  'and that entry really is reachable at its canonical address',
  parseTargetPath('essays/frame').ok,
);
eq(
  'whose frame URL is unambiguous',
  frameHref('essays/frame'),
  '/cms/preview/frame/essays/frame',
);

/* -------------------------------------------------------------------------- */
section('WS-H: the change panel, for the four surfaces that are not documents');
/* -------------------------------------------------------------------------- */

function films(name: string): Filmography {
  const path = fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url));
  const result = validateFilmographyJson(readFileSync(path, 'utf8'));
  if (!result.ok) throw new Error(`fixture ${name}: ${formatIssues(result.issues)}`);
  return result.data;
}

function albums(name: string): Photography {
  const path = fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url));
  const result = validatePhotographyJson(readFileSync(path, 'utf8'));
  if (!result.ok) throw new Error(`fixture ${name}: ${formatIssues(result.issues)}`);
  return result.data;
}

const filmography = requireSection('filmography');
const photography = requireSection('photography');
if (!isRecordSection(filmography) || !isRecordSection(photography)) {
  throw new Error('the registry says filmography or photography is not a record section');
}

const filmsPublished = films('filmography');
const filmsDraft: Filmography = {
  films: [
    filmsPublished.films[1]!,
    { ...filmsPublished.films[0]!, note: 'Re-cut.' },
    filmsPublished.films[2]!,
    filmsPublished.films[3]!,
    { id: 'film_new', youtubeId: 'dQw4w9WgXcQ', title: 'New', kind: 'SHORT FILM', year: '2026' },
  ],
};

const filmDiff = diffRecords(filmsDraft, filmsPublished, filmography.records);
check('a film list diff is comparable', filmDiff.comparable);
eq('one film was added', filmDiff.counts.added, 1);
eq('one film was edited', filmDiff.counts.changed, 1);
eq('and the reorder is reported as one move, not four', filmDiff.counts.moved, 1);
eq('every film is a row', filmDiff.rows.length, 5);
check('the rows are keyed by the record id the API takes', filmDiff.rows.every((row) => row.id.startsWith('film')));
check('and labelled with the film kind and year', filmDiff.rows[0]!.label.includes('·'), filmDiff.rows[0]!.label);
check('the summary says what happened', filmDiff.summary.startsWith('Draft differs:'), filmDiff.summary);

eq(
  'an identical pair reports no change',
  diffRecords(filmsPublished, filmsPublished, filmography.records).identical,
  true,
);
check(
  'one side missing is "no draft", not "no change"',
  !diffRecords(null, filmsPublished, filmography.records).comparable,
);
eq(
  'and the outline of the side that is there is still a list',
  outlineOfRecords(filmsPublished, filmography.records).length,
  filmsPublished.films.length,
);

/* An album page: a row per photograph, and the album's own fields as meta. */
const photographyFile = albums('photography');
const firstBuild = photographyFile.albums.find((album) => album.slug === 'first-build');
if (firstBuild === undefined) throw new Error('the photography fixture lost first-build');

const reordered: Album = {
  ...firstBuild,
  title: 'First Build (draft)',
  cover: firstBuild.photos[0]!.id,
  photos: [firstBuild.photos[2]!, firstBuild.photos[0]!, firstBuild.photos[1]!, ...firstBuild.photos.slice(3)],
};

const albumDiff = diffAlbums(reordered, firstBuild);
check('an album diff is comparable', albumDiff.comparable);
eq('one photograph moved', albumDiff.counts.moved, 1);
eq('nothing was added or removed', albumDiff.counts.added + albumDiff.counts.removed, 0);
eq('every photograph is a row', albumDiff.rows.length, firstBuild.photos.length);
check(
  'the title and the cover are reported as details',
  albumDiff.meta.map((entry) => entry.field).includes('cover') &&
    albumDiff.meta.map((entry) => entry.field).includes('title'),
  albumDiff.meta.map((entry) => entry.field).join(', '),
);
check('the cover photograph is labelled as the cover', albumDiff.rows.some((row) => row.kind === 'cover'));
eq('and an album compared with itself is identical', diffAlbums(firstBuild, firstBuild).identical, true);
eq('its outline is one row per photograph', outlineOfAlbum(firstBuild).length, firstBuild.photos.length);

/* An index page: a row per entry, keyed by slug. */
const essayMeta = { title: 'Chasing the Workaround', slug: 'chasing', date: '2026-06-08' };
const laterMeta = { title: 'Later', slug: 'later', date: '2026-07-01' };
const ledgerDiff = diffLedger([laterMeta, essayMeta], [essayMeta], 'essay');
check('an index diff is comparable', ledgerDiff.comparable);
eq('the unpublished entry is added', ledgerDiff.counts.added, 1);
eq('the published one is unchanged', ledgerDiff.counts.same, 1);
eq('the newest row is first, as both live index pages sort', ledgerDiff.rows[0]!.id, 'later');
eq(
  'a body edit that does not change the row is not reported',
  diffLedger([essayMeta], [essayMeta], 'essay').identical,
  true,
);

/* -------------------------------------------------------------------------- */
section('WS-H: what the frame route assumes about the other four renderers');
/* -------------------------------------------------------------------------- */

/**
 * The frame drops each of these straight into the layout's slot, and the
 * chrome's change list scrolls to the Nth box of `entrySelectorOf(target)`.
 * So the one thing that has to hold is that the renderer emits exactly as
 * many of those elements as the diff produced rows for; a mismatch would
 * scroll to the wrong film and nothing would look broken.
 */
const countOf = (html: string, selector: string): number => {
  const className = selector.replace(/^\./, '').split(/[\s[]/)[0]!;
  return html.split(`class="${className}"`).length - 1 + html.split(`class="${className} `).length - 1;
};

const filmHtml = renderFilmography(filmsPublished.films);
eq(
  'renderFilmography emits one .video per film',
  countOf(filmHtml, '.video'),
  filmsPublished.films.length,
);

const albumIndexHtml = renderPhotography(photographyFile.albums);
eq(
  'renderPhotography emits one .card per album',
  countOf(albumIndexHtml, '.card'),
  photographyFile.albums.length,
);
check(
  'and reproduces the live empty state for an empty collection',
  renderPhotography([]).includes('empty-state'),
);

const albumPageHtml = renderAlbumPage(firstBuild);
eq(
  'renderAlbumPage emits one .album-photo per photograph',
  countOf(albumPageHtml, '.album-photo'),
  firstBuild.photos.length,
);
check(
  'the overlay is the LAST top-level element, so it is not inside the grid',
  albumPageHtml.lastIndexOf('class="lightbox album-lightbox"') > albumPageHtml.lastIndexOf('class="album-grid"'),
);
check('and it is addressable', albumPageHtml.includes(albumLightboxId(firstBuild)));

const ledgerHtml = renderLedgerPage(
  ledgerItemsFromMetas([essayMeta, laterMeta] as never, 'essays'),
  'essays',
);
eq('renderLedgerPage emits one row per item', countOf(ledgerHtml, '.ledger-body'), 2);
check('with a masthead above them', ledgerHtml.startsWith('<div class="masthead"'));

/* -------------------------------------------------------------------------- */

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
