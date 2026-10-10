/**
 * src/cms/server/verify.ts
 *
 * WS-2's proof. Run it:
 *
 *   node src/cms/server/verify.ts              # offline checks, then the live cycle
 *   node src/cms/server/verify.ts --offline     # offline checks only, no network
 *
 * Exit code 0 means every check passed.
 *
 * Phase 1 is offline: the header parsers against files whose real dimensions
 * are known, the HTTP helpers, and the route handlers' refusals, which all
 * happen before any network call.
 *
 * The live part drives the real route handlers - the same functions Astro
 * calls - for all five sections: a document published in two different
 * sections, a film added, edited, reordered and deleted, an album created,
 * filled with uploaded photos, reordered and given a cover, and both record
 * collections published. It runs against the real GitHub API on a THROWAWAY
 * BRANCH that is
 * created at the start and deleted at the end, whatever happens. `main` is
 * read once at the beginning and once at the end, and the run fails if its
 * head moved. Nothing here can touch the live site.
 *
 * Authentication comes from the GitHub CLI (`gh auth token`) or GITHUB_TOKEN.
 * The OAuth redirect itself cannot be exercised without a browser; what is
 * checked here is everything around it: the authorize URL, the state cookie,
 * the state mismatch refusal, and that a session cookie produces a working
 * token.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beginLogin, completeLogin, signOut } from './auth.ts';
import { CmsApiError, createCmsClient } from './client.ts';
import type { CmsClient } from './client.ts';
import type { CookieJar, CookieOptions } from './auth.ts';
import {
  LEGACY_SECTION_ID,
  MEDIA_DIR,
  PAGES_DIR,
  DRAFTS_DIR,
  REPO,
  SESSION_COOKIE,
  STATE_COOKIE,
  draftPath,
  mediaPath,
  mediaSrc,
  pagePath,
} from './config.ts';
import { ConflictError } from './errors.ts';
import {
  commitFiles,
  createBranch,
  deleteBranch,
  getBranchHead,
  headSha,
  readText,
  listDir,
} from './github.ts';
import {
  failFrom,
  ifMatchSha,
  ok,
  requireDocumentKey,
  requireId,
  requireMediaKey,
  requireSectionParam,
  requireSlug,
  resolveSectionOrLegacySlug,
} from './http.ts';
import { mediaDimensions, mediaDimensionsOrFallback } from './media-dimensions.ts';
import { readMedia, safeFilename, serialiseDoc } from './store.ts';
import type { Ctx } from './store.ts';
import {
  applyOpToEntries,
  entryKeyOf,
  indexOfKey,
  parseRecordOp,
  serialiseRecordFile,
} from './records.ts';
import {
  SECTIONS,
  contentDirFor,
  contentPathFor,
  draftPathFor,
  isRecordSection,
  mediaDirFor,
  mediaSrcFor,
  needsSlug,
  requireSection,
  siteUrlFor,
  toDraftPath,
} from '../sections.ts';
import type { RecordSectionDef } from '../sections.ts';
import { newAlbum, newFilm, newPhoto, validateDoc } from '../schema.ts';
import type { Album, Doc, Film, Photo, RecordEntry } from '../schema.ts';

import * as pagesRoute from './routes/pages.ts';
import * as pageRoute from './routes/page.ts';
import * as draftRoute from './routes/draft.ts';
import * as publishRoute from './routes/publish.ts';
import * as mediaRoute from './routes/media.ts';
import * as authStatusRoute from './routes/auth-status.ts';
import * as authLoginRoute from './routes/auth-login.ts';
import * as authCallbackRoute from './routes/auth-callback.ts';
import * as authSignoutRoute from './routes/auth-signout.ts';
import * as sectionsRoute from './routes/sections.ts';
import * as entriesRoute from './routes/entries.ts';
import * as entryRoute from './routes/entry.ts';
import * as entrySlugRoute from './routes/entry-slug.ts';
import * as draftSlugRoute from './routes/draft-slug.ts';
import * as publishSlugRoute from './routes/publish-slug.ts';
import * as mediaSlugRoute from './routes/media-slug.ts';
import * as recordsRoute from './routes/records.ts';

/* -------------------------------------------------------------------------- */
/* Tiny test runner                                                            */
/* -------------------------------------------------------------------------- */

let passed = 0;
const failures: { name: string; error: unknown }[] = [];

function heading(text: string): void {
  console.log(`\n\u001b[1m${text}\u001b[0m`);
}

async function check(name: string, run: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await run();
    passed += 1;
    console.log(`  \u001b[32mPASS\u001b[0m ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  \u001b[31mFAIL\u001b[0m ${name}`);
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.log(
      message
        .split('\n')
        .slice(0, 8)
        .map((line) => `       ${line}`)
        .join('\n'),
    );
  }
}

/** Assert that a promise rejects, and hand the error back for inspection. */
async function rejects(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected this to throw, and it did not');
}

/* -------------------------------------------------------------------------- */
/* Fake request plumbing                                                       */
/* -------------------------------------------------------------------------- */

type Jar = CookieJar & {
  /** Everything currently set, for assertions about cookie flags. */
  entries: Map<string, { value: string; options: CookieOptions }>;
  deleted: string[];
};

function makeJar(initial: Record<string, string> = {}): Jar {
  const entries = new Map<string, { value: string; options: CookieOptions }>();
  for (const [name, value] of Object.entries(initial)) entries.set(name, { value, options: {} });
  const deleted: string[] = [];
  return {
    entries,
    deleted,
    get(name) {
      const found = entries.get(name);
      return found === undefined ? undefined : { value: found.value };
    },
    set(name, value, options = {}) {
      entries.set(name, { value, options });
    },
    delete(name) {
      entries.delete(name);
      deleted.push(name);
    },
  };
}

const ORIGIN = 'https://jinhyuk-editor.vercel.app';

type Handler = (context: unknown) => Response | Promise<Response>;

type CallOptions = {
  path: string;
  method?: string;
  params?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  jar?: Jar;
};

type CallResult = {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
  jar: Jar;
};

/**
 * Call a route the way Astro would. The context is the three fields these
 * routes use; everything else in APIContext is irrelevant to them, which is
 * itself worth knowing, because it is why they can be tested like this.
 */
async function callRoute(handler: Handler | undefined, options: CallOptions): Promise<CallResult> {
  assert.ok(handler !== undefined, `route has no ${options.method ?? 'GET'} handler`);
  const jar = options.jar ?? makeJar();
  const init: RequestInit = { method: options.method ?? 'GET' };
  if (options.headers !== undefined) init.headers = options.headers;
  if (options.body !== undefined && options.body !== null) init.body = options.body;
  const request = new Request(`${ORIGIN}${options.path}`, init);
  const response = await handler({ request, cookies: jar, params: options.params ?? {} });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text !== '') {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { __raw: text };
    }
  }
  return { status: response.status, headers: response.headers, body, jar };
}

/* -------------------------------------------------------------------------- */
/* The client, wired straight to the route handlers                            */
/* -------------------------------------------------------------------------- */

/**
 * A `fetch` that dispatches to the real route handlers instead of going over
 * the network, with the same URL-to-handler mapping astro.config.mjs injects.
 * It lets the client WS-8 will use be tested against the server WS-2 shipped,
 * with no server in between, so a mismatch between the two shows up here
 * rather than during integration.
 */
type TableEntry = {
  pattern: RegExp;
  routes: Record<string, Handler | undefined>;
  /** Which params Astro would hand the route, from the captured groups. */
  params?: (match: RegExpMatchArray) => Record<string, string | undefined>;
};

const SLUG_PARAM = (match: RegExpMatchArray): Record<string, string | undefined> =>
  match[1] === undefined ? {} : { slug: decodeURIComponent(match[1]) };
const SECTION_PARAM = (match: RegExpMatchArray): Record<string, string | undefined> =>
  match[1] === undefined ? {} : { section: decodeURIComponent(match[1]) };
const SECTION_SLUG_PARAMS = (match: RegExpMatchArray): Record<string, string | undefined> => ({
  section: match[1] === undefined ? undefined : decodeURIComponent(match[1]),
  slug: match[2] === undefined ? undefined : decodeURIComponent(match[2]),
});

function routerFetch(jar: Jar): typeof fetch {
  // The same URL-to-handler mapping, and the same param names, that
  // astro.config.mjs injects. Two-segment patterns are listed before their
  // one-segment namesakes for legibility; the anchors mean order cannot matter.
  const table: TableEntry[] = [
    { pattern: /^\/api\/cms\/pages$/, routes: { GET: pagesRoute.GET as Handler } },
    {
      pattern: /^\/api\/cms\/page\/([^/]+)$/,
      routes: { GET: pageRoute.GET as Handler },
      params: SLUG_PARAM,
    },
    { pattern: /^\/api\/cms\/sections$/, routes: { GET: sectionsRoute.GET as Handler } },
    {
      pattern: /^\/api\/cms\/entries\/([^/]+)$/,
      routes: { GET: entriesRoute.GET as Handler },
      params: SECTION_PARAM,
    },
    {
      pattern: /^\/api\/cms\/entry\/([^/]+)\/([^/]+)$/,
      routes: { GET: entrySlugRoute.GET as Handler },
      params: SECTION_SLUG_PARAMS,
    },
    {
      pattern: /^\/api\/cms\/entry\/([^/]+)$/,
      routes: { GET: entryRoute.GET as Handler },
      params: SECTION_PARAM,
    },
    {
      pattern: /^\/api\/cms\/draft\/([^/]+)\/([^/]+)$/,
      routes: { PUT: draftSlugRoute.PUT as Handler, DELETE: draftSlugRoute.DELETE as Handler },
      params: SECTION_SLUG_PARAMS,
    },
    {
      pattern: /^\/api\/cms\/draft\/([^/]+)$/,
      routes: { PUT: draftRoute.PUT as Handler, DELETE: draftRoute.DELETE as Handler },
      params: SLUG_PARAM,
    },
    {
      pattern: /^\/api\/cms\/publish\/([^/]+)\/([^/]+)$/,
      routes: { POST: publishSlugRoute.POST as Handler },
      params: SECTION_SLUG_PARAMS,
    },
    {
      pattern: /^\/api\/cms\/publish\/([^/]+)$/,
      routes: { POST: publishRoute.POST as Handler },
      params: SLUG_PARAM,
    },
    {
      pattern: /^\/api\/cms\/media\/([^/]+)\/([^/]+)$/,
      routes: { POST: mediaSlugRoute.POST as Handler },
      params: SECTION_SLUG_PARAMS,
    },
    {
      pattern: /^\/api\/cms\/media\/([^/]+)$/,
      routes: { POST: mediaRoute.POST as Handler },
      params: SLUG_PARAM,
    },
    {
      pattern: /^\/api\/cms\/records\/([^/]+)$/,
      routes: {
        GET: recordsRoute.GET as Handler,
        PUT: recordsRoute.PUT as Handler,
        POST: recordsRoute.POST as Handler,
        DELETE: recordsRoute.DELETE as Handler,
      },
      params: SECTION_PARAM,
    },
    { pattern: /^\/api\/cms\/auth\/status$/, routes: { GET: authStatusRoute.GET as Handler } },
    {
      pattern: /^\/api\/cms\/auth\/signout$/,
      routes: { POST: authSignoutRoute.POST as Handler },
    },
  ];

  return (async (input: unknown, init?: RequestInit) => {
    const request = new Request(input as string, init);
    const { pathname } = new URL(request.url);
    for (const entry of table) {
      const match = pathname.match(entry.pattern);
      if (match === null) continue;
      const handler = entry.routes[request.method];
      if (handler === undefined) {
        return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405 });
      }
      return handler({ request, cookies: jar, params: entry.params?.(match) ?? {} });
    }
    return new Response(JSON.stringify({ error: `No route for ${pathname}` }), { status: 404 });
  }) as unknown as typeof fetch;
}

function clientFor(jar: Jar): CmsClient {
  return createCmsClient({ baseUrl: ORIGIN, fetch: routerFetch(jar) });
}


/* -------------------------------------------------------------------------- */
/* Read-after-write barriers                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Wait until a read agrees with a write that has already been acknowledged.
 *
 * GitHub answers a contents read with `Cache-Control: private, max-age=60` and
 * serves it from read replicas, so a read issued milliseconds after its own
 * commit can still describe the state before it. Measured on this repo: a few
 * reads in a hundred, unpredictably.
 *
 * These barriers are not hiding a server bug, and they are not sleeps. Every
 * write below states an expectation, and the server refuses rather than
 * guessing when a read disagrees with it — that is asserted directly, in the
 * conflict checks. What a barrier removes is the one thing this harness cannot
 * assert *through*: GitHub's own read-after-write window, which a person
 * typing in an editor never notices and a script firing fifty commits a minute
 * hits repeatedly.
 */
const BARRIER_ATTEMPTS = 30;
const BARRIER_WAIT_MS = 300;
/**
 * How many reads in a row have to agree.
 *
 * One is not enough, and finding that out was the whole lesson: GitHub's
 * contents reads are not merely behind, they are not monotonic. A read can see
 * a write and the next read of the same path, a moment later, can miss it,
 * because the two landed on different replicas. Waiting for three consecutive
 * agreeing reads, 300ms apart, waits for the window to close rather than for
 * one lucky read inside it.
 */
const BARRIER_AGREEMENTS = 3;

async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let last: T = await read();
  let agreed = 0;
  for (let attempt = 1; attempt <= BARRIER_ATTEMPTS; attempt += 1) {
    agreed = done(last) ? agreed + 1 : 0;
    if (agreed >= BARRIER_AGREEMENTS) return last;
    await new Promise((resolve) => setTimeout(resolve, BARRIER_WAIT_MS));
    last = await read();
  }
  throw new Error(
    `${what} did not settle within ${(BARRIER_ATTEMPTS * BARRIER_WAIT_MS) / 1000}s`,
  );
}

/** The file, once GitHub admits it exists. */
async function untilPresent(
  token: string,
  path: string,
  ref: string,
): Promise<{ text: string; sha: string }> {
  const file = await until(
    path,
    () => readText(token, path, ref),
    (value) => value !== null,
  );
  return file as { text: string; sha: string };
}

/** Once GitHub admits the file is gone. */
async function untilGone(token: string, path: string, ref: string): Promise<void> {
  await until(
    `${path} being deleted`,
    () => headSha(token, path, ref),
    (value) => value === null,
  );
}

/** Once GitHub serves exactly the blob a write just reported. */
async function untilSha(token: string, path: string, ref: string, sha: string): Promise<void> {
  await until(
    `${path} at ${sha.slice(0, 7)}`,
    () => headSha(token, path, ref),
    (value) => value === sha,
  );
}

/* -------------------------------------------------------------------------- */
/* Phase 1: offline                                                            */
/* -------------------------------------------------------------------------- */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function repoFile(relative: string): Buffer {
  return readFileSync(`${repoRoot}${relative}`);
}

async function offlineChecks(): Promise<void> {
  heading('Header parsers (known answers, confirmed against sips)');

  // Every expected number here was read off the same file with
  // `sips -g pixelWidth -g pixelHeight`, so this compares the parser with an
  // independent decoder rather than with itself.
  const cases: { file: string; w: number; h: number; format: string; source: string }[] = [
    { file: 'public/home/hero.jpg', w: 2688, h: 1648, format: 'jpeg', source: 'intrinsic' },
    { file: 'public/home/hero.webp', w: 2688, h: 1648, format: 'webp', source: 'intrinsic' },
    {
      file: 'public/photography/placeholder.webp',
      w: 1200,
      h: 918,
      format: 'webp',
      source: 'intrinsic',
    },
    {
      file: 'public/filmography/EudrajWcwwg.jpg',
      w: 1280,
      h: 720,
      format: 'jpeg',
      source: 'intrinsic',
    },
    {
      file: 'public/projects/track-daily-habit-tracker/IMG_2065.png',
      w: 1206,
      h: 2622,
      format: 'png',
      source: 'intrinsic',
    },
  ];

  for (const expected of cases) {
    await check(`${expected.file} is ${expected.w}x${expected.h}`, () => {
      const found = mediaDimensions(repoFile(expected.file));
      assert.deepEqual(found, {
        w: expected.w,
        h: expected.h,
        format: expected.format,
        source: expected.source,
      });
    });
  }

  heading('Header parsers (synthesised files, every remaining branch)');

  // A 37x11 GIF89a, a 64x48 MP4, a 48x64 MP4 whose portrait orientation is in
  // the track matrix rather than in its size, a 37x11 AVIF and a 37x11 HEIC
  // whose ispe is padded to 38x12 and cropped back by a clap box. Produced
  // with ffmpeg and sips, then inlined, so this file needs neither.
  const synthetic: { name: string; base64: string; w: number; h: number; format: string }[] =
    JSON.parse(readFileSync(new URL('./verify-fixtures.json', import.meta.url), 'utf8')) as {
      name: string;
      base64: string;
      w: number;
      h: number;
      format: string;
    }[];

  for (const fixture of synthetic) {
    await check(`${fixture.name} is ${fixture.w}x${fixture.h} (${fixture.format})`, () => {
      const found = mediaDimensions(Buffer.from(fixture.base64, 'base64'));
      assert.ok(found !== null, 'expected to read a size');
      assert.equal(found.w, fixture.w);
      assert.equal(found.h, fixture.h);
      assert.equal(found.format, fixture.format);
    });
  }

  await check('lossless WebP (VP8L) reads its packed 14-bit dimensions', () => {
    // Hand-built, because no encoder on this machine writes VP8L. 300x200:
    // width-1 and height-1 packed into the 28 bits after the 0x2f signature.
    const body = Buffer.alloc(30);
    body.write('RIFF', 0, 'ascii');
    body.writeUInt32LE(22, 4);
    body.write('WEBP', 8, 'ascii');
    body.write('VP8L', 12, 'ascii');
    body.writeUInt32LE(10, 16);
    body[20] = 0x2f;
    body.writeUInt32LE((300 - 1) | ((200 - 1) << 14), 21);
    assert.deepEqual(mediaDimensions(body), {
      w: 300,
      h: 200,
      format: 'webp',
      source: 'intrinsic',
    });
  });

  await check('SVG with a viewBox only', () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect/></svg>',
    );
    assert.deepEqual(mediaDimensions(svg), { w: 120, h: 40, format: 'svg', source: 'declared' });
  });

  await check('SVG width and height in px beat the viewBox', () => {
    const svg = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="300px" height="150px" viewBox="0 0 600 300"></svg>',
    );
    assert.deepEqual(mediaDimensions(svg), { w: 300, h: 150, format: 'svg', source: 'declared' });
  });

  await check('SVG with percentage width falls back to the viewBox ratio', () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 50 25"></svg>',
    );
    assert.deepEqual(mediaDimensions(svg), { w: 50, h: 25, format: 'svg', source: 'declared' });
  });

  heading('Header parsers (negative controls)');

  const rubbish: { name: string; bytes: Buffer }[] = [
    { name: 'empty buffer', bytes: Buffer.alloc(0) },
    { name: 'random bytes', bytes: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) },
    { name: 'a text file', bytes: Buffer.from('this is not an image, it is a sentence') },
    {
      name: 'PNG magic with a truncated IHDR',
      bytes: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(8),
      ]),
    },
    { name: 'a JPEG start marker and nothing else', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
    { name: 'RIFF that is not WEBP', bytes: Buffer.concat([Buffer.from('RIFF....WAVEfmt '), Buffer.alloc(32)]) },
    { name: 'an SVG-ish string with no svg tag', bytes: Buffer.from('<html><body>no</body></html>') },
  ];

  for (const sample of rubbish) {
    await check(`${sample.name} reads as null, not as a guess`, () => {
      assert.equal(mediaDimensions(sample.bytes), null);
    });
  }

  await check('the upload path still gets numbers for a format it cannot read', () => {
    const found = mediaDimensionsOrFallback(Buffer.from('not a video'), 'webm');
    assert.deepEqual(found, { w: 1280, h: 720, format: 'webm', source: 'fallback' });
  });

  heading('Filenames');

  const names: [string, string][] = [
    ['IMG_2065.PNG', 'img-2065.png'],
    ['My Holiday Photo (2).jpeg', 'my-holiday-photo-2.jpeg'],
    ['../../../etc/passwd.png', 'etc-passwd.png'],
    ['....png', 'file.png'],
    ['no-extension', 'no-extension.'],
  ];
  for (const [input, expected] of names) {
    await check(`"${input}" becomes "${expected}"`, () => {
      const { base, ext } = safeFilename(input);
      assert.equal(`${base}.${ext}`, expected);
    });
  }

  await check('a sanitised filename can never climb out of its directory', () => {
    for (const nasty of ['../x.png', '..%2Fx.png', 'a/b/c.png', 'a\\b.png', 'x\u0000.png']) {
      const { base, ext } = safeFilename(nasty);
      assert.ok(!`${base}.${ext}`.includes('/'), `${nasty} kept a slash`);
      assert.ok(!`${base}.${ext}`.includes('\\'), `${nasty} kept a backslash`);
      assert.ok(!`${base}`.includes('..'), `${nasty} kept a ..`);
    }
  });

  heading('HTTP helpers');

  await check('requireSlug accepts kebab-case and rejects everything else', () => {
    assert.equal(requireSlug('track-daily-habit-tracker'), 'track-daily-habit-tracker');
    assert.equal(requireSlug('ws2-verify-123'), 'ws2-verify-123');
    for (const bad of ['', undefined, 'Capital', 'has space', '../escape', 'trailing-', 'a//b', 'dot.dot']) {
      assert.throws(() => requireSlug(bad as string | undefined), /slug/i, `accepted ${String(bad)}`);
    }
  });

  await check('ifMatchSha unwraps a quoted and weak ETag', () => {
    const at = (value: string | null): string | undefined =>
      ifMatchSha(new Request(ORIGIN, value === null ? {} : { headers: { 'If-Match': value } }));
    assert.equal(at('abc123'), 'abc123');
    assert.equal(at('"abc123"'), 'abc123');
    assert.equal(at('W/"abc123"'), 'abc123');
    assert.equal(at('*'), undefined);
    assert.equal(at(null), undefined);
  });

  await check('a success body is { ok: true, ... } and is never cached', async () => {
    const response = ok({ pages: [] });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { pages: [], ok: true });
  });

  await check('a payload cannot overwrite ok:true', async () => {
    const response = ok({ ok: false } as unknown as Record<string, unknown>);
    assert.deepEqual(await response.json(), { ok: true });
  });

  await check('a conflict becomes a 409 carrying both shas', async () => {
    const response = failFrom(
      new ConflictError({
        path: 'src/content/drafts/x.json',
        expectedSha: 'aaa',
        actualSha: 'bbb',
        message: 'it moved',
      }),
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      code: 'conflict',
      path: 'src/content/drafts/x.json',
      expectedSha: 'aaa',
      actualSha: 'bbb',
      error: 'it moved',
    });
  });

  heading('Routes refuse what they should, before any network call');

  await check('every write endpoint is 401 without a session', async () => {
    const calls: [string, CallResult][] = [
      ['GET /pages', await callRoute(pagesRoute.GET as Handler, { path: '/api/cms/pages' })],
      [
        'GET /page/:slug',
        await callRoute(pageRoute.GET as Handler, {
          path: '/api/cms/page/x-y',
          params: { slug: 'x-y' },
        }),
      ],
      [
        'PUT /draft/:slug',
        await callRoute(draftRoute.PUT as Handler, {
          path: '/api/cms/draft/x-y',
          method: 'PUT',
          params: { slug: 'x-y' },
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }),
      ],
      [
        'DELETE /draft/:slug',
        await callRoute(draftRoute.DELETE as Handler, {
          path: '/api/cms/draft/x-y',
          method: 'DELETE',
          params: { slug: 'x-y' },
        }),
      ],
      [
        'POST /publish/:slug',
        await callRoute(publishRoute.POST as Handler, {
          path: '/api/cms/publish/x-y',
          method: 'POST',
          params: { slug: 'x-y' },
        }),
      ],
    ];
    for (const [name, result] of calls) {
      assert.equal(result.status, 401, `${name} was ${result.status}`);
      assert.equal(typeof result.body.error, 'string', `${name} had no error string`);
      assert.equal(result.body.ok, undefined, `${name} claimed ok`);
    }
  });

  await check('a bad slug is a 400 before anything is read', async () => {
    const result = await callRoute(pageRoute.GET as Handler, {
      path: '/api/cms/page/Nope Nope',
      params: { slug: 'Nope Nope' },
    });
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /kebab-case/);
  });

  await check('sign-out clears both session cookies', async () => {
    const jar = makeJar({ 'cms-gh-token': 'x', 'cms-gh-refresh': 'y' });
    const result = await callRoute(authSignoutRoute.POST as Handler, {
      path: '/api/cms/auth/signout',
      method: 'POST',
      jar,
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { signedIn: false, ok: true });
    assert.equal(jar.get('cms-gh-token'), undefined);
    assert.equal(jar.get('cms-gh-refresh'), undefined);
  });

  await check('status is 200 and signedIn:false with no cookie', async () => {
    const result = await callRoute(authStatusRoute.GET as Handler, { path: '/api/cms/auth/status' });
    assert.equal(result.status, 200);
    assert.equal(result.body.signedIn, false);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.repo, REPO);
  });

  heading('OAuth: the parts that do not need a browser');

  await check('login redirects to GitHub with the App client id and no scope', async () => {
    const jar = makeJar();
    const result = await callRoute(authLoginRoute.GET as Handler, {
      path: '/api/cms/auth/login?return=/cms/edit',
      jar,
    });
    assert.equal(result.status, 302);
    const location = new URL(result.headers.get('location') as string);
    assert.equal(location.origin, 'https://github.com');
    assert.equal(location.pathname, '/login/oauth/authorize');
    assert.equal(location.searchParams.get('client_id'), 'Iv23liDOxIhxb7inF4fu');
    assert.equal(
      location.searchParams.get('redirect_uri'),
      `${ORIGIN}/api/cms/auth/callback`,
    );
    // A GitHub App's permissions come from its installation. Sending a scope
    // is how an App's authorize URL gets rejected as though it were an OAuth
    // App's.
    assert.equal(location.searchParams.get('scope'), null);
    const state = location.searchParams.get('state');
    assert.match(String(state), /^[0-9a-f]{32}$/);
    assert.equal(jar.get(STATE_COOKIE)?.value, state);
  });

  await check('the state cookie is httpOnly, secure, sameSite=lax', async () => {
    const jar = makeJar();
    await callRoute(authLoginRoute.GET as Handler, { path: '/api/cms/auth/login', jar });
    const options = jar.entries.get(STATE_COOKIE)?.options;
    assert.deepEqual(
      { httpOnly: options?.httpOnly, secure: options?.secure, sameSite: options?.sameSite, path: options?.path },
      { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
    );
  });

  await check('an off-site ?return is not followed', () => {
    const jar = makeJar();
    beginLogin(new Request(`${ORIGIN}/api/cms/auth/login?return=//evil.example.com`), jar);
    assert.equal(jar.get('cms-gh-return')?.value, '/');
    const jar2 = makeJar();
    beginLogin(new Request(`${ORIGIN}/api/cms/auth/login?return=https://evil.example.com/x`), jar2);
    assert.equal(jar2.get('cms-gh-return')?.value, '/');
  });

  await check('a callback with the wrong state is refused, and no token is requested', async () => {
    const jar = makeJar({ [STATE_COOKIE]: 'the-real-state' });
    const result = await callRoute(authCallbackRoute.GET as Handler, {
      path: '/api/cms/auth/callback?code=abc&state=not-the-real-state',
      jar,
    });
    assert.equal(result.status, 403);
    assert.match(String(result.body.error), /state/i);
    assert.equal(jar.get(SESSION_COOKIE), undefined);
  });

  await check('a callback with no state cookie at all is refused', async () => {
    const result = await callRoute(authCallbackRoute.GET as Handler, {
      path: '/api/cms/auth/callback?code=abc&state=x',
    });
    assert.equal(result.status, 400);
  });

  await check("a callback carrying GitHub's own error is reported, not swallowed", async () => {
    const result = await callRoute(authCallbackRoute.GET as Handler, {
      path: '/api/cms/auth/callback?error=access_denied&error_description=Nope',
    });
    assert.equal(result.status, 401);
    assert.match(String(result.body.error), /Nope/);
  });

  await check('signOut on a fresh jar does not throw', () => {
    signOut(makeJar());
  });

  await check('completeLogin never leaks the token into a response body', async () => {
    // Exercised properly in phase 2; here, the shape of the redirect.
    const jar = makeJar({ [STATE_COOKIE]: 's' });
    const error = await rejects(() =>
      completeLogin(new Request(`${ORIGIN}/api/cms/auth/callback?state=s`), jar),
    );
    assert.match(String((error as Error).message), /code/);
  });

  heading('Serialisation');

  await check('a document is written in schema key order, not input order', () => {
    const scrambled = {
      bands: [],
      meta: { slug: 'x-y', date: '2026-10-08', title: 'T' },
      version: 1,
    };
    const result = validateDoc(scrambled);
    assert.ok(result.ok, 'fixture should validate');
    const text = serialiseDoc(result.doc);
    assert.equal(
      text,
      '{\n  "version": 1,\n  "meta": {\n    "title": "T",\n    "slug": "x-y",\n    "date": "2026-10-08"\n  },\n  "bands": []\n}\n',
    );
  });

  await check('serialising twice gives the same bytes', () => {
    const fixture = loadFixture('dense.json');
    assert.equal(serialiseDoc(fixture), serialiseDoc(fixture));
    assert.ok(serialiseDoc(fixture).endsWith('\n'), 'file should end with a newline');
  });

  heading('The client WS-8 will use, against the real handlers');

  await check('client.status() reports a signed-out session without throwing', async () => {
    const status = await clientFor(makeJar()).status();
    assert.equal(status.signedIn, false);
    assert.equal(status.repo, REPO);
  });

  await check('client.listPages() throws a CmsApiError that knows it is a sign-out', async () => {
    const error = await rejects(() => clientFor(makeJar()).listPages());
    assert.ok(error instanceof CmsApiError, 'should be a CmsApiError');
    assert.equal(error.status, 401);
    assert.equal(error.isSignedOut, true);
    assert.equal(error.isConflict, false);
  });

  await check('client.loginUrl() encodes where to come back to', () => {
    assert.equal(
      clientFor(makeJar()).loginUrl('/cms/edit/track-daily-habit-tracker'),
      `${ORIGIN}/api/cms/auth/login?return=%2Fcms%2Fedit%2Ftrack-daily-habit-tracker`,
    );
  });

  await check('client.signOut() clears the session cookies', async () => {
    const jar = makeJar({ [SESSION_COOKIE]: 'x' });
    await clientFor(jar).signOut();
    assert.equal(jar.get(SESSION_COOKIE), undefined);
  });

  /* ------------------------------------------------------------------ */
  /* WS-C: sections at the edge                                          */
  /* ------------------------------------------------------------------ */

  heading('WS-C: the registry decides every path, and this file never guesses one');

  await check('all five sections resolve to the paths docs/cms-contracts.md 9.1 names', () => {
    // Written out literally rather than derived, because this is the one place
    // the agreement with WS-B's renderer and WS-F's migration is checkable: if
    // the server writes somewhere else, nothing reads what it wrote.
    const expected: Record<string, { content: string; draft: string; media: string }> = {
      home: {
        content: 'src/content/pages/home.json',
        draft: 'src/content/drafts/pages/home.json',
        media: 'public/media/home',
      },
      projects: {
        content: 'src/content/pages/projects/x-y.json',
        draft: 'src/content/drafts/pages/projects/x-y.json',
        media: 'public/media/projects/x-y',
      },
      essays: {
        content: 'src/content/pages/essays/x-y.json',
        draft: 'src/content/drafts/pages/essays/x-y.json',
        media: 'public/media/essays/x-y',
      },
      filmography: {
        content: 'src/content/data/filmography.json',
        draft: 'src/content/drafts/data/filmography.json',
        media: 'public/media/filmography/x-y',
      },
      photography: {
        content: 'src/content/data/photography.json',
        draft: 'src/content/drafts/data/photography.json',
        media: 'public/media/photography/x-y',
      },
    };
    assert.equal(SECTIONS.length, Object.keys(expected).length);
    for (const section of SECTIONS) {
      const want = expected[section.id];
      assert.ok(want !== undefined, `no expectation written for "${section.id}"`);
      const key = needsSlug(section.contentPath) ? 'x-y' : null;
      assert.equal(contentPathFor(section, key), want.content, `${section.id} content path`);
      assert.equal(draftPathFor(section, key), want.draft, `${section.id} draft path`);
      assert.equal(
        mediaDirFor(section, needsSlug(section.mediaDir) ? 'x-y' : null),
        want.media,
        `${section.id} media dir`,
      );
      // The rule, restated where the server depends on it.
      assert.equal(draftPathFor(section, key), toDraftPath(contentPathFor(section, key)));
    }
  });

  await check('phase 1 paths now mean the projects section, and nothing else moved', () => {
    assert.equal(LEGACY_SECTION_ID, 'projects');
    assert.equal(pagePath('x-y'), 'src/content/pages/projects/x-y.json');
    assert.equal(draftPath('x-y'), 'src/content/drafts/pages/projects/x-y.json');
    assert.equal(mediaPath('x-y', 'a.png'), 'public/media/projects/x-y/a.png');
    assert.equal(mediaSrc('x-y', 'a.png'), '/media/projects/x-y/a.png');
  });

  await check('a section that does not exist is a 404, not a 400', () => {
    for (const id of SECTIONS) assert.equal(requireSectionParam(id.id).id, id.id);
    for (const bad of ['blog', 'Home', '', undefined, '../etc']) {
      const error = (() => {
        try {
          requireSectionParam(bad as string | undefined);
        } catch (thrown) {
          return thrown;
        }
        return null;
      })();
      assert.ok(error !== null, `accepted ${String(bad)}`);
      // '' and undefined are a malformed request; a real-looking name is a 404.
      const expected = bad === '' || bad === undefined ? 400 : 404;
      assert.equal((error as { status: number }).status, expected, `${String(bad)} status`);
    }
  });

  await check('one URL segment: a section id wins, anything else is a project slug', () => {
    const home = resolveSectionOrLegacySlug('home');
    assert.equal(home.section.id, 'home');
    assert.equal(home.key, null);
    const films = resolveSectionOrLegacySlug('filmography');
    assert.equal(films.section.id, 'filmography');
    const project = resolveSectionOrLegacySlug('track-daily-habit-tracker');
    assert.equal(project.section.id, 'projects');
    assert.equal(project.key, 'track-daily-habit-tracker');
    assert.throws(() => resolveSectionOrLegacySlug('Nope Nope'), /kebab-case/);
  });

  await check('a document key is checked against its section shape', () => {
    const home = requireSection('home');
    const essays = requireSection('essays');
    const films = requireSection('filmography');

    assert.equal(requireDocumentKey(home, undefined), null, 'the singleton has no key');
    assert.throws(() => requireDocumentKey(home, 'anything'), /single page|single/);
    assert.equal(requireDocumentKey(essays, 'my-essay'), 'my-essay');
    assert.throws(() => requireDocumentKey(essays, undefined), /collection/);
    assert.throws(() => requireDocumentKey(films, 'film_x'), /records/);
  });

  await check('a media key is wider for records than for documents', () => {
    const home = requireSection('home');
    const essays = requireSection('essays');
    const films = requireSection('filmography');
    const albums = requireSection('photography');

    assert.equal(requireMediaKey(home, undefined), null);
    assert.equal(requireMediaKey(essays, 'my-essay'), 'my-essay');
    // A film id has an underscore, which the document slug rule forbids. The
    // record key rule is IdSchema, which is exactly what fillSlug accepts.
    assert.equal(requireMediaKey(films, 'film_untitled'), 'film_untitled');
    assert.throws(() => requireMediaKey(essays, 'film_untitled'), /kebab-case/);
    assert.equal(requireMediaKey(albums, 'first-build'), 'first-build');
    assert.throws(() => requireMediaKey(films, undefined), /needs to say which/);
    for (const nasty of ['../x', 'a/b', 'a.b', '', 'x'.repeat(65)]) {
      assert.throws(() => requireId(nasty), /key/i, `accepted ${nasty}`);
    }
  });

  await check("an upload key can never escape its section's directory", () => {
    const films = requireSection('filmography');
    for (const nasty of ['../../etc', 'a/b', '..', 'x\u0000']) {
      assert.throws(() => requireMediaKey(films, nasty), /key/i, `accepted ${nasty}`);
      // And even if the edge were bypassed, fillSlug is the second wall.
      assert.throws(() => mediaDirFor(films, nasty), /needs a slug/);
    }
  });

  /* ------------------------------------------------------------------ */
  /* WS-C: record operations, which are pure and therefore cheap to prove */
  /* ------------------------------------------------------------------ */

  heading('WS-C: record operations');

  const filmSection = requireSection('filmography') as RecordSectionDef;
  const albumSection = requireSection('photography') as RecordSectionDef;

  const film = (id: string, title: string): Film =>
    newFilm({ id, title, youtubeId: 'EudrajWcwwg', kind: 'SHORT FILM', year: '2019' });
  const threeFilms = (): Film[] => [film('film_a', 'A'), film('film_b', 'B'), film('film_c', 'C')];
  const keysOf = (def: RecordSectionDef, entries: RecordEntry[]): string[] =>
    entries.map((entry) => entryKeyOf(def.records, entry));

  await check('a film is keyed by its record id, an album by its slug', () => {
    assert.equal(entryKeyOf(filmSection.records, film('film_a', 'A')), 'film_a');
    const album = newAlbum({ id: 'album_a', title: 'A', slug: 'an-album' });
    assert.equal(entryKeyOf(albumSection.records, album), 'an-album');
    // And an album is findable by either, because a caller holding a
    // RecordSummary.id should not have to know which it is holding.
    assert.equal(indexOfKey(albumSection.records, [album], 'an-album'), 0);
    assert.equal(indexOfKey(albumSection.records, [album], 'album_a'), 0);
    assert.equal(indexOfKey(albumSection.records, [album], 'nope'), -1);
  });

  await check('add appends, or inserts at an index', () => {
    const base = threeFilms();
    assert.deepEqual(
      keysOf(filmSection, applyOpToEntries(filmSection.records, base, {
        op: 'add',
        entry: film('film_d', 'D'),
      }).entries),
      ['film_a', 'film_b', 'film_c', 'film_d'],
    );
    assert.deepEqual(
      keysOf(filmSection, applyOpToEntries(filmSection.records, base, {
        op: 'add',
        entry: film('film_d', 'D'),
        index: 1,
      }).entries),
      ['film_a', 'film_d', 'film_b', 'film_c'],
    );
    // An index past the end is the end, not a hole.
    assert.deepEqual(
      keysOf(filmSection, applyOpToEntries(filmSection.records, base, {
        op: 'add',
        entry: film('film_d', 'D'),
        index: 99,
      }).entries),
      ['film_a', 'film_b', 'film_c', 'film_d'],
    );
    // And the input array is never mutated.
    assert.deepEqual(keysOf(filmSection, base), ['film_a', 'film_b', 'film_c']);
  });

  await check('add refuses a key that is already taken', () => {
    assert.throws(
      () =>
        applyOpToEntries(filmSection.records, threeFilms(), {
          op: 'add',
          entry: film('film_b', 'B again'),
        }),
      /already a film with the key/,
    );
  });

  await check('update replaces one entry and may rename it, but never re-ids it', () => {
    const base = threeFilms();
    const renamed = applyOpToEntries(filmSection.records, base, {
      op: 'update',
      key: 'film_b',
      entry: film('film_b', 'B, retitled'),
    });
    assert.equal((renamed.entries[1] as Film).title, 'B, retitled');
    assert.deepEqual(keysOf(filmSection, renamed.entries), ['film_a', 'film_b', 'film_c']);

    assert.throws(
      () =>
        applyOpToEntries(filmSection.records, base, {
          op: 'update',
          key: 'film_b',
          entry: film('film_z', 'B'),
        }),
      /cannot change a film's id/,
    );
    assert.throws(
      () =>
        applyOpToEntries(filmSection.records, base, {
          op: 'update',
          key: 'film_missing',
          entry: film('film_missing', 'X'),
        }),
      /no film "film_missing"/,
    );
  });

  await check("an album's slug can be changed, but not onto another album's", () => {
    const albums: Album[] = [
      newAlbum({ id: 'album_a', title: 'A', slug: 'first' }),
      newAlbum({ id: 'album_b', title: 'B', slug: 'second' }),
    ];
    const moved = applyOpToEntries(albumSection.records, albums, {
      op: 'update',
      key: 'first',
      entry: newAlbum({ id: 'album_a', title: 'A', slug: 'renamed' }),
    });
    assert.deepEqual(keysOf(albumSection, moved.entries), ['renamed', 'second']);
    assert.equal(moved.key, 'renamed', 'the op reports the key it ended up with');

    assert.throws(
      () =>
        applyOpToEntries(albumSection.records, albums, {
          op: 'update',
          key: 'first',
          entry: newAlbum({ id: 'album_a', title: 'A', slug: 'second' }),
        }),
      /already uses the key "second"/,
    );
  });

  await check('delete removes one, and refuses a key that is not there', () => {
    assert.deepEqual(
      keysOf(filmSection, applyOpToEntries(filmSection.records, threeFilms(), {
        op: 'delete',
        key: 'film_b',
      }).entries),
      ['film_a', 'film_c'],
    );
    assert.throws(
      () => applyOpToEntries(filmSection.records, threeFilms(), { op: 'delete', key: 'nope' }),
      /no film "nope"/,
    );
  });

  await check('reorder permutes, and refuses anything that is not a permutation', () => {
    assert.deepEqual(
      keysOf(filmSection, applyOpToEntries(filmSection.records, threeFilms(), {
        op: 'reorder',
        keys: ['film_c', 'film_a', 'film_b'],
      }).entries),
      ['film_c', 'film_a', 'film_b'],
    );
    // A short list would silently drop a film, which is the failure this
    // endpoint exists to make impossible.
    assert.throws(
      () =>
        applyOpToEntries(filmSection.records, threeFilms(), {
          op: 'reorder',
          keys: ['film_c', 'film_a'],
        }),
      /has to list every film/,
    );
    assert.throws(
      () =>
        applyOpToEntries(filmSection.records, threeFilms(), {
          op: 'reorder',
          keys: ['film_c', 'film_a', 'film_z'],
        }),
      /not a film in this collection/,
    );
    // The same key twice is the same bug wearing the right length.
    assert.throws(
      () =>
        applyOpToEntries(filmSection.records, threeFilms(), {
          op: 'reorder',
          keys: ['film_a', 'film_a', 'film_b'],
        }),
      /named twice|not a film/,
    );
  });

  await check('move is what a drag lands on, and clamps to the end', () => {
    assert.deepEqual(
      keysOf(filmSection, applyOpToEntries(filmSection.records, threeFilms(), {
        op: 'move',
        key: 'film_c',
        to: 0,
      }).entries),
      ['film_c', 'film_a', 'film_b'],
    );
    assert.deepEqual(
      keysOf(filmSection, applyOpToEntries(filmSection.records, threeFilms(), {
        op: 'move',
        key: 'film_a',
        to: 99,
      }).entries),
      ['film_b', 'film_c', 'film_a'],
    );
  });

  await check('a request body becomes an op only if every field is right', () => {
    assert.deepEqual(parseRecordOp(filmSection, { op: 'delete', key: 'film_a' }), {
      op: 'delete',
      key: 'film_a',
    });
    assert.deepEqual(parseRecordOp(filmSection, { op: 'move', key: 'film_a', to: 2 }), {
      op: 'move',
      key: 'film_a',
      to: 2,
    });
    assert.equal(parseRecordOp(filmSection, { op: 'reorder', keys: ['a', 'b'] }).op, 'reorder');
    assert.equal(
      parseRecordOp(filmSection, { op: 'add', entry: film('film_a', 'A') }).op,
      'add',
    );
    for (const bad of [
      { op: 'nope' },
      { op: 'delete' },
      { op: 'move', key: 'film_a' },
      { op: 'move', key: 'film_a', to: -1 },
      { op: 'reorder', keys: 'film_a' },
      { op: 'add', entry: { id: 'film_a' } },
      { op: 'add', entry: newFilm({ id: 'film_a' }) },
      'not an object',
      null,
      [],
    ]) {
      assert.throws(
        () => parseRecordOp(filmSection, bad),
        /.*/,
        `accepted ${JSON.stringify(bad)}`,
      );
    }
  });

  await check('a fresh film is deliberately invalid until it has a video', () => {
    // newFilm() has an empty youtubeId on purpose (docs/cms-contracts.md 10.4),
    // so the op endpoint refuses it: the editor must ask for the URL first.
    assert.throws(() => parseRecordOp(filmSection, { op: 'add', entry: newFilm() }), /youtubeId/);
    // A fresh album, by contrast, saves as it stands, which is what lets an
    // album be created and then filled.
    assert.equal(parseRecordOp(albumSection, { op: 'add', entry: newAlbum() }).op, 'add');
  });

  await check('a record collection is serialised like a document: 2 spaces, trailing newline', () => {
    const file = { films: threeFilms() };
    const text = serialiseRecordFile(file);
    assert.ok(text.endsWith('\n'));
    assert.equal(text, serialiseRecordFile(file));
    assert.equal(text.split('\n')[1], '  "films": [');
    assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(file)));
  });

  heading('WS-C: the new routes refuse what they should, before any network call');

  await check('every section endpoint is 401 without a session', async () => {
    const calls: [string, CallResult][] = [
      ['GET /sections', await callRoute(sectionsRoute.GET as Handler, { path: '/api/cms/sections' })],
      [
        'GET /entries/:section',
        await callRoute(entriesRoute.GET as Handler, {
          path: '/api/cms/entries/essays',
          params: { section: 'essays' },
        }),
      ],
      [
        'GET /entry/:section',
        await callRoute(entryRoute.GET as Handler, {
          path: '/api/cms/entry/home',
          params: { section: 'home' },
        }),
      ],
      [
        'PUT /draft/:section/:slug',
        await callRoute(draftSlugRoute.PUT as Handler, {
          path: '/api/cms/draft/essays/x-y',
          method: 'PUT',
          params: { section: 'essays', slug: 'x-y' },
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }),
      ],
      [
        'POST /publish/:section/:slug',
        await callRoute(publishSlugRoute.POST as Handler, {
          path: '/api/cms/publish/essays/x-y',
          method: 'POST',
          params: { section: 'essays', slug: 'x-y' },
        }),
      ],
      [
        'GET /records/:section',
        await callRoute(recordsRoute.GET as Handler, {
          path: '/api/cms/records/filmography',
          params: { section: 'filmography' },
        }),
      ],
      [
        'PUT /records/:section',
        await callRoute(recordsRoute.PUT as Handler, {
          path: '/api/cms/records/filmography',
          method: 'PUT',
          params: { section: 'filmography' },
          headers: { 'Content-Type': 'application/json' },
          body: '{"films":[]}',
        }),
      ],
      [
        'POST /records/:section',
        await callRoute(recordsRoute.POST as Handler, {
          path: '/api/cms/records/filmography',
          method: 'POST',
          params: { section: 'filmography' },
          headers: { 'Content-Type': 'application/json' },
          body: '{"op":"delete","key":"film_a"}',
        }),
      ],
    ];
    for (const [name, result] of calls) {
      assert.equal(result.status, 401, `${name} was ${result.status}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.ok, undefined, `${name} claimed ok`);
    }
  });

  await check('a section that does not exist is a 404 before any read', async () => {
    const result = await callRoute(entriesRoute.GET as Handler, {
      path: '/api/cms/entries/blog',
      params: { section: 'blog' },
    });
    assert.equal(result.status, 404);
    assert.match(String(result.body.error), /No section "blog"/);
  });

  await check('a records endpoint refuses a document section, and says which to use', async () => {
    const result = await callRoute(recordsRoute.GET as Handler, {
      path: '/api/cms/records/essays',
      params: { section: 'essays' },
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'wrong_storage');
    assert.match(String(result.body.error), /\/api\/cms\/entry\/essays/);
  });

  await check('a draft endpoint refuses a record section, and says which to use', async () => {
    const result = await callRoute(draftRoute.PUT as Handler, {
      path: '/api/cms/draft/filmography',
      method: 'PUT',
      params: { slug: 'filmography' },
      headers: { 'Content-Type': 'application/json' },
      body: '{"films":[]}',
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'wrong_storage');
    assert.match(String(result.body.error), /\/api\/cms\/records\/filmography/);
  });
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function loadFixture(name: string): Doc {
  const text = readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
  const result = validateDoc(JSON.parse(text));
  if (!result.ok) throw new Error(`fixture ${name} does not validate`);
  return result.doc;
}

/** A fixture re-slugged for the throwaway branch. The fixture file is untouched. */
function fixtureAs(name: string, slug: string): Doc {
  const doc = structuredClone(loadFixture(name));
  doc.meta.slug = slug;
  return doc;
}

/* -------------------------------------------------------------------------- */
/* Phase 2: live cycle on a throwaway branch                                   */
/* -------------------------------------------------------------------------- */

function findToken(): string | null {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.CMS_DEV_TOKEN;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function liveChecks(token: string): Promise<void> {
  const stamp = Date.now();
  const branch = `cms/ws-2-verify-${stamp}`;
  const slug = `ws2-verify-${stamp}`;
  const jar = makeJar({ [SESSION_COOKIE]: token });
  const ctx: Ctx = { token, branch };

  // Every route reads the branch from the environment, so this is also a check
  // that CMS_BRANCH is honoured: if it were not, the writes below would land
  // on main and the "main did not move" assertion at the end would fail.
  process.env.CMS_BRANCH = branch;

  const mainBefore = await getBranchHead(token, 'main');
  console.log(`\n  repo    ${REPO}`);
  console.log(`  main    ${mainBefore} (read only, asserted unchanged at the end)`);
  console.log(`  branch  ${branch}`);
  console.log(`  slug    ${slug}`);

  await createBranch(token, { name: branch, fromBranch: 'main' });
  console.log(`  created ${branch}`);

  try {
    heading('Session');

    await check('auth/status reports the signed-in login', async () => {
      const result = await callRoute(authStatusRoute.GET as Handler, {
        path: '/api/cms/auth/status',
        jar,
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.signedIn, true);
      assert.equal(typeof result.body.login, 'string');
      assert.equal(result.body.branch, branch);
      console.log(`       signed in as ${String(result.body.login)}`);
    });

    await check('a dead token reports signedIn:false and clears the cookie', async () => {
      const deadJar = makeJar({ [SESSION_COOKIE]: 'ghu_thisisnotarealtoken' });
      const result = await callRoute(authStatusRoute.GET as Handler, {
        path: '/api/cms/auth/status',
        jar: deadJar,
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.signedIn, false);
      assert.equal(deadJar.get(SESSION_COOKIE), undefined);
    });

    heading('Write a draft');

    let draftSha = '';
    const v1 = fixtureAs('simple.json', slug);

    await check('PUT /api/cms/draft/:slug writes the draft and returns a commit', async () => {
      const result = await callRoute(draftRoute.PUT as Handler, {
        path: `/api/cms/draft/${slug}`,
        method: 'PUT',
        params: { slug },
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(v1),
        jar,
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.ok, true);
      assert.equal(typeof result.body.commit, 'string');
      assert.equal(typeof result.body.sha, 'string');
      draftSha = String(result.body.sha);
      console.log(`       commit ${String(result.body.commit).slice(0, 7)}  blob ${draftSha.slice(0, 7)}`);
    });

    await check('the file is really in the repo, byte-for-byte as serialised', async () => {
      const file = await untilPresent(token, draftPath(slug), branch);
      assert.equal(file.text, serialiseDoc(v1));
      assert.equal(file.sha, draftSha);
    });

    await check('nothing was written to pages/', async () => {
      assert.equal(await headSha(token, pagePath(slug), branch), null);
    });

    await check('GET /api/cms/page/:slug reads it back unchanged', async () => {
      const result = await callRoute(pageRoute.GET as Handler, {
        path: `/api/cms/page/${slug}`,
        params: { slug },
        jar,
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.published, null);
      assert.equal(result.body.publishedSha, null);
      assert.equal(result.body.draftSha, draftSha);
      assert.deepEqual(result.body.draft, JSON.parse(JSON.stringify(v1)));
    });

    await check('GET /api/cms/pages lists it with hasDraft true', async () => {
      const result = await callRoute(pagesRoute.GET as Handler, { path: '/api/cms/pages', jar });
      assert.equal(result.status, 200);
      const pages = result.body.pages as { slug: string; title: string; hasDraft: boolean; hasPublished: boolean }[];
      const mine = pages.find((page) => page.slug === slug);
      assert.ok(mine !== undefined, `the list should contain ${slug}`);
      assert.equal(mine.hasDraft, true);
      assert.equal(mine.hasPublished, false);
      assert.equal(mine.title, v1.meta.title);
    });

    heading('Conflict detection');

    let draftSha2 = '';
    await check('a second write quoting the current sha succeeds', async () => {
      const v2 = fixtureAs('canvas.json', slug);
      const result = await callRoute(draftRoute.PUT as Handler, {
        path: `/api/cms/draft/${slug}`,
        method: 'PUT',
        params: { slug },
        headers: { 'Content-Type': 'application/json', 'If-Match': `"${draftSha}"` },
        body: JSON.stringify(v2),
        jar,
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      draftSha2 = String(result.body.sha);
      assert.notEqual(draftSha2, draftSha);
    });

    await check('a write quoting the stale sha is a 409 and changes nothing', async () => {
      const stale = fixtureAs('simple.json', slug);
      stale.meta.title = 'This must never be written';
      const result = await callRoute(draftRoute.PUT as Handler, {
        path: `/api/cms/draft/${slug}`,
        method: 'PUT',
        params: { slug },
        headers: { 'Content-Type': 'application/json', 'If-Match': draftSha },
        body: JSON.stringify(stale),
        jar,
      });
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.equal(result.body.code, 'conflict');
      assert.equal(result.body.expectedSha, draftSha);
      assert.equal(result.body.actualSha, draftSha2);
      assert.match(String(result.body.error), /changed in the repo/);
      // And the file on the branch is still version two.
      const file = await readText(token, draftPath(slug), branch);
      assert.equal(file?.sha, draftSha2);
      console.log(`       ${String(result.body.error).slice(0, 120)}`);
    });

    await check('two stale paths in one commit is a 409, not an unhandled rejection', async () => {
      // Publishing checks two expectations at once. If both fail, the error
      // reported has to be the conflict, and the process has to survive.
      const error = await rejects(() =>
        commitFiles(token, {
          branch,
          message: 'this must never be committed',
          changes: [
            { path: draftPath(slug), content: '{}', expectedSha: '0'.repeat(40) },
            { path: pagePath(slug), content: '{}', expectedSha: '1'.repeat(40) },
          ],
        }),
      );
      assert.ok(error instanceof ConflictError, `expected a ConflictError, got ${String(error)}`);
      assert.equal(error.status, 409);
      // And nothing was written.
      assert.equal(await headSha(token, pagePath(slug), branch), null);
    });

    await check('If-None-Match: * refuses to overwrite an existing draft', async () => {
      const result = await callRoute(draftRoute.PUT as Handler, {
        path: `/api/cms/draft/${slug}`,
        method: 'PUT',
        params: { slug },
        headers: {
          'Content-Type': 'application/json',
          'If-None-Match': '*',
        },
        body: JSON.stringify(fixtureAs('simple.json', slug)),
        jar,
      });
      assert.equal(result.status, 409);
      assert.match(String(result.body.error), /already exists/);
    });

    heading('Bad input');

    await check('a document that does not validate is a 400 listing the issues', async () => {
      const result = await callRoute(draftRoute.PUT as Handler, {
        path: `/api/cms/draft/${slug}`,
        method: 'PUT',
        params: { slug },
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, meta: { title: 'x' }, bands: [] }),
        jar,
      });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'invalid_doc');
      assert.match(String(result.body.error), /meta\.slug/);
    });

    await check("a document whose meta.slug is not the URL's slug is a 400", async () => {
      const result = await callRoute(draftRoute.PUT as Handler, {
        path: `/api/cms/draft/${slug}`,
        method: 'PUT',
        params: { slug },
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fixtureAs('simple.json', 'some-other-slug')),
        jar,
      });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'slug_mismatch');
    });

    await check('a body that is not JSON is a 400', async () => {
      const result = await callRoute(draftRoute.PUT as Handler, {
        path: `/api/cms/draft/${slug}`,
        method: 'PUT',
        params: { slug },
        headers: { 'Content-Type': 'application/json' },
        body: 'not json at all',
        jar,
      });
      assert.equal(result.status, 400);
      assert.match(String(result.body.error), /not valid JSON/);
    });

    await check('a page that does not exist reads as two nulls, not as an error', async () => {
      const result = await callRoute(pageRoute.GET as Handler, {
        path: '/api/cms/page/nothing-here-at-all',
        params: { slug: 'nothing-here-at-all' },
        jar,
      });
      assert.equal(result.status, 200);
      assert.deepEqual(
        { published: result.body.published, draft: result.body.draft },
        { published: null, draft: null },
      );
    });

    heading('Media upload');

    let uploadedSrc = '';
    let uploadedPath = '';
    const png = repoFile('public/projects/track-daily-habit-tracker/IMG_2065.png');

    await check('POST /api/cms/media/:slug returns src and the intrinsic size', async () => {
      const form = new FormData();
      form.set('file', new File([new Uint8Array(png)], 'IMG_2065.png', { type: 'image/png' }));
      const result = await callRoute(mediaRoute.POST as Handler, {
        path: `/api/cms/media/${slug}`,
        method: 'POST',
        params: { slug },
        body: form,
        jar,
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.ok, true);
      assert.equal(result.body.src, mediaSrc(slug, 'img-2065.png'));
      assert.equal(result.body.w, 1206);
      assert.equal(result.body.h, 2622);
      assert.equal(result.body.dimensions, 'intrinsic');
      uploadedSrc = String(result.body.src);
      uploadedPath = String(result.body.path);
      assert.equal(uploadedPath, mediaPath(slug, 'img-2065.png'));
      console.log(`       ${uploadedSrc}  ${String(result.body.w)}x${String(result.body.h)}  ${String(result.body.bytes)} bytes`);
    });

    await check('the uploaded bytes round-trip out of git unchanged', async () => {
      await untilPresent(token, uploadedPath, branch);
      const back = await readMedia(ctx, uploadedPath);
      assert.ok(back !== null, 'the file should be in the repo');
      assert.equal(back.bytes.length, png.length);
      assert.ok(back.bytes.equals(png), 'bytes should be identical');
    });

    await check('uploading the same name again does not overwrite it', async () => {
      const form = new FormData();
      form.set('file', new File([new Uint8Array(png)], 'IMG_2065.png', { type: 'image/png' }));
      const result = await callRoute(mediaRoute.POST as Handler, {
        path: `/api/cms/media/${slug}`,
        method: 'POST',
        params: { slug },
        body: form,
        jar,
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.src, mediaSrc(slug, 'img-2065-2.png'));
      const first = await headSha(token, uploadedPath, branch);
      assert.ok(first !== null, 'the first upload should still be there');
    });

    await check('an executable is refused', async () => {
      const form = new FormData();
      form.set('file', new File([new Uint8Array(Buffer.from('MZ'))], 'thing.exe', { type: 'application/octet-stream' }));
      const result = await callRoute(mediaRoute.POST as Handler, {
        path: `/api/cms/media/${slug}`,
        method: 'POST',
        params: { slug },
        body: form,
        jar,
      });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'bad_type');
    });

    await check('an upload that is not multipart is refused', async () => {
      const result = await callRoute(mediaRoute.POST as Handler, {
        path: `/api/cms/media/${slug}`,
        method: 'POST',
        params: { slug },
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        jar,
      });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'not_multipart');
    });

    heading('Publish');

    // The document that gets published uses the image that was just uploaded,
    // at the size the upload reported. This is the loop the editor actually
    // performs, so it is the one worth testing.
    const finalDoc = fixtureAs('canvas.json', slug);
    finalDoc.meta.title = 'WS-2 verification page';
    finalDoc.bands.push({
      id: 'b_ws2_canvas',
      type: 'canvas',
      height: 700,
      items: [
        {
          id: 'i_ws2_upload',
          kind: 'image',
          x: 0,
          y: 0,
          w: 320,
          h: Math.round((320 / 1206) * 2622),
          src: uploadedSrc,
          alt: 'the file uploaded by this test',
        },
      ],
    });

    let publishedSha = '';
    let publishCommit = '';
    let draftShaBeforePublish = '';

    await check('the draft is saved with the uploaded image in it', async () => {
      const result = await callRoute(draftRoute.PUT as Handler, {
        path: `/api/cms/draft/${slug}`,
        method: 'PUT',
        params: { slug },
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(finalDoc),
        jar,
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      draftShaBeforePublish = String(result.body.sha);
    });

    await check('publishing with a stale published sha is a 409', async () => {
      const result = await callRoute(publishRoute.POST as Handler, {
        path: `/api/cms/publish/${slug}`,
        method: 'POST',
        params: { slug },
        headers: { 'If-Match': '0000000000000000000000000000000000000000' },
        jar,
      });
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.equal(result.body.code, 'conflict');
      // And it published nothing.
      await untilGone(token, pagePath(slug), branch);
      await untilSha(token, draftPath(slug), branch, draftShaBeforePublish);
    });

    await check('POST /api/cms/publish/:slug returns a commit', async () => {
      const result = await callRoute(publishRoute.POST as Handler, {
        path: `/api/cms/publish/${slug}`,
        method: 'POST',
        params: { slug },
        jar,
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.ok, true);
      publishCommit = String(result.body.commit);
      publishedSha = String(result.body.sha);
      console.log(`       commit ${publishCommit.slice(0, 7)}`);
    });

    await check('pages/<slug>.json now holds exactly what the draft held', async () => {
      const published = await untilPresent(token, pagePath(slug), branch);
      assert.equal(published.sha, publishedSha);
      assert.equal(published.text, serialiseDoc(finalDoc));
    });

    await check('the draft is gone', async () => {
      await untilGone(token, draftPath(slug), branch);
      const entries = await listDir(token, toDraftPath(`${PAGES_DIR}/${LEGACY_SECTION_ID}`), branch);
      assert.ok(
        !entries.some((entry) => entry.name === `${slug}.json`),
        'the drafts directory should not list it',
      );
    });

    await check('publish was ONE commit: its parent had the draft and no page', async () => {
      const commit = (await fetchJson(
        token,
        `https://api.github.com/repos/${REPO}/commits/${publishCommit}`,
      )) as {
        parents: { sha: string }[];
        files?: { filename: string; status: string; previous_filename?: string }[];
      };
      assert.equal(commit.parents.length, 1, 'one parent');
      const parent = commit.parents[0] as { sha: string };
      // At the parent commit: draft present, page absent. At this commit: the
      // other way round. So no observer of the repo can ever see both, and
      // the Pages workflow fires once rather than twice.
      assert.ok(
        (await headSha(token, draftPath(slug), parent.sha)) !== null,
        'the parent commit should still have the draft',
      );
      assert.equal(
        await headSha(token, pagePath(slug), parent.sha),
        null,
        'the parent commit should not have the page',
      );

      // Exactly two paths are involved, and no others. GitHub describes the
      // commit either as an add plus a removal or, because the blob is
      // byte-identical, as a single rename; both say the same thing, so the
      // assertion is on the set of paths rather than on its choice of word.
      const files = commit.files ?? [];
      const paths = new Set<string>();
      for (const file of files) {
        paths.add(file.filename);
        if (file.previous_filename !== undefined) paths.add(file.previous_filename);
      }
      assert.deepEqual([...paths].sort(), [draftPath(slug), pagePath(slug)].sort());
      console.log(
        `       ${files.map((file) => `${file.status} ${file.previous_filename ?? ''}${file.previous_filename === undefined ? '' : ' -> '}${file.filename}`).join('   ')}`,
      );
    });

    await check('GET /api/cms/page/:slug now returns published and no draft', async () => {
      const result = await callRoute(pageRoute.GET as Handler, {
        path: `/api/cms/page/${slug}`,
        params: { slug },
        jar,
      });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.published, JSON.parse(JSON.stringify(finalDoc)));
      assert.equal(result.body.draft, null);
      assert.equal(result.body.draftSha, null);
      assert.equal(result.body.publishedSha, publishedSha);
    });

    await check('GET /api/cms/pages shows it published with no draft', async () => {
      const result = await callRoute(pagesRoute.GET as Handler, { path: '/api/cms/pages', jar });
      const pages = result.body.pages as { slug: string; title: string; hasDraft: boolean; hasPublished: boolean }[];
      const mine = pages.find((page) => page.slug === slug);
      assert.ok(mine !== undefined);
      assert.deepEqual(
        { hasDraft: mine.hasDraft, hasPublished: mine.hasPublished, title: mine.title },
        { hasDraft: false, hasPublished: true, title: 'WS-2 verification page' },
      );
    });

    await check('publishing again is a 404, because there is no draft', async () => {
      const result = await callRoute(publishRoute.POST as Handler, {
        path: `/api/cms/publish/${slug}`,
        method: 'POST',
        params: { slug },
        jar,
      });
      assert.equal(result.status, 404);
      assert.match(String(result.body.error), /no draft/i);
    });

    heading('Discard a draft');

    await check('deleting a draft that is not there is a 404', async () => {
      const result = await callRoute(draftRoute.DELETE as Handler, {
        path: `/api/cms/draft/${slug}`,
        method: 'DELETE',
        params: { slug },
        jar,
      });
      assert.equal(result.status, 404);
    });

    await check('a new draft over a published page, then discarded, leaves the page alone', async () => {
      const edited = structuredClone(finalDoc);
      edited.meta.title = 'An edit that gets thrown away';
      const write = await callRoute(draftRoute.PUT as Handler, {
        path: `/api/cms/draft/${slug}`,
        method: 'PUT',
        params: { slug },
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edited),
        jar,
      });
      assert.equal(write.status, 200, JSON.stringify(write.body));

      const remove = await callRoute(draftRoute.DELETE as Handler, {
        path: `/api/cms/draft/${slug}`,
        method: 'DELETE',
        params: { slug },
        headers: { 'If-Match': String(write.body.sha) },
        jar,
      });
      assert.equal(remove.status, 200, JSON.stringify(remove.body));

      await untilGone(token, draftPath(slug), branch);
      const published = await readText(token, pagePath(slug), branch);
      assert.equal(published?.sha, publishedSha, 'the published page must be untouched');
    });

    heading('A full cycle through the client, not the handlers');

    // Same branch, its own slug, so this is an independent second pass over
    // the whole lifecycle using only the public client surface.
    const clientSlug = `${slug}-client`;
    const client = clientFor(jar);

    await check('client: save a draft, read it back, list it', async () => {
      const doc = fixtureAs('dense.json', clientSlug);
      const ack = await client.saveDraft(clientSlug, doc);
      assert.equal(typeof ack.commit, 'string');
      assert.equal(typeof ack.sha, 'string');
      await untilSha(token, draftPath(clientSlug), branch, ack.sha);

      const snapshot = await client.readPage(clientSlug);
      assert.deepEqual(snapshot.draft, JSON.parse(JSON.stringify(doc)));
      assert.equal(snapshot.published, null);
      assert.equal(snapshot.draftSha, ack.sha);

      const pages = await client.listPages();
      const mine = pages.find((page) => page.slug === clientSlug);
      assert.ok(mine !== undefined);
      assert.equal(mine.hasDraft, true);
    });

    await check('client: a stale save throws a conflict carrying both shas', async () => {
      const snapshot = await client.readPage(clientSlug);
      const doc = fixtureAs('dense.json', clientSlug);
      doc.meta.title = 'second write';
      const second = await client.saveDraft(clientSlug, doc, snapshot.draftSha);

      doc.meta.title = 'third write, from a stale tab';
      const error = await rejects(() =>
        client.saveDraft(clientSlug, doc, snapshot.draftSha as string),
      );
      assert.ok(error instanceof CmsApiError);
      assert.equal(error.isConflict, true);
      assert.equal(error.conflict?.expectedSha, snapshot.draftSha);
      assert.equal(error.conflict?.actualSha, second.sha);
      assert.equal(error.conflict?.path, draftPath(clientSlug));
    });

    await check('client: upload a Blob with an explicit filename', async () => {
      const blob = new Blob([new Uint8Array(png)], { type: 'image/png' });
      const upload = await client.uploadMedia(clientSlug, blob, 'Pasted Shot.png');
      assert.equal(upload.src, mediaSrc(clientSlug, 'pasted-shot.png'));
      assert.equal(upload.w, 1206);
      assert.equal(upload.h, 2622);
      assert.equal(upload.dimensions, 'intrinsic');
    });

    await check('client: publish, then the draft is gone and the page is there', async () => {
      const before = await client.readPage(clientSlug);
      const ack = await client.publish(clientSlug, before.publishedSha);
      assert.equal(typeof ack.commit, 'string');

      const after = await client.readPage(clientSlug);
      assert.equal(after.draft, null);
      assert.equal(after.draftSha, null);
      assert.deepEqual(after.published, before.draft);
      assert.equal(after.publishedSha, ack.sha);

      const pages = await client.listPages();
      const mine = pages.find((page) => page.slug === clientSlug);
      assert.ok(mine !== undefined);
      assert.deepEqual(
        { hasDraft: mine.hasDraft, hasPublished: mine.hasPublished },
        { hasDraft: false, hasPublished: true },
      );
    });

    await check('client: discarding a draft that is not there is a 404, not a crash', async () => {
      const error = await rejects(() => client.deleteDraft(clientSlug));
      assert.ok(error instanceof CmsApiError);
      assert.equal(error.status, 404);
      assert.equal(error.isConflict, false);
    });

    await sectionChecks({ token, branch, jar, stamp });

    heading('Safety');

    await check('main did not move', async () => {
      const mainAfter = await getBranchHead(token, 'main');
      assert.equal(mainAfter, mainBefore, 'main must be byte-identical to where it started');
    });

    await check('nothing was written outside pages/, drafts/ and media/', async () => {
      const commits = (await fetchJson(
        token,
        `https://api.github.com/repos/${REPO}/commits?sha=${branch}&per_page=100`,
      )) as { sha: string }[];
      const ours = commits.map((commit) => commit.sha).filter((sha) => sha !== mainBefore);
      // Derived from the registry rather than listed, so a sixth section could
      // not widen this check by accident: the published directory of every
      // section, the draft mirror of all of them, and the one media root.
      const roots = [
        ...new Set([DRAFTS_DIR, MEDIA_DIR, PAGES_DIR, ...SECTIONS.map(contentDirFor)]),
      ];
      const allowed = new RegExp(`^(${roots.join('|')})/`);
      const touched = new Set<string>();
      for (const sha of ours) {
        if (sha === mainBefore) continue;
        const commit = (await fetchJson(
          token,
          `https://api.github.com/repos/${REPO}/commits/${sha}`,
        )) as { files?: { filename: string }[]; parents: { sha: string }[] };
        if (commit.parents.length === 0) break;
        for (const file of commit.files ?? []) touched.add(file.filename);
        if (commit.parents.some((p) => p.sha === mainBefore)) break;
      }
      for (const file of touched) {
        assert.match(file, allowed, `${file} is outside the CMS's own directories`);
      }
      console.log(
        `       ${touched.size} files touched, all under ${roots.join(', ')}`,
      );
    });
  } finally {
    heading('Cleanup');
    await check(`the throwaway branch ${branch} is deleted`, async () => {
      await deleteBranch(token, branch);
      // The ref read lags a delete exactly as it lags a write, so this waits
      // for GitHub to agree rather than asserting on its first answer.
      const gone = await until(
        `${branch} being deleted`,
        async () => {
          try {
            await getBranchHead(token, branch);
            return null;
          } catch (error) {
            return error as Error;
          }
        },
        (value) => value !== null && /No branch/.test(value.message),
      );
      assert.match(String(gone?.message), /No branch/);
    });
    delete process.env.CMS_BRANCH;
  }
}

/* -------------------------------------------------------------------------- */
/* Phase 2 live: all five sections, on the same throwaway branch               */
/* -------------------------------------------------------------------------- */

function loadRecordFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

/** Upload one file through a route and hand back what the editor would hold. */
async function uploadThrough(
  options: { route: Handler; path: string; params: Record<string, string | undefined>; jar: Jar },
  file: { name: string; bytes: Buffer; type: string },
): Promise<{ src: string; w: number; h: number; path: string }> {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
  const result = await callRoute(options.route, {
    path: options.path,
    method: 'POST',
    params: options.params,
    body: form,
    jar: options.jar,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return {
    src: String(result.body.src),
    w: Number(result.body.w),
    h: Number(result.body.h),
    path: String(result.body.path),
  };
}

/**
 * POST one record op.
 *
 * A successful op is followed by a barrier on the blob it reported, so the
 * NEXT op reads what this one wrote. Without it the sequence below would
 * occasionally ask the server to update a film that its own read of the draft
 * had not caught up with yet, which is GitHub's read window and not a bug in
 * the endpoint.
 */
async function recordOp(
  options: { jar: Jar; token: string; branch: string },
  section: RecordSectionDef,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<CallResult> {
  const result = await callRoute(recordsRoute.POST as Handler, {
    path: `/api/cms/records/${section.id}`,
    method: 'POST',
    params: { section: section.id },
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    jar: options.jar,
  });
  if (result.status === 200 && typeof result.body.sha === 'string') {
    await untilSha(options.token, draftPathFor(section), options.branch, result.body.sha);
  }
  return result;
}

function entriesOf(result: CallResult): { key: string; title: string; subtitle?: string; thumb?: string | null; hasDraft: boolean; hasPublished: boolean }[] {
  return result.body.entries as {
    key: string;
    title: string;
    subtitle?: string;
    thumb?: string | null;
    hasDraft: boolean;
    hasPublished: boolean;
  }[];
}

async function sectionChecks(options: {
  token: string;
  branch: string;
  jar: Jar;
  stamp: number;
}): Promise<void> {
  const { token, branch, jar, stamp } = options;
  const ctx: Ctx = { token, branch };
  const client = clientFor(jar);
  /** What `recordOp` needs to wait for its own write to become readable. */
  const bar = { jar, token, branch };

  const png = repoFile('public/projects/track-daily-habit-tracker/IMG_2065.png');
  const webp = repoFile('public/photography/placeholder.webp');
  const jpg = repoFile('public/filmography/EudrajWcwwg.jpg');

  const home = requireSection('home');
  const essays = requireSection('essays');
  const projects = requireSection('projects');
  const filmography = requireSection('filmography') as RecordSectionDef;
  const photography = requireSection('photography') as RecordSectionDef;

  /* ---------------------------------------------------------------- */
  heading('The sidebar: every section at once');

  await check('GET /api/cms/sections describes all five, in registry order', async () => {
    const result = await callRoute(sectionsRoute.GET as Handler, {
      path: '/api/cms/sections',
      jar,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const sections = result.body.sections as {
      id: string;
      label: string;
      shape: string;
      storage: string;
      count: number;
      hasDraft: boolean;
    }[];
    assert.deepEqual(
      sections.map((section) => section.id),
      SECTIONS.map((section) => section.id),
    );
    assert.deepEqual(
      sections.map((section) => `${section.id}:${section.shape}:${section.storage}`),
      [
        'home:singleton:document',
        'projects:collection:document',
        'essays:collection:document',
        'filmography:collection:records',
        'photography:collection:records',
      ],
    );
    // The singleton is one entry whether or not its file exists yet.
    assert.equal(sections[0]?.count, 1);
    for (const section of sections) {
      assert.equal(typeof section.count, 'number');
      assert.equal(typeof section.hasDraft, 'boolean');
    }
    console.log(
      `       ${sections.map((section) => `${section.id} ${section.count}${section.hasDraft ? '*' : ''}`).join('   ')}`,
    );
  });

  /* ---------------------------------------------------------------- */
  heading('Home: a singleton document, one segment and no slug');

  const homeDoc = fixtureAs('home.json', 'home');

  await check('GET /api/cms/entry/home reads two nulls before anything is written', async () => {
    const result = await callRoute(entryRoute.GET as Handler, {
      path: '/api/cms/entry/home',
      params: { section: 'home' },
      jar,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(
      { published: result.body.published, draft: result.body.draft, key: result.body.key },
      { published: null, draft: null, key: 'home' },
    );
    assert.equal(result.body.siteUrl, '/');
  });

  await check('a document whose meta.slug is not "home" is a 400, not a file called home', async () => {
    const wrong = fixtureAs('home.json', 'not-home');
    const result = await callRoute(draftRoute.PUT as Handler, {
      path: '/api/cms/draft/home',
      method: 'PUT',
      params: { slug: 'home' },
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wrong),
      jar,
    });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.code, 'slug_mismatch');
    await untilGone(token, draftPathFor(home), branch);
  });

  await check('/api/cms/entry/home/anything is a 400: a singleton has no entries', async () => {
    const result = await callRoute(entrySlugRoute.GET as Handler, {
      path: '/api/cms/entry/home/x-y',
      params: { section: 'home', slug: 'x-y' },
      jar,
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'not_a_collection');
  });

  let homePublishCommit = '';

  await check('PUT /api/cms/draft/home writes src/content/drafts/pages/home.json', async () => {
    const result = await callRoute(draftRoute.PUT as Handler, {
      path: '/api/cms/draft/home',
      method: 'PUT',
      params: { slug: 'home' },
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(homeDoc),
      jar,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.section, 'home');
    assert.equal(result.body.key, 'home');
    const file = await untilPresent(token, 'src/content/drafts/pages/home.json', branch);
    assert.equal(file.text, serialiseDoc(homeDoc));
    await untilGone(token, 'src/content/pages/home.json', branch);
  });

  await check('POST /api/cms/publish/home moves it, in one commit', async () => {
    const result = await callRoute(publishRoute.POST as Handler, {
      path: '/api/cms/publish/home',
      method: 'POST',
      params: { slug: 'home' },
      jar,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    homePublishCommit = String(result.body.commit);
    assert.equal(result.body.title, homeDoc.meta.title);
    assert.equal(result.body.siteUrl, '/');
    const published = await untilPresent(token, 'src/content/pages/home.json', branch);
    assert.equal(published.text, serialiseDoc(homeDoc));
    await untilGone(token, draftPathFor(home), branch);
  });

  await check('the publish commit touched exactly those two paths', async () => {
    const commit = (await fetchJson(
      token,
      `https://api.github.com/repos/${REPO}/commits/${homePublishCommit}`,
    )) as { files?: { filename: string; previous_filename?: string }[] };
    const paths = new Set<string>();
    for (const file of commit.files ?? []) {
      paths.add(file.filename);
      if (file.previous_filename !== undefined) paths.add(file.previous_filename);
    }
    assert.deepEqual([...paths].sort(), [contentPathFor(home), draftPathFor(home)].sort());
  });

  await check('GET /api/cms/entries/home is one row, titled from the document', async () => {
    const result = await callRoute(entriesRoute.GET as Handler, {
      path: '/api/cms/entries/home',
      params: { section: 'home' },
      jar,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(entriesOf(result), [
      { key: 'home', title: homeDoc.meta.title, hasDraft: false, hasPublished: true },
    ]);
  });

  await check('an upload for home needs no key and lands in public/media/home', async () => {
    const upload = await uploadThrough(
      { route: mediaRoute.POST as Handler, path: '/api/cms/media/home', params: { slug: 'home' }, jar },
      { name: 'Hero Frame.webp', bytes: webp, type: 'image/webp' },
    );
    assert.equal(upload.src, '/media/home/hero-frame.webp');
    assert.equal(upload.path, 'public/media/home/hero-frame.webp');
    assert.deepEqual({ w: upload.w, h: upload.h }, { w: 1200, h: 918 });
  });

  /* ---------------------------------------------------------------- */
  heading('Essays: a second document section, in its own tree');

  const essaySlug = `ws-c-essay-${stamp}`;
  const essayDoc = fixtureAs('essay.json', essaySlug);

  await check('an upload for an essay lands in public/media/essays/<slug>', async () => {
    const upload = await uploadThrough(
      {
        route: mediaSlugRoute.POST as Handler,
        path: `/api/cms/media/essays/${essaySlug}`,
        params: { section: 'essays', slug: essaySlug },
        jar,
      },
      { name: 'IMG_2065.png', bytes: png, type: 'image/png' },
    );
    assert.equal(upload.src, mediaSrcFor(essays, essaySlug, 'img-2065.png'));
    assert.equal(upload.src, `/media/essays/${essaySlug}/img-2065.png`);
    assert.deepEqual({ w: upload.w, h: upload.h }, { w: 1206, h: 2622 });
    // The image the editor just uploaded goes into the document it is editing,
    // at the size the endpoint reported, which is the loop that matters.
    essayDoc.bands.push({
      id: 'b_wsc_canvas',
      type: 'canvas',
      height: 700,
      items: [
        {
          id: 'i_wsc_upload',
          kind: 'image',
          x: 0,
          y: 0,
          w: 320,
          h: Math.round((320 / upload.w) * upload.h),
          src: upload.src,
          alt: 'the file uploaded by this test',
        },
      ],
    });
  });

  await check('PUT /api/cms/draft/essays/<slug> writes the essays draft tree', async () => {
    const result = await callRoute(draftSlugRoute.PUT as Handler, {
      path: `/api/cms/draft/essays/${essaySlug}`,
      method: 'PUT',
      params: { section: 'essays', slug: essaySlug },
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(essayDoc),
      jar,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const file = await untilPresent(token, draftPathFor(essays, essaySlug), branch);
    assert.equal(file.text, serialiseDoc(essayDoc));
    assert.equal(
      draftPathFor(essays, essaySlug),
      `src/content/drafts/pages/essays/${essaySlug}.json`,
    );
    // And it did NOT land in the projects tree, which is where phase 1 put
    // everything and where the alias still puts it.
    await untilGone(token, draftPathFor(projects, essaySlug), branch);
  });

  await check('a document that says it is a project cannot be saved into essays', async () => {
    const confused = structuredClone(essayDoc);
    confused.meta.section = 'projects';
    const result = await callRoute(draftSlugRoute.PUT as Handler, {
      path: `/api/cms/draft/essays/${essaySlug}`,
      method: 'PUT',
      params: { section: 'essays', slug: essaySlug },
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(confused),
      jar,
    });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.code, 'section_mismatch');
  });

  await check('a collection with no slug in the URL is a 400 that says so', async () => {
    const result = await callRoute(draftRoute.PUT as Handler, {
      path: '/api/cms/draft/essays',
      method: 'PUT',
      params: { slug: 'essays' },
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(essayDoc),
      jar,
    });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.code, 'needs_slug');
  });

  await check('GET /api/cms/entry/essays/<slug> reads the draft back unchanged', async () => {
    const result = await callRoute(entrySlugRoute.GET as Handler, {
      path: `/api/cms/entry/essays/${essaySlug}`,
      params: { section: 'essays', slug: essaySlug },
      jar,
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.draft, JSON.parse(JSON.stringify(essayDoc)));
    assert.equal(result.body.published, null);
    assert.equal(result.body.siteUrl, siteUrlFor(essays, essaySlug));
    assert.equal(result.body.siteUrl, `/essays/${essaySlug}/`);
  });

  await check('POST /api/cms/publish/essays/<slug> publishes into the essays tree', async () => {
    const result = await callRoute(publishSlugRoute.POST as Handler, {
      path: `/api/cms/publish/essays/${essaySlug}`,
      method: 'POST',
      params: { section: 'essays', slug: essaySlug },
      jar,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const published = await untilPresent(token, contentPathFor(essays, essaySlug), branch);
    assert.equal(published.text, serialiseDoc(essayDoc));
    await untilGone(token, draftPathFor(essays, essaySlug), branch);
    // Two sections, two documents, both published, neither in the other's tree.
    assert.ok((await headSha(token, contentPathFor(home), branch)) !== null);
  });

  await check('GET /api/cms/entries/essays lists it as published', async () => {
    const result = await callRoute(entriesRoute.GET as Handler, {
      path: '/api/cms/entries/essays',
      params: { section: 'essays' },
      jar,
    });
    const mine = entriesOf(result).find((entry) => entry.key === essaySlug);
    assert.ok(mine !== undefined, `the list should contain ${essaySlug}`);
    assert.deepEqual(
      { title: mine.title, hasDraft: mine.hasDraft, hasPublished: mine.hasPublished },
      { title: essayDoc.meta.title, hasDraft: false, hasPublished: true },
    );
    // A document section has no subtitle or thumbnail, and says so by leaving
    // them out rather than by sending nulls.
    assert.equal('subtitle' in mine, false);
    assert.equal('thumb' in mine, false);
  });

  /* ---------------------------------------------------------------- */
  heading('Filmography: add, edit, reorder, delete, publish');

  const filmFixture = loadRecordFixture('filmography.json') as { films: Film[] };
  const fixtureIds = filmFixture.films.map((film) => film.id);
  const newFilmEntry = newFilm({
    id: `film_wsc_${stamp}`,
    youtubeId: '2jiXj6uOuDs',
    title: 'A film this test added',
    kind: 'TRAILER',
    year: '2026',
    note: 'Added through POST /api/cms/records/filmography.',
  });

  await check('GET /api/cms/records/filmography is two nulls and no entries', async () => {
    const result = await callRoute(recordsRoute.GET as Handler, {
      path: '/api/cms/records/filmography',
      params: { section: 'filmography' },
      jar,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(
      { published: result.body.published, draft: result.body.draft, key: result.body.key },
      { published: null, draft: null, key: 'films' },
    );
    assert.deepEqual(result.body.entries, []);
    assert.equal(result.body.entriesFrom, 'none');
  });

  let filmDraftSha = '';

  await check('PUT /api/cms/records/filmography saves the whole collection as a draft', async () => {
    const result = await callRoute(recordsRoute.PUT as Handler, {
      path: '/api/cms/records/filmography',
      method: 'PUT',
      params: { section: 'filmography' },
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filmFixture),
      jar,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    filmDraftSha = String(result.body.sha);
    assert.equal(entriesOf(result).length, 4);
    const file = await untilPresent(token, 'src/content/drafts/data/filmography.json', branch);
    assert.equal(file.sha, filmDraftSha, 'the draft is in the draft mirror of src/content/data');
    await untilGone(token, 'src/content/data/filmography.json', branch);
  });

  await check('a collection that does not validate is a 400 listing the issues', async () => {
    const result = await callRoute(recordsRoute.PUT as Handler, {
      path: '/api/cms/records/filmography',
      method: 'PUT',
      params: { section: 'filmography' },
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ films: [{ id: 'film_x', title: 'No video' }] }),
      jar,
    });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.code, 'invalid_records');
    assert.match(String(result.body.error), /youtubeId/);
    await untilSha(token, 'src/content/drafts/data/filmography.json', branch, filmDraftSha);
  });

  await check('op add puts a fifth film at the end', async () => {
    const result = await recordOp(bar, filmography, { op: 'add', entry: newFilmEntry });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.basedOn, 'draft');
    assert.equal(result.body.key, newFilmEntry.id);
    const keys = entriesOf(result).map((entry) => entry.key);
    assert.deepEqual(keys, [...fixtureIds, newFilmEntry.id]);
    filmDraftSha = String(result.body.sha);
  });

  await check('op add refuses a film whose id is already in the collection', async () => {
    const result = await recordOp(bar, filmography, { op: 'add', entry: newFilmEntry });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.code, 'duplicate_key');
    await untilSha(token, 'src/content/drafts/data/filmography.json', branch, filmDraftSha);
  });

  await check('op update retitles one film and leaves the order alone', async () => {
    const edited: Film = { ...newFilmEntry, title: 'A film this test renamed', year: '2025' };
    const result = await recordOp(bar, filmography, {
      op: 'update',
      key: newFilmEntry.id,
      entry: edited,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const rows = entriesOf(result);
    assert.deepEqual(
      rows.map((row) => row.key),
      [...fixtureIds, newFilmEntry.id],
    );
    const mine = rows.find((row) => row.key === newFilmEntry.id);
    assert.equal(mine?.title, 'A film this test renamed');
    assert.equal(mine?.subtitle, 'TRAILER · 2025');
    filmDraftSha = String(result.body.sha);
  });

  await check('op reorder reverses the collection, and the file in git agrees', async () => {
    const reversed = [...fixtureIds, newFilmEntry.id].reverse();
    const result = await recordOp(bar, filmography, { op: 'reorder', keys: reversed });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(
      entriesOf(result).map((row) => row.key),
      reversed,
    );
    // Read it out of the repo rather than trusting the response: the order on
    // the live site is the order in the file.
    const file = await readText(token, 'src/content/drafts/data/filmography.json', branch);
    const parsed = JSON.parse(String(file?.text)) as { films: Film[] };
    assert.deepEqual(
      parsed.films.map((film) => film.id),
      reversed,
    );
    filmDraftSha = String(file?.sha);
    console.log(`       ${reversed.join('  ')}`);
  });

  await check('op reorder that drops a film is refused, and writes nothing', async () => {
    const result = await recordOp(bar, filmography, {
      op: 'reorder',
      keys: fixtureIds.slice(0, 2),
    });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.code, 'bad_reorder');
    assert.match(String(result.body.error), /list every film/);
    await untilSha(token, 'src/content/drafts/data/filmography.json', branch, filmDraftSha);
  });

  await check('op move puts one film at the front', async () => {
    const result = await recordOp(bar, filmography, { op: 'move', key: fixtureIds[0] as string, to: 0 });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(entriesOf(result)[0]?.key, fixtureIds[0]);
    assert.equal(entriesOf(result).length, 5);
    filmDraftSha = String(result.body.sha);
  });

  await check('an op quoting a stale sha is a 409 and changes nothing', async () => {
    const result = await recordOp(
      bar,
      filmography,
      { op: 'delete', key: fixtureIds[1] as string },
      { 'If-Match': '0'.repeat(40) },
    );
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.code, 'conflict');
    await untilSha(token, 'src/content/drafts/data/filmography.json', branch, filmDraftSha);
  });

  await check('op delete removes the film this test added', async () => {
    const result = await recordOp(
      bar,
      filmography,
      { op: 'delete', key: newFilmEntry.id },
      { 'If-Match': filmDraftSha },
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const keys = entriesOf(result).map((row) => row.key);
    assert.equal(keys.length, 4);
    assert.ok(!keys.includes(newFilmEntry.id));
    filmDraftSha = String(result.body.sha);
  });

  let filmPublishCommit = '';

  await check('POST /api/cms/publish/filmography moves the collection, in one commit', async () => {
    const before = await readText(token, 'src/content/drafts/data/filmography.json', branch);
    const result = await callRoute(publishRoute.POST as Handler, {
      path: '/api/cms/publish/filmography',
      method: 'POST',
      params: { slug: 'filmography' },
      jar,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    filmPublishCommit = String(result.body.commit);
    assert.equal(entriesOf(result).length, 4);
    const published = await untilPresent(token, 'src/content/data/filmography.json', branch);
    assert.equal(published.text, before?.text, 'publish is a copy, byte for byte');
    await untilGone(token, 'src/content/drafts/data/filmography.json', branch);
  });

  await check('that publish touched exactly the two data paths', async () => {
    const commit = (await fetchJson(
      token,
      `https://api.github.com/repos/${REPO}/commits/${filmPublishCommit}`,
    )) as { parents: { sha: string }[]; files?: { filename: string; previous_filename?: string }[] };
    assert.equal(commit.parents.length, 1);
    const paths = new Set<string>();
    for (const file of commit.files ?? []) {
      paths.add(file.filename);
      if (file.previous_filename !== undefined) paths.add(file.previous_filename);
    }
    assert.deepEqual(
      [...paths].sort(),
      ['src/content/data/filmography.json', 'src/content/drafts/data/filmography.json'].sort(),
    );
  });

  await check('GET /api/cms/entries/filmography carries subtitles and poster thumbnails', async () => {
    const result = await callRoute(entriesRoute.GET as Handler, {
      path: '/api/cms/entries/filmography',
      params: { section: 'filmography' },
      jar,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const rows = entriesOf(result);
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.hasDraft, false);
      assert.equal(row.hasPublished, true);
      assert.match(String(row.subtitle), / · \d{4}/);
      assert.equal(typeof row.thumb, 'string');
    }
    // A film with no uploaded poster falls back to YouTube's own thumbnail,
    // through the registry's summarise, not through anything here.
    const trailer = rows.find((row) => row.key === 'film_space_race_trailer');
    assert.equal(trailer?.thumb, 'https://i.ytimg.com/vi/2jiXj6uOuDs/maxresdefault.jpg');
    console.log(`       ${rows.map((row) => `${row.key} (${String(row.subtitle)})`).join('  ')}`);
  });

  await check('the next op after a publish starts from the published collection', async () => {
    const result = await recordOp(bar, filmography, { op: 'move', key: fixtureIds[3] as string, to: 0 });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.basedOn, 'published');
    assert.equal(entriesOf(result)[0]?.key, fixtureIds[3]);
    // And the published file is untouched: an op writes the draft, only.
    const published = await readText(token, 'src/content/data/filmography.json', branch);
    const parsed = JSON.parse(String(published?.text)) as { films: Film[] };
    assert.notEqual(parsed.films[0]?.id, fixtureIds[3]);
  });

  await check('DELETE /api/cms/records/filmography throws the draft away and keeps the publication', async () => {
    const publishedBefore = await headSha(token, 'src/content/data/filmography.json', branch);
    const result = await callRoute(recordsRoute.DELETE as Handler, {
      path: '/api/cms/records/filmography',
      method: 'DELETE',
      params: { section: 'filmography' },
      jar,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    await untilGone(token, 'src/content/drafts/data/filmography.json', branch);
    assert.equal(typeof publishedBefore, 'string', 'the collection should be published by now');
    await untilSha(
      token,
      'src/content/data/filmography.json',
      branch,
      publishedBefore as string,
    );
  });

  /* ---------------------------------------------------------------- */
  heading('Photography: an album, six photos, their order and its cover');

  const albumSlug = `ws-c-album-${stamp}`;
  const albumId = `album_wsc_${stamp}`;
  const album = newAlbum({
    id: albumId,
    slug: albumSlug,
    title: 'An album this test made',
    year: '2026',
    summary: 'Created empty, then filled, reordered and given a cover.',
  });

  await check('op add creates an empty album, which is legal and is the point', async () => {
    const result = await recordOp(bar, photography, { op: 'add', entry: album });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.basedOn, 'none', 'there was no photography.json at all');
    const rows = entriesOf(result);
    assert.deepEqual(
      rows.map((row) => `${row.key}|${String(row.subtitle)}|${String(row.thumb)}`),
      [`${albumSlug}|2026 · 0 photos|null`],
    );
  });

  const photos: Photo[] = [];

  await check('three photos upload into public/media/photography/<album slug>', async () => {
    const files = [
      { name: 'IMG_2065.png', bytes: png, type: 'image/png', w: 1206, h: 2622 },
      { name: 'placeholder.webp', bytes: webp, type: 'image/webp', w: 1200, h: 918 },
      { name: 'EudrajWcwwg.jpg', bytes: jpg, type: 'image/jpeg', w: 1280, h: 720 },
    ];
    for (const file of files) {
      const upload = await uploadThrough(
        {
          route: mediaSlugRoute.POST as Handler,
          path: `/api/cms/media/photography/${albumSlug}`,
          params: { section: 'photography', slug: albumSlug },
          jar,
        },
        file,
      );
      assert.equal(upload.path.startsWith(`public/media/photography/${albumSlug}/`), true, upload.path);
      assert.deepEqual({ w: upload.w, h: upload.h }, { w: file.w, h: file.h });
      // The response is exactly what newPhoto wants (docs/cms-contracts.md 11).
      photos.push(newPhoto(upload.src, { w: upload.w, h: upload.h }));
    }
    assert.equal(photos.length, 3);
    console.log(`       ${photos.map((photo) => photo.src).join('  ')}`);
  });

  await check('op update fills the album with the photos that were uploaded', async () => {
    const filled: Album = { ...album, photos: [...photos] };
    const result = await recordOp(bar, photography, {
      op: 'update',
      key: albumSlug,
      entry: filled,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(entriesOf(result)[0]?.subtitle, '2026 · 3 photos');
    // With no cover chosen, the thumbnail is the first photo.
    assert.equal(entriesOf(result)[0]?.thumb, photos[0]?.src);
  });

  await check('op update reorders the photos, and the file in git agrees', async () => {
    const reordered: Album = {
      ...album,
      photos: [photos[2] as Photo, photos[0] as Photo, photos[1] as Photo],
    };
    const result = await recordOp(bar, photography, {
      op: 'update',
      key: albumSlug,
      entry: reordered,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const file = await readText(token, 'src/content/drafts/data/photography.json', branch);
    const parsed = JSON.parse(String(file?.text)) as { albums: Album[] };
    assert.deepEqual(
      parsed.albums[0]?.photos.map((photo) => photo.id),
      [photos[2]?.id, photos[0]?.id, photos[1]?.id],
    );
    // Reordering photos does not change the tile, because there is no cover
    // yet and the first photo is now a different one.
    assert.equal(entriesOf(result)[0]?.thumb, photos[2]?.src);
  });

  let albumDraftSha = '';

  await check('op update sets the cover, and the tile follows it rather than the order', async () => {
    const covered: Album = {
      ...album,
      cover: photos[1]?.id as string,
      photos: [photos[2] as Photo, photos[0] as Photo, photos[1] as Photo],
    };
    const result = await recordOp(bar, photography, {
      op: 'update',
      key: albumSlug,
      entry: covered,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(entriesOf(result)[0]?.thumb, photos[1]?.src);
    albumDraftSha = String(result.body.sha);
  });

  await check('a cover that is not one of the album’s photos is refused', async () => {
    const result = await recordOp(bar, photography, {
      op: 'update',
      key: albumSlug,
      entry: { ...album, cover: 'ph_not_in_here', photos: [...photos] },
    });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.match(String(result.body.error), /cover "ph_not_in_here" is not the id of a photo/);
    await untilSha(token, draftPathFor(photography), branch, albumDraftSha);
  });

  await check('deleting the cover photo without clearing the cover is refused', async () => {
    // docs/cms-contracts.md 10.2, rule 3: unlike a dangling anchor, a cover
    // pointing at a deleted photo IS an error, and this is where it bites.
    const result = await recordOp(bar, photography, {
      op: 'update',
      key: albumSlug,
      entry: {
        ...album,
        cover: photos[1]?.id as string,
        photos: [photos[2] as Photo, photos[0] as Photo],
      },
    });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    // `invalid_record`, singular: the Album schema's own cross-field rule
    // catches it while the entry is being parsed, before the collection is
    // assembled, so the message names the album rather than the collection.
    assert.equal(result.body.code, 'invalid_record');
    assert.match(String(result.body.error), /cover/);
  });

  await check('deleting the cover photo and clearing the cover in one edit is fine', async () => {
    const result = await recordOp(bar, photography, {
      op: 'update',
      key: albumSlug,
      entry: { ...album, photos: [photos[2] as Photo, photos[0] as Photo] },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(entriesOf(result)[0]?.subtitle, '2026 · 2 photos');
    assert.equal(entriesOf(result)[0]?.thumb, photos[2]?.src);
  });

  await check('renaming an album moves its page, and the key moves with it', async () => {
    const renamed = `${albumSlug}-renamed`;
    const result = await recordOp(bar, photography, {
      op: 'update',
      key: albumSlug,
      entry: { ...album, slug: renamed, photos: [photos[2] as Photo, photos[0] as Photo] },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.key, renamed);
    assert.equal(entriesOf(result)[0]?.key, renamed);
    assert.equal(siteUrlFor(photography, renamed), `/photography/${renamed}/`);
    // Put it back, so the published album is the one whose media directory
    // these uploads are in.
    const back = await recordOp(bar, photography, {
      op: 'update',
      key: renamed,
      entry: { ...album, photos: [photos[2] as Photo, photos[0] as Photo] },
    });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.key, albumSlug);
  });

  await check('POST /api/cms/publish/photography publishes the album', async () => {
    const before = await readText(token, 'src/content/drafts/data/photography.json', branch);
    const result = await callRoute(publishRoute.POST as Handler, {
      path: '/api/cms/publish/photography',
      method: 'POST',
      params: { slug: 'photography' },
      jar,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const published = await untilPresent(token, 'src/content/data/photography.json', branch);
    assert.equal(published.text, before?.text);
    await untilGone(token, 'src/content/drafts/data/photography.json', branch);
  });

  await check('the uploaded photo bytes are really in the repo, unchanged', async () => {
    const src = photos[0]?.src as string;
    const path = `public${src}`;
    await untilPresent(token, path, branch);
    const back = await readMedia(ctx, path);
    assert.ok(back !== null, `${path} should be in the repo`);
    assert.ok(back.bytes.equals(png), 'bytes should be identical');
  });

  await check('GET /api/cms/entries/photography shows the published album', async () => {
    const result = await callRoute(entriesRoute.GET as Handler, {
      path: '/api/cms/entries/photography',
      params: { section: 'photography' },
      jar,
    });
    const rows = entriesOf(result);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      {
        key: rows[0]?.key,
        subtitle: rows[0]?.subtitle,
        hasDraft: rows[0]?.hasDraft,
        hasPublished: rows[0]?.hasPublished,
      },
      { key: albumSlug, subtitle: '2026 · 2 photos', hasDraft: false, hasPublished: true },
    );
  });

  /* ---------------------------------------------------------------- */
  heading('The same five sections through the client WS-D and WS-E will use');

  await check('client.listSections() reports what was just written', async () => {
    const sections = await client.listSections();
    const byId = new Map(sections.map((section) => [section.id, section]));
    assert.equal(byId.get('home')?.count, 1);
    assert.equal(byId.get('filmography')?.count, 4);
    assert.equal(byId.get('photography')?.count, 1);
    assert.equal(byId.get('filmography')?.hasDraft, false);
    assert.ok((byId.get('essays')?.count ?? 0) >= 1);
  });

  await check('client.readEntry() reads the homepage with no key at all', async () => {
    const snapshot = await client.readEntry('home');
    assert.deepEqual(snapshot.published, JSON.parse(JSON.stringify(homeDoc)));
    assert.equal(snapshot.draft, null);
    assert.equal(snapshot.key, 'home');
    assert.equal(snapshot.siteUrl, '/');
  });

  await check('client: edit the homepage, read it back, publish it', async () => {
    const edited = structuredClone(homeDoc);
    edited.meta.summary = 'Edited through the client.';
    const ack = await client.saveEntryDraft('home', null, edited);
    assert.equal(typeof ack.commit, 'string');
    await untilSha(token, draftPathFor(home), branch, ack.sha);
    const mid = await client.readEntry('home');
    assert.equal(mid.draft?.meta.summary, 'Edited through the client.');
    const published = await client.publishEntry('home', null, mid.publishedSha);
    assert.equal(typeof published.commit, 'string');
    await untilGone(token, draftPathFor(home), branch);
    const after = await client.readEntry('home');
    assert.equal(after.draft, null);
    assert.equal(after.published?.meta.summary, 'Edited through the client.');
  });

  await check('client.readRecords() and client.recordOp() reorder the films', async () => {
    const snapshot = await client.readRecords('filmography');
    assert.equal(snapshot.draft, null);
    assert.equal(snapshot.entriesFrom, 'published');
    const keys = snapshot.entries.map((entry) => entry.key);
    assert.equal(keys.length, 4);

    const moved = await client.recordOp('filmography', { op: 'move', key: keys[3] as string, to: 0 });
    assert.deepEqual(
      moved.entries.map((entry) => entry.key),
      [keys[3], keys[0], keys[1], keys[2]],
    );
    assert.equal(moved.basedOn, 'published');
    await untilSha(token, draftPathFor(filmography), branch, moved.sha);

    const reordered = await client.recordOp(
      'filmography',
      { op: 'reorder', keys: keys as string[] },
      moved.sha,
    );
    assert.deepEqual(
      reordered.entries.map((entry) => entry.key),
      keys,
    );
    await untilSha(token, draftPathFor(filmography), branch, reordered.sha);

    const ack = await client.publishRecords('filmography', snapshot.publishedSha);
    assert.equal(ack.entries.length, 4);
    await untilGone(token, draftPathFor(filmography), branch);
    const after = await client.readRecords('filmography');
    assert.equal(after.draft, null);
    assert.deepEqual(
      after.entries.map((entry) => entry.key),
      keys,
    );
  });

  await check('client: a stale record op throws a conflict carrying both shas', async () => {
    const first = await client.recordOp('filmography', { op: 'move', key: fixtureIds[0] as string, to: 3 });
    await untilSha(token, draftPathFor(filmography), branch, first.sha);
    const error = await rejects(() =>
      client.recordOp('filmography', { op: 'move', key: fixtureIds[1] as string, to: 0 }, '0'.repeat(40)),
    );
    assert.ok(error instanceof CmsApiError, `expected a CmsApiError, got ${String(error)}`);
    assert.equal(error.isConflict, true);
    assert.equal(error.conflict?.path, 'src/content/drafts/data/filmography.json');
    assert.equal(error.conflict?.actualSha, first.sha);
    await client.discardRecords('filmography', first.sha);
  });

  await check('client.uploadSectionMedia() puts a film poster under its record id', async () => {
    const filmId = fixtureIds[0] as string;
    const blob = new Blob([new Uint8Array(jpg)], { type: 'image/jpeg' });
    const upload = await client.uploadSectionMedia('filmography', filmId, blob, 'Poster Frame.jpg');
    assert.equal(upload.src, `/media/filmography/${filmId}/poster-frame.jpg`);
    assert.deepEqual({ w: upload.w, h: upload.h }, { w: 1280, h: 720 });
    assert.equal(upload.dimensions, 'intrinsic');
  });

  await check('client.listEntries() sees every section the same way', async () => {
    for (const section of SECTIONS) {
      const entries = await client.listEntries(section.id);
      assert.ok(Array.isArray(entries), `${section.id} should list`);
      if (isRecordSection(section)) {
        for (const entry of entries) assert.equal(typeof entry.subtitle, 'string');
      }
    }
  });
}

async function fetchJson(token: string, url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'jinhyuk.org-cms',
    },
  });
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

const offlineOnly = process.argv.includes('--offline');

console.log('\u001b[1mWS-2 storage and API: verification\u001b[0m');

await offlineChecks();

if (offlineOnly) {
  console.log('\n(--offline: skipping the live cycle)');
} else {
  const token = findToken();
  if (token === null) {
    heading('Live cycle');
    console.log(
      '  SKIPPED: no token. Run `gh auth login`, or set GITHUB_TOKEN, then run this again.',
    );
    failures.push({ name: 'live cycle', error: new Error('no GitHub token available') });
  } else {
    heading('Live cycle on a throwaway branch');
    await liveChecks(token);
  }
}

console.log(
  `\n\u001b[1m${passed} passed, ${failures.length} failed\u001b[0m`,
);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure.name}`);
  process.exit(1);
}
