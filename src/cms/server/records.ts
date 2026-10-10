/**
 * src/cms/server/records.ts
 *
 * WS-C. The two record collections: filmography and photography.
 *
 * A record collection is ONE file holding an ordered array
 * (`{ films: [...] }`, `{ albums: [...] }`), so one file is one commit and
 * there are no per-entry endpoints: adding, editing, deleting and reordering
 * are all the same write of the same file with a different array
 * (docs/cms-contracts.md 9.4, 11 note 1).
 *
 * Which leaves one real question, and it is the reason this file exists rather
 * than the editor just PUTting a whole array: **who permutes the array?**
 *
 * If the client does it, every mutation is read-modify-write across two
 * round trips, and two tabs — or one tab and one slow save — silently drop
 * each other's films. The whole-file PUT is still here, because the contract
 * specifies it and because an editor holding the whole collection in memory
 * wants it. But `applyRecordOp` does the read, the permute and the write
 * inside one request, against the sha it just read, so a reorder cannot lose a
 * film that was added somewhere else in the meantime. That is what "reordering
 * is a first-class operation" has to mean to be worth anything.
 *
 * Nothing here knows the word "film" or "album". Everything goes through
 * WS-A's `section.records` (`RecordsDef`), so a third record section would
 * need no change in this file.
 */

import { ApiError, ConflictError, badRequest, notFound } from './errors.ts';
import {
  discardSlotDraft,
  publishSlot,
  readSlot,
  readSlotWorking,
  writeSlotDraft,
} from './drafts.ts';
import type { Ctx, ShaExpectation, Slot, SlotRead, WriteResult } from './drafts.ts';
import { contentPathFor, draftPathFor } from '../sections.ts';
import type { RecordSectionDef, RecordSummary, RecordsDef } from '../sections.ts';
import { formatIssues } from '../schema.ts';
import type { RecordEntry, RecordFile } from '../schema.ts';

/* -------------------------------------------------------------------------- */
/* Serialisation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The on-disk form: two-space indented JSON with a trailing newline, exactly
 * as a document (`serialiseDoc`), and written from what zod returned rather
 * than from what the client sent — so the file's key order is the schema's key
 * order and a diff of a reordered collection is a reordered collection, not a
 * reshuffled file.
 */
export function serialiseRecordFile(file: RecordFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/* -------------------------------------------------------------------------- */
/* The slot                                                                    */
/* -------------------------------------------------------------------------- */

export function recordSlot(section: RecordSectionDef): Slot<RecordFile> {
  return {
    label: section.id,
    contentPath: contentPathFor(section),
    draftPath: draftPathFor(section),
    parse: (text) => parseRecordFile(section.records, text),
  };
}

function parseRecordFile(def: RecordsDef, text: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false as const,
      issues: [{ path: '(root)', message: `invalid JSON: ${(error as Error).message}` }],
    };
  }
  return def.validateFile(value);
}

/* -------------------------------------------------------------------------- */
/* Keys                                                                        */
/* -------------------------------------------------------------------------- */

/** Every record has an `id`; the unions do not name it, so this is the one cast. */
function idOf(entry: RecordEntry): string {
  return (entry as unknown as { id: string }).id;
}

/**
 * What identifies this entry in a URL and in the API: a film's record id, an
 * album's slug (docs/cms-contracts.md 9.4, `RecordSummary.key`). Read through
 * `slugField` so no section name appears here.
 */
export function entryKeyOf(def: RecordsDef, entry: RecordEntry): string {
  if (def.slugField === null) return idOf(entry);
  const value = (entry as unknown as Record<string, unknown>)[def.slugField];
  return typeof value === 'string' && value !== '' ? value : idOf(entry);
}

export function entryTitleOf(def: RecordsDef, entry: RecordEntry): string {
  const value = (entry as unknown as Record<string, unknown>)[def.titleField];
  return typeof value === 'string' && value !== '' ? value : entryKeyOf(def, entry);
}

/**
 * Where this key is in the array, or -1.
 *
 * The key is matched first, then the record id, because the two differ for
 * albums and a caller holding only an id (from a `RecordSummary.id`, or from
 * the media directory it just uploaded into) should not have to care.
 */
export function indexOfKey(def: RecordsDef, entries: RecordEntry[], key: string): number {
  const byKey = entries.findIndex((entry) => entryKeyOf(def, entry) === key);
  if (byKey !== -1) return byKey;
  return entries.findIndex((entry) => idOf(entry) === key);
}

/* -------------------------------------------------------------------------- */
/* Reading and whole-file writing                                              */
/* -------------------------------------------------------------------------- */

export type RecordsRead = SlotRead<RecordFile> & {
  /** List rows for whichever side the editor should show: the draft if there is one. */
  entries: RecordSummary[];
  /** Which side `entries` was built from. */
  entriesFrom: 'draft' | 'published' | 'none';
};

export async function readRecords(
  ctx: Ctx,
  section: RecordSectionDef,
): Promise<RecordsRead> {
  const read = await readSlot(ctx, recordSlot(section));
  const working = read.draft ?? read.published;
  return {
    ...read,
    entries: working === null ? [] : section.records.summarise(working),
    entriesFrom: read.draft !== null ? 'draft' : read.published !== null ? 'published' : 'none',
  };
}

/**
 * Save the whole collection as the draft. The contract's
 * `PUT /api/cms/records/:section` (docs/cms-contracts.md 11): read, permute,
 * write back, with the sha you read as `If-Match`.
 */
export async function writeRecordsDraft(
  ctx: Ctx,
  section: RecordSectionDef,
  body: unknown,
  expected: ShaExpectation = undefined,
): Promise<WriteResult & { data: RecordFile; entries: RecordSummary[] }> {
  const result = section.records.validateFile(body);
  if (!result.ok) {
    throw badRequest(
      `That ${section.label.toLowerCase()} collection does not validate:\n${formatIssues(result.issues)}`,
      'invalid_records',
    );
  }
  const slot = recordSlot(section);
  const write = await writeSlotDraft(ctx, slot, serialiseRecordFile(result.data), expected);
  return { ...write, data: result.data, entries: section.records.summarise(result.data) };
}

export async function discardRecordsDraft(
  ctx: Ctx,
  section: RecordSectionDef,
  expected: ShaExpectation = undefined,
): Promise<{ commit: string }> {
  return discardSlotDraft(ctx, recordSlot(section), expected);
}

export async function publishRecords(
  ctx: Ctx,
  section: RecordSectionDef,
  expected: ShaExpectation = undefined,
): Promise<WriteResult & { data: RecordFile; entries: RecordSummary[] }> {
  const published = await publishSlot(ctx, recordSlot(section), expected);
  return {
    commit: published.commit,
    sha: published.sha,
    data: published.value,
    entries: section.records.summarise(published.value),
  };
}

/* -------------------------------------------------------------------------- */
/* Operations on one record                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The five things an editor does to a collection. Every one of them is applied
 * server side to the collection as it is on the branch right now, and saved as
 * one commit.
 *
 *   add      a new entry, at `index` or at the end
 *   update   replace one entry wholesale; its `id` must not change
 *   delete   remove one entry
 *   reorder  a complete permutation of the existing keys
 *   move     one entry to a new index — what a drag lands on
 *
 * `reorder` takes every key rather than a pair of indices on purpose: a client
 * that has dropped or invented one is refused, instead of writing a collection
 * that is quietly missing a film.
 */
export type RecordOp =
  | { op: 'add'; entry: RecordEntry; index?: number }
  | { op: 'update'; key: string; entry: RecordEntry }
  | { op: 'delete'; key: string }
  | { op: 'reorder'; keys: string[] }
  | { op: 'move'; key: string; to: number };

export const RECORD_OPS = ['add', 'update', 'delete', 'reorder', 'move'] as const;

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest(`Expected a JSON object with an "op" key, one of ${RECORD_OPS.join(', ')}.`);
  }
  return body as Record<string, unknown>;
}

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw === '') {
    throw badRequest(`"${field}" must be a non-empty string.`);
  }
  return raw;
}

function requireIndex(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw badRequest(`"${field}" must be a whole number of 0 or more.`);
  }
  return raw;
}

function requireEntry(def: RecordsDef, raw: unknown): RecordEntry {
  const result = def.validateEntry(raw);
  if (!result.ok) {
    throw badRequest(
      `That ${def.noun} does not validate:\n${formatIssues(result.issues)}`,
      'invalid_record',
    );
  }
  return result.data;
}

/** Turn a request body into an op, with every field checked. Never trusts a cast. */
export function parseRecordOp(section: RecordSectionDef, body: unknown): RecordOp {
  const def = section.records;
  const object = asObject(body);
  const op = object.op;
  switch (op) {
    case 'add': {
      const entry = requireEntry(def, object.entry);
      return object.index === undefined
        ? { op: 'add', entry }
        : { op: 'add', entry, index: requireIndex(object.index, 'index') };
    }
    case 'update':
      return {
        op: 'update',
        key: requireString(object.key, 'key'),
        entry: requireEntry(def, object.entry),
      };
    case 'delete':
      return { op: 'delete', key: requireString(object.key, 'key') };
    case 'reorder': {
      if (!Array.isArray(object.keys)) {
        throw badRequest('"keys" must be an array holding every key in the collection, in the new order.');
      }
      return { op: 'reorder', keys: object.keys.map((key, i) => requireString(key, `keys.${i}`)) };
    }
    case 'move':
      return {
        op: 'move',
        key: requireString(object.key, 'key'),
        to: requireIndex(object.to, 'to'),
      };
    default:
      throw badRequest(
        `"op" was ${JSON.stringify(op)}; it must be one of ${RECORD_OPS.join(', ')}.`,
        'bad_op',
      );
  }
}

/** Apply one op to an array, with every refusal spelled out. Pure; no I/O. */
export function applyOpToEntries(
  def: RecordsDef,
  entries: RecordEntry[],
  op: RecordOp,
): { entries: RecordEntry[]; key: string } {
  const next = [...entries];

  switch (op.op) {
    case 'add': {
      const key = entryKeyOf(def, op.entry);
      if (indexOfKey(def, next, key) !== -1) {
        throw badRequest(
          `There is already a ${def.noun} with the key "${key}". Ids are never reused and two entries cannot share one key.`,
          'duplicate_key',
        );
      }
      const at = op.index === undefined ? next.length : Math.min(op.index, next.length);
      next.splice(at, 0, op.entry);
      return { entries: next, key };
    }

    case 'update': {
      const at = indexOfKey(def, next, op.key);
      if (at === -1) throw notFound(`There is no ${def.noun} "${op.key}" to update.`);
      const existing = next[at] as RecordEntry;
      if (idOf(op.entry) !== idOf(existing)) {
        // An update may change an album's slug — that is a rename, and the URL
        // moves with it. It may never change the record id, which is the one
        // stable handle the media directory and the published order hang off.
        throw badRequest(
          `An update cannot change a ${def.noun}'s id ("${idOf(existing)}" to "${idOf(op.entry)}"). Delete it and add a new one if that is what you mean.`,
          'id_changed',
        );
      }
      const newKey = entryKeyOf(def, op.entry);
      const clash = next.findIndex(
        (entry, index) => index !== at && entryKeyOf(def, entry) === newKey,
      );
      if (clash !== -1) {
        throw badRequest(
          `Another ${def.noun} already uses the key "${newKey}".`,
          'duplicate_key',
        );
      }
      next[at] = op.entry;
      return { entries: next, key: newKey };
    }

    case 'delete': {
      const at = indexOfKey(def, next, op.key);
      if (at === -1) throw notFound(`There is no ${def.noun} "${op.key}" to delete.`);
      next.splice(at, 1);
      return { entries: next, key: op.key };
    }

    case 'reorder': {
      const current = next.map((entry) => entryKeyOf(def, entry));
      const wanted = op.keys;
      if (wanted.length !== current.length) {
        throw badRequest(
          `A reorder has to list every ${def.noun}: the collection holds ${current.length} and ${wanted.length} were sent. Nothing was changed.`,
          'bad_reorder',
        );
      }
      const remaining = new Map<string, number>();
      next.forEach((entry, index) => remaining.set(entryKeyOf(def, entry), index));
      const reordered: RecordEntry[] = [];
      for (const key of wanted) {
        const index = remaining.get(key);
        if (index === undefined) {
          throw badRequest(
            `A reorder named "${key}", which is not a ${def.noun} in this collection (or was named twice). Nothing was changed.`,
            'bad_reorder',
          );
        }
        remaining.delete(key);
        reordered.push(next[index] as RecordEntry);
      }
      return { entries: reordered, key: wanted[0] ?? '' };
    }

    case 'move': {
      const at = indexOfKey(def, next, op.key);
      if (at === -1) throw notFound(`There is no ${def.noun} "${op.key}" to move.`);
      const [entry] = next.splice(at, 1);
      const to = Math.min(op.to, next.length);
      next.splice(to, 0, entry as RecordEntry);
      return { entries: next, key: op.key };
    }

    default: {
      // Exhaustive: the compiler proves there is no other op.
      const never: never = op;
      throw new Error(`unhandled record op ${JSON.stringify(never)}`);
    }
  }
}

export type RecordOpResult = WriteResult & {
  data: RecordFile;
  entries: RecordSummary[];
  /** The key the op acted on, which may be a new one after a rename. */
  key: string;
  /** Where the collection the op was applied to came from. */
  basedOn: 'draft' | 'published' | 'none';
};

/**
 * Read the collection, apply one op, validate the whole file, save it as the
 * draft — one request, one commit, one chance for anything to have moved.
 *
 * With no `If-Match` the sha quoted on the commit is the one this call just
 * read, so a film added by another tab between the read and the write is a 409
 * rather than a film that disappears. With an `If-Match` the client's own view
 * is checked as well.
 *
 * When there is no draft yet the published collection is the starting point,
 * which is how the first edit after a publish works; when there is neither,
 * the section's `empty()` is, which is how the very first film gets added to a
 * repo that has no filmography.json at all.
 */
export async function applyRecordOp(
  ctx: Ctx,
  section: RecordSectionDef,
  op: RecordOp,
  expected: ShaExpectation = undefined,
): Promise<RecordOpResult> {
  // Read, apply, write — so the write can be refused because the collection
  // moved between the read and it, which is usually this server's own read
  // being behind its own last write. "Apply this op to the collection" means
  // the collection as it now stands, so the honest response is to read it
  // again and reapply, not to refuse.
  //
  // Unless the CALLER stated an expectation. `If-Match` means "I am editing
  // the version I was shown"; honouring that and refusing is the whole point
  // of sending it, and a client that sends it wants the 409.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await attemptRecordOp(ctx, section, op, expected);
    } catch (error) {
      if (expected !== undefined || attempt >= 2 || !worthRereading(error, section)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}

/**
 * Refusals that are conclusions about the collection we READ, rather than
 * about the request.
 *
 * Every one of them can be manufactured by a read that is behind this server's
 * own last write. "There is no film film_x" is exactly what a stale collection
 * says about a film added a second ago; "a reorder has to list every film" is
 * what it says when the caller's key list is the true one and ours is not.
 * So each is re-derived from a fresh read before it is believed — and if it is
 * genuine, the re-reads agree and the refusal stands, a second later.
 *
 * Deliberately not in here: anything decided from the request alone, which
 * `parseRecordOp` settles before a read happens; `id_changed`, because a
 * record's id is stable across versions so no read can invent that; and
 * `invalid_draft` / `invalid_published`, because a file that does not parse
 * does not parse and that message is worth showing promptly.
 */
const RE_DERIVE_CODES = new Set(['not_found', 'duplicate_key', 'bad_reorder', 'invalid_records']);

function worthRereading(error: unknown, section: RecordSectionDef): boolean {
  if (error instanceof ConflictError) return error.path === draftPathFor(section);
  return error instanceof ApiError && error.code !== undefined && RE_DERIVE_CODES.has(error.code);
}

async function attemptRecordOp(
  ctx: Ctx,
  section: RecordSectionDef,
  op: RecordOp,
  expected: ShaExpectation,
): Promise<RecordOpResult> {
  const def = section.records;
  const slot = recordSlot(section);
  const working = await readSlotWorking(ctx, slot);
  const file = working.value ?? def.empty();

  const applied = applyOpToEntries(def, def.entries(file), op);
  const nextFile = def.withEntries(file, applied.entries);

  const result = def.validateFile(nextFile);
  if (!result.ok) {
    throw badRequest(
      `That ${op.op} would leave the ${section.label.toLowerCase()} collection invalid, so nothing was written:\n${formatIssues(result.issues)}`,
      'invalid_records',
    );
  }

  const write = await writeSlotDraft(
    ctx,
    slot,
    serialiseRecordFile(result.data),
    expected === undefined ? working.draftSha : expected,
  );

  return {
    ...write,
    data: result.data,
    entries: def.summarise(result.data),
    key: applied.key,
    basedOn: working.from,
  };
}

/* -------------------------------------------------------------------------- */
/* Summaries                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every key and id in the published collection.
 *
 * Both, because `EntrySummary.hasPublished` is answered for a row whose key is
 * an album slug that may have been renamed in the draft: the id still says
 * whether that album is live.
 */
export function publishedKeys(
  section: RecordSectionDef,
  published: RecordFile | null,
): Set<string> {
  const def = section.records;
  const keys = new Set<string>();
  if (published === null) return keys;
  for (const entry of def.entries(published)) {
    keys.add(entryKeyOf(def, entry));
    keys.add(idOf(entry));
  }
  return keys;
}
