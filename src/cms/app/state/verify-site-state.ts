/**
 * src/cms/app/state/verify-site-state.ts
 *
 * WS-D's proof for the navigation layer, with no browser and no network.
 *
 *   node src/cms/app/state/verify-site-state.ts
 *
 * It drives the real routing, the real site store, the real record store and
 * the real in-memory API over WS-A's real fixtures, and exits non-zero if any
 * guarantee the shell leans on is untrue. The browser half of the proof is
 * `../shell/site-harness/drive.mjs`, which does the same things through the
 * actual UI and screenshots every section.
 *
 * Nothing in here imports React, so it runs under bare `node` with type
 * stripping — deliberately not importing `./index.ts`, which re-exports the
 * React bindings.
 */

import { readFileSync } from 'node:fs';

import {
  formatIssues,
  isAlbum,
  isFilm,
  validateDocJson,
} from '../../schema.ts';
import type { Album, Doc, Film, RecordFile, SectionId } from '../../schema.ts';
import {
  SECTIONS,
  isRecordSection,
  requireSection,
} from '../../sections.ts';
import type { RecordSectionDef } from '../../sections.ts';
import { createRecordStore, recordEntryKey } from './record-store.ts';
import {
  CMS_ROOT,
  cmsRouteHref,
  createMemoryNavigator,
  entryRoute,
  parseCmsRoute,
  resolveRoute,
  sameRoute,
} from './route.ts';
import type { CmsRoute } from './route.ts';
import { copyTitle, createDocFor, duplicateDoc, uniqueSlug } from './entries.ts';
import { canDeleteEntry, documentApiFor, mediaSlugFor } from './site-api.ts';
import { createSiteStore } from './site-store.ts';
import { createStubSiteApi } from './site-stub-api.ts';
import type { StubSiteApi } from './site-stub-api.ts';

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (ok) {
    console.log(`    ok    ${label}${detail ? ` (${detail})` : ''}`);
  } else {
    failures += 1;
    console.log(`    FAIL  ${label}${detail ? ` (${detail})` : ''}`);
  }
}

function section(name: string): void {
  console.log(`\n  ${name}`);
}

function fixtureText(name: string): string {
  return readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');
}

function loadDoc(name: string): Doc {
  const result = validateDocJson(fixtureText(name));
  if (!result.ok) throw new Error(`fixture ${name} is invalid:\n${formatIssues(result.issues)}`);
  return result.doc;
}

function loadRecords(id: SectionId, name: string): RecordFile {
  const def = requireSection(id);
  if (!isRecordSection(def)) throw new Error(`${id} is not a record section`);
  const result = def.records.validateFile(JSON.parse(fixtureText(name)));
  if (!result.ok) throw new Error(`fixture ${name} is invalid:\n${formatIssues(result.issues)}`);
  return result.data;
}

const home = loadDoc('home.json');
const essay = loadDoc('essay.json');
const dense = loadDoc('dense.json');
const canvas = loadDoc('canvas.json');
const filmography = loadRecords('filmography', 'filmography.json');
const photography = loadRecords('photography', 'photography.json');

const FILMS = requireSection('filmography') as RecordSectionDef;
const ALBUMS = requireSection('photography') as RecordSectionDef;

/** The world the harness boots: every section populated from WS-A's fixtures. */
function world(options: { canDeleteEntry?: boolean } = {}): StubSiteApi {
  return createStubSiteApi({
    ...(options.canDeleteEntry === undefined ? {} : { canDeleteEntry: options.canDeleteEntry }),
    docs: {
      home: { [home.meta.slug]: { published: home } },
      projects: {
        [dense.meta.slug]: { published: dense },
        [canvas.meta.slug]: { published: canvas },
      },
      essays: { [essay.meta.slug]: { published: essay } },
    },
    records: {
      filmography: { published: filmography },
      photography: { published: photography },
    },
  });
}

const sleep = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Let every queued promise in the store's async paths run out. */
const settle = async (times = 6): Promise<void> => {
  for (let i = 0; i < times; i += 1) await sleep(0);
};

/* ========================================================================== */
section('routing is derived from the registry, not from literals');

check('the editor root came out of the registry', CMS_ROOT === '/cms', CMS_ROOT);
check('the overview parses', parseCmsRoute(CMS_ROOT)?.kind === 'overview');
check('a trailing slash is the same place', parseCmsRoute(`${CMS_ROOT}/`)?.kind === 'overview');
check('a non-editor path is not a route', parseCmsRoute('/projects/x') === null);
check('an unknown section is not a route', parseCmsRoute(`${CMS_ROOT}/blog`) === null);

for (const def of SECTIONS) {
  const parsed = parseCmsRoute(def.cmsUrl);
  check(
    `${def.id}: its own cmsUrl parses back to it`,
    parsed !== null && parsed.kind === 'section' && parsed.section === def.id,
    def.cmsUrl,
  );
  check(`${def.id}: href round-trips`, cmsRouteHref({ kind: 'section', section: def.id }) === def.cmsUrl);

  if (def.cmsEntryUrl !== null) {
    const href = cmsRouteHref({ kind: 'entry', section: def.id, key: 'some-key' });
    const back = parseCmsRoute(href);
    check(
      `${def.id}: an entry URL round-trips`,
      back !== null && back.kind === 'entry' && back.section === def.id && back.key === 'some-key',
      href,
    );
  }
}

check(
  'a path-traversal key is not a route',
  parseCmsRoute(`${CMS_ROOT}/essays/..%2F..%2Fetc`) === null &&
    parseCmsRoute(`${CMS_ROOT}/essays/../../secrets`) === null,
);

{
  const singleton = resolveRoute({ kind: 'section', section: 'home' });
  check('home resolves straight into an editor', singleton.view === 'entry');
  check('home has no entry key', singleton.entryKey === null);
  const collection = resolveRoute({ kind: 'section', section: 'essays' });
  check('a collection resolves to its list', collection.view === 'list');
  const entry = resolveRoute({ kind: 'entry', section: 'essays', key: 'fixture-essay' });
  check('an entry resolves to an editor', entry.view === 'entry' && entry.entryKey === 'fixture-essay');
  const bogus = resolveRoute({ kind: 'section', section: 'blog' as SectionId });
  check('an unknown section falls back to the overview', bogus.view === 'overview');
  check(
    'entryRoute collapses a singleton',
    entryRoute(requireSection('home'), 'home').kind === 'section',
  );
  check('sameRoute compares by value', sameRoute({ kind: 'section', section: 'essays' }, { kind: 'section', section: 'essays' }));
  check(
    'sameRoute separates two entries',
    !sameRoute(
      { kind: 'entry', section: 'essays', key: 'a' },
      { kind: 'entry', section: 'essays', key: 'b' },
    ),
  );
}

/* ========================================================================== */
section('media paths come from the registry (9.3)');

check('home uploads with no slug', mediaSlugFor(requireSection('home'), null) === null);
check('an essay uploads under its slug', mediaSlugFor(requireSection('essays'), 'my-essay') === 'my-essay');
check(
  "a film uploads under its record id",
  mediaSlugFor(FILMS, 'film_getaway') === 'film_getaway',
);
check('an album uploads under its slug', mediaSlugFor(ALBUMS, 'first-build') === 'first-build');

/* ========================================================================== */
section('the document adapter turns one section into phase 1\'s CmsApi');

{
  const api = world();
  const projects = documentApiFor(api, requireSection('projects'));
  const pages = await projects.listPages();
  check('it lists only that section', pages.length === 2, pages.map((page) => page.slug).join(','));

  const page = await projects.getPage(dense.meta.slug);
  check('it reads a page by slug', page.published?.meta.slug === dense.meta.slug);

  const singleton = documentApiFor(api, requireSection('home'));
  const got = await singleton.getPage('home');
  check('the singleton reads with no slug on the wire', got.published?.meta.section === 'home');
  const homeCall = api.calls.filter((call) => call.method === 'getEntry').at(-1);
  check('and the call really carried null', homeCall?.slug === null, String(homeCall?.slug));

  let threw = false;
  try {
    documentApiFor(api, FILMS);
  } catch {
    threw = true;
  }
  check('a record section has no document API', threw);
}

/* ========================================================================== */
section('the record store: one file, undo, dirty');

{
  const api = world();
  const store = createRecordStore({ api, section: FILMS, file: filmography, published: filmography });
  const before = store.getState();
  check('it summarises through the section', before.summaries.length === 4, `${before.summaries.length}`);
  check('clean on boot', before.dirty === false && before.canUndo === false);
  check(
    'a film row is labelled from the registry',
    before.summaries[0]?.subtitle === 'SHORT FILM · 2019',
    before.summaries[0]?.subtitle,
  );
  check('a film\'s key is its record id', before.summaries[0]?.key === before.summaries[0]?.id);

  // Create.
  const created = store.createEntry();
  check('create appends one', store.getState().summaries.length === 5);
  check('create opens it', store.getState().openId === created);
  check('create dirties the collection', store.getState().dirty === true);
  check('a new film is invalid until it has a video', store.validate().ok === false);

  // Undo the create.
  store.undo();
  check('undo removes it again', store.getState().summaries.length === 4);
  check('undo returns to clean', store.getState().dirty === false);
  check('and the collection validates again', store.validate().ok === true);
  store.redo();
  check('redo puts it back', store.getState().summaries.length === 5);
  store.undo();

  // Patch.
  const first = store.getState().entries[0] as Film;
  store.patchEntry(first.id, { title: 'Untitled (recut)' });
  check('patch changes the entry', (store.getState().entries[0] as Film).title === 'Untitled (recut)');
  check('the list row follows the patch', store.getState().summaries[0]?.title === 'Untitled (recut)');
  check('patch dirties', store.getState().dirty === true);
  store.undo();
  check('undo restores the title', (store.getState().entries[0] as Film).title === 'Untitled');

  // Reorder.
  const order = () => store.getState().entries.map((entry) => entry.id).join(',');
  const originalOrder = order();
  store.moveEntry(first.id, 2);
  check('reorder permutes the array', order() !== originalOrder, order());
  check('reorder keeps every entry', store.getState().entries.length === 4);
  check('the reordered file still validates', store.validate().ok === true);
  store.undo();
  check('undo restores the order', order() === originalOrder);

  // Duplicate.
  const copyId = store.duplicateEntry(first.id);
  check('duplicate adds one', store.getState().entries.length === 5);
  const copy = store.entryById(copyId as string) as Film;
  check('the copy has a new id', copy.id !== first.id);
  check('the copy is titled as a copy', copy.title === copyTitle(first.title), copy.title);
  check('the copy sits next to its original', store.getState().entries[1]?.id === copy.id);
  check('a duplicated collection validates', store.validate().ok === true);
  store.undo();

  // Delete.
  store.select(first.id);
  store.deleteEntry(first.id);
  check('delete removes it', store.getState().entries.length === 3);
  check('deleting the open entry clears the selection', store.getState().openId === null);
  check('delete offers undo', store.getState().notice?.undoable === true);
  store.undo();
  check('undo brings it back', store.getState().entries.length === 4);

  // Save and publish.
  const saved = await store.save();
  check('save writes the whole file', saved === true);
  check('save leaves it clean', store.getState().dirty === false);
  check('one PUT, not one per record', api.calls.filter((call) => call.method === 'putRecords').length === 1);
  check('the server now has a draft', api.snapshot().records.filmography?.draft !== null);
  const published = await store.publish();
  check('publish copies the draft over', published === true);
  check('and deletes the draft', api.snapshot().records.filmography?.draft === null);
}

/* ========================================================================== */
section('the record store: the album rules (10.2)');

{
  const api = world();
  const store = createRecordStore({ api, section: ALBUMS, file: photography, published: photography });
  const album = store.getState().entries[0] as Album;
  check('the album fixture has a chosen cover', album.cover === 'ph_build_04');
  check(
    'an album row counts its photos',
    store.getState().summaries[0]?.subtitle === '2026 · 6 photos',
    store.getState().summaries[0]?.subtitle,
  );
  check('an album\'s key is its slug', store.getState().summaries[0]?.key === album.slug);

  // Deleting the cover photo has to clear `cover` in the same edit.
  store.patchEntry(album.id, { photos: album.photos.filter((photo) => photo.id !== album.cover) });
  const after = store.entryById(album.id) as Album;
  check('deleting the cover photo cleared cover', after.cover === undefined);
  check('and the result still validates', store.validate().ok === true);
  check('the row falls back to the first photo', store.getState().summaries[0]?.thumb === after.photos[0]?.src);
  store.undo();

  // A duplicate must not collide on slug, which PhotographySchema refuses.
  const copyId = store.duplicateEntry(album.id) as string;
  const copy = store.entryById(copyId) as Album;
  check('the copy got a free slug', copy.slug !== album.slug, copy.slug);
  const validity = store.validate();
  check('two albums, two slugs, still valid', validity.ok === true, formatIssues(validity.issues));

  // Two fresh albums in a row would both be `untitled-album` without the fix.
  store.undo();
  const a = store.createEntry() as string;
  const b = store.createEntry() as string;
  const slugs = [a, b].map((id) => (store.entryById(id) as Album).slug);
  check('two new albums get two slugs', slugs[0] !== slugs[1], slugs.join(' / '));
  const freshValidity = store.validate();
  check('and the collection still validates', freshValidity.ok === true, formatIssues(freshValidity.issues));
  check('a brand new album needs no photos to be valid', isAlbum(store.entryById(a) as Album));
}

/* ========================================================================== */
section('entry factories');

{
  const essays = requireSection('essays');
  const made = createDocFor(essays as never, { taken: ['new-essay'] });
  check('a new document avoids a taken slug', made.meta.slug === 'new-essay-2', made.meta.slug);
  check('it is stamped with its section', made.meta.section === 'essays');
  check('it opens on something typeable', made.bands.length === 1 && made.bands[0]?.type === 'prose');
  check('and it validates, because creating it is a PUT', validateDocJson(JSON.stringify(made)).ok);

  const copy = duplicateDoc(essay, { taken: [essay.meta.slug] });
  check('a copied document has a new slug', copy.meta.slug !== essay.meta.slug, copy.meta.slug);
  check('a copied document keeps its ids', JSON.stringify(copy.bands) === JSON.stringify(essay.bands));
  check('copy, copy 2, copy 3', copyTitle(copyTitle('A')) === 'A copy 2');
  check('a title that slugifies to nothing still gets a slug', uniqueSlug('。。。', [], 'essay') === 'essay');
}

/* ========================================================================== */
section('the site store: navigating every section');

{
  const api = world();
  const nav = createMemoryNavigator();
  const store = createSiteStore({ api, navigator: nav });
  const stop = store.start();
  await settle();

  check('it boots on the overview', store.getState().resolved.view === 'overview');
  check('the sidebar has every section before anything loads', store.getState().sections.length === SECTIONS.length);
  check('counts arrived from the API', store.getState().sections.find((s) => s.id === 'projects')?.count === 2);
  check('auth was asked once', api.calls.filter((call) => call.method === 'authStatus').length === 1);

  for (const def of SECTIONS) {
    store.openSection(def.id);
    await settle();
    const state = store.getState();
    check(
      `${def.id}: the route moved`,
      state.resolved.section?.id === def.id,
      state.resolved.section?.id ?? 'none',
    );
    if (def.shape === 'singleton') {
      check(`${def.id}: a singleton goes straight in`, state.editor?.kind === 'document');
      check(`${def.id}: with no entry key`, state.editor?.entryKey === null);
    } else {
      check(`${def.id}: a collection shows its list`, state.resolved.view === 'list');
      check(`${def.id}: the list has rows`, store.entriesOf(def.id).length > 0, `${store.entriesOf(def.id).length}`);
    }
  }

  // Open one entry in each collection and check the dispatch.
  const opened: [SectionId, string, 'document' | 'records'][] = [
    ['projects', dense.meta.slug, 'document'],
    ['essays', essay.meta.slug, 'document'],
    ['filmography', recordEntryKey(FILMS.records, FILMS.records.entries(filmography)[0] as Film), 'records'],
    ['photography', (ALBUMS.records.entries(photography)[0] as Album).slug, 'records'],
  ];
  for (const [id, key, kind] of opened) {
    store.openEntry(id, key);
    await settle();
    const editor = store.getState().editor;
    check(`${id}/${key}: the right editor is bound`, editor?.kind === kind, editor?.kind ?? 'none');
    check(`${id}/${key}: on the right entry`, editor?.entryKey === key, editor?.entryKey ?? 'none');
  }

  // The document store is reused per section and re-pointed.
  store.openEntry('projects', canvas.meta.slug);
  await settle();
  check('the document store followed the entry', store.docStore('projects')?.getState().slug === canvas.meta.slug);
  check('the record stores are still alive', store.recordStore('filmography') !== null);

  stop();
}

/* ========================================================================== */
section('the site store: the unsaved-changes guard');

{
  const api = world();
  const nav = createMemoryNavigator({ kind: 'entry', section: 'essays', key: essay.meta.slug });
  const store = createSiteStore({ api, navigator: nav });
  const stop = store.start();
  await settle();

  const doc = store.docStore('essays');
  check('the essay opened', doc !== null && store.getState().editor?.kind === 'document');
  doc?.updateMeta({ title: 'Edited but not saved' });
  check('the editor is dirty', store.isDirty() === true);

  let asked = 0;
  store.setConfirmDiscard(() => {
    asked += 1;
    return false;
  });
  const refused = store.openSection('projects');
  await settle();
  check('navigation was refused', refused === false);
  check('the guard was asked', asked === 1);
  check('we are still on the essay', store.getState().resolved.section?.id === 'essays');

  store.setConfirmDiscard(() => true);
  const allowed = store.openSection('projects');
  await settle();
  check('allowing it moves', allowed === true && store.getState().resolved.section?.id === 'projects');

  // A clean editor is never asked about.
  let askedAgain = 0;
  store.setConfirmDiscard(() => {
    askedAgain += 1;
    return true;
  });
  store.openSection('essays');
  await settle();
  check('a clean editor is not interrogated', askedAgain === 0);

  stop();
}

/* ========================================================================== */
section('the site store: create, duplicate, delete, reorder');

{
  const api = world();
  const nav = createMemoryNavigator();
  const store = createSiteStore({ api, navigator: nav });
  const stop = store.start();
  await settle();

  // Documents: create is a draft write, and the list grows.
  store.openSection('essays');
  await settle();
  const madeKey = await store.createEntry('essays');
  await settle();
  check('a new essay was created', madeKey !== null, madeKey ?? 'null');
  check('it was written as a draft', api.snapshot().docs.essays?.[madeKey as string]?.draft !== null);
  check('it is never published by creating it', api.snapshot().docs.essays?.[madeKey as string]?.published === null);
  check('the list shows it', store.entriesOf('essays').some((entry) => entry.key === madeKey));
  check('it opened', store.getState().resolved.entryKey === madeKey);
  check(
    'and the row is badged as a draft',
    store.entriesOf('essays').find((entry) => entry.key === madeKey)?.hasDraft === true,
  );

  // Documents: duplicate.
  const copyKey = await store.duplicateEntry('essays', essay.meta.slug);
  await settle();
  check('an essay was duplicated', copyKey !== null && copyKey !== essay.meta.slug, copyKey ?? 'null');
  check('the copy is a draft on the server', api.snapshot().docs.essays?.[copyKey as string]?.draft !== null);

  // Documents: delete, which needs the optional endpoint.
  check('this API can delete an entry', canDeleteEntry(api) === true);
  check('the capability says so', store.can('essays').delete === true);
  const deleted = await store.deleteEntry('essays', copyKey as string);
  await settle();
  check('the copy was deleted', deleted === true);
  check('it is gone from the server', api.snapshot().docs.essays?.[copyKey as string] === undefined);
  check('and gone from the list', !store.entriesOf('essays').some((entry) => entry.key === copyKey));

  // Records: create and reorder are local edits to one file.
  store.openSection('filmography');
  await settle();
  const filmsBefore = store.entriesOf('filmography').length;
  const newFilmKey = await store.createEntry('filmography');
  await settle();
  check('a film was added locally', store.entriesOf('filmography').length === filmsBefore + 1);
  check('no write happened yet', api.calls.filter((call) => call.method === 'putRecords').length === 0);
  check('it opened', store.getState().resolved.entryKey === newFilmKey, newFilmKey ?? 'null');

  const before = store.entriesOf('filmography').map((entry) => entry.key).join(',');
  const moved = store.moveEntry('filmography', newFilmKey as string, -1);
  check('reorder moved it', moved === true);
  check(
    'the list order changed',
    store.entriesOf('filmography').map((entry) => entry.key).join(',') !== before,
  );
  check('reorder is undoable on the record store', store.recordStore('filmography')?.getState().canUndo === true);

  // Records: delete is local and undoable, and leaves the route on the list.
  const victim = store.entriesOf('filmography')[0]?.key as string;
  store.openEntry('filmography', victim);
  await settle();
  const removed = await store.deleteEntry('filmography', victim);
  await settle();
  check('the film was removed locally', removed === true);
  check('and we are back on the list', store.getState().resolved.view === 'list');
  store.recordStore('filmography')?.undo();
  check('undo brings the film back', store.entriesOf('filmography').some((entry) => entry.key === victim));

  stop();
}

/* ========================================================================== */
section('the site store: a section the API cannot delete from');

{
  const api = world({ canDeleteEntry: false });
  const store = createSiteStore({ api, navigator: createMemoryNavigator() });
  const stop = store.start();
  await settle();

  const can = store.can('essays');
  check('delete is refused for documents', can.delete === false);
  check('and it says why', can.deleteReason.length > 0, can.deleteReason.slice(0, 48));
  check('create and duplicate still work', can.create && can.duplicate);
  check('records can still be deleted', store.can('filmography').delete === true);
  check('a record collection can be reordered', store.can('filmography').reorder === true);
  check('a document collection cannot', store.can('essays').reorder === false);
  check('a singleton offers none of it', store.can('home').create === false && store.can('home').delete === false);

  const refused = await store.deleteEntry('essays', essay.meta.slug);
  check('and calling it does nothing', refused === false);
  check('the essay is still there', api.snapshot().docs.essays?.[essay.meta.slug] !== undefined);

  stop();
}

/* ========================================================================== */
section('the site store: an album renamed in the editor moves its own URL');

{
  const api = world();
  const album = ALBUMS.records.entries(photography)[0] as Album;
  const nav = createMemoryNavigator({ kind: 'entry', section: 'photography', key: album.slug });
  const store = createSiteStore({ api, navigator: nav });
  const stop = store.start();
  await settle();

  check('the album opened', store.getState().editor?.kind === 'records');
  const records = store.recordStore('photography');
  records?.patchEntry(album.id, { slug: 'renamed-album' });
  await settle();
  check('the route followed the slug', store.getState().resolved.entryKey === 'renamed-album', store.getState().resolved.entryKey ?? 'null');
  check('the binding followed too', store.getState().editor?.entryKey === 'renamed-album');
  check(
    'the URL followed',
    cmsRouteHref(nav.current()) === '/cms/photography/renamed-album',
    cmsRouteHref(nav.current()),
  );
  check('and it was a replace, not a push', nav.trail.length === 1, `${nav.trail.length} entries`);

  stop();
}

/* ========================================================================== */
section('the site store: Back and Forward');

{
  const api = world();
  const nav = createMemoryNavigator();
  const store = createSiteStore({ api, navigator: nav });
  const stop = store.start();
  await settle();

  store.openSection('essays');
  await settle();
  store.openEntry('essays', essay.meta.slug);
  await settle();
  check('two pushes', nav.trail.length === 3, nav.trail.map((route: CmsRoute) => cmsRouteHref(route)).join(' '));

  nav.pop({ kind: 'section', section: 'essays' });
  await settle();
  check('Back puts us on the list', store.getState().resolved.view === 'list');
  check('and closes the editor', store.getState().editor === null);

  nav.pop({ kind: 'entry', section: 'essays', key: essay.meta.slug });
  await settle();
  check('Forward reopens the editor', store.getState().editor?.kind === 'document');

  stop();
}

/* ========================================================================== */
section('the stub API behaves like the real one');

{
  const api = world();
  let rejected = false;
  try {
    await api.putDraft('essays', 'x', { version: 1, meta: { title: '', slug: 'x', date: '2026-01-01' }, bands: [] } as Doc);
  } catch (error) {
    rejected = String(error).includes('invalid document');
  }
  check('it validates a document before writing', rejected);

  let mismatch = false;
  try {
    await api.putDraft('essays', 'other', essay);
  } catch (error) {
    mismatch = String(error).includes('slug mismatch');
  }
  check('it refuses a slug that disagrees with the body', mismatch);

  let badRecords = false;
  try {
    await api.putRecords('filmography', { films: [{ id: 'a', youtubeId: '', title: '', kind: '', year: '' }] } as RecordFile);
  } catch (error) {
    badRecords = String(error).includes('invalid filmography');
  }
  check('it validates a record file before writing', badRecords);

  let wrongKind = false;
  try {
    await api.getRecords('essays');
  } catch (error) {
    wrongKind = String(error).includes('holds documents');
  }
  check('a document section has no record endpoint', wrongKind);

  let nothingToPublish = false;
  try {
    await api.publish('photography', null);
  } catch (error) {
    nothingToPublish = String(error).includes('no draft to publish');
  }
  check('publishing with no draft is an error', nothingToPublish);

  const upload = await api.uploadMedia('photography', 'first-build', new File(['x'], 'A Photo.JPG', { type: 'image/jpeg' }));
  check('an upload lands under the registry path', upload.src === '/media/photography/first-build/a-photo.jpg', upload.src);
  check('and reports intrinsic dimensions', upload.w > 0 && upload.h > 0);

  const sections = await api.listSections();
  check('listSections answers for every section', sections.length === SECTIONS.length);
  check(
    'a record section counts its entries',
    sections.find((summary) => summary.id === 'filmography')?.count === 4,
  );
  const entries = await api.listEntries('filmography');
  check('listEntries carries a thumbnail for records', typeof entries[0]?.thumb === 'string');
  check('and a subtitle', entries[0]?.subtitle !== undefined);
  const essays = await api.listEntries('essays');
  check('a document row carries its date', essays[0]?.date === essay.meta.date, essays[0]?.date);
  check('a film row carries no date', entries[0]?.date === undefined);
  check('every film row has a key that routes', entries.every((entry) => parseCmsRoute(`/cms/filmography/${entry.key}`) !== null));
  check('isFilm/isAlbum still narrow the fixtures', isFilm(FILMS.records.entries(filmography)[0] as Film));
}

/* ========================================================================== */

console.log(`\n  ${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`  ${failures} FAILED\n`);
  process.exit(1);
}
console.log('  WS-D navigation layer verified\n');
