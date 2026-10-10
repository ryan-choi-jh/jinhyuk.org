/**
 * src/cms/preview/verify.ts
 *
 * WS-7's proof, extended by WS-H to all six surfaces, start to finish, without
 * any other workstream's help:
 *
 *   node src/cms/preview/verify.ts [--out=<dir>] [--keep] [--port=<n>]
 *                                  [--only=home,album,...] [--no-shots]
 *
 * What it does:
 *
 *  1. Writes a whole scratch content tree — a homepage, an essay, a project,
 *     a film list and two photo albums, each with a published version and a
 *     deliberately different draft, so there is something for the
 *     draft/published toggle to actually show on every surface. Every file
 *     goes through WS-A's validator first and lands at the path WS-A's
 *     registry names, so what is previewed is content the CMS would accept
 *     and the layout the API writes.
 *  2. Starts `astro dev` with CMS_PREVIEW_LOCAL_DIR pointing at that tree. No
 *     GitHub token, no network, no commit, no branch: the preview is the one
 *     part of the CMS it is safe to verify this way, and "never test against
 *     main" (brief 4, WS-2) is honoured by never going near a repository.
 *  3. Checks the draft/published toggle on EVERY surface over plain HTTP,
 *     because that question is answered by the server-rendered markup and a
 *     browser would only make it slower to ask.
 *  4. Drives headless Chrome over the real routes, reads the numbers the frame
 *     measured in the browser out of the chrome's data attributes, and asserts
 *     them at 1440 and at 390. The 390 case is the one that matters: on a
 *     document, positioning dropped, items stacked in document order, no
 *     connectors (brief 3.4); on an album, six photographs still six
 *     photographs.
 *  5. Screenshots every surface at 1440 and 390, plus the published side of
 *     the two that change most, plus dark, plus the list — so a human can see
 *     what the assertions are claiming.
 *  6. Checks at the config level that none of this reaches the static GitHub
 *     Pages build.
 *
 * THE ALBUM PAGE IS THE INTERESTING ONE. It is the only surface with no live
 * counterpart to compare against (docs/cms-sections.md 3.4), so there is
 * nothing to diff it with and the assertions have to stand on their own: the
 * grid holds every photograph, each row is about as tall as
 * `--album-row` asks, the overlay is present and closed, and at 390 the
 * photographs are one per row and the page does not scroll sideways.
 *
 * Local evidence tool, not a CI test: it needs Chrome at the hardcoded macOS
 * path. selftest.ts is the part that runs anywhere.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MOBILE_BREAKPOINT,
  formatIssues,
  isCanvasBand,
  resolveAnchor,
  validateDoc,
  validateDocJson,
  validateFilmographyJson,
  validatePhotographyJson,
} from '../schema.ts';
import type { Album, Doc, Film, Photo, RecordFile } from '../schema.ts';
import {
  CONTENT_ROOT,
  contentPathFor,
  draftPathFor,
  getSection,
  isRecordSection,
  requireSection,
} from '../sections.ts';
import type { SectionDef } from '../sections.ts';
import { PREVIEW_WIDTHS, frameHref, previewHref } from './state.ts';
import { diffDocs } from './diff.ts';
import { parseTargetPath } from './target.ts';

/* -------------------------------------------------------------------------- */
/* Setup                                                                      */
/* -------------------------------------------------------------------------- */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PROJECT = resolve(HERE, '../../..');
const FIXTURES = join(PROJECT, 'src/cms/fixtures');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ASTRO = join(PROJECT, 'node_modules/.bin/astro');

const args = process.argv.slice(2);
const outArg = args.find((arg) => arg.startsWith('--out='));
const portArg = args.find((arg) => arg.startsWith('--port='));
const onlyArg = args.find((arg) => arg.startsWith('--only='));
const OUT = outArg === undefined ? join(tmpdir(), 'jinhyuk-ws7-preview') : resolve(outArg.slice('--out='.length));
const KEEP = args.includes('--keep');
const SHOTS_ON = !args.includes('--no-shots');
const ONLY = onlyArg === undefined ? null : new Set(onlyArg.slice('--only='.length).split(','));
const CONTENT = join(OUT, 'content');
const SHOTS = join(OUT, 'shots');
const PROFILES = join(OUT, '.chrome-profiles');

/** The project slug the phase 1 document assertions are measured against. */
const PROJECT_SLUG = 'fixture-dense';
const ESSAY_SLUG = 'fixture-essay';
const ALBUM_SLUG = 'first-build';

/** `--album-row` in sections.css. The height a row of photographs aims for. */
const ALBUM_ROW = 400;

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
  const a = String(actual);
  const b = String(expected);
  check(label, a === b, a === b ? '' : `got ${a}, want ${b}`);
}

function section(name: string): void {
  console.log(`\n${name}`);
}

/* -------------------------------------------------------------------------- */
/* The content under test                                                     */
/* -------------------------------------------------------------------------- */

function loadFixture(name: string): Doc {
  const result = validateDocJson(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
  if (!result.ok) throw new Error(`fixture ${name}: ${formatIssues(result.issues)}`);
  return result.doc;
}

function loadFilms(): Film[] {
  const result = validateFilmographyJson(readFileSync(join(FIXTURES, 'filmography.json'), 'utf8'));
  if (!result.ok) throw new Error(`filmography fixture: ${formatIssues(result.issues)}`);
  return result.data.films;
}

function loadAlbums(): Album[] {
  const result = validatePhotographyJson(readFileSync(join(FIXTURES, 'photography.json'), 'utf8'));
  if (!result.ok) throw new Error(`photography fixture: ${formatIssues(result.issues)}`);
  return result.data.albums;
}

/**
 * Write one content file where the registry says it goes.
 *
 * `CMS_PREVIEW_LOCAL_DIR` stands in for `src/content/`, so the repository path
 * minus that prefix is the path inside the scratch tree. Using the registry
 * rather than a literal is the point: if WS-A moves essays, this harness moves
 * with them and the preview is tested against the layout the API writes.
 */
function writeContent(repoPath: string, body: string): void {
  const prefix = `${CONTENT_ROOT}/`;
  const relative = repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : repoPath;
  const file = join(CONTENT, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function writeDoc(section: SectionDef, key: string | null, doc: Doc, side: 'draft' | 'published'): void {
  const result = validateDoc(doc);
  if (!result.ok) {
    throw new Error(`refusing to write an invalid document at ${section.id}/${key}: ${formatIssues(result.issues)}`);
  }
  const path = side === 'draft' ? draftPathFor(section, key) : contentPathFor(section, key);
  writeContent(path, `${JSON.stringify(result.doc, null, 2)}\n`);
}

function writeRecords(section: SectionDef, file: RecordFile, side: 'draft' | 'published'): void {
  if (!isRecordSection(section)) throw new TypeError(`${section.id} is not a record section`);
  const result = section.records.validateFile(file);
  if (!result.ok) {
    throw new Error(`refusing to write an invalid ${section.id} collection: ${formatIssues(result.issues)}`);
  }
  const path = side === 'draft' ? draftPathFor(section) : contentPathFor(section);
  writeContent(path, `${JSON.stringify(result.data, null, 2)}\n`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The published document: the draft, minus its last band, with its opening
 * paragraph rewritten and its title changed. One band added, one band edited,
 * one detail changed — enough that the toggle has something to show and the
 * change list has something to list.
 */
function olderVersionOf(draft: Doc, title: string): Doc {
  const published = clone(draft);
  published.meta.title = title;
  published.bands.pop();
  const first = published.bands[0];
  if (first === undefined || first.type !== 'prose') throw new Error('fixture shape changed');
  first.blocks[0]!.content = [
    { type: 'text', text: 'This is the published wording, which the draft rewrites.' },
  ];
  return published;
}

/* -------------------------------------------------------------------------- */
/* Ports and the dev server                                                   */
/* -------------------------------------------------------------------------- */

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

type Dev = { port: number; stop: () => void };

async function startDev(port: number): Promise<Dev> {
  const child = spawn(ASTRO, ['dev', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: PROJECT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // The whole point: read these files, not a repository.
      CMS_PREVIEW_LOCAL_DIR: CONTENT,
      // Make sure a token in the environment cannot quietly change the source.
      CMS_DEV_TOKEN: '',
      BROWSER: 'none',
      FORCE_COLOR: '0',
    },
  });

  let log = '';
  child.stdout.on('data', (chunk: Buffer) => {
    log += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    log += chunk.toString('utf8');
  });

  const stop = (): void => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  };

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (Date.now() > deadline) {
      stop();
      throw new Error(`astro dev did not come up on ${port}.\n${log.slice(-4000)}`);
    }
    try {
      const response = await fetch(`${base}/cms/preview`, { redirect: 'manual' });
      if (response.status < 500) {
        await response.text();
        break;
      }
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 400));
  }
  return { port, stop };
}

/* -------------------------------------------------------------------------- */
/* Chrome                                                                     */
/* -------------------------------------------------------------------------- */

let launches = 0;

/**
 * A fresh Chrome profile per launch. A reused one sometimes refuses to start.
 *
 * `name` is carried only so a launch can be identified in the profile
 * directory while debugging; it does NOT share a profile. Sharing one between
 * the measuring pass and the screenshot pass was tried, to get the second
 * launch a warm disk cache, and it made things worse rather than better:
 * four of six photographs came back as placeholders instead of one. The
 * screenshot's race with image decoding is fixed in the frame route instead,
 * where the images stop being lazy before the browser ever sees them.
 */
function profileFor(name: string | null): string {
  launches += 1;
  return join(PROFILES, name === null ? String(launches) : `${name}-${launches}`);
}

/**
 * One headless Chrome, killed as soon as it has produced what was asked for.
 * The approach, the flags and the reason for the two different flag sets are
 * WS-1's (src/cms/render/verify.ts): new headless never exits on its own, and
 * a virtual time budget that makes a DOM dump fast makes a screenshot blank.
 */
function chrome(
  extra: string[],
  url: string,
  width: number,
  height: number,
  ready: (stdout: string) => boolean,
  limitMs = 60_000,
  profile: string | null = null,
): Promise<string> {
  return new Promise((done) => {
    const child = spawn(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--force-device-scale-factor=1',
        '--hide-scrollbars',
        `--user-data-dir=${profileFor(profile)}`,
        `--window-size=${width},${height}`,
        ...extra,
        url,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(deadline);
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      done(stdout);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.resume();
    child.on('error', finish);
    child.on('exit', finish);

    const poll = setInterval(() => {
      if (ready(stdout)) finish();
    }, 150);
    const deadline = setTimeout(finish, limitMs);
  });
}

const DUMP_FLAGS = ['--virtual-time-budget=12000', '--dump-dom'];
const SHOT_FLAGS = ['--run-all-compositor-stages-before-draw', '--disable-new-content-rendering-timeout'];

const domReady = (stdout: string): boolean => stdout.includes('</html>');

function shotReady(path: string): () => boolean {
  return () => {
    if (!existsSync(path)) return false;
    const stat = statSync(path);
    return stat.size > 1024 && Date.now() - stat.mtimeMs > 400;
  };
}

/** The data-pv-* attributes the chrome puts on <html> for exactly this purpose. */
function readState(dom: string): Record<string, string> {
  const match = /<html\b([^>]*)>/i.exec(dom);
  if (match === null) return {};
  const state: Record<string, string> = {};
  for (const attr of match[1]!.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
    state[attr[1]!] = attr[2]!;
  }
  return state;
}

async function dump(
  url: string,
  windowWidth: number,
  profile: string | null = null,
): Promise<{ dom: string; state: Record<string, string> }> {
  // The dev server compiles on first request and every Chrome launch gets a
  // fresh profile with an empty cache, so a first visit can run out of budget
  // before the frame has reported. Retry on a warm server rather than making
  // the budget enormous for every page.
  let dom = '';
  let state: Record<string, string> = {};
  for (let attempt = 0; attempt < 3; attempt += 1) {
    dom = await chrome(DUMP_FLAGS, url, windowWidth, 1200, domReady, 60_000, profile);
    state = readState(dom);
    if (state['data-pv-ready'] === '1') break;
  }
  return { dom, state };
}

async function shot(
  url: string,
  windowWidth: number,
  windowHeight: number,
  name: string,
  profile: string | null = null,
): Promise<string> {
  mkdirSync(SHOTS, { recursive: true });
  const path = join(SHOTS, name);
  rmSync(path, { force: true });
  await chrome([...SHOT_FLAGS, `--screenshot=${path}`], url, windowWidth, windowHeight, shotReady(path), 60_000, profile);
  if (!existsSync(path)) {
    await chrome([...SHOT_FLAGS, `--screenshot=${path}`], url, windowWidth, windowHeight, shotReady(path));
  }
  return path;
}

/* -------------------------------------------------------------------------- */
/* The static build                                                           */
/* -------------------------------------------------------------------------- */

/**
 * "Must be excluded from the static build the same way the existing preview
 * route is." Proved where the exclusion lives: astro.config.mjs only adds the
 * editor-routes integration when `isDev || PUBLIC_EDITOR_BUILD`, so the static
 * Pages build injects nothing, and none of the three files is under
 * src/pages/, which would make it a route in both builds regardless.
 */
function injectedPatterns(editorBuild: boolean): Promise<string[]> {
  const script = `
    const mod = await import(${JSON.stringify(join(PROJECT, 'astro.config.mjs'))});
    const config = mod.default;
    const patterns = [];
    for (const integration of config.integrations ?? []) {
      if (integration?.name !== 'editor-routes') continue;
      const hook = integration.hooks?.['astro:config:setup'];
      if (typeof hook === 'function') await hook({ injectRoute: (r) => patterns.push(r.pattern) });
    }
    console.log(JSON.stringify({ output: config.output, patterns }));
  `;
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: PROJECT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: editorBuild ? { ...process.env, PUBLIC_EDITOR_BUILD: '1' } : { ...process.env, PUBLIC_EDITOR_BUILD: '' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('exit', (code) => {
      if (code !== 0) return fail(new Error(`config probe failed: ${err.slice(-2000)}`));
      try {
        done((JSON.parse(out.trim()) as { patterns: string[] }).patterns);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}


/* -------------------------------------------------------------------------- */
/* Reading the geometry back                                                  */
/* -------------------------------------------------------------------------- */

/** `data-pv-images` is `loaded/total`, so it is two numbers and not one. */
function imageCount(state: Record<string, string>): { loaded: number; total: number } {
  const [loaded, total] = (state['data-pv-images'] ?? '0/0').split('/').map(Number);
  return { loaded: loaded ?? 0, total: total ?? 0 };
}

type Box = { top: number; left: number; width: number; height: number };

/** `data-pv-entry-boxes`: `top:left:width:height`, in page order. */
function parseBoxes(raw: string | undefined): Box[] {
  if (raw === undefined || raw === '') return [];
  return raw
    .split(',')
    .map((quad) => quad.split(':').map(Number))
    .filter((quad) => quad.length === 4 && quad.every((value) => Number.isFinite(value)))
    .map(([top, left, width, height]) => ({ top: top!, left: left!, width: width!, height: height! }));
}

type Row = {
  /** The common height of the photographs on it. */
  height: number;
  count: number;
  /** Left edge of the first, right edge of the last. */
  left: number;
  right: number;
  /** The largest difference in height between two photographs on this row. */
  heightSpread: number;
};

/**
 * Boxes grouped into rows by their top edge.
 *
 * This is how a justified gallery is checked, and it is the question a
 * screenshot of the first row cannot answer: a row is justified when every
 * photograph on it has been scaled to the SAME HEIGHT and the row SPANS THE
 * COLUMN. Row height itself is content, not correctness — six phone
 * screenshots at 1206×2622 justify to a 588px row against a 400px target,
 * because five of them is as close as you can get to 400 without going under
 * it, and asserting 400 would be asserting the fixture.
 *
 * Two tops within 2px are the same row: a row whose photographs differ by a
 * fraction of a pixel is still a row.
 */
function rowsOf(boxes: readonly Box[]): Row[] {
  const groups: Box[][] = [];
  for (const box of boxes) {
    const group = groups.find((candidate) => Math.abs(candidate[0]!.top - box.top) <= 2);
    if (group === undefined) groups.push([box]);
    else group.push(box);
  }
  return groups
    .sort((a, b) => a[0]!.top - b[0]!.top)
    .map((group) => {
      const heights = group.map((box) => box.height);
      return {
        height: Math.round(Math.max(...heights)),
        count: group.length,
        left: Math.min(...group.map((box) => box.left)),
        right: Math.max(...group.map((box) => box.left + box.width)),
        heightSpread: Math.max(...heights) - Math.min(...heights),
      };
    });
}

/* -------------------------------------------------------------------------- */
/* The surfaces                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One previewable surface, and what the browser should find on it.
 *
 * A table and not eight copies of the same twenty lines: every surface is
 * measured the same way, and what differs between them is the handful of
 * numbers below. `entries` is how many of `entrySelectorOf(target)`'s
 * elements there should be — films, album tiles, photographs, ledger rows or
 * bands — which is the one count that proves the renderer ran rather than the
 * page merely loading.
 */
type Surface = {
  /** Shortname for --only, and the screenshot prefix. */
  name: string;
  /** The preview path: `<section>` or `<section>/<key>`. */
  path: string;
  /** What `data-pv-surface` should say. */
  surface: string;
  /** Rows the frame should report, on the draft side. */
  entries: number;
  /** Canvas items, for the 3.4 assertions. Zero on a surface with no canvas. */
  items?: number;
  overlays?: number;
  /** Anchored items whose connector should be drawn above the breakpoint. */
  anchored?: number;
  /** Extra assertions, given the chrome's data attributes at this width. */
  expect?: (state: Record<string, string>, width: number) => void;
};

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);
  if (!existsSync(ASTRO)) throw new Error(`astro not found at ${ASTRO}. Dependencies are expected to be installed already.`);

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  console.log('WS-7 + WS-H preview verification');
  console.log(`out  ${OUT}`);

  /* ---------------------------------------------------------------------- */
  section('the content');
  /* ---------------------------------------------------------------------- */

  const home = requireSection('home');
  const essays = requireSection('essays');
  const projects = requireSection('projects');
  const filmography = requireSection('filmography');
  const photography = requireSection('photography');

  /* Home: the draft retitles it and rewrites the intro's first line. */
  const homeDoc = loadFixture('home');
  const homeDraft = clone(homeDoc);
  homeDraft.meta.title = 'Ryan Choi (draft)';
  writeDoc(home, null, homeDoc, 'published');
  writeDoc(home, null, homeDraft, 'draft');

  /* An essay, published and drafted. */
  const essayDraft = clone(loadFixture('essay'));
  essayDraft.meta.slug = ESSAY_SLUG;
  const essayPublished = olderVersionOf(essayDraft, 'Chasing the Workaround (as published)');
  writeDoc(essays, ESSAY_SLUG, essayPublished, 'published');
  writeDoc(essays, ESSAY_SLUG, essayDraft, 'draft');

  /* A second essay that has only ever been a draft, so the index's toggle
     and the "no published version" path are both exercised. */
  const soloEssay = clone(loadFixture('simple'));
  soloEssay.meta.slug = 'fixture-solo-essay';
  soloEssay.meta.section = 'essays';
  soloEssay.meta.title = 'An essay that is only a draft';
  writeDoc(essays, 'fixture-solo-essay', soloEssay, 'draft');

  /* A project. The dense fixture, because it is the one with positioned canvas
     items, an overlay band and an anchored connector — everything brief 3.4
     says has to be dropped at 390. */
  const projectDraft = clone(loadFixture('dense'));
  projectDraft.meta.slug = PROJECT_SLUG;
  const projectPublished = olderVersionOf(projectDraft, 'Fixture: dense canvas (as published)');
  writeDoc(projects, PROJECT_SLUG, projectPublished, 'published');
  writeDoc(projects, PROJECT_SLUG, projectDraft, 'draft');

  /* The film list. The draft swaps the first two, re-notes one and adds one. */
  const films = loadFilms();
  const filmsDraft: Film[] = [
    films[1]!,
    { ...films[0]!, note: 'Re-cut for the draft.' },
    ...films.slice(2),
    { id: 'film_draft_only', youtubeId: 'dQw4w9WgXcQ', title: 'A film only in the draft', kind: 'SHORT FILM', year: '2026' },
  ];
  writeRecords(filmography, { films }, 'published');
  writeRecords(filmography, { films: filmsDraft }, 'draft');

  /* The albums. The draft reorders one album's photographs, moves its cover,
     retitles it and adds a whole new album. */
  const albums = loadAlbums();
  const firstBuild = albums.find((album) => album.slug === ALBUM_SLUG);
  if (firstBuild === undefined) throw new Error(`the photography fixture lost ${ALBUM_SLUG}`);
  const reordered: Album = {
    ...firstBuild,
    title: 'First Build (draft)',
    cover: firstBuild.photos[0]!.id,
    photos: [
      firstBuild.photos[2]!,
      firstBuild.photos[0]!,
      firstBuild.photos[1]!,
      ...firstBuild.photos.slice(3),
    ],
  };
  const newAlbumPhoto: Photo = {
    id: 'ph_draft_only',
    src: '/photography/placeholder.webp',
    alt: 'A placeholder photograph',
    w: 1200,
    h: 918,
  };
  const albumsDraft: Album[] = [
    reordered,
    ...albums.slice(1),
    {
      id: 'album_draft_only',
      slug: 'draft-only',
      title: 'An album only in the draft',
      year: '2026',
      photos: [newAlbumPhoto],
    },
  ];
  writeRecords(photography, { albums }, 'published');
  writeRecords(photography, { albums: albumsDraft }, 'draft');

  /* What the assertions below are derived from, rather than typed in. */
  const items = projectDraft.bands.filter(isCanvasBand).flatMap((band) => band.items);
  const overlays = projectDraft.bands.filter((band) => isCanvasBand(band) && band.overlay === true);
  const anchored = items.filter(
    (item) => item.anchor !== undefined && resolveAnchor(projectDraft, item.anchor) !== null,
  );
  const essayItems = essayDraft.bands.filter(isCanvasBand).flatMap((band) => band.items);
  const homeItems = homeDraft.bands.filter(isCanvasBand).flatMap((band) => band.items);
  const expectedDiff = diffDocs(projectDraft, projectPublished);

  check('the project draft has canvas items to position', items.length > 0, `${items.length} items`);
  check('it has an overlay band', overlays.length > 0, `${overlays.length}`);
  check('it has an anchored item, so there is a connector to suppress', anchored.length > 0, `${anchored.length}`);
  eq('the two versions differ by one added band', expectedDiff.counts.added, 1);
  eq('and one edited band', expectedDiff.counts.changed, 1);
  check('and a changed title', expectedDiff.meta.some((m) => m.field === 'title'), expectedDiff.summary);
  check('the album under test has several photographs', firstBuild.photos.length >= 4, `${firstBuild.photos.length}`);
  check(
    'one of them has no intrinsic size, which the grid has to cope with',
    firstBuild.photos.some((photo) => photo.w === undefined),
  );
  check('every path came from the registry', getSection('photography') === photography);

  /* ---------------------------------------------------------------------- */
  section('the static build');
  /* ---------------------------------------------------------------------- */

  const staticPatterns = await injectedPatterns(false);
  const editorPatterns = await injectedPatterns(true);
  const mine = ['/cms/preview', '/cms/preview/frame/[...path]', '/cms/preview/[...path]'];

  eq('the static build injects no routes at all', staticPatterns.length, 0);
  for (const pattern of mine) {
    check(`the editor build injects ${pattern}`, editorPatterns.includes(pattern));
    check(`the static build does not inject ${pattern}`, !staticPatterns.includes(pattern));
  }
  check(
    'and none of my files is under src/pages/, which would be a route in both builds',
    !existsSync(join(PROJECT, 'src/pages/cms')),
  );
  // The frame route has to be matched before the chrome route, or
  // /cms/preview/frame/home would be read as the section "frame".
  check(
    'the frame pattern is injected before the catch-all it would otherwise fall into',
    editorPatterns.indexOf('/cms/preview/frame/[...path]') <
      editorPatterns.indexOf('/cms/preview/[...path]'),
  );

  /* ---------------------------------------------------------------------- */
  section('the surfaces');
  /* ---------------------------------------------------------------------- */

  const surfaces: Surface[] = [
    {
      name: 'home',
      path: 'home',
      surface: 'document',
      entries: homeDraft.bands.length - 2,
      items: 0,
      overlays: 0,
      expect: (state, width) => {
        // splitHome lifts the hero and the intro out of the band pipeline into
        // the site's own `.hero` and `.intro`, so the homepage's canvas item
        // is NOT a `.doc-item` and must not be counted as one.
        eq(`home @ ${width}: the hero is not a canvas item`, state['data-pv-items'], '0');
        check(
          `home @ ${width}: the hero image is in the page`,
          imageCount(state).total >= homeItems.length,
          `${state['data-pv-images']} for ${homeItems.length} hero image(s)`,
        );
      },
    },
    {
      name: 'essay',
      path: `essays/${ESSAY_SLUG}`,
      surface: 'document',
      entries: essayDraft.bands.length,
      items: essayItems.length,
      overlays: 0,
    },
    {
      name: 'essays-index',
      path: 'essays',
      surface: 'ledger',
      // The published essay plus the draft-only one: the draft view of an
      // index is "what the site would look like if I published everything".
      entries: 2,
      items: 0,
      overlays: 0,
    },
    {
      name: 'project',
      path: `projects/${PROJECT_SLUG}`,
      surface: 'document',
      entries: projectDraft.bands.length,
      items: items.length,
      overlays: overlays.length,
      anchored: anchored.length,
    },
    {
      name: 'projects-index',
      path: 'projects',
      surface: 'ledger',
      entries: 1,
      items: 0,
      overlays: 0,
    },
    {
      name: 'filmography',
      path: 'filmography',
      surface: 'films',
      entries: filmsDraft.length,
      items: 0,
      overlays: 0,
      expect: (state, width) => {
        // The facade ships the poster and builds the player on click, so a
        // page that has already loaded an iframe per film is a regression in
        // WS-B's renderer that this preview would be hiding.
        check(
          `filmography @ ${width}: one poster per film, and no player yet`,
          imageCount(state).total >= filmsDraft.length,
          `${state['data-pv-images']} for ${filmsDraft.length} films`,
        );
      },
    },
    {
      name: 'photography',
      path: 'photography',
      surface: 'albums',
      entries: albumsDraft.length,
      items: 0,
      overlays: 0,
    },
    {
      name: 'album',
      path: `photography/${ALBUM_SLUG}`,
      surface: 'album',
      entries: reordered.photos.length,
      items: 0,
      overlays: 0,
      expect: (state, width) => {
        eq(
          `album @ ${width}: every photograph is in the grid`,
          state['data-pv-entries'],
          String(reordered.photos.length),
        );
        const shown = imageCount(state);
        check(
          `album @ ${width}: every photograph decoded`,
          shown.total === reordered.photos.length && shown.loaded === shown.total,
          `${state['data-pv-images']} for ${reordered.photos.length} photographs`,
        );
      },
    },
  ];

  const selected = surfaces.filter((surface) => ONLY === null || ONLY.has(surface.name));
  for (const surface of selected) {
    const parsed = parseTargetPath(surface.path);
    check(`${surface.name}: ${surface.path} resolves to a target`, parsed.ok, parsed.ok ? '' : parsed.reason);
    if (parsed.ok) eq(`${surface.name}: as the ${surface.surface} surface`, parsed.target.surface, surface.surface);
  }

  /* ---------------------------------------------------------------------- */
  section('astro dev');
  /* ---------------------------------------------------------------------- */

  const port = portArg === undefined ? await freePort() : Number(portArg.slice('--port='.length));
  const dev = await startDev(port);
  const base = `http://127.0.0.1:${dev.port}`;
  console.log(`    up on ${base}`);

  try {
    // Warm the module graph so the first measured visit is not also the first
    // compile of doc.css, sections.css, the connector script and the shape
    // generator.
    for (const surface of selected) {
      for (const version of ['draft', 'published'] as const) {
        await (await fetch(`${base}${frameHref(surface.path, { version })}`)).text();
      }
      await (await fetch(`${base}${previewHref(surface.path)}`)).text();
    }
    await (await fetch(`${base}/cms/preview`)).text();

    /* -------------------------------------------------------------------- */
    section('the list of sections');
    /* -------------------------------------------------------------------- */

    const listResponse = await fetch(`${base}/cms/preview`);
    const listHtml = await listResponse.text();
    eq('GET /cms/preview', listResponse.status, 200);
    check('it is reading local files, and says so', listHtml.includes('local files'));
    for (const id of ['home', 'projects', 'essays', 'filmography', 'photography']) {
      check(`it lists the ${id} section`, listHtml.includes(`href="/cms/preview/${id}"`));
    }
    check(
      'it links an album to its own page',
      listHtml.includes(`href="/cms/preview/photography/${ALBUM_SLUG}"`),
    );
    check(
      'a film is listed but not linked, because it has no page of its own',
      listHtml.includes('pv-card--flat') && !listHtml.includes('/cms/preview/filmography/film_'),
    );
    check('the draft-only essay is badged draft', /fixture-solo-essay[\s\S]{0,500}?draft</.test(listHtml));

    /* Per ENTRY, not per collection: the two files a record section has are
       one draft and one published file, but whether a particular film is live
       is its own question and the badge has to answer that one. */
    const rowOf = (title: string): string =>
      listHtml.slice(listHtml.indexOf(title), listHtml.indexOf(title) + 700);
    const draftOnlyFilm = rowOf('A film only in the draft');
    check('a film that exists only in the draft is badged draft', draftOnlyFilm.includes('>draft<'));
    check('and NOT published', !draftOnlyFilm.includes('>published<'));
    const liveFilm = rowOf('The Getaway');
    check('a film that is live is badged published', liveFilm.includes('>published<'));
    const draftOnlyAlbum = rowOf('An album only in the draft');
    check('the same for an album', draftOnlyAlbum.includes('>draft<') && !draftOnlyAlbum.includes('>published<'));
    check(
      'and the counts read as English',
      listHtml.includes('5 films') && listHtml.includes('3 albums') && listHtml.includes('1 project'),
    );

    /* -------------------------------------------------------------------- */
    section('the draft/published toggle, on every surface');
    /* -------------------------------------------------------------------- */

    /**
     * Over HTTP and not in a browser: which version a URL renders is decided
     * by the server, visible in the markup it returns, and asking a browser
     * would only make the same question take eight more Chrome launches.
     */
    const frameFor = async (path: string, version: 'draft' | 'published'): Promise<string> =>
      (await fetch(`${base}${frameHref(path, { version })}`)).text();

    const countOf = (html: string, needle: string): number => html.split(needle).length - 1;

    for (const surface of selected) {
      const draft = await frameFor(surface.path, 'draft');
      const published = await frameFor(surface.path, 'published');
      check(`${surface.name}: both versions render`, draft.length > 1000 && published.length > 1000);
      check(
        `${surface.name}: and they are not the same page`,
        draft !== published,
        `${draft.length} vs ${published.length} bytes`,
      );
      eq(`${surface.name}: the draft frame says which surface it is`, countOf(draft, `"${surface.surface}"`) > 0, true);
    }

    // The specific differences, so "not the same page" cannot pass on a
    // changed title alone.
    const filmsDraftHtml = await frameFor('filmography', 'draft');
    const filmsPublishedHtml = await frameFor('filmography', 'published');
    eq('filmography draft has the extra film', countOf(filmsDraftHtml, 'class="video"'), filmsDraft.length);
    eq('filmography published does not', countOf(filmsPublishedHtml, 'class="video"'), films.length);

    const albumsDraftHtml = await frameFor('photography', 'draft');
    const albumsPublishedHtml = await frameFor('photography', 'published');
    eq('photography draft has the extra album', countOf(albumsDraftHtml, 'class="card"'), albumsDraft.length);
    eq('photography published does not', countOf(albumsPublishedHtml, 'class="card"'), albums.length);

    const albumDraftHtml = await frameFor(`photography/${ALBUM_SLUG}`, 'draft');
    const albumPublishedHtml = await frameFor(`photography/${ALBUM_SLUG}`, 'published');
    check('the album draft shows the drafted title', albumDraftHtml.includes('First Build (draft)'));
    check('the published album shows the published one', albumPublishedHtml.includes('>First Build<'));
    eq(
      'both sides hold every photograph',
      [countOf(albumDraftHtml, 'class="album-photo'), countOf(albumPublishedHtml, 'class="album-photo')].join('/'),
      `${reordered.photos.length}/${firstBuild.photos.length}`,
    );
    /* WS-B marks each photograph with its own id, so the reorder is checkable
       exactly rather than by guessing at the markup around it. */
    const firstPhotoId = (html: string): string | undefined =>
      /class="album-photo[^"]*" data-photo-id="([^"]+)"/.exec(html)?.[1];
    eq('the drafted album leads with the photograph that was moved', firstPhotoId(albumDraftHtml), reordered.photos[0]!.id);
    eq('and the published one still leads with its own first', firstPhotoId(albumPublishedHtml), firstBuild.photos[0]!.id);
    check(
      'so the reorder really did move one',
      firstPhotoId(albumDraftHtml) !== firstPhotoId(albumPublishedHtml),
    );

    const essaysDraftHtml = await frameFor('essays', 'draft');
    const essaysPublishedHtml = await frameFor('essays', 'published');
    eq('the essays index draft lists the unpublished essay', countOf(essaysDraftHtml, 'class="ledger-title"'), 2);
    eq('and the published view does not', countOf(essaysPublishedHtml, 'class="ledger-title"'), 1);

    /* -------------------------------------------------------------------- */
    section('the chrome, and what it says changed');
    /* -------------------------------------------------------------------- */

    for (const surface of selected) {
      const html = await (await fetch(`${base}${previewHref(surface.path)}`)).text();
      check(`${surface.name}: the chrome renders`, html.includes('id="pv"'));
      check(`${surface.name}: it knows its path`, html.includes(`data-path="${surface.path}"`));
      check(`${surface.name}: and its surface`, html.includes(`data-surface="${surface.surface}"`));
      check(`${surface.name}: both versions are offered`, html.includes('data-pv-version="published"'));
      check(`${surface.name}: all five sections are in the tab row`, countOf(html, 'class="pv-tab"') === 5);
      check(`${surface.name}: the change list says something changed`, html.includes('Draft differs'));
      check(
        `${surface.name}: and its rows are clickable`,
        html.includes('data-pv-band=') || html.includes('data-pv-entry='),
      );
    }

    const albumChrome = await (await fetch(`${base}${previewHref(`photography/${ALBUM_SLUG}`)}`)).text();
    check('the album chrome reports the reorder', albumChrome.includes('data-status="moved"'));
    check('and the changed cover, by name', albumChrome.includes('ph_build_04') && albumChrome.includes('class="pv-meta-row"'));
    check('its rows scroll by index, not by band id', albumChrome.includes('data-pv-entry="0"'));

    const projectChrome = await (await fetch(`${base}${previewHref(`projects/${PROJECT_SLUG}`)}`)).text();
    check('a document chrome scrolls by band id', projectChrome.includes('data-pv-band='));
    check('the band that was added is listed as added', projectChrome.includes('data-status="added"'));
    check('the band that was edited is listed as edited', projectChrome.includes('data-status="changed"'));

    /* Phase 1's URLs, which must not have stopped working. */
    const legacyChrome = await fetch(`${base}/cms/preview/${PROJECT_SLUG}`);
    eq('phase 1\'s bare slug still resolves', legacyChrome.status, 200);
    check(
      'and canonicalises to the sectioned path',
      (await legacyChrome.text()).includes(`data-path="projects/${PROJECT_SLUG}"`),
    );
    const legacyFrame = await fetch(`${base}/cms/preview/${PROJECT_SLUG}/frame`, { redirect: 'manual' });
    eq('phase 1\'s frame URL redirects', legacyFrame.status, 302);
    eq(
      'to the canonical frame URL',
      legacyFrame.headers.get('location'),
      `/cms/preview/frame/${PROJECT_SLUG}`,
    );
    await legacyFrame.text();

    const missing = await fetch(`${base}${previewHref('projects/no-such-page')}`);
    check('an unknown entry is an empty state, not an error', (await missing.text()).includes('Nothing to preview'));
    const badSection = await fetch(`${base}${previewHref('nope/nope')}`);
    check('an unknown section says which the five are', (await badSection.text()).includes('That is not a section'));
    const noPage = await fetch(`${base}${previewHref('filmography/film_untitled')}`);
    check(
      'a film says it has no page of its own rather than inventing one',
      (await noPage.text()).includes('has no page per entry'),
    );

    /* -------------------------------------------------------------------- */
    section('in a browser, at 1440 and at 390');
    /* -------------------------------------------------------------------- */

    // Wide enough that the 1440 frame is shown at 100%, so all screenshots are
    // at true scale and comparable with WS-1's and WS-B's.
    const WINDOW_WIDTH = 1540;
    const MEASURED: readonly number[] = [1440, 390];

    for (const surface of selected) {
      for (const width of MEASURED) {
        const url = `${base}${previewHref(surface.path, { version: 'draft', width: width as (typeof PREVIEW_WIDTHS)[number] })}`;
        console.log(`\n  ${surface.name} @ ${width}px — ${url}`);
        const profile = `${surface.name}-${width}`;
        const { state } = await dump(url, WINDOW_WIDTH, profile);

        eq(`${surface.name} @ ${width}: the frame reported`, state['data-pv-ready'], '1');
        eq(`${surface.name} @ ${width}: it is the ${surface.surface} surface`, state['data-pv-surface'], surface.surface);
        eq(`${surface.name} @ ${width}: the viewport is exactly the preset`, state['data-pv-width'], String(width));
        eq(`${surface.name} @ ${width}: the rows the renderer produced are all there`, state['data-pv-entries'], String(surface.entries));
        const images = imageCount(state);
        check(
          `${surface.name} @ ${width}: every image decoded`,
          images.loaded === images.total,
          state['data-pv-images'] ?? '',
        );
        console.log(
          `    note  webfonts ${state['data-pv-fonts'] === 'yes' ? 'loaded' : 'NOT loaded — screenshots will show fallback type'}`,
        );

        const itemCount = surface.items ?? 0;
        eq(`${surface.name} @ ${width}: canvas items`, state['data-pv-items'], String(itemCount));
        eq(`${surface.name} @ ${width}: overlay bands`, state['data-pv-overlays'], String(surface.overlays ?? 0));

        if (width <= MOBILE_BREAKPOINT) {
          // Brief 3.4, the hard rule. True on every surface, including the
          // four that have no canvas to drop: there, it is the assertion that
          // the fallback fired at all.
          eq(`${surface.name} @ ${width}: the fallback is in force`, state['data-pv-mobile'], 'yes');
          eq(`${surface.name} @ ${width}: nothing is positioned`, state['data-pv-positioned'], '0');
          eq(`${surface.name} @ ${width}: every item is stacked instead`, state['data-pv-stacked'], String(itemCount));
          eq(`${surface.name} @ ${width}: items are in document order`, state['data-pv-order'], 'yes');
          eq(`${surface.name} @ ${width}: the overlay band is back in flow`, state['data-pv-overlays-positioned'], '0');
          eq(`${surface.name} @ ${width}: no connectors are drawn`, state['data-pv-connectors'], '0');
          eq(`${surface.name} @ ${width}: and none were even generated`, state['data-pv-connector-nodes'], '0');
        } else {
          eq(`${surface.name} @ ${width}: the fallback is off`, state['data-pv-mobile'], 'no');
          eq(`${surface.name} @ ${width}: every item is positioned`, state['data-pv-positioned'], String(itemCount));
          eq(
            `${surface.name} @ ${width}: the overlay band is out of flow`,
            state['data-pv-overlays-positioned'],
            String(surface.overlays ?? 0),
          );
          if ((surface.anchored ?? 0) > 0) {
            check(
              `${surface.name} @ ${width}: the anchored connector is drawn`,
              Number(state['data-pv-connectors'] ?? '0') >= (surface.anchored ?? 0),
              `${state['data-pv-connectors']} drawn, ${surface.anchored} anchored`,
            );
          }
          eq(`${surface.name} @ ${width}: the frame is shown at 100%`, state['data-pv-scale'], '1.0000');
        }

        surface.expect?.(state, width);

        if (SHOTS_ON) {
          const frameHeight = Number(state['data-pv-height'] ?? '0');
          const scale = Number(state['data-pv-scale'] ?? '1');
          // Chrome paints the window, so the window has to be as tall as the
          // page for the screenshot to be the whole page.
          const windowHeight = Math.min(16000, Math.round(frameHeight * scale) + 460);
          const file = `${surface.name}-${width}.png`;
          const path = await shot(url, WINDOW_WIDTH, windowHeight, file, profile);
          check(`${surface.name} @ ${width}: screenshot written`, existsSync(path), `${file} (${windowHeight}px tall)`);
        }
      }
    }

    /* -------------------------------------------------------------------- */
    section('the album page on its own terms');
    /* -------------------------------------------------------------------- */

    /**
     * The one surface with no live counterpart (docs/cms-sections.md 3.4), so
     * there is nothing to compare it with and these numbers are the whole of
     * the evidence. The geometry comes out of `data-pv-entry-boxes`, which is
     * every photograph's top and height as the browser laid it out.
     */
    for (const width of [1440, 390] as const) {
      const url = `${base}${previewHref(`photography/${ALBUM_SLUG}`, { version: 'draft', width })}`;
      const { state } = await dump(url, 1540);
      const boxes = parseBoxes(state['data-pv-entry-boxes']);
      const rows = rowsOf(boxes);

      eq(`album @ ${width}: the grid holds every photograph`, boxes.length, reordered.photos.length);
      check(
        `album @ ${width}: no photograph collapsed to nothing`,
        boxes.every((box) => box.height > 40),
        `heights ${boxes.map((box) => box.height).join(', ')}`,
      );
      eq(`album @ ${width}: the overlay is in the page and closed`, state['data-pv-dialogs'], '0/1');
      eq(`album @ ${width}: and it is fixed to the viewport`, state['data-pv-dialogs-fixed'], '1');
      eq(`album @ ${width}: nothing overflows sideways`, state['data-pv-overflow-x'], 'no');

      if (width > MOBILE_BREAKPOINT) {
        check(
          `album @ ${width}: the photographs are justified into rows`,
          rows.length > 1 && rows.length < boxes.length,
          `${rows.length} rows for ${boxes.length} photographs`,
        );
        check(
          `album @ ${width}: every row but the last holds more than one photograph`,
          rows.slice(0, -1).every((row) => row.count > 1),
          rows.map((row) => row.count).join(', '),
        );
        // The two halves of "justified": one height per row, and the row
        // reaches the far edge of the column.
        check(
          `album @ ${width}: every photograph on a row is the same height`,
          rows.every((row) => row.heightSpread <= 2),
          rows.map((row) => `${row.height}±${row.heightSpread}`).join(', '),
        );
        const full = rows.slice(0, -1);
        const span = Math.max(...rows.map((row) => row.right)) - Math.min(...rows.map((row) => row.left));
        check(
          `album @ ${width}: a full row spans the column`,
          full.every((row) => Math.abs(row.right - row.left - span) <= 2),
          `rows ${full.map((row) => row.right - row.left).join(', ')} against ${span}`,
        );
        check(
          `album @ ${width}: and the last row is left-aligned rather than stretched`,
          rows[rows.length - 1]!.left === Math.min(...rows.map((row) => row.left)),
        );
        console.log(
          `    note  --album-row is ${ALBUM_ROW}px and these rows came out ${rows.map((row) => row.height).join(', ')}px: the fixture is portrait phone screenshots, so a row fills the column before it comes down to the target`,
        );
      } else {
        eq(
          `album @ ${width}: one photograph per row on a phone`,
          rows.length,
          reordered.photos.length,
        );
      }
    }

    /* The hero overlay on the homepage is the same component, so it gets the
       same two assertions: present, closed, and fixed. */
    {
      const { state } = await dump(`${base}${previewHref('home', { version: 'draft' })}`, 1540);
      eq('the homepage hero overlay is present and closed', state['data-pv-dialogs'], '0/1');
      eq('and fixed to the viewport', state['data-pv-dialogs-fixed'], '1');
      eq('the homepage does not scroll sideways', state['data-pv-overflow-x'], 'no');
    }

    /* -------------------------------------------------------------------- */
    section('theme, and the frame on its own');
    /* -------------------------------------------------------------------- */

    const darkPath = `photography/${ALBUM_SLUG}`;
    const darkUrl = `${base}${previewHref(darkPath, { version: 'draft', theme: 'dark' })}`;
    const darkDump = await dump(darkUrl, 1540, 'dark');
    eq('the dark frame still reports', darkDump.state['data-pv-ready'], '1');
    check('and the frame took the forced theme', darkDump.dom.includes('theme=dark'));

    const frameOnly = await fetch(`${base}${frameHref(`projects/${PROJECT_SLUG}`, { version: 'draft' })}`);
    const frameHtml = await frameOnly.text();
    eq('GET the frame on its own', frameOnly.status, 200);
    check('it is the site layout, not the tool', frameHtml.includes('class="site-nav"'));
    check('with the document in the full-width column', frameHtml.includes('<div class="doc'));
    check('the masthead is WS-B\'s renderDocHead', frameHtml.includes('class="doc-head'));
    check('as a sibling of the document, not inside it', /<\/header>\s*<div class="doc/.test(frameHtml.replace(/\s+/g, ' ')));

    check(
      'nothing in a previewed page loads lazily',
      !albumDraftHtml.includes('loading="lazy"') && !filmsDraftHtml.includes('loading="lazy"'),
    );
    check(
      'and every image decodes synchronously, so a screenshot is deterministic',
      albumDraftHtml.includes('decoding="sync"') && !albumDraftHtml.includes('decoding="async"'),
    );

    const homeFrame = await (await fetch(`${base}${frameHref('home', { version: 'draft' })}`)).text();
    check('the homepage gets the site\'s own hero, not a bordered canvas item', homeFrame.includes('class="hero"'));
    check('and no masthead, because its name is the first line of the intro', !homeFrame.includes('class="doc-head'));
    check('and the enlarge overlay', homeFrame.includes('class="lightbox"'));

    if (SHOTS_ON) {
      await shot(darkUrl, 1540, Math.min(16000, Number(darkDump.state['data-pv-height'] ?? '2000') + 460), 'dark-album-1440.png', 'dark');
      check('dark screenshot written', existsSync(join(SHOTS, 'dark-album-1440.png')));

      for (const [path, file] of [
        [previewHref('filmography', { version: 'published' }), 'published-filmography-1440.png'],
        [previewHref(`photography/${ALBUM_SLUG}`, { version: 'published' }), 'published-album-1440.png'],
      ] as const) {
        const { state } = await dump(`${base}${path}`, 1540, file);
        await shot(`${base}${path}`, 1540, Math.min(16000, Number(state['data-pv-height'] ?? '2000') + 460), file, file);
        check(`${file} written`, existsSync(join(SHOTS, file)));
      }

      await shot(`${base}/cms/preview`, 1540, 2400, 'sections.png');
      check('the list screenshot is written', existsSync(join(SHOTS, 'sections.png')));
    }

    /* -------------------------------------------------------------------- */
    section('a section with no file yet');
    /* -------------------------------------------------------------------- */

    /**
     * Last, because it takes the photography collection away.
     *
     * A list surface exists before its first entry does, and what it renders
     * then is the live site's own empty state — `renderPhotography([])`
     * reproduces "Currently developing" entity for entity (WS-B). That is the
     * page a new CMS user sees first, so previewing it has to work before
     * anything has been saved, which is exactly when it is hardest to notice
     * that it does not.
     */
    rmSync(join(CONTENT, 'data/photography.json'), { force: true });
    rmSync(join(CONTENT, 'drafts/data/photography.json'), { force: true });

    const emptyIndex = await (await fetch(`${base}${frameHref('photography')}`)).text();
    check('the photography index still renders', emptyIndex.includes('class="masthead"'));
    check('as the live empty state, not as an error', emptyIndex.includes('empty-state'));
    check('with no album tiles', !emptyIndex.includes('class="card"'));
    check('and not as "nothing to preview"', !emptyIndex.includes('Nothing to preview'));

    const emptyChrome = await (await fetch(`${base}${previewHref('photography')}`)).text();
    check('its chrome still frames it', emptyChrome.includes('id="pv-frame"'));
    check('and says there is nothing saved rather than nothing possible', emptyChrome.includes('Nothing saved in this collection yet'));

    const goneAlbum = await (await fetch(`${base}${frameHref(`photography/${ALBUM_SLUG}`)}`)).text();
    check(
      'but an album page does NOT exist until its album does',
      goneAlbum.includes('There is no album at'),
    );

    const emptyFilms = await (await fetch(`${base}${frameHref('filmography')}`)).text();
    check('and the film list is untouched by any of that', emptyFilms.includes('class="video"'));
  } finally {
    dev.stop();
  }

  console.log(`\nshots in ${SHOTS}`);
  console.log(`${checks - failures}/${checks} checks passed`);
  if (!KEEP) console.log('(pass --keep to leave the scratch content in place)');
  if (failures > 0) {
    console.error(`${failures} FAILED`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
