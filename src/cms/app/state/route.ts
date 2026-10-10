/**
 * src/cms/app/state/route.ts
 *
 * WS-D. Where the editor is, as data.
 *
 * Three places exist, and they come straight out of WS-A's registry rather
 * than out of a string literal in here:
 *
 *   overview   the site map                        `/cms`
 *   section    one section's entry list            `section.cmsUrl`
 *   entry      one entry open in an editor         `section.cmsEntryUrl`
 *
 * Nothing in this file writes `/cms`, `'home'` or `'photography'`. The root is
 * derived from the registry (every section's `cmsUrl` is the root plus its id,
 * which `assertRegistryShape` checks at import time), and an entry URL is
 * matched by splitting that section's own `cmsEntryUrl` on `SLUG_TOKEN`. Add a
 * sixth section to `src/cms/sections.ts` and this file routes it with no edit.
 *
 * A singleton has no `cmsEntryUrl` (docs/cms-contracts.md 9.2: `cmsUrlFor`
 * returns `cmsUrl` for it), so `/cms/home` is both "the home section" and "the
 * home document". `resolveRoute` is what collapses those two: it answers with
 * a `view` of `'entry'` for a singleton's section route, which is how
 * "Home is a singleton: no entry list, go straight in" is implemented once
 * instead of at every call site.
 *
 * `Navigator` is the seam that keeps this testable. The browser one pushes
 * real history entries; the memory one is what the harness and
 * `./verify-site-state.ts` use, so routing is proven with no DOM and no URL.
 */

import { IdSchema } from '../../schema.ts';
import type { SectionId } from '../../schema.ts';
import { SECTIONS, SLUG_TOKEN, getSection } from '../../sections.ts';
import type { SectionDef } from '../../sections.ts';

/* -------------------------------------------------------------------------- */
/* The route                                                                   */
/* -------------------------------------------------------------------------- */

export type CmsRoute =
  /** The site map. No section chosen. */
  | { kind: 'overview' }
  /** A section. For a collection that is its entry list; for a singleton, the entry. */
  | { kind: 'section'; section: SectionId }
  /** One entry of a collection. `key` is a slug, or a film's record id. */
  | { kind: 'entry'; section: SectionId; key: string };

export const OVERVIEW: CmsRoute = { kind: 'overview' };

/* -------------------------------------------------------------------------- */
/* Registry-derived shape                                                      */
/* -------------------------------------------------------------------------- */

function assertRegistryShape(): string {
  const roots = new Set<string>();
  for (const section of SECTIONS) {
    const tail = `/${section.id}`;
    if (!section.cmsUrl.endsWith(tail)) {
      throw new TypeError(
        `section "${section.id}" has cmsUrl "${section.cmsUrl}", which does not end with "${tail}"; ` +
          'src/cms/app/state/route.ts derives the editor root from that suffix',
      );
    }
    roots.add(section.cmsUrl.slice(0, section.cmsUrl.length - tail.length));

    if (section.cmsEntryUrl !== null) {
      const parts = section.cmsEntryUrl.split(SLUG_TOKEN);
      if (parts.length !== 2) {
        throw new TypeError(
          `section "${section.id}" has cmsEntryUrl "${section.cmsEntryUrl}", which must contain ` +
            `exactly one "${SLUG_TOKEN}"`,
        );
      }
    }
  }
  if (roots.size !== 1) {
    throw new TypeError(`the sections disagree about the editor root: ${[...roots].join(', ')}`);
  }
  return [...roots][0] as string;
}

/** `/cms`. Derived, never typed. */
export const CMS_ROOT: string = assertRegistryShape();

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/** The URL a route is at. The inverse of `parseCmsRoute`. */
export function cmsRouteHref(route: CmsRoute): string {
  if (route.kind === 'overview') return CMS_ROOT;
  const section = getSection(route.section);
  if (section === null) return CMS_ROOT;
  if (route.kind === 'section') return section.cmsUrl;
  if (section.cmsEntryUrl === null) return section.cmsUrl;
  if (!IdSchema.safeParse(route.key).success) return section.cmsUrl;
  return section.cmsEntryUrl.split(SLUG_TOKEN).join(route.key);
}

/** Same place? Compares by value, so it is safe on freshly built routes. */
export function sameRoute(a: CmsRoute, b: CmsRoute): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'overview' || b.kind === 'overview') return true;
  if (a.section !== (b as { section: SectionId }).section) return false;
  if (a.kind === 'entry' && b.kind === 'entry') return a.key === b.key;
  return true;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

/** `/cms/essays/` and `/cms/essays` are the same place. */
function normalize(pathname: string): string {
  const path = pathname.split('?')[0]?.split('#')[0] ?? '';
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  if (withSlash.length > 1 && withSlash.endsWith('/')) return withSlash.slice(0, -1);
  return withSlash;
}

/**
 * A pathname to a route, or null when it is not an editor URL at all. Null is
 * a 404 at the route level and the overview's problem at the shell level, the
 * same way `getSection` returning null is.
 */
export function parseCmsRoute(pathname: string): CmsRoute | null {
  const path = normalize(pathname);
  if (path === CMS_ROOT) return OVERVIEW;

  for (const section of SECTIONS) {
    if (path === section.cmsUrl) return { kind: 'section', section: section.id };

    if (section.cmsEntryUrl === null) continue;
    const [prefix, suffix] = section.cmsEntryUrl.split(SLUG_TOKEN) as [string, string];
    if (!path.startsWith(prefix)) continue;
    if (suffix !== '' && !path.endsWith(suffix)) continue;
    const key = path.slice(prefix.length, suffix === '' ? undefined : path.length - suffix.length);
    if (!IdSchema.safeParse(key).success) continue;
    return { kind: 'entry', section: section.id, key };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Resolving                                                                   */
/* -------------------------------------------------------------------------- */

/** Which of the three regions the shell should draw for a route. */
export type RouteView = 'overview' | 'list' | 'entry';

export type ResolvedRoute = {
  route: CmsRoute;
  section: SectionDef | null;
  /**
   * The entry the editor should open, or null. A singleton resolves to `null`
   * with `view: 'entry'`, which is exactly what the API means by "`:slug` is
   * omitted for a singleton section" (docs/cms-contracts.md 11).
   */
  entryKey: string | null;
  view: RouteView;
};

/**
 * A route, looked up. The one place that knows a singleton's section route is
 * really an entry route, and that an entry route for a singleton is a typo for
 * the same thing.
 */
export function resolveRoute(route: CmsRoute): ResolvedRoute {
  if (route.kind === 'overview') {
    return { route, section: null, entryKey: null, view: 'overview' };
  }
  const section = getSection(route.section);
  if (section === null) return { route: OVERVIEW, section: null, entryKey: null, view: 'overview' };

  if (section.shape === 'singleton') {
    const canonical: CmsRoute = { kind: 'section', section: section.id };
    return { route: canonical, section, entryKey: null, view: 'entry' };
  }

  if (route.kind === 'entry') {
    return { route, section, entryKey: route.key, view: 'entry' };
  }
  return { route, section, entryKey: null, view: 'list' };
}

/** The route that opens this entry, honouring the singleton collapse. */
export function entryRoute(section: SectionDef, key: string | null): CmsRoute {
  if (section.shape === 'singleton' || key === null) return { kind: 'section', section: section.id };
  return { kind: 'entry', section: section.id, key };
}

/* -------------------------------------------------------------------------- */
/* Navigator                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How a route reaches, and comes back from, the address bar. The store takes
 * one of these so that nothing in `state/` touches `window`, which is what
 * lets `./verify-site-state.ts` drive every navigation under bare node.
 */
export type Navigator = {
  /** Where we are now. */
  current(): CmsRoute;
  /** Go there, adding a history entry. */
  push(route: CmsRoute): void;
  /** Go there, replacing the current history entry. */
  replace(route: CmsRoute): void;
  /**
   * Called when the browser moves without us: Back, Forward. Returns an
   * unsubscribe. The store re-reads `current()` rather than trusting the
   * argument, so a listener that cannot tell where it went is still correct.
   */
  listen(onPopState: (route: CmsRoute) => void): () => void;
};

/** A navigator with no browser behind it. The harness and the node proof use this. */
export function createMemoryNavigator(initial: CmsRoute = OVERVIEW): Navigator & {
  /** Every route pushed or replaced, oldest first. For assertions. */
  readonly trail: CmsRoute[];
  /** Simulate Back/Forward: move to `route` and tell the store. */
  pop(route: CmsRoute): void;
} {
  let route = initial;
  const trail: CmsRoute[] = [initial];
  const listeners = new Set<(route: CmsRoute) => void>();

  return {
    trail,
    current: () => route,
    push(next) {
      route = next;
      trail.push(next);
    },
    replace(next) {
      route = next;
      trail[trail.length - 1] = next;
    },
    listen(onPopState) {
      listeners.add(onPopState);
      return () => {
        listeners.delete(onPopState);
      };
    },
    pop(next) {
      route = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

/**
 * The real thing: `history.pushState` and `popstate`. A URL that is not an
 * editor URL resolves to the overview rather than throwing, because the
 * address bar is user input.
 */
export function createBrowserNavigator(): Navigator {
  const read = (): CmsRoute => {
    if (typeof window === 'undefined') return OVERVIEW;
    return parseCmsRoute(window.location.pathname) ?? OVERVIEW;
  };

  return {
    current: read,
    push(route) {
      if (typeof window === 'undefined') return;
      const href = cmsRouteHref(route);
      if (normalize(window.location.pathname) === normalize(href)) return;
      window.history.pushState({ cms: route }, '', href);
    },
    replace(route) {
      if (typeof window === 'undefined') return;
      window.history.replaceState({ cms: route }, '', cmsRouteHref(route));
    },
    listen(onPopState) {
      if (typeof window === 'undefined') return () => {};
      const handler = (): void => onPopState(read());
      window.addEventListener('popstate', handler);
      return () => window.removeEventListener('popstate', handler);
    },
  };
}
