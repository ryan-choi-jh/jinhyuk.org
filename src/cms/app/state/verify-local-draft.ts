/**
 * src/cms/app/state/verify-local-draft.ts
 *
 * The crash snapshot, against a fake storage.
 *
 *   node src/cms/app/state/verify-local-draft.ts
 *
 * Every function in local-draft.ts takes its storage as an argument for
 * exactly this reason: the interesting cases are the ones a real browser
 * will not perform on demand. Storage that throws on read (a private
 * window), storage that throws on write (full), a snapshot written by an
 * older version of the editor, a snapshot from yesterday, a snapshot that is
 * simply corrupt.
 *
 * The rule under all of them: a snapshot is a convenience, and a convenience
 * that fails must never become a problem. Nothing here may throw.
 */

import { formatIssues, validateDoc } from '../../schema.ts';
import type { Doc } from '../../schema.ts';
import {
  MAX_AGE_MS,
  clearLocalDraft,
  describeAge,
  localDraftKey,
  readLocalDraft,
  worthOffering,
  writeLocalDraft,
} from './local-draft.ts';

let passed = 0;
const failures: string[] = [];
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1;
  else failures.push(`${name}${detail === '' ? '' : `\n      ${detail}`}`);
}

function doc(title: string): Doc {
  const result = validateDoc({
    version: 1,
    meta: { title, slug: 'thing', date: '2026-01-01', section: 'essays' },
    bands: [{ id: 'b1', type: 'prose', blocks: [{ id: 'p1', kind: 'p', content: [{ type: 'text', text: title }] }] }],
  });
  if (!result.ok) throw new Error(formatIssues(result.issues));
  return result.doc;
}

/** A storage that behaves, and ones that do not. */
function fake(): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}
const throwsOnRead = { getItem: () => { throw new Error('no'); }, setItem: () => {}, removeItem: () => {} };
const throwsOnWrite = { getItem: () => null, setItem: () => { throw new Error('full'); }, removeItem: () => {} };

const NOW = 1_800_000_000_000;
const KEY = localDraftKey('essays', 'thing');

/* ---- the ordinary round trip -------------------------------------------- */
{
  const store = fake();
  const a = doc('A draft in progress');
  ok('a snapshot writes', writeLocalDraft(KEY, a, NOW, store));
  const back = readLocalDraft(KEY, NOW + 1000, store);
  ok('…and reads back', back !== null && back.doc.meta.title === 'A draft in progress');
  ok('…with its timestamp', back?.at === NOW);
  clearLocalDraft(KEY, store);
  ok('…and clears', readLocalDraft(KEY, NOW, store) === null);
}

/* ---- the key separates entries ------------------------------------------ */
{
  const store = fake();
  writeLocalDraft(localDraftKey('essays', 'one'), doc('One'), NOW, store);
  writeLocalDraft(localDraftKey('essays', 'two'), doc('Two'), NOW, store);
  writeLocalDraft(localDraftKey('home', null), doc('Home'), NOW, store);
  ok(
    'each entry has its own snapshot',
    readLocalDraft(localDraftKey('essays', 'one'), NOW, store)?.doc.meta.title === 'One' &&
      readLocalDraft(localDraftKey('essays', 'two'), NOW, store)?.doc.meta.title === 'Two' &&
      readLocalDraft(localDraftKey('home', null), NOW, store)?.doc.meta.title === 'Home',
  );
  ok('a singleton key has no trailing slash', localDraftKey('home', null).endsWith('home'), localDraftKey('home', null));
}

/* ---- storage that will not cooperate ------------------------------------ */
{
  ok('a storage that throws on read returns nothing', readLocalDraft(KEY, NOW, throwsOnRead) === null);
  ok('a storage that throws on write says so', writeLocalDraft(KEY, doc('x'), NOW, throwsOnWrite) === false);
  ok('…and does not throw', true);
  // No storage at all: the browser-less case, and a private window.
  ok('no storage reads as nothing', readLocalDraft(KEY, NOW, null as never) === null);
}

/* ---- rubbish in storage -------------------------------------------------- */
{
  const store = fake();
  for (const [what, value] of [
    ['not JSON', '{oh dear'],
    ['JSON but not an object', '42'],
    ['no timestamp', JSON.stringify({ doc: doc('x') })],
    ['a timestamp that is not a number', JSON.stringify({ at: 'now', doc: doc('x') })],
    ['no document', JSON.stringify({ at: NOW })],
    ['null', 'null'],
  ] as const) {
    store.setItem(KEY, value);
    ok(`${what} reads as nothing`, readLocalDraft(KEY, NOW, store) === null);
  }
}

/* ---- age ---------------------------------------------------------------- */
{
  const store = fake();
  writeLocalDraft(KEY, doc('Yesterday'), NOW, store);
  ok('a fresh snapshot is offered', readLocalDraft(KEY, NOW + 60_000, store) !== null);
  ok(
    'one older than a day is not: it is a forgotten tab, not work in progress',
    readLocalDraft(KEY, NOW + MAX_AGE_MS + 1, store) === null,
  );
}

/* ---- when it is worth offering ------------------------------------------ */
{
  const current = doc('What the server has');
  const same = { doc: doc('What the server has'), at: NOW };
  const different = { doc: doc('What I was typing'), at: NOW };
  ok('nothing to offer when there is no snapshot', !worthOffering(null, current));
  ok(
    'nothing to offer when it matches what is on screen',
    !worthOffering(same, current),
    'a snapshot is written FROM the open document, so this is the normal case and a banner here would never go away',
  );
  ok('offered when it differs', worthOffering(different, current));
}

/* ---- the words ---------------------------------------------------------- */
{
  ok('seconds read as less than a minute', describeAge(NOW, NOW + 30_000) === 'less than a minute ago');
  ok('one minute is singular', describeAge(NOW, NOW + 60_000) === '1 minute ago');
  ok('several are plural', describeAge(NOW, NOW + 11 * 60_000) === '11 minutes ago');
  ok('and hours', describeAge(NOW, NOW + 3 * 60 * 60_000) === '3 hours ago');
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  process.exitCode = 1;
}
