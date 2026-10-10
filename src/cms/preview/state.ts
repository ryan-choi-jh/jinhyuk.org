/**
 * src/cms/preview/state.ts
 *
 * WS-7 PREVIEW, extended by WS-H. The preview's whole state is in its URL, and
 * this file is the only place that knows how to read or write it.
 *
 *   /cms/preview                        the list of every section
 *   /cms/preview/<path>                 the preview, chrome plus frame
 *   /cms/preview/frame/<path>           the page by itself, which is what the
 *                                       frame loads and what a screenshot of
 *                                       "the real thing" should point at
 *
 * `<path>` is `<section>` or `<section>/<key>`, plus phase 1's bare project
 * slug as an inbound alias. What those mean is `target.ts`'s business, not
 * this file's: everything here treats the path as an opaque string of
 * segments, which is what keeps it free of imports (see the note below).
 *
 * THE FRAME MOVED IN FRONT. Phase 1 put it at `/cms/preview/<slug>/frame`, and
 * a trailing marker stops working the moment a path can have two segments:
 * `/cms/preview/essays/frame` is then both "the essays index, framed" and "the
 * essay called frame". A literal segment in front is unambiguous for every
 * key, and `preview.astro` still answers the phase 1 URL with a redirect.
 *
 * Query parameters, all optional:
 *
 *   v=draft|published   which document. Default: the draft if there is one,
 *                       otherwise the published page.
 *   w=1440|1100|390     the frame's width, in CSS px. Chrome only; the frame
 *                       does not need to be told, because the iframe's own
 *                       width IS its viewport width, which is the entire
 *                       reason the 3.4 fallback can be checked without a
 *                       phone. Default 1440.
 *   theme=light|dark    force a theme. Default: whatever the browser would
 *                       have chosen, exactly as the live site does it.
 *
 * Pure, and deliberately dependency-free: no fs, no fetch, no DOM, no Astro,
 * and no import of src/cms/schema.ts either. It is imported by the routes, by
 * the client scripts and by selftest.ts, and a browser bundle that reached the
 * schema would be pulling zod into the page to learn one integer. The one
 * number it would have borrowed is restated below and checked against the
 * schema in selftest.ts instead.
 */

/* -------------------------------------------------------------------------- */
/* Widths                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * MOBILE_BREAKPOINT from src/cms/schema.ts, restated so this module stays
 * free of imports. selftest.ts asserts the two are equal, so they cannot
 * drift: if WS-0 ever moves the breakpoint, the test fails here rather than
 * the preview quietly mislabelling a width.
 */
export const MOBILE_BREAKPOINT_PX = 900;

/**
 * The three presets from the brief (docs/cms-rebuild.md 4, WS-7) and from
 * WS-1's own verification, so a preview screenshot and a renderer screenshot
 * are comparable:
 *
 *   1440  the designed page. 1440 - 2*48 of gutter leaves REFERENCE_WIDTH.
 *   1100  the awkward middle: the canvas has shrunk, the fallback has not
 *         fired, and this is where an authored overlay first collides.
 *    390  a phone. Below MOBILE_BREAKPOINT, so 3.4 applies.
 *
 * "Do not invent others" (rule 6), so this is a closed set.
 */
export const PREVIEW_WIDTHS = [1440, 1100, 390] as const;
export type PreviewWidth = (typeof PREVIEW_WIDTHS)[number];
export const DEFAULT_WIDTH: PreviewWidth = 1440;

/** The 390 preset is the only one below the breakpoint. Derived, never typed in. */
export function isMobileWidth(width: PreviewWidth): boolean {
  return width <= MOBILE_BREAKPOINT_PX;
}

/** What the button says. The second half is why you would press it. */
export function widthLabel(width: PreviewWidth): string {
  if (width === 1440) return 'as designed';
  if (width === 1100) return 'narrow desktop';
  return 'phone';
}

export function parseWidth(raw: string | null | undefined): PreviewWidth {
  const asNumber = Number(raw);
  const found = PREVIEW_WIDTHS.find((width) => width === asNumber);
  return found ?? DEFAULT_WIDTH;
}

/* -------------------------------------------------------------------------- */
/* Versions                                                                   */
/* -------------------------------------------------------------------------- */

export type PreviewVersion = 'draft' | 'published';

export function parseVersion(raw: string | null | undefined): PreviewVersion | null {
  if (raw === 'draft' || raw === 'published') return raw;
  return null;
}

export type VersionAvailability = { draft: boolean; published: boolean };

export type ResolvedVersion = {
  /** Null only when neither document exists. */
  version: PreviewVersion | null;
  /** True when the URL asked for one that is not there and we showed the other. */
  substituted: boolean;
};

/**
 * Which document to show.
 *
 * A link to `?v=draft` that outlives the draft (because it was published, and
 * publish deletes the draft, 2.3) must not become an error page: it shows the
 * published page and says that is what it did. That is the single most common
 * way to meet this URL, since the obvious thing to do after previewing a draft
 * is publish it and then reload.
 */
export function resolveVersion(
  requested: PreviewVersion | null,
  available: VersionAvailability,
): ResolvedVersion {
  const preferred: PreviewVersion = available.draft ? 'draft' : 'published';
  if (requested === null) {
    const version = available.draft || available.published ? preferred : null;
    return { version, substituted: false };
  }
  if (available[requested]) return { version: requested, substituted: false };
  const other: PreviewVersion = requested === 'draft' ? 'published' : 'draft';
  if (available[other]) return { version: other, substituted: true };
  return { version: null, substituted: false };
}

export function versionLabel(version: PreviewVersion): string {
  return version === 'draft' ? 'Draft' : 'Published';
}

/* -------------------------------------------------------------------------- */
/* Theme                                                                      */
/* -------------------------------------------------------------------------- */

/** Null means "do not force one": follow the saved choice or the OS, as the site does. */
export type PreviewTheme = 'light' | 'dark' | null;

export function parseTheme(raw: string | null | undefined): PreviewTheme {
  if (raw === 'light' || raw === 'dark') return raw;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

export const PREVIEW_BASE = '/cms/preview';
/** The literal segment that marks a frame URL. See the note at the top. */
export const FRAME_SEGMENT = 'frame';
export const FRAME_BASE = `${PREVIEW_BASE}/${FRAME_SEGMENT}`;
export const VERSION_PARAM = 'v';
export const WIDTH_PARAM = 'w';
export const THEME_PARAM = 'theme';

export type PreviewState = {
  version?: PreviewVersion | null;
  width?: PreviewWidth;
  theme?: PreviewTheme;
};

function query(pairs: [string, string][]): string {
  if (pairs.length === 0) return '';
  return `?${pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}

/**
 * A `<section>/<key>` path, escaped segment by segment.
 *
 * Per segment and not as a whole, because `encodeURIComponent` of the whole
 * path would escape the separating slash and send `essays%2Ffoo` as one
 * segment. Both halves are `[A-Za-z0-9_-]` by the time they get here
 * (`isPreviewKey`), so this is a guard against a hand-typed URL rather than
 * part of the normal path.
 *
 * Two things it does beyond encoding. An empty segment is dropped, so a
 * doubled slash cannot produce `//`. And `.` or `..` is encoded character by
 * character, because `encodeURIComponent('..')` is `'..'` — a dot is a legal
 * URL character — and a path operator in a link is worse than an ugly link:
 * the browser would resolve it before the route ever saw it.
 */
function safeSegment(value: string): string {
  const encoded = encodeURIComponent(value);
  if (encoded === '.' || encoded === '..') return encoded.replace(/\./g, '%2E');
  return encoded;
}

export function pathHref(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map(safeSegment)
    .join('/');
}

/**
 * The chrome: toolbar, frame, change list.
 *
 * `path` is `<section>`, `<section>/<key>`, or phase 1's bare project slug —
 * every one of which this function treats identically, because the chrome
 * route is the thing that resolves them.
 */
export function previewHref(path: string, state: PreviewState = {}): string {
  const pairs: [string, string][] = [];
  if (state.version != null) pairs.push([VERSION_PARAM, state.version]);
  if (state.width !== undefined && state.width !== DEFAULT_WIDTH) {
    pairs.push([WIDTH_PARAM, String(state.width)]);
  }
  if (state.theme != null) pairs.push([THEME_PARAM, state.theme]);
  return `${PREVIEW_BASE}/${pathHref(path)}${query(pairs)}`;
}

/**
 * The page itself. No width: the iframe's width is the viewport, and a width
 * in here would be a second source of truth for the same number.
 */
export function frameHref(path: string, state: PreviewState = {}): string {
  const pairs: [string, string][] = [];
  if (state.version != null) pairs.push([VERSION_PARAM, state.version]);
  if (state.theme != null) pairs.push([THEME_PARAM, state.theme]);
  return `${FRAME_BASE}/${pathHref(path)}${query(pairs)}`;
}

/**
 * Phase 1's frame URL, recognised so the chrome route can redirect it.
 *
 * Returns the path it was asking for, or null when this is not that shape. The
 * rule is narrow on purpose: ONLY a two-segment path whose first segment is
 * not a section, which is exactly `<project-slug>/frame` and cannot collide
 * with a real `<section>/<key>` — so an essay whose slug is literally `frame`
 * is still reachable. The caller supplies `isSection`, because this module
 * does not import the registry.
 */
export function legacyFramePath(
  segments: readonly string[],
  isSection: (id: string) => boolean,
): string | null {
  if (segments.length !== 2) return null;
  if (segments[1] !== FRAME_SEGMENT) return null;
  const first = segments[0];
  if (first === undefined || first === '' || isSection(first)) return null;
  return first;
}

/** Where to send someone who has no GitHub session, so they come back here. */
export function loginHref(returnTo: string): string {
  return `/api/cms/auth/login?return=${encodeURIComponent(returnTo)}`;
}

/* -------------------------------------------------------------------------- */
/* The frame's report                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What the frame tells the chrome about itself, over postMessage. The chrome
 * needs `height` to let the iframe be its own full length, and `bands` to
 * scroll to one. The rest is the readout under the toolbar: at 390 it is how
 * you know the 3.4 fallback actually fired, rather than merely believing it
 * did because the page looks narrow.
 *
 * Messages only ever travel frame -> chrome. The chrome never asks the frame
 * for anything, which is why there is one message type and no request/reply
 * bookkeeping: everything the chrome needs arrives with every report, and a
 * report is sent whenever the frame changes shape.
 */
export const FRAME_MESSAGE = 'cms-preview:state';

export type FrameBandBox = {
  id: string;
  /** Offset within the frame's document, in the frame's own CSS px. */
  top: number;
  height: number;
  /**
   * WS-H. The other two sides, because a justified gallery is the one surface
   * whose correctness is geometric: "every photograph in a row is the same
   * height and the row spans the column" is the definition of justified, and
   * neither half can be checked from a top edge alone.
   */
  left: number;
  width: number;
};

export type FrameReport = {
  type: typeof FRAME_MESSAGE;
  /**
   * Which surface the frame rendered, as the frame route stamped it on
   * `<html>`. The chrome shows it, and a test can assert that asking for an
   * album page really produced one.
   */
  surface: string;
  /** Full content height, so the chrome can let the iframe be its own length. */
  height: number;
  /** The frame's own viewport width. Should equal the chosen preset. */
  width: number;
  /** Is the 900px fallback in force? Read from a media query, not from the number. */
  mobile: boolean;
  items: { total: number; positioned: number; stacked: number };
  /** Bands taken out of flow by `overlay: true`, as the browser sees them. */
  overlays: { total: number; positioned: number };
  /** Connector paths drawn AND visible. Must be 0 below the breakpoint (3.4). */
  connectors: number;
  /** Paths present in the svg whether or not it is displayed. Diagnostic. */
  connectorNodes: number;
  /** True when every `.doc-item` starts at or below the one before it in the DOM. */
  inDocumentOrder: boolean;
  images: { total: number; loaded: number };
  fontsReady: boolean;
  /**
   * WS-H. Sideways overflow, which is the one layout failure a screenshot of
   * the top of a page hides completely. `scrollWidth > clientWidth` inside a
   * 390px frame is a horizontal scrollbar on a phone.
   */
  clientWidth: number;
  scrollWidth: number;
  /**
   * WS-H. The enlarge overlays in the page: the homepage hero's and every
   * album's. `open` must be 0 on a page nobody has touched, and `fixed` must
   * equal `total` — an overlay that resolved against a containing block
   * instead of the viewport is a bug that only shows when you click it.
   */
  dialogs: { total: number; open: number; fixed: number };
  bands: FrameBandBox[];
  /**
   * WS-H. The same boxes for a surface that has no bands: the Nth film, album
   * tile, photograph or ledger row, in page order, with `id` the index as a
   * string. Which elements those are comes from the frame route, which puts
   * `entrySelectorOf(target)` on `<html data-pv-entries>` — the frame script
   * cannot work it out for itself without knowing what it is rendering.
   *
   * Empty on a document, where `bands` is the addressable list instead.
   */
  entries: FrameBandBox[];
};
