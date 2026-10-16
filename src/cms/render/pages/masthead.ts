/**
 * src/cms/render/pages/masthead.ts
 *
 * WS-B. The index-page masthead, and the two date formats the site uses.
 *
 * Tiny on purpose. It exists because four surfaces open with the same three
 * lines of markup and the same `.masthead` class, and four copies of them is
 * four chances to disagree with `src/styles/global.css`.
 *
 * Markup is byte-for-byte what `src/pages/*\/index.astro` emits today, so the
 * cutover is a change of data source and not a change of appearance.
 *
 * No DOM, no React, no Astro.
 */

import { escapeText } from '../escape.ts';

/**
 * `<div class="masthead"><h1>Filmography</h1></div>`, with the optional deck
 * the site's `.masthead .deck` rule already styles.
 */
export function renderMasthead(title: string, deck?: string): string {
  const sub = deck === undefined || deck === '' ? '' : `<p class="deck">${escapeText(deck)}</p>`;
  return `<div class="masthead"><h1>${escapeText(title)}</h1>${sub}</div>`;
}

/**
 * The formats the live index pages use, kept together so nobody has to
 * remember which surface wants which:
 *
 *   essays    2026.10.14         src/pages/essays/index.astro, the projects'
 *                                format to the day
 *   projects  2026.07            src/pages/projects/index.astro
 *
 * The input is a `Doc.meta.date`, which the schema has already proved is a real
 * YYYY-MM-DD, so this is a slice and not a parse: `new Date(...)` would move
 * the day across a timezone for no benefit.
 */
export function formatLedgerDate(date: string, precision: LedgerDatePrecision): string {
  if (precision === 'long') return formatLongDate(date);
  const slice = precision === 'day' ? date.slice(0, 10) : date.slice(0, 7);
  return slice.replace(/-/g, '.');
}

/**
 * How the date is written. `long` is "October 14, 2026", the way an essay's
 * own masthead writes it (`formatDate` in ../index.ts). The essays index used
 * it while its rows were cards cut into a full-width cover; since it became
 * the projects' list with a cover strip, it writes the date the projects' way.
 */
export type LedgerDatePrecision = 'day' | 'month' | 'long';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** A slice too, not a `Date`, for the reason above. Anything unparseable comes back as it was. */
function formatLongDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (match === null) return date;
  const month = MONTHS[Number(match[2]) - 1];
  if (month === undefined) return date;
  return `${month} ${Number(match[3])}, ${match[1]}`;
}

/** `<p class="empty">Nothing published yet. Soon.</p>` — the site's own wording. */
export function renderEmptyLine(message: string): string {
  return `<p class="empty">${escapeText(message)}</p>`;
}
