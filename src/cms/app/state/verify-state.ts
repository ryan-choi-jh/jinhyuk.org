/**
 * src/cms/app/state/verify-state.ts
 *
 * WS-3's proof for the state layer, with no browser and no network.
 *
 *   node src/cms/app/state/verify-state.ts
 *
 * It drives the real store, the real document operations and the real stub API
 * over the real fixtures, and exits non-zero if any guarantee the shell leans
 * on is untrue. The browser half of the proof is `../shell/harness/drive.mjs`,
 * which does the same things through the actual UI.
 *
 * Nothing in here imports React, so it runs under bare `node` with type
 * stripping. Deliberately not importing `./index.ts`, which re-exports the
 * React bindings.
 */

import { readFileSync } from 'node:fs';

import { formatIssues, validateDoc, validateDocJson } from '../../schema.ts';
import type { Band, CanvasBand, CanvasItem, Doc, ProseBand } from '../../schema.ts';
import * as ops from './doc-ops.ts';
import { COALESCE_MS } from './history.ts';
import { createDocStore } from './store.ts';
import { createStubApi } from './stub-api.ts';

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

function loadFixture(name: string): Doc {
  const text = readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');
  const result = validateDocJson(text);
  if (!result.ok) throw new Error(`fixture ${name} is invalid:\n${formatIssues(result.issues)}`);
  return result.doc;
}

const dense = loadFixture('dense.json');
const simple = loadFixture('simple.json');

/* -------------------------------------------------------------------------- */

section('fixtures');
check('dense.json validates', validateDoc(dense).ok);
check('simple.json validates', validateDoc(simple).ok);
check('dense.json has an overlay band at index 1', (dense.bands[1] as CanvasBand).overlay === true);

/* -------------------------------------------------------------------------- */

section('doc-ops: structure');
{
  const inserted = ops.insertBand(dense, 0, ops.createProseBand());
  check('insert at 0 grows the document', inserted.bands.length === dense.bands.length + 1);
  check('insert leaves the original alone', dense.bands.length === 6, `${dense.bands.length} bands`);
  check('inserted document still validates', validateDoc(inserted).ok);

  const removed = ops.removeBand(dense, 'b_dense_prose_1');
  check('delete removes exactly one band', removed.bands.length === dense.bands.length - 1);
  check(
    'deleting band 0 strips overlay from the band that floats up (rule 10)',
    (removed.bands[0] as CanvasBand).overlay === undefined,
  );
  const removedCheck = validateDoc(removed);
  check(
    'document with the floated band still validates',
    removedCheck.ok,
    removedCheck.ok ? '' : formatIssues(removedCheck.issues),
  );

  const moved = ops.moveBand(dense, 'b_dense_stack', 0);
  check('move puts the band where asked', moved.bands[0]?.id === 'b_dense_stack');
  check('move keeps every band', moved.bands.length === dense.bands.length);
  check(
    'move preserves the full set of ids',
    new Set(moved.bands.map((band) => band.id)).size === dense.bands.length,
  );
  check('moved document validates', validateDoc(moved).ok);

  check('drop index above the dragged row is unchanged', ops.dropIndexToTargetIndex(3, 1) === 1);
  check('drop index below the dragged row shifts down', ops.dropIndexToTargetIndex(1, 4) === 3);
  check('dropping into its own gap is a no-op', ops.dropIndexToTargetIndex(2, 2) === 2);

  check('a no-op returns the same object', ops.removeBand(dense, 'nope') === dense);
}

section('doc-ops: canvas');
{
  const item = (dense.bands[1] as CanvasBand).items[1] as CanvasItem;
  const nudged = ops.updateCanvasItem(dense, 'b_dense_overlay', item.id, { x: item.x + 10 });
  const after = (nudged.bands[1] as CanvasBand).items[1] as CanvasItem;
  check('update moves the item', after.x === item.x + 10);
  check('update keeps the id', after.id === item.id);
  check('updated document validates', validateDoc(nudged).ok);

  const cleared = ops.updateCanvasItem(dense, 'b_dense_overlay', item.id, { rotate: undefined });
  const clearedItem = (cleared.bands[1] as CanvasBand).items[1] as CanvasItem;
  check('clearing an optional field removes the key', !('rotate' in clearedItem));

  const rect = (dense.bands[3] as CanvasBand).items[1] as CanvasItem;
  check('fixture rect has a fill and a radius', rect.fill !== undefined && rect.radius !== undefined);
  const toLine = ops.updateCanvasItem(dense, 'b_dense_shapes', rect.id, { shape: 'line' });
  const lined = (toLine.bands[3] as CanvasBand).items[1] as CanvasItem;
  check('turning a rect into a line drops fill (rule 6)', lined.fill === undefined);
  check('turning a rect into a line drops radius (rule 6)', lined.radius === undefined);
  const linedCheck = validateDoc(toLine);
  check(
    'shape-kind change leaves a valid document',
    linedCheck.ok,
    linedCheck.ok ? '' : formatIssues(linedCheck.issues),
  );

  const dropped = ops.removeCanvasItem(dense, 'b_dense_stack', 'i_dense_stack_2');
  check('item delete removes one item', (dropped.bands[4] as CanvasBand).items.length === 3);
}

section('doc-ops: prose');
{
  const band = simple.bands[0] as ProseBand;
  const first = band.blocks[0];
  if (first === undefined) throw new Error('simple.json has no blocks');

  const toQuote = ops.setBlockKind(simple, band.id, first.id, 'quote');
  const quoted = (toQuote.bands[0] as ProseBand).blocks[0];
  check('kind change is recorded', quoted?.kind === 'quote');
  check(
    'paragraph content is rewrapped as a paragraph node for a quote (2.3)',
    (quoted?.content[0] as { type?: string } | undefined)?.type === 'paragraph',
  );
  check('rewrapped document validates', validateDoc(toQuote).ok);

  const backToP = ops.setBlockKind(toQuote, band.id, first.id, 'p');
  const unquoted = (backToP.bands[0] as ProseBand).blocks[0];
  check(
    'quote back to paragraph unwraps to inline nodes',
    (unquoted?.content[0] as { type?: string } | undefined)?.type === 'text',
  );
  check(
    'the round trip keeps the text',
    ops.blockPlainText(unquoted as NonNullable<typeof unquoted>) === ops.blockPlainText(first),
    ops.blockPlainText(unquoted as NonNullable<typeof unquoted>).slice(0, 30),
  );

  const listBlock = band.blocks.find((block) => block.kind === 'ul');
  if (listBlock !== undefined) {
    const toP = ops.setBlockKind(simple, band.id, listBlock.id, 'p');
    const flat = (toP.bands[0] as ProseBand).blocks.find((block) => block.id === listBlock.id);
    check(
      'a list flattens to inline nodes',
      flat !== undefined && flat.content.every((node) => (node as { type?: string }).type === 'text'),
    );
    check('flattened document validates', validateDoc(toP).ok);
  }

  const withBlock = ops.insertProseBlock(simple, band.id, 1, 'h3');
  check('insert adds a block', (withBlock.bands[0] as ProseBand).blocks.length === band.blocks.length + 1);
  check('inserted block is where asked', (withBlock.bands[0] as ProseBand).blocks[1]?.kind === 'h3');
  check('document with a new block validates', validateDoc(withBlock).ok);
}

section('doc-ops: meta and equality');
{
  const retitled = ops.updateMeta(dense, { title: 'Changed' });
  check('meta patch applies', retitled.meta.title === 'Changed');
  check('meta patch leaves the original', dense.meta.title !== 'Changed');
  check('clearing an optional field removes the key', !('summary' in ops.updateMeta(dense, { summary: '' }).meta));
  check('setting the same value is a no-op', ops.updateMeta(dense, { title: dense.meta.title }) === dense);

  check('deepEqual ignores key order', ops.deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }));
  check('deepEqual treats a missing key and an undefined key as equal', ops.deepEqual({ a: 1 }, { a: 1, b: undefined }));
  check('deepEqual sees a different value', !ops.deepEqual({ a: 1 }, { a: 2 }));
  check('deepEqual compares arrays by position', !ops.deepEqual([1, 2], [2, 1]));
  check('a clone is structurally equal but not the same object', (() => {
    const copy = ops.cloneDoc(dense);
    return copy !== dense && ops.docsEqual(copy, dense);
  })());
}

/* -------------------------------------------------------------------------- */

section('store: undo, redo, dirty');
{
  let clock = 1_000_000;
  const api = createStubApi({ pages: { 'fixture-dense': { published: dense, draft: null } } });
  const store = createDocStore({ api, doc: dense, published: dense, hasDraft: false, now: () => clock });

  const original = ops.cloneDoc(dense);

  check('boots clean', store.getState().dirty === false);
  check('boots with no history', !store.getState().canUndo && !store.getState().canRedo);
  check('boots with nothing selected', store.getState().selection.kind === 'none');

  const order0 = store.getState().doc.bands.map((band) => band.id).join(',');

  store.moveBand('b_dense_stack', 0);
  check('move marks the document dirty', store.getState().dirty === true);
  check('move enables undo', store.getState().canUndo === true);
  check('undo is labelled', store.getState().undoLabel === 'move band');
  check('move reordered the bands', store.getState().doc.bands[0]?.id === 'b_dense_stack');

  const bandId = store.insertBand('canvas', 2);
  check('insert returns the new band id', typeof bandId === 'string');
  check('insert selects the new band', store.getState().selection.kind === 'band');
  check('insert grew the document', store.getState().doc.bands.length === 7);

  store.deleteBand('b_dense_shapes');
  check('delete shrank the document', store.getState().doc.bands.length === 6);
  check('delete leaves an undoable notice', store.getState().notice?.undoable === true);
  check('deleting a different band leaves the selection alone', store.getState().selection.kind === 'band');

  const edited = ops.cloneDoc(store.getState().doc);

  check('undo 1', store.undo());
  check('undo 2', store.undo());
  check('undo 3', store.undo());
  check('three undos restore the band order', store.getState().doc.bands.map((band) => band.id).join(',') === order0);
  check('three undos restore the document exactly', ops.docsEqual(store.getState().doc, original));
  check('back at the saved state the document is clean again', store.getState().dirty === false);
  check('nothing more to undo', store.getState().canUndo === false);
  check('undo on an empty stack returns false', store.undo() === false);

  check('redo 1', store.redo());
  check('redo 2', store.redo());
  check('redo 3', store.redo());
  check('three redos restore the edited document exactly', ops.docsEqual(store.getState().doc, edited));
  check('redone document is dirty again', store.getState().dirty === true);
  check('nothing more to redo', store.getState().canRedo === false);
  check('redo on an empty stack returns false', store.redo() === false);

  // An edit after an undo throws the redo branch away.
  store.undo();
  check('undo re-enables redo', store.getState().canRedo === true);
  store.updateMeta({ title: 'A new branch' });
  check('a new edit clears the redo stack', store.getState().canRedo === false);

  section('store: validation gates save');
  store.reset(ops.cloneDoc(original), { published: original, hasDraft: false });
  store.updateMeta({ date: '2026-02-30' });
  check('an impossible date is still in the document', store.getState().doc.meta.date === '2026-02-30');
  const refused = await store.save();
  check('save refuses an invalid document', refused === false);
  check('the refusal lists issues', store.getState().issues.length > 0);
  check('nothing was sent to the API', !api.calls.some((call) => call.method === 'putDraft'));
  check('the refusal says so', store.getState().notice?.kind === 'error');
  store.undo();
  check('undo recovers a valid document', validateDoc(store.getState().doc).ok);

  section('store: coalescing');
  store.reset(ops.cloneDoc(original), { published: original, hasDraft: false });
  const itemId = 'i_dense_rotated';
  for (let step = 0; step < 20; step += 1) {
    clock += 10;
    store.updateCanvasItem('b_dense_overlay', itemId, { x: 1070 + step });
  }
  check('a drag of 20 moves is one undo step', (() => {
    store.undo();
    const item = (store.getState().doc.bands[1] as CanvasBand).items.find((candidate) => candidate.id === itemId);
    return item?.x === 1070;
  })());
  check('one undo is enough to get back to clean', store.getState().dirty === false);

  store.reset(ops.cloneDoc(original), { published: original, hasDraft: false });
  clock += 10;
  store.updateCanvasItem('b_dense_overlay', itemId, { x: 1100 });
  clock += COALESCE_MS + 50;
  store.updateCanvasItem('b_dense_overlay', itemId, { x: 1200 });
  store.undo();
  check('a gesture that stopped for longer than the window is a separate step', (() => {
    const item = (store.getState().doc.bands[1] as CanvasBand).items.find((candidate) => candidate.id === itemId);
    return item?.x === 1100;
  })());

  section('store: selection');
  store.reset(ops.cloneDoc(original), { published: original, hasDraft: false });
  store.selectItems('b_dense_stack', ['i_dense_stack_2', 'i_dense_stack_3']);
  check('two items can be selected at once', store.getState().selection.kind === 'item');
  store.deleteCanvasItem('b_dense_stack', 'i_dense_stack_2');
  const selection = store.getState().selection;
  check(
    'deleting one of two selected items keeps the other selected',
    selection.kind === 'item' && selection.itemIds.length === 1 && selection.itemIds[0] === 'i_dense_stack_3',
  );
  store.selectBlock('b_dense_prose_1', 'p_dense_anchor');
  check('a prose block can be selected', store.getState().selection.kind === 'block');
  store.deleteBand('b_dense_prose_1');
  check('deleting the band clears a selection pointing into it', store.getState().selection.kind === 'none');
  store.undo();
  check('undo restores the selection that was live before the edit', store.getState().selection.kind === 'block');
  store.selectBand('b_dense_shapes');
  store.deleteBand('b_dense_shapes');
  check('deleting the selected band clears the selection', store.getState().selection.kind === 'none');
}

/* -------------------------------------------------------------------------- */

section('stub api: draft and publish semantics');
{
  const api = createStubApi({ pages: { 'fixture-dense': { published: dense, draft: null } } });
  const store = createDocStore({ api, doc: dense, published: dense, hasDraft: false });

  store.updateMeta({ title: 'Saved from the store' });
  check('dirty before saving', store.getState().dirty === true);

  const saved = await store.save();
  check('save succeeds', saved === true);
  check('save clears dirty', store.getState().dirty === false);
  check('save records a commit', (store.getState().lastCommit ?? '').startsWith('stub'));
  check('the stub now holds a draft', api.snapshot()['fixture-dense']?.draft !== null);
  check(
    'the published document is untouched by a save (2.3)',
    api.snapshot()['fixture-dense']?.published?.meta.title === dense.meta.title,
  );
  check('the draft carries the edit', api.snapshot()['fixture-dense']?.draft?.meta.title === 'Saved from the store');

  const published = await store.publish();
  check('publish succeeds', published === true);
  check('publish copies the draft over published', api.snapshot()['fixture-dense']?.published?.meta.title === 'Saved from the store');
  check('publish deletes the draft', api.snapshot()['fixture-dense']?.draft === null);
  check('the store knows the draft is gone', store.getState().hasDraft === false);

  // Publishing with something unsaved saves first, or the edit would be lost.
  store.updateMeta({ title: 'Edited then published' });
  const republished = await store.publish();
  check('publish with unsaved changes still succeeds', republished === true);
  check('publish saved the pending edit first', api.snapshot()['fixture-dense']?.published?.meta.title === 'Edited then published');
  check('and the draft is gone again', api.snapshot()['fixture-dense']?.draft === null);
  check('clean after publishing', store.getState().dirty === false);

  api.failNext('putDraft', 'tree conflict: blob sha has moved on');
  store.updateMeta({ title: 'This one fails' });
  const failed = await store.save();
  check('a failing save reports failure', failed === false);
  check('a failing save leaves the document dirty', store.getState().dirty === true);
  check('a failing save surfaces the error', store.getState().notice?.message.includes('tree conflict') === true);
  check('a failing save leaves the phase idle', store.getState().phase === 'idle');

  const recovered = await store.save();
  check('the next save goes through', recovered === true);

  const loaded = await store.loadPage('fixture-dense');
  check('loadPage succeeds', loaded === true);
  check('loadPage resets history', store.getState().canUndo === false);
  check('loadPage lands clean', store.getState().dirty === false);

  const missing = await store.loadPage('no-such-page');
  check('loading a page that does not exist fails', missing === false);

  const auth = await api.authStatus();
  check('the stub reports a signed-in user', auth.signedIn === true);
}

section('stub api: it really does validate');
{
  const api = createStubApi();
  const broken = { ...ops.cloneDoc(simple), bands: [...simple.bands, { id: 'bad band', type: 'prose', blocks: [] }] } as unknown as Doc;
  let message = '';
  try {
    await api.putDraft(simple.meta.slug, broken);
  } catch (error) {
    message = (error as Error).message;
  }
  check('an invalid document is rejected', message.includes('invalid document'));
  check('the rejection names the field', message.includes('bands.1.id'), message.split('\n')[1] ?? '');

  let mismatch = '';
  try {
    await api.putDraft('some-other-slug', ops.cloneDoc(simple));
  } catch (error) {
    mismatch = (error as Error).message;
  }
  check('a slug mismatch is rejected', mismatch.includes('slug mismatch'));
}

section('shell: band grouping (overlay bands attach to the band before them)');
{
  // Mirrors ../shell/page-surface.tsx groupBands, checked here because it is
  // the one piece of layout logic that is pure.
  const groups: { host: Band; overlays: Band[] }[] = [];
  for (const band of dense.bands) {
    const isOverlay = band.type === 'canvas' && band.overlay === true;
    const last = groups[groups.length - 1];
    if (isOverlay && last !== undefined) last.overlays.push(band);
    else groups.push({ host: band, overlays: [] });
  }
  check('dense.json collapses to five groups', groups.length === 5, `${groups.length}`);
  check('the overlay attaches to the prose band before it', groups[0]?.host.id === 'b_dense_prose_1');
  check('and it is the only overlay', groups[0]?.overlays[0]?.id === 'b_dense_overlay');
}

/* -------------------------------------------------------------------------- */

console.log(`\n  ${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`  ${failures} FAILED`);
  process.exit(1);
}
console.log('  WS-3 state layer verified\n');
