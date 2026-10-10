/**
 * src/cms/app/state/entries.ts
 *
 * WS-D. Making a new entry, and making a copy of one.
 *
 * Four of these operations exist in the brief — create, duplicate, delete,
 * reorder — and three of them need a value built before an API call can be
 * made: a blank document for a new page, a copy of a document under a new
 * slug, a slug nothing else is using. That is all this file is. The record
 * side of the same four lives in `./record-store.ts`, because there the unit
 * of work is the whole collection file.
 *
 * Nothing here names a section. A new entry's `meta.section` comes from the
 * `SectionDef` it is handed, and its shape comes from the phase 1 factories in
 * `./doc-ops.ts`, so a new essay and a new project differ only in that id.
 */

import { DOC_VERSION, slugify } from '../../schema.ts';
import type { Doc, DocumentSectionId } from '../../schema.ts';
import type { DocumentSectionDef } from '../../sections.ts';
import { cloneDoc, createProseBand } from './doc-ops.ts';

/** `2026-10-09`, UTC, which is what `DateSchema` wants. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * A slug nothing in `taken` is using, derived from `text`.
 *
 * `slugify` returns '' for a title made only of punctuation or only of Hangul,
 * so there is a fallback; `DocMetaSchema.shape.slug` would reject ''. The
 * suffix is `-2`, `-3`, and so on, which is what a person expects from "New
 * essay" twice.
 */
export function uniqueSlug(text: string, taken: Iterable<string>, fallback = 'untitled'): string {
  const used = new Set(taken);
  const base = slugify(text) === '' ? slugify(fallback) || 'untitled' : slugify(text);
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** 'Essay' -> 'Essay copy', 'Essay copy' -> 'Essay copy 2'. */
export function copyTitle(title: string): string {
  const match = /^(.*\bcopy)(?: (\d+))?$/.exec(title.trim());
  if (match === null) return `${title} copy`;
  const n = match[2] === undefined ? 2 : Number(match[2]) + 1;
  return `${match[1]} ${n}`;
}

/**
 * A blank document for a document section: one prose band holding one empty
 * paragraph, so the editor opens on something a person can type into rather
 * than on an empty page with no affordance.
 *
 * It validates as it stands, which matters because creating an entry *is* a
 * `PUT /api/cms/draft/:section/:slug` and WS-C validates before writing.
 */
export function createDocFor(
  section: DocumentSectionDef,
  options: { title?: string; slug?: string; taken?: Iterable<string>; now?: Date } = {},
): Doc {
  const title = options.title ?? `New ${section.noun}`;
  const slug = options.slug ?? uniqueSlug(title, options.taken ?? [], section.noun);
  return {
    version: DOC_VERSION,
    meta: {
      title,
      slug,
      date: todayIso(options.now),
      section: section.id as DocumentSectionId,
    },
    bands: [createProseBand()],
  };
}

/**
 * A copy of `doc` under a new slug.
 *
 * Band, block and item ids are kept. They only have to be unique *within* a
 * document (`DocSchema`'s `claim`), and a shape's hand-drawn wobble is seeded
 * from its item id — so keeping them is what makes the copy look identical to
 * the original instead of subtly redrawing every squiggle.
 */
export function duplicateDoc(
  doc: Doc,
  options: { taken?: Iterable<string>; title?: string; slug?: string; now?: Date } = {},
): Doc {
  const copy = cloneDoc(doc);
  const title = options.title ?? copyTitle(doc.meta.title);
  copy.meta.title = title;
  copy.meta.slug = options.slug ?? uniqueSlug(title, options.taken ?? [doc.meta.slug]);
  copy.meta.date = todayIso(options.now);
  return copy;
}

