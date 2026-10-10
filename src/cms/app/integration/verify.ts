/**
 * src/cms/app/integration/verify.ts
 *
 * WS-8's node-only proof. Everything in the wiring that is arithmetic or
 * protocol rather than pixels, asserted with exact numbers and exact HTTP.
 *
 *   node src/cms/app/integration/verify.ts
 *
 * No browser, no network, no GitHub token, no other workstream's harness. The
 * API adapter is driven against a fake `fetch` that speaks WS-2's wire format
 * (including its 409s), so the sha bookkeeping — the one piece of state the
 * integration owns — is checked rather than hoped for.
 *
 * Exit code 0 means every check passed.
 */

import { readFileSync } from 'node:fs';

import { formatIssues, validateDoc, validateDocJson } from '../../schema.ts';
import type { CanvasBand, CanvasItem, Doc, ProseBlock } from '../../schema.ts';
import { generateShape } from '../../assets/shapes.ts';
import { draftToItem, newDraft } from '../../assets/draft.ts';
import { convertBlockKind } from '../prose/block.ts';
import { conflictMessage, createCmsApi } from './api.ts';
import { CmsWriteError } from './api.ts';
import { createDocStore } from '../state/store.ts';
import {
  addCanvasItemAt,
  blankDoc,
  firstCanvasBand,
  replaceProseBlock,
  titleFromSlug,
} from './doc-edits.ts';
import {
  extensionOf,
  fitMedia,
  freshItemId,
  itemKindForFile,
  makeMediaResolver,
  mediaItem,
  nextZ,
  placeBox,
  placeCentred,
  projectItemSrc,
  restoreItemSrc,
  takenIds,
} from './media.ts';
import { INTEGRATION_CSS } from './styles.ts';

/* -------------------------------------------------------------------------- */
/* Checks                                                                      */
/* -------------------------------------------------------------------------- */

let total = 0;
let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  total += 1;
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
  check(label, a === b, a === b ? b ?? '' : `got ${a}, wanted ${b}`);
}

function section(name: string): void {
  console.log(`\n  ${name}`);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function fixture(name: string): Doc {
  const text = readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');
  const parsed = validateDocJson(text);
  if (!parsed.ok) throw new Error(`${name} does not validate:\n${formatIssues(parsed.issues)}`);
  return parsed.doc;
}

const canvasDoc = fixture('canvas.json');
const simpleDoc = fixture('simple.json');

/* -------------------------------------------------------------------------- */
/* A fake WS-2                                                                 */
/* -------------------------------------------------------------------------- */

type ServerFile = { text: string; sha: string };

type Call = { method: string; path: string; headers: Record<string, string> };

/**
 * Speaks the wire format of docs/cms-contracts.md 3 plus the sha expectations
 * WS-2 added on top of it: `If-Match: <sha>`, `If-None-Match: *`, and a 409
 * body carrying `path`, `expectedSha` and `actualSha`.
 *
 * It is deliberately strict about the expectation, because the point of the
 * adapter is to send the right one. A write with the wrong sha is a 409 here
 * exactly as it would be against GitHub.
 */
function fakeServer(initial: { published?: Doc; draft?: Doc } = {}) {
  let counter = 0;
  const nextSha = (): string => `sha${(counter += 1)}`;
  const nextCommit = (): string => `commit${(counter += 1)}`;

  const files = new Map<string, ServerFile>();
  if (initial.published !== undefined) {
    files.set('published', { text: JSON.stringify(initial.published), sha: nextSha() });
  }
  if (initial.draft !== undefined) {
    files.set('draft', { text: JSON.stringify(initial.draft), sha: nextSha() });
  }

  const calls: Call[] = [];
  const uploads: { name: string; bytes: number }[] = [];
  let signedIn = true;

  const json = (status: number, body: Record<string, unknown>): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  function expectationOf(headers: Headers): string | null | undefined {
    if (headers.get('If-None-Match') === '*') return null;
    const match = headers.get('If-Match');
    return match === null ? undefined : match;
  }

  function enforce(
    key: 'draft' | 'published',
    path: string,
    expectation: string | null | undefined,
  ): Response | null {
    const current = files.get(key) ?? null;
    const actual = current === null ? null : current.sha;
    if (expectation === undefined) return null;
    if (expectation === actual) return null;
    return json(409, {
      ok: false,
      error: `${path} has changed in the repository since you loaded it.`,
      code: 'conflict',
      path,
      expectedSha: expectation,
      actualSha: actual,
    });
  }

  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), 'http://cms.test');
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    calls.push({
      method,
      path: url.pathname,
      headers: Object.fromEntries([...headers.entries()]),
    });

    if (!signedIn && url.pathname !== '/api/cms/auth/status') {
      return json(401, { ok: false, error: 'Sign in to GitHub to edit.', code: 'unauthorized' });
    }

    if (url.pathname === '/api/cms/auth/status') {
      return json(200, {
        ok: true,
        signedIn,
        ...(signedIn ? { login: 'ryan-choi-jh', name: 'Ryan' } : {}),
        repo: 'ryan-choi-jh/jinhyuk.org',
        branch: 'cms/throwaway',
        expects: 'ryan-choi-jh',
      });
    }

    if (url.pathname === '/api/cms/pages') {
      return json(200, {
        ok: true,
        pages: [
          {
            slug: 'fixture-canvas',
            title: 'Fixture: prose and canvas',
            hasDraft: files.has('draft'),
            hasPublished: files.has('published'),
          },
        ],
      });
    }

    if (url.pathname.startsWith('/api/cms/page/')) {
      const published = files.get('published') ?? null;
      const draft = files.get('draft') ?? null;
      return json(200, {
        ok: true,
        published: published === null ? null : JSON.parse(published.text),
        draft: draft === null ? null : JSON.parse(draft.text),
        publishedSha: published === null ? null : published.sha,
        draftSha: draft === null ? null : draft.sha,
      });
    }

    if (url.pathname.startsWith('/api/cms/draft/')) {
      const path = 'src/content/drafts/fixture-canvas.json';
      const refused = enforce('draft', path, expectationOf(headers));
      if (refused !== null) return refused;
      if (method === 'PUT') {
        files.set('draft', { text: String(init.body), sha: nextSha() });
        return json(200, {
          ok: true,
          commit: nextCommit(),
          sha: (files.get('draft') as ServerFile).sha,
        });
      }
      files.delete('draft');
      return json(200, { ok: true, commit: nextCommit() });
    }

    if (url.pathname.startsWith('/api/cms/publish/')) {
      const path = 'src/content/pages/fixture-canvas.json';
      const refused = enforce('published', path, expectationOf(headers));
      if (refused !== null) return refused;
      const draft = files.get('draft');
      if (draft === undefined) {
        return json(404, { ok: false, error: 'There is no draft to publish.' });
      }
      files.set('published', { text: draft.text, sha: nextSha() });
      files.delete('draft');
      return json(200, {
        ok: true,
        commit: nextCommit(),
        sha: (files.get('published') as ServerFile).sha,
        title: 'published',
      });
    }

    if (url.pathname.startsWith('/api/cms/media/')) {
      const form = init.body as FormData;
      const file = form.get('file') as File;
      uploads.push({ name: file.name, bytes: file.size });
      return json(200, {
        ok: true,
        src: `/media/fixture-canvas/${file.name}`,
        w: 1200,
        h: 800,
        commit: nextCommit(),
        path: `public/media/fixture-canvas/${file.name}`,
        dimensions: 'intrinsic',
        format: 'png',
        bytes: file.size,
      });
    }

    return json(404, { ok: false, error: `no route ${url.pathname}` });
  };

  return {
    fetch: fetchImpl as unknown as typeof fetch,
    calls,
    uploads,
    files,
    /** Simulate somebody else committing: the blob sha moves on. */
    bump(key: 'draft' | 'published'): void {
      const current = files.get(key);
      if (current !== undefined) files.set(key, { ...current, sha: nextSha() });
    },
    signOut(): void {
      signedIn = false;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 1. The adapter, and the sha expectations it sends                           */
/* -------------------------------------------------------------------------- */

async function checkAdapter(): Promise<void> {
  section('1. API adapter: shapes, shas and errors');

  const server = fakeServer({ published: canvasDoc });
  const conflicts: string[] = [];
  const signedOut: string[] = [];
  const api = createCmsApi({
    baseUrl: 'http://cms.test',
    fetch: server.fetch,
    returnTo: () => '/cms/fixture-canvas',
    onConflict: (_info, message) => conflicts.push(message),
    onSignedOut: (url) => signedOut.push(url),
  });

  const status = await api.authStatus();
  equal('authStatus is WS-3 shaped', { signedIn: status.signedIn, login: status.login }, {
    signedIn: true,
    login: 'ryan-choi-jh',
  });
  equal('the richer status is kept', api.lastStatus()?.branch, 'cms/throwaway');

  const pages = await api.listPages();
  equal('listPages trims to {slug,title,hasDraft}', pages, [
    { slug: 'fixture-canvas', title: 'Fixture: prose and canvas', hasDraft: false },
  ]);

  equal('no expectation before the page is read', api.shasFor('fixture-canvas'), undefined);

  const page = await api.getPage('fixture-canvas');
  check('getPage returns the published doc', page.published !== null && page.draft === null);
  equal('getPage records both shas', api.shasFor('fixture-canvas'), {
    draftSha: null,
    publishedSha: 'sha1',
  });

  // First save: there is no draft, so the expectation is "nothing there yet".
  server.calls.length = 0;
  const first = await api.putDraft('fixture-canvas', page.published as Doc);
  equal('a first save sends If-None-Match: *', server.calls[0]?.headers['if-none-match'], '*');
  check('a first save has no If-Match', server.calls[0]?.headers['if-match'] === undefined);
  check('putDraft resolves with a commit', typeof first.commit === 'string' && first.ok);
  const savedSha = api.shasFor('fixture-canvas')?.draftSha;
  equal(
    'the returned draft sha is kept',
    savedSha === (server.files.get('draft') as ServerFile).sha,
    true,
  );

  // Second save: the expectation is the sha the first one returned.
  server.calls.length = 0;
  await api.putDraft('fixture-canvas', page.published as Doc);
  equal('a later save sends If-Match', server.calls[0]?.headers['if-match'], savedSha);
  check('a later save has no If-None-Match', server.calls[0]?.headers['if-none-match'] === undefined);

  // Somebody else commits. The next save must be refused, not merged.
  const beforeBump = api.shasFor('fixture-canvas')?.draftSha ?? null;
  server.bump('draft');
  const afterBump = (server.files.get('draft') as ServerFile).sha;
  let conflict: unknown = null;
  try {
    await api.putDraft('fixture-canvas', page.published as Doc);
  } catch (error) {
    conflict = error;
  }
  check('a stale save throws', conflict instanceof CmsWriteError);
  check('…as a conflict', (conflict as CmsWriteError).isConflict === true, 'status 409');
  equal('…carrying both shas', (conflict as CmsWriteError).conflict, {
    path: 'src/content/drafts/fixture-canvas.json',
    expectedSha: beforeBump,
    actualSha: afterBump,
  });
  equal('…and reported to the host once', conflicts.length, 1);
  check(
    'the message is the server’s own sentence',
    (conflict as CmsWriteError).message.includes('has changed in the repository'),
  );

  // Reload, then redo: the fix the message tells the author to use.
  await api.getPage('fixture-canvas');
  equal('reloading refreshes the expectation', api.shasFor('fixture-canvas')?.draftSha, afterBump);
  await api.putDraft('fixture-canvas', page.published as Doc);
  check('…and the redo lands', true, 'no throw');

  // Publish: the expectation is the PUBLISHED sha, and after it there is no draft.
  server.calls.length = 0;
  await api.publish('fixture-canvas');
  equal('publish sends the published sha', server.calls[0]?.headers['if-match'], 'sha1');
  equal('after publishing there is no draft', api.shasFor('fixture-canvas')?.draftSha, null);
  check(
    'after publishing the published sha moved',
    api.shasFor('fixture-canvas')?.publishedSha !== 'sha1',
  );
  check('the server deleted the draft', !server.files.has('draft'));

  // Upload.
  const upload = await api.uploadMediaDetailed(
    'fixture-canvas',
    new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    'shot.png',
  );
  equal('uploadMedia returns src and intrinsic size', [upload.src, upload.w, upload.h], [
    '/media/fixture-canvas/shot.png',
    1200,
    800,
  ]);
  equal('…and the filename reached the server', server.uploads[0]?.name, 'shot.png');

  const trimmed = await api.uploadMedia(
    'fixture-canvas',
    new File([new Uint8Array([1])], 'again.png', { type: 'image/png' }),
  );
  equal('the CmsApi method trims to {ok,src,w,h}', Object.keys(trimmed).sort(), [
    'h',
    'ok',
    'src',
    'w',
  ]);

  // Signed out mid-session.
  server.signOut();
  let authError: unknown = null;
  try {
    await api.putDraft('fixture-canvas', page.published as Doc);
  } catch (error) {
    authError = error;
  }
  check('a 401 throws', authError instanceof CmsWriteError);
  check('…flagged as signed out', (authError as CmsWriteError).isSignedOut === true);
  equal('…with a login URL for the host', signedOut, [
    'http://cms.test/api/cms/auth/login?return=%2Fcms%2Ffixture-canvas',
  ]);

  // A transport failure, which is the error an author is most likely to hit.
  const broken = createCmsApi({
    baseUrl: 'http://cms.test',
    fetch: (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch,
    returnTo: () => '/cms/x',
  });
  let networkError: unknown = null;
  try {
    await broken.listPages();
  } catch (error) {
    networkError = error;
  }
  check(
    'a network failure says what it was and what to do',
    networkError instanceof CmsWriteError &&
      (networkError as CmsWriteError).message.includes('Failed to fetch') &&
      (networkError as CmsWriteError).message.includes('Check the connection'),
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Media placement                                                          */
/* -------------------------------------------------------------------------- */

function checkMedia(): void {
  section('2. Media: sizing, placement and src projection');

  const stage = { width: 1344, height: 700 };

  equal('a landscape photo fits the drop width', fitMedia({ w: 4032, h: 3024 }, stage), {
    w: 564,
    h: 423,
  });
  equal('a portrait photo fits the band height', fitMedia({ w: 1170, h: 2532 }, stage), {
    w: 312,
    h: 676,
  });
  equal('a small icon is never blown up', fitMedia({ w: 48, h: 48 }, stage), { w: 48, h: 48 });
  equal('a zero is survivable', fitMedia({ w: 0, h: 0 }, stage), { w: 1, h: 1 });
  check(
    'the aspect ratio survives',
    Math.abs(564 / 423 - 4032 / 3024) < 0.01,
    'within 1% of the original',
  );

  equal('a box is centred on the drop point', placeBox({ w: 200, h: 100 }, stage, { x: 500, y: 300 }), {
    x: 400,
    y: 250,
    w: 200,
    h: 100,
  });
  equal('…clamped at the left and top', placeBox({ w: 200, h: 100 }, stage, { x: 10, y: 5 }), {
    x: 0,
    y: 0,
    w: 200,
    h: 100,
  });
  equal('…clamped at the right and bottom', placeBox({ w: 200, h: 100 }, stage, { x: 1340, y: 699 }), {
    x: 1144,
    y: 600,
    w: 200,
    h: 100,
  });
  equal(
    'an item larger than the band sits at the origin',
    placeBox({ w: 2000, h: 900 }, stage, { x: 600, y: 300 }),
    { x: 0, y: 0, w: 2000, h: 900 },
  );

  const a = placeCentred({ w: 360, h: 150 }, stage, 0);
  const b = placeCentred({ w: 360, h: 150 }, stage, 1);
  equal('an insert with no drop point is centred', [a.x, a.y], [492, 275]);
  check('a second insert is stepped, not stacked', b.x === a.x + 28 && b.y === a.y + 28);

  equal('z goes one above the top of the band', nextZ([{ z: 0 }, { z: 4 }, {}] as CanvasItem[]), 5);
  equal('…and starts at 0 on an empty band', nextZ([]), 0);

  equal('extensions are read off the name', extensionOf('A Photo.FINAL.JPG'), 'jpg');
  equal('an image is an image item', itemKindForFile('x.webp'), 'image');
  equal('a video is a video item', itemKindForFile('clip.MOV'), 'video');
  equal('a pdf is refused before it is uploaded', itemKindForFile('paper.pdf'), null);
  equal('an extensionless file is refused', itemKindForFile('clipboard', 'image/png'), null);

  // The whole drop path.
  const band = (firstCanvasBand(canvasDoc) as CanvasBand);
  const item = mediaItem(
    'i_dropped',
    'image',
    { src: '/media/x/photo.png', w: 4032, h: 3024, dimensions: 'intrinsic' },
    band,
    { x: 700, y: 300 },
  );
  equal('a dropped file becomes a placed item', item, {
    id: 'i_dropped',
    kind: 'image',
    x: 418,
    y: 89,
    w: 564,
    h: 423,
    z: 3,
    src: '/media/x/photo.png',
  });

  const withItem = addCanvasItemAt(canvasDoc, band.id, () => item);
  const validated = validateDoc(withItem);
  check(
    'the document still validates with it in',
    validated.ok,
    validated.ok ? '' : formatIssues(validated.issues),
  );

  // Projection: WS-4 renders item.src directly, so it is swapped in and back.
  const resolve = makeMediaResolver('ryan-choi-jh/jinhyuk.org', 'cms/throwaway');
  equal(
    'uploaded media resolves to the branch it was committed to',
    resolve('/media/a/b.png'),
    'https://raw.githubusercontent.com/ryan-choi-jh/jinhyuk.org/cms/throwaway/public/media/a/b.png',
  );
  equal('anything else is left alone', resolve('/projects/x.png'), '/projects/x.png');
  equal('an absolute URL is left alone', resolve('https://x/y.png'), 'https://x/y.png');
  equal(
    'an unknown repo means identity',
    makeMediaResolver(null, 'main')('/media/a/b.png'),
    '/media/a/b.png',
  );

  const items: CanvasItem[] = [
    { id: 'i1', kind: 'image', x: 0, y: 0, w: 10, h: 10, src: '/media/a/b.png' },
    { id: 'i2', kind: 'shape', x: 0, y: 0, w: 10, h: 10, shape: 'line' },
  ];
  const projected = projectItemSrc(items, resolve);
  check('projection rewrites only media srcs', projected[0]?.src?.startsWith('https://') === true);
  equal('…and leaves a shape untouched', projected[1], items[1]);
  // What WS-4 hands back: the same ids, new geometry, src as it was given.
  const moved = projected.map((entry) => ({ ...entry, x: entry.x + 5 }));
  const restored = restoreItemSrc(moved, items);
  equal('un-projection restores the document src', restored[0]?.src, '/media/a/b.png');
  equal('…and keeps the new geometry', restored[0]?.x, 5);
  equal('an unchanged array is returned by identity', projectItemSrc(items, (s) => s), items);
  equal(
    'a round trip with no resolver changes nothing',
    restoreItemSrc(projectItemSrc(items, (s) => s), items),
    items,
  );
}

/* -------------------------------------------------------------------------- */
/* 3. Prose: one block in, one undo step, one shape                            */
/* -------------------------------------------------------------------------- */

function checkProse(): void {
  section('3. Prose: WS-5’s whole block through WS-3’s content-only slot');

  const band = simpleDoc.bands[0];
  if (band === undefined || band.type !== 'prose') throw new Error('simple.json changed shape');
  const block = band.blocks[0] as ProseBlock;

  const edited: ProseBlock = {
    ...block,
    content: [{ type: 'text', text: 'rewritten by the integration test' }],
  };
  const afterEdit = replaceProseBlock(simpleDoc, band.id, edited);
  const target = (afterEdit.bands[0] as { blocks: ProseBlock[] }).blocks[0] as ProseBlock;
  equal('content is written', (target.content[0] as { text: string }).text, 'rewritten by the integration test');
  equal('kind is unchanged', target.kind, block.kind);
  check('the rest of the document is untouched', afterEdit.bands.length === simpleDoc.bands.length);
  check('the original is not mutated', simpleDoc.bands[0] !== afterEdit.bands[0]);
  equal(
    'a no-op returns the same document',
    replaceProseBlock(simpleDoc, band.id, block) === simpleDoc,
    true,
  );
  equal(
    'an unknown band is a no-op',
    replaceProseBlock(simpleDoc, 'b_nope', edited) === simpleDoc,
    true,
  );
  equal(
    'an unknown block is a no-op',
    replaceProseBlock(simpleDoc, band.id, { ...edited, id: 'p_nope' }) === simpleDoc,
    true,
  );

  // The seam that mattered: a kind change carries WS-5's conversion, in ONE
  // document edit, so there is one undo step and the words survive.
  const converted = convertBlockKind(block, 'h2');
  const afterKind = replaceProseBlock(simpleDoc, band.id, converted);
  const headed = (afterKind.bands[0] as { blocks: ProseBlock[] }).blocks[0] as ProseBlock;
  equal('a kind change is written', headed.kind, 'h2');
  equal('…with WS-5’s converted content', headed.content, converted.content);
  equal('…keeping the document’s own block id', headed.id, block.id);
  const validated = validateDoc(afterKind);
  check(
    'the converted document validates',
    validated.ok,
    validated.ok ? '' : formatIssues(validated.issues),
  );

  // Every kind pair, because a conversion that produces illegal content would
  // only show up as a failed save.
  let allValid = true;
  for (const from of ['p', 'h2', 'h3', 'quote', 'ul', 'ol'] as const) {
    for (const to of ['p', 'h2', 'h3', 'quote', 'ul', 'ol'] as const) {
      const start = convertBlockKind(block, from);
      const end = convertBlockKind(start, to);
      const doc = replaceProseBlock(simpleDoc, band.id, end);
      if (!validateDoc(doc).ok) {
        allValid = false;
        console.log(`          ${from} -> ${to} produced an invalid document`);
      }
    }
  }
  check('all 36 kind conversions save', allValid);
}

/* -------------------------------------------------------------------------- */
/* 4. Assets: WS-6’s picker output onto a canvas                               */
/* -------------------------------------------------------------------------- */

function checkAssets(): void {
  section('4. Assets: a picker draft becomes a canvas item');

  const band = firstCanvasBand(canvasDoc) as CanvasBand;
  let allValid = true;
  let allDrawn = true;

  for (const shape of ['line', 'rect', 'ellipse', 'squiggle', 'arrow'] as const) {
    const draft = newDraft(shape, { color: '#2e7d52', strokeWidth: 3 });
    const box = placeCentred({ w: draft.w, h: draft.h }, { width: 1344, height: band.height }, 0);
    const item = draftToItem(draft, { x: box.x, y: box.y, z: nextZ(band.items) });
    const doc = addCanvasItemAt(canvasDoc, band.id, () => item);
    const result = validateDoc(doc);
    if (!result.ok) {
      allValid = false;
      console.log(`          ${shape}: ${formatIssues(result.issues)}`);
    }
    // The drawing is the integration's job only in so far as it must not be
    // empty: a shape item the renderer cannot draw is a blank box on the page.
    const spec = { shape, width: item.w, height: item.h, color: '#2e7d52', strokeWidth: 3, seed: 7 };
    const svg = generateShape(spec);
    if (!svg.startsWith('<svg') || !svg.includes('path') || svg.length < 80) allDrawn = false;
  }

  check('all five asset kinds save', allValid);
  check('all five asset kinds draw', allDrawn);

  // The id is the wobble seed (contracts 5.2), so the item must keep the
  // draft's id or the author gets a different drawing from the one previewed.
  const draft = newDraft('squiggle');
  const item = draftToItem(draft, { x: 0, y: 0 });
  equal('the item keeps the previewed id', item.id, draft.id);

  // Ids must be unique document-wide, which is the one thing that could go
  // wrong with reusing the picker's id.
  const ids = takenIds(canvasDoc);
  check('takenIds sees bands, blocks and items', ids.has('b_canvas_stage') && ids.has('i_canvas_sq') && ids.has('p_canvas_intro'));
  const minted = freshItemId(canvasDoc);
  check('a fresh id is not already in the document', !ids.has(minted), minted);
}

/* -------------------------------------------------------------------------- */
/* 5. A new page                                                               */
/* -------------------------------------------------------------------------- */

function checkNewPage(): void {
  section('5. A slug with no page yet');

  equal('a title is guessed from the slug', titleFromSlug('track-daily-habit-tracker'), 'Track daily habit tracker');
  equal('…and an empty slug is survivable', titleFromSlug(''), 'Untitled');

  const doc = blankDoc({
    slug: 'ws8-e2e',
    title: 'Ws8 e2e',
    date: '2026-10-09',
    bandId: 'b_new',
    blockId: 'p_new',
  });
  const result = validateDoc(doc);
  check(
    'a blank document validates',
    result.ok,
    result.ok ? '' : formatIssues(result.issues),
  );
  equal('…with an empty paragraph, not a missing key', (doc.bands[0] as { blocks: ProseBlock[] }).blocks[0]?.content, []);
  equal('…and the slug it was asked for', doc.meta.slug, 'ws8-e2e');
}

/* -------------------------------------------------------------------------- */
/* 6. The CSS this layer injects                                               */
/* -------------------------------------------------------------------------- */

function checkStyles(): void {
  section('6. Integration CSS stays in its lane');

  check(
    'an overlay band’s canvas stage is transparent',
    INTEGRATION_CSS.includes('.cms-band-box--overlay .cv-stage') &&
      INTEGRATION_CSS.includes('background: transparent'),
  );
  check('nothing is forced with !important', !INTEGRATION_CSS.includes('!important'));

  // Every selector must be prefixed, so this file cannot restyle the site or
  // another workstream's chrome by accident.
  const selectors = INTEGRATION_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map((block) => block.split('{')[0]?.trim() ?? '')
    .filter((text) => text !== '')
    .flatMap((group) => group.split(',').map((one) => one.trim()))
    .filter((one) => one !== '' && !one.startsWith('@'));
  const stray = selectors.filter(
    (one) => !/^(\.ws8-|\.cms-|:root)/.test(one),
  );
  equal('every rule is scoped to .ws8-* or inside .cms-*', stray, []);
}

/* -------------------------------------------------------------------------- */
/* 7. The whole save / publish path through WS-3's store                       */
/* -------------------------------------------------------------------------- */

/**
 * `createDocStore` is React-free by design, so the real store can be driven
 * against the real adapter and a fake WS-2 with no browser at all. This is the
 * closest thing to the editor that runs under bare node, and it is where the
 * notice ordering is checked: the conflict advice has to survive the store
 * writing its own "Save failed" message a microtask later.
 */
async function checkStorePath(): Promise<void> {
  section('7. Save and Publish, through the real store');

  const server = fakeServer({ published: canvasDoc });
  const conflicts: string[] = [];
  const api = createCmsApi({
    baseUrl: 'http://cms.test',
    fetch: server.fetch,
    returnTo: () => '/cms/fixture-canvas',
    onConflict: (_info, message) => {
      // Exactly what src/cms/app/index.tsx does.
      setTimeout(() => store.notify('error', conflictMessage(message)), 0);
      conflicts.push(message);
    },
  });

  const page = await api.getPage('fixture-canvas');
  const store = createDocStore({
    api,
    doc: page.published as Doc,
    published: page.published,
    hasDraft: false,
  });

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

  check('a fresh store is clean', !store.getState().dirty);
  store.updateMeta({ title: 'Edited by the integration test' });
  check('an edit makes it dirty', store.getState().dirty);

  equal('Save writes the draft', await store.save(), true);
  equal('…and says so', store.getState().notice?.message, 'Draft saved.');
  equal('…and the store is clean again', store.getState().dirty, false);
  check('…and the draft is on the server', server.files.has('draft'));
  check(
    '…holding what was edited',
    JSON.parse((server.files.get('draft') as ServerFile).text).meta.title ===
      'Edited by the integration test',
  );
  check('…and the published file is untouched', !JSON.parse(
    (server.files.get('published') as ServerFile).text,
  ).meta.title.includes('integration test'));

  // Somebody else commits to the draft between saves.
  server.bump('draft');
  store.updateMeta({ title: 'Edited again' });
  equal('a save against a moved file fails', await store.save(), false);
  check('…and the document is still dirty, so nothing was lost locally', store.getState().dirty);
  await settle();
  const notice = store.getState().notice?.message ?? '';
  check('…and the advice survives the store’s own message', notice.includes('Reload from repo'), notice);
  check('…which still carries WS-2’s sentence', notice.includes('has changed in the repository'));
  equal('…reported once', conflicts.length, 1);

  // Reload, then redo: the v1 answer to a conflict.
  equal('Reload takes the newer version', await store.loadPage('fixture-canvas'), true);
  equal('…and the local edit is gone, as the message warned', store.getState().dirty, false);
  store.updateMeta({ title: 'Redone' });
  equal('…and the redo saves', await store.save(), true);

  equal('Publish copies the draft over the page', await store.publish(), true);
  equal('…and says so', store.getState().notice?.message, 'Published.');
  check('…the draft is gone', !server.files.has('draft'));
  equal(
    '…the published file is the draft',
    JSON.parse((server.files.get('published') as ServerFile).text).meta.title,
    'Redone',
  );
  equal('…and the store knows there is no draft', store.getState().hasDraft, false);

  // The next save after a publish must create, not overwrite.
  server.calls.length = 0;
  store.updateMeta({ title: 'After publishing' });
  equal('a save after publishing works', await store.save(), true);
  equal(
    '…sending If-None-Match, because publish deleted the draft',
    server.calls.find((call) => call.method === 'PUT')?.headers['if-none-match'],
    '*',
  );
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

console.log('WS-8 editor integration: node checks');
await checkAdapter();
checkMedia();
checkProse();
checkAssets();
checkNewPage();
checkStyles();
await checkStorePath();

console.log(`\n  ${total - failures}/${total} checks passed`);
if (failures > 0) {
  console.log(`  ${failures} FAILED`);
  process.exit(1);
}
