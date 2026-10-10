/**
 * src/cms/preview/target.ts
 *
 * WS-H. What the preview is pointing at.
 *
 * Phase 1 had one answer: a slug, which was always a project page. Phase 2 has
 * five sections in two storage shapes and six previewable surfaces, so the URL
 * after `/cms/preview/` is no longer a slug — it is a section and, when the
 * section is a collection, a key inside it.
 *
 *   /cms/preview/home                       the homepage
 *   /cms/preview/essays                     the essays index
 *   /cms/preview/essays/chasing-the-…       one essay
 *   /cms/preview/projects                   the projects index
 *   /cms/preview/projects/track-…           one project
 *   /cms/preview/filmography                the film list
 *   /cms/preview/photography                the album tiles
 *   /cms/preview/photography/first-build    one album page
 *   /cms/preview/track-…                    phase 1's URL, still a project
 *
 * The single-segment rule is WS-C's, deliberately: a segment that names a
 * section means that section, and anything else is a project slug
 * (`resolveSectionOrLegacySlug` in `src/cms/server/http.ts`). Two places that
 * read the same shape of URL should read it the same way, and the phase 1
 * links in `src/cms/app/integration/e2e.mjs` keep working for free.
 *
 * WHICH SURFACE a target is, is derived here and nowhere else. Every branch
 * below asks WS-A's registry — `shape`, `storage`, `records.key` — rather than
 * comparing a section id against a literal, so a sixth section would be a row
 * in `src/cms/sections.ts` and not an `if` in this file. The one exception is
 * marked and explained: `ledgerSectionOf`.
 *
 * Pure. No fs, no fetch, no DOM. It imports the registry and the schema, which
 * is why nothing in `client/` may import it: that would pull zod into the
 * previewed page. The client gets the one string it needs — the path — through
 * a data attribute, and `state.ts` stays import-free so it can be shared.
 */

import { IdSchema } from '../schema.ts';
import type { LedgerSectionId } from '../render/pages/ledger.ts';
import {
  SECTIONS,
  cmsUrlFor,
  getSection,
  isRecordSection,
  siteUrlFor,
} from '../sections.ts';
import type { DocumentSectionDef, RecordSectionDef, SectionDef } from '../sections.ts';
import { LEGACY_SECTION_ID } from '../server/config.ts';

/* -------------------------------------------------------------------------- */
/* Surfaces                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The six previewable surfaces, named after what they ARE rather than after
 * the section they happen to belong to.
 *
 *   document    home, one essay, one project          renderDocPage
 *   ledger      the essays index, the projects index   renderLedgerPage
 *   films       the filmography list                   renderFilmography
 *   albums      the photography index                   renderPhotography
 *   album       one album page                          renderAlbumPage
 *
 * `film` is the sixth thing that could be addressed and is not a surface: a
 * film plays in place on the index, so `photography.entryUrl` is a URL and
 * `filmography.entryUrl` is null (WS-A). Asking for one resolves to the list.
 */
export type PreviewSurface = 'document' | 'ledger' | 'films' | 'albums' | 'album';

export type DocumentTarget = {
  surface: 'document';
  section: DocumentSectionDef;
  /** Null for the singleton. A slug for a collection entry. */
  key: string | null;
  /** True when this came from phase 1's one-segment project URL. */
  legacy: boolean;
};

export type LedgerTarget = {
  surface: 'ledger';
  section: DocumentSectionDef;
  /** Which of the two ledger styles `renderLedgerPage` should use. */
  ledger: LedgerSectionId;
  key: null;
  legacy: false;
};

export type RecordListTarget = {
  surface: 'films' | 'albums';
  section: RecordSectionDef;
  key: null;
  legacy: false;
};

export type AlbumTarget = {
  surface: 'album';
  section: RecordSectionDef;
  key: string;
  legacy: false;
};

export type PreviewTarget = DocumentTarget | LedgerTarget | RecordListTarget | AlbumTarget;

/* -------------------------------------------------------------------------- */
/* Deriving a surface from the registry                                       */
/* -------------------------------------------------------------------------- */

/**
 * The ledger style for a document section, or null for one that has no index
 * page of its own.
 *
 * THE ONE PLACE A SECTION ID IS NARROWED BY HAND. `LedgerSectionId` is WS-B's
 * `'essays' | 'projects'`, and `DocumentSectionId` is those two plus `'home'`,
 * so the compiler cannot see that "a document section that is a collection" is
 * exactly the ledger set. The test in `selftest.ts` checks that it is, so the
 * assertion fails there rather than mis-rendering an index page if a fourth
 * document section is ever added. See contractDeviations in my report.
 */
export function ledgerSectionOf(section: DocumentSectionDef): LedgerSectionId | null {
  return section.shape === 'collection' ? (section.id as LedgerSectionId) : null;
}

/** Which list surface a record section renders. The registry's own discriminant. */
function recordSurfaceOf(section: RecordSectionDef): 'films' | 'albums' {
  return section.records.key === 'films' ? 'films' : 'albums';
}

/** A key the registry will accept in a path. `contentPathFor` throws on anything else. */
export function isPreviewKey(value: string): boolean {
  return IdSchema.safeParse(value).success;
}

/**
 * The section's own page: the index for a collection, the page itself for the
 * singleton. Never null, because every section has one.
 */
export function sectionTarget(section: SectionDef): PreviewTarget {
  if (isRecordSection(section)) {
    return { surface: recordSurfaceOf(section), section, key: null, legacy: false };
  }
  const ledger = ledgerSectionOf(section);
  if (ledger !== null) return { surface: 'ledger', section, ledger, key: null, legacy: false };
  return { surface: 'document', section, key: null, legacy: false };
}

/**
 * One entry inside a section, or null when that section has no entry pages.
 *
 * A film returns null rather than a target, because `entryUrl` is null for
 * filmography and inventing a `/filmography/<id>/` preview would be previewing
 * a page the site does not have.
 */
export function entryTarget(section: SectionDef, key: string): PreviewTarget | null {
  if (!isPreviewKey(key)) return null;
  if (isRecordSection(section)) {
    if (siteUrlFor(section, key) === null) return null;
    return { surface: 'album', section, key, legacy: false };
  }
  if (section.shape !== 'collection') return null;
  return { surface: 'document', section, key, legacy: false };
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The path after `/cms/preview/`, which is also what `state.ts` turns into a
 * URL and what the chrome hands its client script. Always `<section>` or
 * `<section>/<key>` — never phase 1's bare slug, so the canonical URL of a
 * project is `projects/<slug>` and the bare slug is only ever an inbound alias.
 */
export function targetPath(target: PreviewTarget): string {
  return target.key === null ? target.section.id : `${target.section.id}/${target.key}`;
}

/** Split a path into segments, tolerating leading, trailing and doubled slashes. */
export function pathSegments(path: string | null | undefined): string[] {
  if (path === undefined || path === null) return [];
  return path.split('/').filter((segment) => segment !== '');
}

export type ParseResult =
  | { ok: true; target: PreviewTarget }
  | { ok: false; reason: 'empty' | 'unknown_section' | 'bad_key' | 'no_entry_page' | 'too_deep' };

/**
 * Read a path into a target.
 *
 * Never throws and never guesses: an unparseable path is a reason, which the
 * route turns into an empty state saying which part it did not recognise. The
 * alternative — defaulting to something — is how you end up previewing the
 * homepage while believing you are looking at an essay.
 */
export function parseTargetPath(path: string | null | undefined): ParseResult {
  const segments = pathSegments(path);
  if (segments.length === 0) return { ok: false, reason: 'empty' };
  if (segments.length > 2) return { ok: false, reason: 'too_deep' };

  const [first, second] = segments as [string, string | undefined];
  const named = getSection(first);

  if (second === undefined) {
    // WS-C's one-segment rule: a section id means the section, anything else
    // is phase 1's project slug.
    if (named !== null) return { ok: true, target: sectionTarget(named) };
    if (!isPreviewKey(first)) return { ok: false, reason: 'bad_key' };
    const projects = getSection(LEGACY_SECTION_ID);
    if (projects === null || isRecordSection(projects)) {
      return { ok: false, reason: 'unknown_section' };
    }
    return {
      ok: true,
      target: { surface: 'document', section: projects, key: first, legacy: true },
    };
  }

  if (named === null) return { ok: false, reason: 'unknown_section' };
  if (!isPreviewKey(second)) return { ok: false, reason: 'bad_key' };
  const target = entryTarget(named, second);
  if (target === null) return { ok: false, reason: 'no_entry_page' };
  return { ok: true, target };
}

/**
 * Why a path did not resolve, in the words of someone who typed it.
 *
 * `no_entry_page` is the interesting one, and the message says what to do
 * instead rather than only what went wrong.
 */
export function parseFailureMessage(reason: Exclude<ParseResult, { ok: true }>['reason']): string {
  switch (reason) {
    case 'empty':
      return 'No section named. Pick one from the list.';
    case 'unknown_section':
      return `That is not a section. The five are ${SECTIONS.map((s) => s.id).join(', ')}.`;
    case 'bad_key':
      return 'That is not a usable entry key: letters, digits, hyphens and underscores only.';
    case 'no_entry_page':
      return 'That section has no page per entry, so there is nothing to preview on its own. Its list page is the surface.';
    case 'too_deep':
      return 'A preview path is a section, optionally followed by one entry key.';
  }
}

/* -------------------------------------------------------------------------- */
/* Describing a target                                                        */
/* -------------------------------------------------------------------------- */

/** What the toolbar calls the surface. Not the entry's title: the kind of page. */
export function surfaceLabel(target: PreviewTarget): string {
  switch (target.surface) {
    case 'document':
      return target.key === null ? target.section.label : target.section.noun;
    case 'ledger':
      return `${target.section.label} index`;
    case 'films':
      return `${target.section.label} list`;
    case 'albums':
      return `${target.section.label} index`;
    case 'album':
      return `${target.section.noun} page`;
  }
}

/** Where this surface is on the live site, so the toolbar can link to it. */
export function siteHrefOf(target: PreviewTarget): string {
  if (target.key === null) return target.section.indexUrl;
  return siteUrlFor(target.section, target.key) ?? target.section.indexUrl;
}

/** Where this surface is edited, so the toolbar can link to the editor. */
export function cmsHrefOf(target: PreviewTarget): string {
  return cmsUrlFor(target.section, target.key);
}

/** True when this target's content is a `Doc`, which is what the band diff needs. */
export function isDocumentTarget(target: PreviewTarget): target is DocumentTarget {
  return target.surface === 'document';
}

/**
 * The CSS selector whose elements are this surface's "entries", in page order.
 *
 * The chrome's change list scrolls the frame to a row, and for a document that
 * row is a band with an id in the markup. The other four surfaces have no band
 * ids, so the frame reports the Nth box of this selector instead and the
 * chrome matches on index. The selectors are WS-B's own class names, the ones
 * their harness counts in `verify-sections.ts`.
 */
export function entrySelectorOf(target: PreviewTarget): string {
  switch (target.surface) {
    case 'document':
      return '.doc-band[data-band-id]';
    case 'ledger':
      return '.ledger li';
    case 'films':
      return '.video';
    case 'albums':
      return '.card';
    case 'album':
      return '.album-photo';
  }
}

/* -------------------------------------------------------------------------- */
/* The whole map, for the sidebar                                             */
/* -------------------------------------------------------------------------- */

export type SectionNav = {
  section: SectionDef;
  /** The section's own page. */
  target: PreviewTarget;
  /** True when entries inside it have pages of their own. */
  hasEntryPages: boolean;
};

/** Every section, in sidebar order, with its own previewable surface. */
export function sectionNav(): SectionNav[] {
  return SECTIONS.map((section) => ({
    section,
    target: sectionTarget(section),
    hasEntryPages: section.entryUrl !== null,
  }));
}

/** The same section, the same key and the same surface: the same page. */
export function isSameTarget(a: PreviewTarget, b: PreviewTarget): boolean {
  return a.section.id === b.section.id && a.key === b.key && a.surface === b.surface;
}
