/**
 * src/cms/app/chrome/edits.ts
 *
 * Every change the nav-and-footer panel can make, as pure functions over
 * `SiteChrome`.
 *
 * Separated from the component for the same reason `../records/album-edits.ts`
 * is: a reorder is a thing you want to be able to reason about (and to run under
 * bare `node`) without mounting React. Nothing here does I/O and nothing here
 * mutates its argument.
 *
 * No JSX, so this file is importable from anywhere.
 */

import {
  HrefSchema,
  MAX_NAV_LINKS,
  MAX_SOCIAL_LINKS,
  SOCIAL_ICONS,
  formatIssues,
  newNavLink,
  newSocialLink,
  validateSiteChrome,
} from '../../schema.ts';
import type { NavLink, SiteChrome, SocialIcon, SocialLink } from '../../schema.ts';
import { SOCIAL_ICON_LABELS } from '../../site-icons.ts';

/* -------------------------------------------------------------------------- */
/* List primitives                                                             */
/* -------------------------------------------------------------------------- */

/** A copy with `index` removed. Out-of-range leaves the list alone. */
export function removeAt<T>(list: readonly T[], index: number): T[] {
  if (index < 0 || index >= list.length) return [...list];
  const next = [...list];
  next.splice(index, 1);
  return next;
}

/** A copy with `index` replaced. Out-of-range leaves the list alone. */
export function replaceAt<T>(list: readonly T[], index: number, value: T): T[] {
  if (index < 0 || index >= list.length) return [...list];
  const next = [...list];
  next[index] = value;
  return next;
}

/**
 * A copy with `from` moved to `to`. Both are clamped, so "move the first one up"
 * is a no-op rather than an error — which is what a disabled-looking arrow that
 * got clicked anyway should do.
 */
export function moveAt<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item as T);
  return next;
}

/** A copy with `value` appended, or the same list when the cap is reached. */
export function appendCapped<T>(list: readonly T[], value: T, max: number): T[] {
  if (list.length >= max) return [...list];
  return [...list, value];
}

/* -------------------------------------------------------------------------- */
/* Whole-chrome edits                                                          */
/* -------------------------------------------------------------------------- */

export function withNav(chrome: SiteChrome, nav: NavLink[]): SiteChrome {
  return { ...chrome, nav };
}

export function withSocial(chrome: SiteChrome, social: SocialLink[]): SiteChrome {
  return { ...chrome, footer: { ...chrome.footer, social } };
}

export function withCopyright(chrome: SiteChrome, copyright: string): SiteChrome {
  return { ...chrome, footer: { ...chrome.footer, copyright } };
}

export function setNavField(
  chrome: SiteChrome,
  index: number,
  field: 'label' | 'href',
  value: string,
): SiteChrome {
  const link = chrome.nav[index];
  if (link === undefined) return chrome;
  // Spelled out rather than built with a computed key, so the compiler checks
  // the field names instead of widening the object to a string map.
  const next: NavLink =
    field === 'label' ? { ...link, label: value } : { ...link, href: value };
  return withNav(chrome, replaceAt(chrome.nav, index, next));
}

export function addNavLink(chrome: SiteChrome): SiteChrome {
  return withNav(chrome, appendCapped(chrome.nav, newNavLink(), MAX_NAV_LINKS));
}

export function removeNavLink(chrome: SiteChrome, index: number): SiteChrome {
  return withNav(chrome, removeAt(chrome.nav, index));
}

export function moveNavLink(chrome: SiteChrome, from: number, to: number): SiteChrome {
  return withNav(chrome, moveAt(chrome.nav, from, to));
}

export function setSocialText(
  chrome: SiteChrome,
  index: number,
  field: 'name' | 'href',
  value: string,
): SiteChrome {
  const link = chrome.footer.social[index];
  if (link === undefined) return chrome;
  const next: SocialLink =
    field === 'name' ? { ...link, name: value } : { ...link, href: value };
  return withSocial(chrome, replaceAt(chrome.footer.social, index, next));
}

/**
 * Change which drawing a social link uses.
 *
 * When the name is still the previous icon's own label — "X" on an entry that
 * was the X link — it follows the icon, because that is what the person meant;
 * a name they actually wrote ("Ryan on YouTube") is left alone.
 */
export function setSocialIcon(chrome: SiteChrome, index: number, icon: SocialIcon): SiteChrome {
  const link = chrome.footer.social[index];
  if (link === undefined) return chrome;
  const wasDefaultName = link.name === SOCIAL_ICON_LABELS[link.icon] || link.name.trim() === '';
  const next: SocialLink = {
    ...link,
    icon,
    ...(wasDefaultName ? { name: SOCIAL_ICON_LABELS[icon] } : {}),
  };
  return withSocial(chrome, replaceAt(chrome.footer.social, index, next));
}

/**
 * A new social link, set to the first icon the footer is not already using —
 * and named after it, which is right whether or not there was a spare one,
 * because the name is always the label of the icon it ends up with.
 */
export function addSocialLink(chrome: SiteChrome): SiteChrome {
  const used = new Set(chrome.footer.social.map((link) => link.icon));
  const icon = SOCIAL_ICONS.find((key) => !used.has(key)) ?? SOCIAL_ICONS[0];
  const fresh = newSocialLink({ icon, name: SOCIAL_ICON_LABELS[icon] });
  return withSocial(chrome, appendCapped(chrome.footer.social, fresh, MAX_SOCIAL_LINKS));
}

export function removeSocialLink(chrome: SiteChrome, index: number): SiteChrome {
  return withSocial(chrome, removeAt(chrome.footer.social, index));
}

export function moveSocialLink(chrome: SiteChrome, from: number, to: number): SiteChrome {
  return withSocial(chrome, moveAt(chrome.footer.social, from, to));
}

/* -------------------------------------------------------------------------- */
/* Problems, per field                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The schema's own complaint about one address, in a sentence a person can act
 * on. Empty gets its own wording, because "href must be a site-absolute
 * path…" is a specification and "Add the address" is an instruction.
 */
export function hrefProblem(href: string): string | null {
  if (href.trim() === '') return 'Add the address.';
  const parsed = HrefSchema.safeParse(href);
  if (parsed.success) return null;
  return parsed.error.issues[0]?.message ?? 'That is not an address the site can link to.';
}

export function labelProblem(label: string): string | null {
  return label.trim() === '' ? 'Add a label; this is what the nav bar prints.' : null;
}

export function nameProblem(name: string): string | null {
  return name.trim() === '' ? 'Add a name; a screen reader reads it out.' : null;
}

export function copyrightProblem(copyright: string): string | null {
  return copyright.trim() === '' ? 'Add a line, or the footer has no text at all.' : null;
}

/* -------------------------------------------------------------------------- */
/* Whole-file validity                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Null when this would save, else every reason it would not, one per line.
 *
 * The same validator the endpoint runs, so the panel can refuse before the
 * round trip and say exactly what the server would have said.
 */
export function chromeProblem(chrome: SiteChrome): string | null {
  const result = validateSiteChrome(chrome);
  return result.ok ? null : formatIssues(result.issues);
}

/** Dirty, by value. The chrome is small and plain, so this is honest and cheap. */
export function sameChrome(a: SiteChrome | null, b: SiteChrome | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}
