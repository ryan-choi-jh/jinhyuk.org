/**
 * src/cms/preview/diff.ts
 *
 * WS-7. "A toggle between draft and published, which should make the
 * difference obvious when both exist."
 *
 * A toggle on its own is not obvious. Flicking between two renderings of a
 * long page tells you something changed only if the change happens to be on
 * screen, and the one thing a preview is for is catching the change you did
 * not mean to make. So the chrome also lists what differs, band by band, and
 * the toolbar says it in one line.
 *
 * Band level, not character level, on purpose. A band is the unit the author
 * moves, inserts and deletes (2.2), the unit the editor's outline shows, and
 * the unit the chrome can scroll the frame to. A word-level diff of TipTap
 * JSON would be a bigger, slower, less legible answer to a question nobody
 * asked: this panel's job is to point at the part of the page to go and look
 * at, in the frame, with your own eyes.
 *
 * Both documents reaching here have been through `validateDoc`, so both have
 * the schema's key order and `JSON.stringify` is a sound equality test.
 *
 * Pure. No fs, no fetch, no DOM.
 */

import { isCanvasBand } from '../schema.ts';
import type { Album, Band, Doc, DocMeta, Photo, ProseBand, RecordFile } from '../schema.ts';
import type { RecordsDef } from '../sections.ts';

/* -------------------------------------------------------------------------- */
/* Labels                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The readable text inside a block's TipTap JSON, for a label. The content is
 * typed `unknown` by the schema (3.2), so this walks defensively rather than
 * trusting a shape.
 */
export function plainText(content: unknown, limit = 80): string {
  const parts: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 12 || parts.join(' ').length > limit * 2) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (typeof record.text === 'string') parts.push(record.text);
    if (record.content !== undefined) walk(record.content, depth + 1);
  };
  walk(content, 0);
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function proseLabel(band: ProseBand): string {
  for (const block of band.blocks) {
    const text = plainText(block.content);
    if (text !== '') return text;
  }
  return `${band.blocks.length} empty block${band.blocks.length === 1 ? '' : 's'}`;
}

/** One line describing a band, for the change list. */
export function bandLabel(band: Band): string {
  if (!isCanvasBand(band)) return proseLabel(band);
  const kinds = new Map<string, number>();
  for (const item of band.items) {
    const kind = item.kind === 'shape' ? (item.shape ?? 'shape') : item.kind;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const summary = [...kinds.entries()]
    .map(([kind, count]) => (count === 1 ? kind : `${count} ${kind}s`))
    .join(', ');
  const overlay = band.overlay === true ? 'overlay, ' : '';
  return summary === '' ? `${overlay}empty canvas` : `${overlay}${summary}`;
}

export function bandKindLabel(band: Band): string {
  return isCanvasBand(band) ? (band.overlay === true ? 'canvas · overlay' : 'canvas') : 'prose';
}

/* -------------------------------------------------------------------------- */
/* The diff                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `added` and `removed` are from the draft's point of view: a band in the
 * draft that is not published is added. `moved` is the same content at a
 * different index. `changed` beats `moved` when both are true, because the
 * content is the more interesting half.
 */
export type BandStatus = 'same' | 'changed' | 'added' | 'removed' | 'moved';

export type BandDiffEntry = {
  id: string;
  status: BandStatus;
  /** 'prose' | 'canvas' | 'canvas · overlay', from whichever side has the band. */
  kind: string;
  label: string;
  /** Index in each document, or null where the band is absent. */
  draftIndex: number | null;
  publishedIndex: number | null;
};

/**
 * The `meta` fields this panel compares as single lines of text.
 *
 * A subset of `keyof DocMeta`, and typed as its own union rather than as
 * `keyof DocMeta`, because `meta` is no longer all strings: WS-A added
 * `section` (a narrower union, fine) and `buttons` (an array, not fine), and
 * indexing with the full key union makes `draft[field]` the union of every
 * value type. Narrowing the key list narrows the value type with it, which is
 * what keeps `draft: string | null` honest.
 *
 * `buttons` is therefore not in here, and is compared as part of the document
 * rather than as a detail line — see `BUTTONS_FIELD` below.
 */
const META_TEXT_FIELDS = ['title', 'slug', 'date', 'summary', 'url', 'cover', 'section'] as const;

export type MetaTextField = (typeof META_TEXT_FIELDS)[number];

/** The pseudo-field the end-of-post buttons are reported under. */
export const BUTTONS_FIELD = 'buttons';

export type MetaDiffEntry = {
  field: MetaTextField | typeof BUTTONS_FIELD;
  draft: string | null;
  published: string | null;
};

export type DocDiff = {
  /** False when one side is missing: there is nothing to compare, not "no changes". */
  comparable: boolean;
  /** Byte-for-byte equal, meta included. */
  identical: boolean;
  meta: MetaDiffEntry[];
  bands: BandDiffEntry[];
  counts: { added: number; removed: number; changed: number; moved: number; same: number };
  /** The toolbar line. Always safe to show. */
  summary: string;
};

/** The buttons as one line, so they can be reported beside the text fields. */
function buttonsLine(meta: DocMeta): string | null {
  if (meta.buttons === undefined || meta.buttons.length === 0) return null;
  return meta.buttons.map((button) => `${button.label} → ${button.href}`).join(' · ');
}

function metaDiff(draft: DocMeta, published: DocMeta): MetaDiffEntry[] {
  const entries: MetaDiffEntry[] = [];
  for (const field of META_TEXT_FIELDS) {
    const a = draft[field] ?? null;
    const b = published[field] ?? null;
    if (a !== b) entries.push({ field, draft: a, published: b });
  }
  const draftButtons = buttonsLine(draft);
  const publishedButtons = buttonsLine(published);
  if (draftButtons !== publishedButtons) {
    entries.push({ field: BUTTONS_FIELD, draft: draftButtons, published: publishedButtons });
  }
  return entries;
}

function byId(bands: readonly Band[]): Map<string, { band: Band; index: number }> {
  const map = new Map<string, { band: Band; index: number }>();
  bands.forEach((band, index) => {
    // A document with duplicate band ids is rejected by the schema, so the
    // first wins and this never silently loses a band in practice.
    if (!map.has(band.id)) map.set(band.id, { band, index });
  });
  return map;
}

function pluralise(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The ids that stayed put, by longest common subsequence.
 *
 * Comparing indices directly would call four bands "moved" when one band was
 * dragged past three others, because three of them did change index. The LCS
 * is the longest run of bands whose relative order is unchanged, so what is
 * left over is the smallest honest answer to "what did you move": one band.
 *
 * Sequences here are a handful of bands long, so the quadratic table is
 * cheaper than the alternative of explaining why it is not needed.
 */
function stayedPut(draftIds: string[], publishedIds: string[]): Set<string> {
  const n = draftIds.length;
  const m = publishedIds.length;
  const table: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] =
        draftIds[i] === publishedIds[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const keep = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (draftIds[i] === publishedIds[j]) {
      keep.add(draftIds[i]!);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return keep;
}

export function diffDocs(draft: Doc | null, published: Doc | null): DocDiff {
  const empty = { added: 0, removed: 0, changed: 0, moved: 0, same: 0 };

  if (draft === null || published === null) {
    const only = draft !== null ? 'draft' : published !== null ? 'published' : null;
    return {
      comparable: false,
      identical: false,
      meta: [],
      bands: [],
      counts: { ...empty },
      summary:
        only === null
          ? 'Nothing saved at this slug yet.'
          : only === 'draft'
            ? 'Draft only. This page has never been published.'
            : 'Published only. There is no draft.',
    };
  }

  const draftBands = byId(draft.bands);
  const publishedBands = byId(published.bands);
  const counts = { ...empty };
  const bands: BandDiffEntry[] = [];

  const common = draft.bands.map((band) => band.id).filter((id) => publishedBands.has(id));
  const keep = stayedPut(
    common,
    published.bands.map((band) => band.id).filter((id) => draftBands.has(id)),
  );

  const entryFor = (id: string): BandDiffEntry => {
    const inDraft = draftBands.get(id);
    const inPublished = publishedBands.get(id);
    const band = (inDraft ?? inPublished)!.band;
    let status: BandStatus;
    if (inDraft === undefined) status = 'removed';
    else if (inPublished === undefined) status = 'added';
    else if (JSON.stringify(inDraft.band) !== JSON.stringify(inPublished.band)) status = 'changed';
    else if (!keep.has(id)) status = 'moved';
    else status = 'same';
    counts[status] += 1;
    return {
      id,
      status,
      kind: bandKindLabel(band),
      label: bandLabel(band),
      draftIndex: inDraft?.index ?? null,
      publishedIndex: inPublished?.index ?? null,
    };
  };

  // Draft order first, because that is the order the frame shows when the
  // toggle is on Draft, which is the default. Bands that only exist in the
  // published page are appended, after their own position in that page.
  for (const band of draft.bands) bands.push(entryFor(band.id));
  for (const band of published.bands) {
    if (!draftBands.has(band.id)) bands.push(entryFor(band.id));
  }

  const identical = JSON.stringify(draft) === JSON.stringify(published);
  const metaChanges = metaDiff(draft.meta, published.meta);

  const pieces: string[] = [];
  if (counts.changed > 0) pieces.push(`${pluralise(counts.changed, 'band')} edited`);
  if (counts.added > 0) pieces.push(`${counts.added} added`);
  if (counts.removed > 0) pieces.push(`${counts.removed} removed`);
  if (counts.moved > 0) pieces.push(`${counts.moved} moved`);
  if (metaChanges.length > 0) {
    pieces.push(`${pluralise(metaChanges.length, 'detail')} (${metaChanges.map((m) => m.field).join(', ')})`);
  }

  return {
    comparable: true,
    identical,
    meta: metaChanges,
    bands,
    counts,
    summary: identical
      ? 'Draft is identical to the published page.'
      : pieces.length === 0
        ? 'Draft differs from the published page.'
        : `Draft differs: ${pieces.join(', ')}.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Outline of a single document                                              */
/* -------------------------------------------------------------------------- */

/**
 * The same list for a page with only one version, so the panel is a band
 * outline rather than blank. Every entry is 'same': there is nothing to
 * compare it with, and claiming otherwise would be a lie dressed as a diff.
 */
export function outlineOf(doc: Doc | null): BandDiffEntry[] {
  if (doc === null) return [];
  return doc.bands.map((band, index) => ({
    id: band.id,
    status: 'same' as BandStatus,
    kind: bandKindLabel(band),
    label: bandLabel(band),
    draftIndex: index,
    publishedIndex: index,
  }));
}

/* -------------------------------------------------------------------------- */
/* WS-H: the same panel, for the four surfaces that are not a document        */
/* -------------------------------------------------------------------------- */

/**
 * One shape for every surface's change list, so the chrome has one loop.
 *
 * `DocDiff` keeps its `bands` key, because `selftest.ts`, `verify.ts` and the
 * phase 1 integration run all read it; `SurfaceDiff` is what the route
 * actually renders, and `surfaceDiffOfDocs` is the adapter between them. The
 * duplication is one field name and the alternative was renaming a key three
 * other files read.
 */
export type SurfaceDiff = {
  comparable: boolean;
  identical: boolean;
  meta: MetaDiffEntry[];
  rows: BandDiffEntry[];
  counts: { added: number; removed: number; changed: number; moved: number; same: number };
  summary: string;
};

/** A thing with a stable key, which is all the generic diff needs to know. */
type Keyed = {
  key: string;
  /** The word for this kind of row: 'prose', 'film', 'album', 'photo', 'essay'. */
  kind: string;
  label: string;
  /** Compared with `===`, so pass a canonical string. */
  fingerprint: string;
};

/**
 * The band diff, generalised.
 *
 * Identical logic to `diffDocs`: match by key, call content inequality
 * `changed`, and use the longest common subsequence so dragging one item past
 * three others reports one move rather than four. That reasoning is written
 * out at `stayedPut` and is not repeated here.
 */
function diffKeyed(
  draft: readonly Keyed[] | null,
  published: readonly Keyed[] | null,
  noun: string,
  only: { draft: string; published: string; neither: string },
): SurfaceDiff {
  const empty = { added: 0, removed: 0, changed: 0, moved: 0, same: 0 };

  if (draft === null || published === null) {
    return {
      comparable: false,
      identical: false,
      meta: [],
      rows: (draft ?? published ?? []).map((item, index) => ({
        id: item.key,
        status: 'same' as BandStatus,
        kind: item.kind,
        label: item.label,
        draftIndex: index,
        publishedIndex: index,
      })),
      counts: { ...empty },
      summary:
        draft !== null ? only.draft : published !== null ? only.published : only.neither,
    };
  }

  const draftBy = new Map(draft.map((item, index) => [item.key, { item, index }]));
  const publishedBy = new Map(published.map((item, index) => [item.key, { item, index }]));
  const keep = stayedPut(
    draft.map((item) => item.key).filter((key) => publishedBy.has(key)),
    published.map((item) => item.key).filter((key) => draftBy.has(key)),
  );

  const counts = { ...empty };
  const rows: BandDiffEntry[] = [];

  const rowFor = (key: string): BandDiffEntry => {
    const inDraft = draftBy.get(key);
    const inPublished = publishedBy.get(key);
    const item = (inDraft ?? inPublished)!.item;
    let status: BandStatus;
    if (inDraft === undefined) status = 'removed';
    else if (inPublished === undefined) status = 'added';
    else if (inDraft.item.fingerprint !== inPublished.item.fingerprint) status = 'changed';
    else if (!keep.has(key)) status = 'moved';
    else status = 'same';
    counts[status] += 1;
    return {
      id: key,
      status,
      kind: item.kind,
      label: item.label,
      draftIndex: inDraft?.index ?? null,
      publishedIndex: inPublished?.index ?? null,
    };
  };

  for (const item of draft) rows.push(rowFor(item.key));
  for (const item of published) {
    if (!draftBy.has(item.key)) rows.push(rowFor(item.key));
  }

  const identical =
    draft.length === published.length &&
    draft.every((item, index) => {
      const other = published[index];
      return other !== undefined && other.key === item.key && other.fingerprint === item.fingerprint;
    });

  const pieces: string[] = [];
  if (counts.changed > 0) pieces.push(`${pluralise(counts.changed, noun)} edited`);
  if (counts.added > 0) pieces.push(`${counts.added} added`);
  if (counts.removed > 0) pieces.push(`${counts.removed} removed`);
  if (counts.moved > 0) pieces.push(`${counts.moved} reordered`);

  return {
    comparable: true,
    identical,
    meta: [],
    rows,
    counts,
    summary: identical
      ? `Draft is identical to the published ${noun} list.`
      : pieces.length === 0
        ? 'Draft differs from the published version.'
        : `Draft differs: ${pieces.join(', ')}.`,
  };
}

/** `diffDocs`, in the shape the route renders. */
export function surfaceDiffOfDocs(draft: Doc | null, published: Doc | null): SurfaceDiff {
  const diff = diffDocs(draft, published);
  const rows = diff.comparable ? diff.bands : outlineOf(draft ?? published);
  return {
    comparable: diff.comparable,
    identical: diff.identical,
    meta: diff.meta,
    rows,
    counts: diff.counts,
    summary: diff.summary,
  };
}

/* -------------------------------------------------------------------------- */
/* Records: a film list or an album list                                      */
/* -------------------------------------------------------------------------- */

/**
 * One row per entry in a record collection.
 *
 * Keyed by `RecordSummary.key`, which is a film's record id and an album's
 * slug — the same key WS-C's record ops take, so a row in this panel and the
 * `{op:'update', key}` that produced it name the same thing.
 *
 * The fingerprint is the entry's own JSON. Both sides have been through the
 * section's `validateFile`, so zod has put the keys in schema order on both
 * and `JSON.stringify` is a sound equality test — the same argument
 * `diffDocs` makes for documents.
 */
function recordRows(file: RecordFile | null, def: RecordsDef): Keyed[] | null {
  if (file === null) return null;
  const entries = def.entries(file);
  // `summarise` walks `entries` in order, so the two arrays are index-aligned.
  // That is the registry's contract and the only thing joining a row's title
  // to the entry its fingerprint comes from.
  const summaries = def.summarise(file);
  return entries.map((entry, index) => {
    const summary = summaries[index];
    return {
      key: summary?.key ?? String(index),
      kind: def.noun,
      label:
        summary === undefined
          ? `${def.noun} ${index + 1}`
          : summary.subtitle === ''
            ? summary.title
            : `${summary.title} — ${summary.subtitle}`,
      fingerprint: JSON.stringify(entry),
    };
  });
}

export function diffRecords(
  draft: RecordFile | null,
  published: RecordFile | null,
  def: RecordsDef,
): SurfaceDiff {
  return diffKeyed(recordRows(draft, def), recordRows(published, def), def.noun, {
    draft: `Draft only. This ${def.noun} list has never been published.`,
    published: `Published only. There is no draft.`,
    neither: `Nothing saved in this collection yet.`,
  });
}

/* -------------------------------------------------------------------------- */
/* One album page: a row per photograph                                       */
/* -------------------------------------------------------------------------- */

/** The caption, else the alt text, else the filename. Whatever identifies it. */
function photoLabel(photo: Photo, index: number): string {
  const text = photo.caption ?? photo.alt;
  if (text !== undefined && text !== '') return text;
  const name = photo.src.split('/').pop();
  return name === undefined || name === '' ? `photograph ${index + 1}` : name;
}

function photoRows(album: Album | null): Keyed[] | null {
  if (album === null) return null;
  return album.photos.map((photo, index) => ({
    key: photo.id,
    kind: album.cover === photo.id || (album.cover === undefined && index === 0) ? 'cover' : 'photo',
    label: photoLabel(photo, index),
    fingerprint: JSON.stringify(photo),
  }));
}

/**
 * The album page's change list, which is a photograph at a time.
 *
 * `meta` carries the album's own fields, because on this surface they are the
 * page's title, year and summary rather than a detail of something else — and
 * because a changed cover is the single edit most worth being told about: it
 * changes the tile on the index page, which is somewhere you are not looking.
 */
export function diffAlbums(draft: Album | null, published: Album | null): SurfaceDiff {
  const diff = diffKeyed(photoRows(draft), photoRows(published), 'photograph', {
    draft: 'Draft only. This album has never been published.',
    published: 'Published only. There is no draft.',
    neither: 'No album here.',
  });
  if (draft === null || published === null) return diff;

  const meta: MetaDiffEntry[] = [];
  const line = (
    field: MetaDiffEntry['field'],
    a: string | undefined,
    b: string | undefined,
  ): void => {
    if ((a ?? null) !== (b ?? null)) meta.push({ field, draft: a ?? null, published: b ?? null });
  };
  line('title', draft.title, published.title);
  line('slug', draft.slug, published.slug);
  line('date', draft.year, published.year);
  line('summary', draft.summary, published.summary);
  line('cover', draft.cover ?? draft.photos[0]?.id, published.cover ?? published.photos[0]?.id);

  const pieces: string[] = [];
  if (diff.counts.changed > 0) pieces.push(`${pluralise(diff.counts.changed, 'photograph')} edited`);
  if (diff.counts.added > 0) pieces.push(`${diff.counts.added} added`);
  if (diff.counts.removed > 0) pieces.push(`${diff.counts.removed} removed`);
  if (diff.counts.moved > 0) pieces.push(`${diff.counts.moved} reordered`);
  if (meta.length > 0) {
    pieces.push(`${pluralise(meta.length, 'detail')} (${meta.map((entry) => entry.field).join(', ')})`);
  }

  return {
    ...diff,
    identical: diff.identical && meta.length === 0,
    meta,
    summary:
      diff.identical && meta.length === 0
        ? 'Draft is identical to the published album.'
        : `Draft differs: ${pieces.join(', ')}.`,
  };
}

/* -------------------------------------------------------------------------- */
/* An index page: a row per entry                                             */
/* -------------------------------------------------------------------------- */

/**
 * The ledger's change list, which answers the question an index preview is
 * asked: which rows would appear, and which of them are not live yet.
 *
 * The fingerprint is only what the row shows — title, date, summary — and not
 * the whole document, because an index page does not change when the body of
 * an essay does, and reporting it as changed here would be pointing at the
 * wrong page.
 */
export function diffLedger(
  draft: readonly DocMeta[] | null,
  published: readonly DocMeta[] | null,
  noun: string,
): SurfaceDiff {
  const rows = (metas: readonly DocMeta[] | null): Keyed[] | null =>
    metas === null
      ? null
      : [...metas]
          .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
          .map((meta) => ({
            key: meta.slug,
            kind: noun,
            label: `${meta.title} · ${meta.date}`,
            fingerprint: JSON.stringify([meta.title, meta.date, meta.summary ?? null]),
          }));

  return diffKeyed(rows(draft), rows(published), noun, {
    draft: `Draft only: nothing in this section is published yet.`,
    published: `Published only. No ${noun} has an unpublished draft.`,
    neither: `Nothing in this section yet.`,
  });
}

/* -------------------------------------------------------------------------- */
/* Outlines, for a surface with only one version                              */
/* -------------------------------------------------------------------------- */

export function outlineOfRecords(file: RecordFile | null, def: RecordsDef): BandDiffEntry[] {
  return (recordRows(file, def) ?? []).map((item, index) => ({
    id: item.key,
    status: 'same' as BandStatus,
    kind: item.kind,
    label: item.label,
    draftIndex: index,
    publishedIndex: index,
  }));
}

export function outlineOfAlbum(album: Album | null): BandDiffEntry[] {
  return (photoRows(album) ?? []).map((item, index) => ({
    id: item.key,
    status: 'same' as BandStatus,
    kind: item.kind,
    label: item.label,
    draftIndex: index,
    publishedIndex: index,
  }));
}
