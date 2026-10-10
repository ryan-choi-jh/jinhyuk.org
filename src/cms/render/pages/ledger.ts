/**
 * src/cms/render/pages/ledger.ts
 *
 * WS-B. The two index pages that are lists of documents: essays and projects.
 *
 * Markup and wording are byte-for-byte `src/pages/essays/index.astro` and
 * `src/pages/projects/index.astro`, including the two things they disagree
 * about and that are easy to get wrong when the data source changes under
 * them:
 *
 *   essays    date is 2026.06.09, no summary line, empty copy "Nothing
 *             published yet. Soon."
 *   projects  date is 2026.07, a `.ledger-summary` under the title, empty copy
 *             "Nothing here yet. Soon."
 *
 * The input is document metadata, not whole documents, so an index page does
 * not have to read and validate every band of every essay to list it.
 *
 * No DOM, no React, no Astro.
 */

import type { Doc, DocMeta } from '../../schema.ts';
import { attr, escapeText, joinParts } from '../escape.ts';
import { formatLedgerDate, renderMasthead } from './masthead.ts';

/** One row. Built from a `DocMeta` by `ledgerItemsFromMetas`. */
export type LedgerItem = {
  href: string;
  title: string;
  /** Shown on projects, not on essays. */
  summary?: string;
  /** YYYY-MM-DD. Formatted by the section's own precision. */
  date: string;
};

export type LedgerSectionId = 'essays' | 'projects';

type LedgerStyle = {
  heading: string;
  precision: 'day' | 'month';
  showSummary: boolean;
  empty: string;
  hrefBase: string;
};

/**
 * One table rather than two branches, so a third list surface is a row here
 * and not a copy of the renderer.
 */
const LEDGER: Readonly<Record<LedgerSectionId, LedgerStyle>> = {
  essays: {
    heading: 'Essays',
    precision: 'day',
    showSummary: false,
    empty: 'Nothing published yet. Soon.',
    hrefBase: '/essays/',
  },
  projects: {
    heading: 'Projects',
    precision: 'month',
    showSummary: true,
    empty: 'Nothing here yet. Soon.',
    hrefBase: '/projects/',
  },
};

/** Newest first, which is what both live pages sort by. */
export function sortNewestFirst<T extends { date: string }>(items: readonly T[]): T[] {
  // The schema has already proved every date is a real YYYY-MM-DD, so a string
  // compare is a date compare, and it cannot shift a day across a timezone.
  return [...items].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export function ledgerItemsFromMetas(
  metas: readonly DocMeta[],
  section: LedgerSectionId,
): LedgerItem[] {
  const style = LEDGER[section];
  return sortNewestFirst(metas).map((meta) => {
    const item: LedgerItem = {
      href: `${style.hrefBase}${meta.slug}/`,
      title: meta.title,
      date: meta.date,
    };
    if (style.showSummary && meta.summary !== undefined && meta.summary !== '') {
      item.summary = meta.summary;
    }
    return item;
  });
}

export function ledgerItemsFromDocs(
  docs: readonly Doc[],
  section: LedgerSectionId,
): LedgerItem[] {
  return ledgerItemsFromMetas(
    docs.map((doc) => doc.meta),
    section,
  );
}

function renderRow(item: LedgerItem, precision: 'day' | 'month'): string {
  const summary =
    item.summary === undefined || item.summary === ''
      ? ''
      : `<span class="ledger-summary">${escapeText(item.summary)}</span>`;
  return (
    '<li>' +
    '<div class="ledger-body">' +
    `<a class="ledger-title"${attr('href', item.href)}>${escapeText(item.title)}</a>` +
    summary +
    '</div>' +
    `<span class="ledger-date">${escapeText(formatLedgerDate(item.date, precision))}</span>` +
    '</li>'
  );
}

/**
 * The list alone, for a page that keeps its own masthead.
 *
 * Sorts. Both live index pages sort newest first, and a caller that hands over
 * rows in directory order gets a page that is subtly wrong in a way nobody
 * notices until two essays are a day apart — which is what happened the first
 * time this was screenshotted against the live page. Sorting here, rather than
 * trusting every caller to remember, is the one place that cannot forget;
 * `ledgerItemsFromMetas` sorts too, and sorting sorted rows costs nothing.
 */
export function renderLedger(items: readonly LedgerItem[], section: LedgerSectionId): string {
  const style = LEDGER[section];
  if (items.length === 0) return `<p class="empty">${escapeText(style.empty)}</p>`;
  const rows = sortNewestFirst(items).map((item) => renderRow(item, style.precision));
  return `<ul class="ledger">${joinParts(rows)}</ul>`;
}

/** The whole surface, masthead included. */
export function renderLedgerPage(
  items: readonly LedgerItem[],
  section: LedgerSectionId,
): string {
  return renderMasthead(LEDGER[section].heading) + renderLedger(items, section);
}
