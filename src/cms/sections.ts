/**
 * src/cms/sections.ts
 *
 * WS-A SECTION REGISTRY. The CMS's map of the site: five sections, what each
 * one stores, where its files live, where it appears on the site and in the
 * editor, and — for the two that hold records — what fields a record has.
 *
 * This file exists so that nothing else has to write a section name as a bare
 * string literal. WS-D's navigation renders `SECTIONS`; WS-C's routing looks
 * a section up with `getSection` and asks it for paths. If either of them
 * reaches for `if (section === 'photography')` outside a narrow, something is
 * missing here: say so in your report rather than hardcoding it.
 *
 * Owned by WS-A, together with `src/cms/schema.ts`. Do not edit it.
 *
 * Two things to know before using it:
 *
 *  1. Paths are patterns. A collection's `contentPath` contains the literal
 *     token `:slug`; fill it with `contentPathFor(section, slug)`, never with
 *     string concatenation. The fill is also the path-traversal guard — it
 *     refuses anything that is not an id.
 *  2. A draft path is always the content path with `src/content/` swapped for
 *     `src/content/drafts/`, so the draft tree is a literal mirror of the
 *     published tree and no section needs its own rule. `verify.ts` asserts it.
 */

import {
  DOCUMENT_SECTION_IDS,
  FILM_KIND_SUGGESTIONS,
  IdSchema,
  RECORD_SECTION_IDS,
  SECTION_IDS,
  albumCoverSrc,
  filmPosterSrc,
  isFilmography,
  isPhotography,
  newAlbum,
  newFilm,
  validateAlbum,
  validateFilm,
  validateFilmography,
  validatePhotography,
} from './schema.ts';
import type {
  Album,
  DocumentSectionId,
  Film,
  RecordEntry,
  RecordFile,
  RecordSectionId,
  SectionId,
  ValidateResultOf,
} from './schema.ts';

/* -------------------------------------------------------------------------- */
/* Roots and tokens                                                            */
/* -------------------------------------------------------------------------- */

/** Everything the site reads lives under here. */
export const CONTENT_ROOT = 'src/content';
/** Working copies. Never read by the site build (docs/cms-rebuild.md 2.3). */
export const DRAFT_ROOT = `${CONTENT_ROOT}/drafts`;
/** Uploads (docs/cms-sections.md 3.5). One pipeline, per-section directories. */
export const MEDIA_ROOT = 'public/media';
export const MEDIA_URL_ROOT = '/media';
/** Every content file is JSON now. Markdoc and YAML are gone at cutover. */
export const CONTENT_FILE_EXT = '.json';

/** The literal token a path or URL pattern uses for the entry key. */
export const SLUG_TOKEN = ':slug';

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

/** One entry, or many. */
export type SectionShape = 'singleton' | 'collection';

/**
 * Which editor a section's entries open in. 'document' is the phase 1 editor,
 * bands of prose and canvas. 'records' is typed fields plus media.
 */
export type SectionStorage = 'document' | 'records';

/**
 * The input a record field needs. A closed union so WS-E's record editor can
 * switch exhaustively and the compiler tells it when a field type is added.
 *
 *   text      one line
 *   textarea  several lines, no formatting
 *   slug      lowercase kebab-case, drives a URL
 *   year      "2019", or a range like "2018-2019"
 *   youtube   paste a URL, store the 11-character id (youtubeIdFromInput)
 *   image     one uploaded image, optional
 *   photos    an ordered, reorderable list of uploaded photos
 *   cover     pick one of this record's own photos by id
 */
export type RecordFieldType =
  | 'text'
  | 'textarea'
  | 'slug'
  | 'year'
  | 'youtube'
  | 'image'
  | 'photos'
  | 'cover';

export type RecordField = {
  /** The key on the record. Matches the schema field exactly. */
  name: string;
  /** What the editor labels it. */
  label: string;
  type: RecordFieldType;
  /** False means the schema has it `.optional()`. */
  required: boolean;
  /** One line of helper text under the input. */
  help?: string;
  /** Offered as a datalist. Not a constraint; the schema takes any string. */
  suggestions?: readonly string[];
};

/**
 * One row in a record section's list. Built from the whole collection file so
 * that a caller never has to know whether it is holding films or albums.
 */
export type RecordSummary = {
  /** The record id. Stable, never reused. */
  id: string;
  /** What identifies this entry in a URL and in the API: a film's id, an album's slug. */
  key: string;
  title: string;
  /** The second line of the list row: "SHORT FILM · 2019", "2024 · 6 photos". */
  subtitle: string;
  /** Thumbnail, resolved through the section's own fallback. Null when there is none. */
  thumb: string | null;
};

/**
 * Everything a record collection needs, with every function typed against the
 * `RecordFile` / `RecordEntry` unions so it is callable without narrowing. To
 * get at the concrete shape, narrow with `isFilmography`, `isPhotography`,
 * `isFilm` or `isAlbum` from the schema, or switch on `key`.
 */
export type RecordsDef = {
  /** The one key inside the collection's JSON file. Also the discriminant. */
  key: 'films' | 'albums';
  /** Singular noun for one entry, for UI copy. */
  noun: string;
  /** Every editable field, in the order the editor should show them. */
  fields: readonly RecordField[];
  /** Which field holds the entry's name. Always present in `fields`. */
  titleField: string;
  /** The field whose value identifies an entry in a URL, or null to use the record id. */
  slugField: string | null;
  /** `newId` prefix for a fresh record. */
  idPrefix: string;

  /** An empty collection, for a section that has no file yet. */
  empty: () => RecordFile;
  /** A fresh entry with sane defaults. */
  create: () => RecordEntry;
  /** The entries inside a collection file, in order. */
  entries: (file: RecordFile) => RecordEntry[];
  /**
   * The same collection with a different array of entries. Reordering is
   * exactly this: read, permute, write back. Does NOT validate; run the result
   * through `validateFile` before saving it.
   */
  withEntries: (file: RecordFile, entries: RecordEntry[]) => RecordFile;
  /** List rows, built from the whole file. */
  summarise: (file: RecordFile) => RecordSummary[];

  validateFile: (value: unknown) => ValidateResultOf<RecordFile>;
  validateEntry: (value: unknown) => ValidateResultOf<RecordEntry>;
};

type SectionBase = {
  id: SectionId;
  /** What the sidebar calls it. */
  label: string;
  /** Singular noun for one entry: "page", "project", "essay", "film", "album". */
  noun: string;
  shape: SectionShape;
  /** Position in the sidebar. The index into SECTION_IDS. */
  order: number;

  /**
   * Published content, relative to the repository root. Contains `:slug` for a
   * collection. Fill it with `contentPathFor`.
   */
  contentPath: string;
  /** The same file in the draft mirror. Always `toDraftPath(contentPath)`. */
  draftPath: string;
  /** Upload directory, relative to the repository root. Contains `:slug` for a collection. */
  mediaDir: string;
  /** The URL the same directory is served at. */
  mediaUrlPrefix: string;

  /** Where this section's index lives on the live site. */
  indexUrl: string;
  /** Where one entry lives on the live site, or null when entries have no page of their own. */
  entryUrl: string | null;

  /** Where this section lives in the editor. */
  cmsUrl: string;
  /** Where one entry is edited, or null for a singleton. */
  cmsEntryUrl: string | null;
};

export type DocumentSectionDef = SectionBase & {
  id: DocumentSectionId;
  storage: 'document';
  records: null;
};

export type RecordSectionDef = SectionBase & {
  id: RecordSectionId;
  storage: 'records';
  records: RecordsDef;
};

export type SectionDef = DocumentSectionDef | RecordSectionDef;

/* -------------------------------------------------------------------------- */
/* Path helpers                                                                */
/* -------------------------------------------------------------------------- */

/** True when this pattern needs a slug filled in. */
export function needsSlug(pattern: string): boolean {
  return pattern.includes(SLUG_TOKEN);
}

/**
 * Fill `:slug` in a pattern. A pattern with no token ignores the argument.
 *
 * This is the only place a slug reaches a file path, which makes it the
 * traversal guard: anything that is not an id (`[A-Za-z0-9_-]{1,64}`, so no
 * slash, no dot, no `..`) throws. It throws rather than returning null because
 * an unfillable pattern is a caller bug, not user input — validate the slug
 * with `IdSchema` or `DocMetaSchema.shape.slug` at the edge, where a bad
 * request becomes a 400.
 */
export function fillSlug(pattern: string, slug?: string | null): string {
  if (!needsSlug(pattern)) return pattern;
  if (slug === undefined || slug === null || !IdSchema.safeParse(slug).success) {
    throw new TypeError(
      `"${pattern}" needs a slug and ${JSON.stringify(slug)} is not one ` +
        `(1-64 characters from A-Z a-z 0-9 _ -)`,
    );
  }
  return pattern.split(SLUG_TOKEN).join(slug);
}

/**
 * The draft mirror of a published content path. `src/content/X` becomes
 * `src/content/drafts/X`, for every section, with no per-section rule.
 */
export function toDraftPath(contentPath: string): string {
  const prefix = `${CONTENT_ROOT}/`;
  if (!contentPath.startsWith(prefix)) {
    throw new TypeError(`"${contentPath}" is not under ${CONTENT_ROOT}/`);
  }
  if (contentPath.startsWith(`${DRAFT_ROOT}/`)) {
    throw new TypeError(`"${contentPath}" is already a draft path`);
  }
  return `${DRAFT_ROOT}/${contentPath.slice(prefix.length)}`;
}

/** The directory part of a path pattern, with no trailing slash. */
function dirOf(pattern: string): string {
  const cut = pattern.lastIndexOf('/');
  return cut === -1 ? '' : pattern.slice(0, cut);
}

export function contentPathFor(section: SectionDef, slug?: string | null): string {
  return fillSlug(section.contentPath, slug);
}

export function draftPathFor(section: SectionDef, slug?: string | null): string {
  return fillSlug(section.draftPath, slug);
}

/** The directory a section's published files live in. What a list call reads. */
export function contentDirFor(section: SectionDef): string {
  return dirOf(section.contentPath);
}

/** The matching directory in the draft mirror. */
export function draftDirFor(section: SectionDef): string {
  return dirOf(section.draftPath);
}

export function mediaDirFor(section: SectionDef, slug?: string | null): string {
  return fillSlug(section.mediaDir, slug);
}

export function mediaUrlFor(section: SectionDef, slug?: string | null): string {
  return fillSlug(section.mediaUrlPrefix, slug);
}

/** `/media/essays/my-essay/photo.png` — the `src` an uploaded file gets. */
export function mediaSrcFor(section: SectionDef, slug: string | null, filename: string): string {
  return `${mediaUrlFor(section, slug)}/${filename}`;
}

/** Where this entry is on the live site. Null when its section has no entry pages. */
export function siteUrlFor(section: SectionDef, slug?: string | null): string | null {
  if (section.entryUrl === null) return null;
  return fillSlug(section.entryUrl, slug);
}

/** Where this entry is edited. A singleton's own `cmsUrl` is its editor. */
export function cmsUrlFor(section: SectionDef, slug?: string | null): string {
  if (section.cmsEntryUrl === null || slug === undefined || slug === null) return section.cmsUrl;
  return fillSlug(section.cmsEntryUrl, slug);
}

/** `my-essay.json` -> `my-essay`. Null for anything that is not a content file. */
export function slugFromFilename(filename: string): string | null {
  if (!filename.endsWith(CONTENT_FILE_EXT)) return null;
  const slug = filename.slice(0, -CONTENT_FILE_EXT.length);
  return slug === '' ? null : slug;
}

/* -------------------------------------------------------------------------- */
/* Record collection definitions                                               */
/* -------------------------------------------------------------------------- */

function films(file: RecordFile): Film[] {
  return isFilmography(file) ? file.films : [];
}

function albums(file: RecordFile): Album[] {
  return isPhotography(file) ? file.albums : [];
}

const FILMOGRAPHY_RECORDS: RecordsDef = {
  key: 'films',
  noun: 'film',
  titleField: 'title',
  // A film has no page of its own, so nothing needs a slug: the record id is
  // the key everywhere.
  slugField: null,
  idPrefix: 'film',
  fields: [
    {
      name: 'youtubeId',
      label: 'YouTube',
      type: 'youtube',
      required: true,
      help: 'Paste the video URL. The id is pulled out of it.',
    },
    { name: 'title', label: 'Title', type: 'text', required: true },
    {
      name: 'kind',
      label: 'Kind',
      type: 'text',
      required: true,
      help: 'The small-caps label under the title.',
      suggestions: FILM_KIND_SUGGESTIONS,
    },
    { name: 'year', label: 'Year', type: 'year', required: true },
    {
      name: 'note',
      label: 'Note',
      type: 'textarea',
      required: false,
      help: 'Role, festival, who directed it.',
    },
    {
      name: 'poster',
      label: 'Poster',
      type: 'image',
      required: false,
      help: "Leave empty to use YouTube's own thumbnail.",
    },
  ],

  empty: () => ({ films: [] }),
  create: () => newFilm(),
  entries: (file) => films(file),
  withEntries: (_file, entries) => ({ films: entries as Film[] }),
  summarise: (file) =>
    films(file).map((film) => ({
      id: film.id,
      key: film.id,
      title: film.title,
      subtitle: `${film.kind} · ${film.year}`,
      thumb: filmPosterSrc(film),
    })),
  validateFile: (value) => validateFilmography(value),
  validateEntry: (value) => validateFilm(value),
};

const PHOTOGRAPHY_RECORDS: RecordsDef = {
  key: 'albums',
  noun: 'album',
  titleField: 'title',
  // An album does have a page, at /photography/<slug>/, so its slug is the key.
  slugField: 'slug',
  idPrefix: 'album',
  fields: [
    { name: 'title', label: 'Title', type: 'text', required: true },
    {
      name: 'slug',
      label: 'Address',
      type: 'slug',
      required: true,
      help: 'The album page lives at /photography/<slug>/.',
    },
    { name: 'year', label: 'Year', type: 'year', required: true },
    { name: 'summary', label: 'Summary', type: 'textarea', required: false },
    {
      name: 'photos',
      label: 'Photos',
      type: 'photos',
      required: true,
      help: 'Upload several at once, then drag to reorder.',
    },
    {
      name: 'cover',
      label: 'Cover',
      type: 'cover',
      required: false,
      help: 'Leave empty to use the first photo.',
    },
  ],

  empty: () => ({ albums: [] }),
  create: () => newAlbum(),
  entries: (file) => albums(file),
  withEntries: (_file, entries) => ({ albums: entries as Album[] }),
  summarise: (file) =>
    albums(file).map((album) => ({
      id: album.id,
      key: album.slug,
      title: album.title,
      subtitle: `${album.year} · ${album.photos.length} photo${album.photos.length === 1 ? '' : 's'}`,
      thumb: albumCoverSrc(album),
    })),
  validateFile: (value) => validatePhotography(value),
  validateEntry: (value) => validateAlbum(value),
};

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

function document_(
  id: DocumentSectionId,
  label: string,
  noun: string,
  shape: SectionShape,
  contentPath: string,
  mediaLeaf: string,
  indexUrl: string,
  entryUrl: string | null,
): DocumentSectionDef {
  const collection = shape === 'collection';
  return {
    id,
    label,
    noun,
    shape,
    order: SECTION_IDS.indexOf(id),
    storage: 'document',
    records: null,
    contentPath,
    draftPath: toDraftPath(contentPath),
    mediaDir: `${MEDIA_ROOT}/${mediaLeaf}`,
    mediaUrlPrefix: `${MEDIA_URL_ROOT}/${mediaLeaf}`,
    indexUrl,
    entryUrl,
    cmsUrl: `/cms/${id}`,
    cmsEntryUrl: collection ? `/cms/${id}/${SLUG_TOKEN}` : null,
  };
}

function records_(
  id: RecordSectionId,
  label: string,
  contentPath: string,
  indexUrl: string,
  entryUrl: string | null,
  def: RecordsDef,
): RecordSectionDef {
  return {
    id,
    label,
    noun: def.noun,
    shape: 'collection',
    order: SECTION_IDS.indexOf(id),
    storage: 'records',
    records: def,
    contentPath,
    draftPath: toDraftPath(contentPath),
    mediaDir: `${MEDIA_ROOT}/${id}/${SLUG_TOKEN}`,
    mediaUrlPrefix: `${MEDIA_URL_ROOT}/${id}/${SLUG_TOKEN}`,
    indexUrl,
    entryUrl,
    cmsUrl: `/cms/${id}`,
    cmsEntryUrl: `/cms/${id}/${SLUG_TOKEN}`,
  };
}

/**
 * The five sections, in sidebar order (docs/cms-sections.md 2).
 *
 * | Section     | Shape      | Editor    | Published file                            |
 * |-------------|------------|-----------|-------------------------------------------|
 * | Home        | singleton  | document  | src/content/pages/home.json               |
 * | Projects    | collection | document  | src/content/pages/projects/<slug>.json    |
 * | Essays      | collection | document  | src/content/pages/essays/<slug>.json      |
 * | Filmography | collection | records   | src/content/data/filmography.json         |
 * | Photography | collection | records   | src/content/data/photography.json         |
 */
export const SECTIONS: readonly SectionDef[] = [
  document_(
    'home',
    'Home',
    'page',
    'singleton',
    `${CONTENT_ROOT}/pages/home${CONTENT_FILE_EXT}`,
    'home',
    '/',
    null,
  ),
  document_(
    'projects',
    'Projects',
    'project',
    'collection',
    `${CONTENT_ROOT}/pages/projects/${SLUG_TOKEN}${CONTENT_FILE_EXT}`,
    `projects/${SLUG_TOKEN}`,
    '/projects/',
    `/projects/${SLUG_TOKEN}/`,
  ),
  document_(
    'essays',
    'Essays',
    'essay',
    'collection',
    `${CONTENT_ROOT}/pages/essays/${SLUG_TOKEN}${CONTENT_FILE_EXT}`,
    `essays/${SLUG_TOKEN}`,
    '/essays/',
    `/essays/${SLUG_TOKEN}/`,
  ),
  records_(
    'filmography',
    'Filmography',
    `${CONTENT_ROOT}/data/filmography${CONTENT_FILE_EXT}`,
    '/filmography/',
    // A film plays in place on the index. There is no /filmography/<id>/ page.
    null,
    FILMOGRAPHY_RECORDS,
  ),
  records_(
    'photography',
    'Photography',
    `${CONTENT_ROOT}/data/photography${CONTENT_FILE_EXT}`,
    '/photography/',
    // New site surface in phase 2 (docs/cms-sections.md 3.4).
    `/photography/${SLUG_TOKEN}/`,
    PHOTOGRAPHY_RECORDS,
  ),
];

const BY_ID = new Map<string, SectionDef>(SECTIONS.map((section) => [section.id, section]));

/** Lookup by id. Null for anything that is not a section, so a bad URL is a 404. */
export function getSection(id: string): SectionDef | null {
  return BY_ID.get(id) ?? null;
}

/**
 * Lookup that throws. For code that already knows the id is good — a literal,
 * or a value that `getSection` has already accepted.
 */
export function requireSection(id: SectionId): SectionDef {
  const section = BY_ID.get(id);
  if (section === undefined) throw new TypeError(`no section "${id}"`);
  return section;
}

export function isDocumentSection(section: SectionDef): section is DocumentSectionDef {
  return section.storage === 'document';
}

export function isRecordSection(section: SectionDef): section is RecordSectionDef {
  return section.storage === 'records';
}

/** The three sections the document editor handles. */
export function documentSections(): DocumentSectionDef[] {
  return SECTIONS.filter(isDocumentSection);
}

/** The two sections the record editor handles. */
export function recordSections(): RecordSectionDef[] {
  return SECTIONS.filter(isRecordSection);
}

/** Sanity, asserted at import time rather than discovered in a renderer. */
if (SECTIONS.length !== SECTION_IDS.length) {
  throw new Error(
    `the registry has ${SECTIONS.length} sections but schema.ts names ${SECTION_IDS.length}`,
  );
}
for (const id of [...DOCUMENT_SECTION_IDS, ...RECORD_SECTION_IDS]) {
  if (!BY_ID.has(id)) throw new Error(`the registry is missing section "${id}"`);
}
