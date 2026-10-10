/**
 * src/cms/app/library/catalogue.ts
 *
 * Turning a catalogue file into the list the browser shows, and filtering it.
 *
 * Pure. No fs, no fetch, no React, no DOM: the harness, the browser and the
 * import script all call the same functions, and a test can call them with a
 * literal.
 *
 * Loading is deliberately forgiving in one direction and strict in the other.
 * A single malformed entry in a hand-edited file greys out one tile and
 * reports why; it does not empty the drawer. But a malformed entry is never
 * silently repaired, and `problems` is surfaced in the browser's footer so a
 * bad hand-edit is visible rather than mysterious.
 */

import { BUILT_IN_SHAPE_ENTRIES } from './shapes.ts';
import { isAssetEntry, isShapeEntry, parseEntry } from './schema.ts';
import type { AssetEntry, LibraryEntry, ShapeEntry } from './schema.ts';

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

export type LoadedCatalogue = {
  /** Shapes first, then assets, each group in catalogue order. */
  entries: LibraryEntry[];
  /** One line per entry that could not be read. Empty on a clean file. */
  problems: string[];
};

/**
 * Read a catalogue value (already-parsed JSON, or anything at all) into the
 * list the browser renders.
 *
 * The result is always usable: the five built-in shapes are present even when
 * the argument is `null`, `{}`, or a file somebody truncated, because the
 * generated half of the library does not depend on the file at all.
 */
export function loadCatalogue(raw: unknown): LoadedCatalogue {
  const problems: string[] = [];
  const fromFile: LibraryEntry[] = [];

  const container = raw as { version?: unknown; entries?: unknown } | null;
  const rawEntries = container?.entries;

  if (raw !== null && raw !== undefined && !Array.isArray(rawEntries)) {
    problems.push('catalogue: no `entries` array; showing the built-in shapes only');
  } else if (Array.isArray(rawEntries)) {
    if (container?.version !== undefined && container.version !== 1) {
      problems.push(`catalogue: version ${String(container.version)} is not 1`);
    }
    rawEntries.forEach((value, index) => {
      const parsed = parseEntry(value);
      if (parsed.ok) {
        fromFile.push(parsed.entry);
        return;
      }
      const id = (value as { id?: unknown } | null)?.id;
      const where = typeof id === 'string' ? `"${id}"` : `entries[${index}]`;
      problems.push(`${where}: ${parsed.errors.join('; ')}`);
    });
  }

  const seen = new Set<string>();
  const unique = fromFile.filter((entry) => {
    if (seen.has(entry.id)) {
      problems.push(`"${entry.id}": duplicate id, later copy ignored`);
      return false;
    }
    seen.add(entry.id);
    return true;
  });

  return { entries: [...mergeShapes(unique.filter(isShapeEntry)), ...unique.filter(isAssetEntry)], problems };
}

/**
 * Built-in shapes, with any same-id entry from the file replacing the built-in
 * one, and any extra shape preset from the file appended. Order is stable: the
 * five built-ins in their declared order, then presets in file order, so the
 * grid does not reshuffle when a preset is added.
 */
export function mergeShapes(fromFile: readonly ShapeEntry[]): ShapeEntry[] {
  const overrides = new Map(fromFile.map((entry) => [entry.id, entry]));
  const builtIn = BUILT_IN_SHAPE_ENTRIES.map((entry) => overrides.get(entry.id) ?? entry);
  const builtInIds = new Set(BUILT_IN_SHAPE_ENTRIES.map((entry) => entry.id));
  return [...builtIn, ...fromFile.filter((entry) => !builtInIds.has(entry.id))];
}

/* -------------------------------------------------------------------------- */
/* Filtering                                                                   */
/* -------------------------------------------------------------------------- */

export type KindFilter = 'all' | 'asset' | 'shape';

export type Query = {
  /** Free text. Whitespace-separated terms, all of which must match. */
  text?: string;
  /** A category id, or 'all'. */
  category?: string;
  kind?: KindFilter;
};

/**
 * Everything one entry is searchable by, lowercased: its name, its tags, its
 * category, and the thing it is made of: a file's basename for an asset, the
 * generator name for a shape. The basename matters because the owner will
 * type "IMG_2065" or "hero" long before he remembers what he named it.
 */
export function searchTextFor(entry: LibraryEntry): string {
  const parts = [entry.name, entry.category, ...entry.tags];
  if (isAssetEntry(entry)) {
    parts.push(basename(entry.src));
    if (entry.format !== undefined) parts.push(entry.format);
    if (entry.transparent === true) parts.push('transparent');
  } else {
    parts.push(entry.generator, 'shape');
  }
  return parts.join(' ').toLowerCase();
}

function basename(src: string): string {
  const tail = src.split('/').pop() ?? src;
  // "IMG_2065.png" is searchable as IMG_2065, img, 2065 and png.
  return `${tail} ${tail.replace(/\.[a-z0-9]+$/i, '')} ${tail.replace(/[^A-Za-z0-9]+/g, ' ')}`;
}

export function tokenise(text: string): string[] {
  return text.trim().toLowerCase().split(/\s+/).filter((token) => token !== '');
}

/** All terms must appear somewhere in the entry's searchable text. */
export function matchesText(entry: LibraryEntry, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = searchTextFor(entry);
  return tokens.every((token) => haystack.includes(token));
}

export function filterEntries(entries: readonly LibraryEntry[], query: Query): LibraryEntry[] {
  const tokens = tokenise(query.text ?? '');
  const category = query.category ?? 'all';
  const kind = query.kind ?? 'all';
  return entries.filter((entry) => {
    if (kind !== 'all' && entry.kind !== kind) return false;
    if (category !== 'all' && entry.category !== category) return false;
    return matchesText(entry, tokens);
  });
}

/* -------------------------------------------------------------------------- */
/* Categories                                                                  */
/* -------------------------------------------------------------------------- */

export type CategoryCount = { id: string; count: number };

/**
 * The filter row. Built from whatever the entries actually hold rather than
 * from a fixed list, so importing into a new category needs no code change.
 * Counts respect the text and kind filters but not the category filter, which
 * is what lets the row say "no squiggles match 'hero'" instead of going blank.
 */
export function categoriesOf(
  entries: readonly LibraryEntry[],
  query: Omit<Query, 'category'> = {},
): CategoryCount[] {
  const tokens = tokenise(query.text ?? '');
  const kind = query.kind ?? 'all';
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!counts.has(entry.category)) counts.set(entry.category, 0);
    if (kind !== 'all' && entry.kind !== kind) continue;
    if (!matchesText(entry, tokens)) continue;
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Human label for a category or tag id: "film-still" -> "Film still". */
export function humanise(id: string): string {
  const spaced = id.replace(/[-_]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* -------------------------------------------------------------------------- */
/* Small facts about an entry, for the grid and the detail panel               */
/* -------------------------------------------------------------------------- */

/** The image the grid should load for an asset: its thumbnail if it has one. */
export function previewSrcFor(entry: AssetEntry): string {
  return entry.preview?.src ?? entry.src;
}

/** Aspect ratio (w / h) of what the grid will actually draw. */
export function previewAspect(entry: LibraryEntry): number {
  if (isAssetEntry(entry)) {
    const preview = entry.preview;
    if (preview !== undefined) return preview.w / preview.h;
    return entry.width / entry.height;
  }
  return entry.defaults.width / entry.defaults.height;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
