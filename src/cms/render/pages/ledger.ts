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
 *   essays    one cover per essay (`meta.cover`), the title and the date
 *             ("October 14, 2026") on a card cut into its lower-left corner;
 *             empty copy "Nothing published yet. Soon."
 *   projects  rows: date is 2026.07, a `.ledger-summary` under the title,
 *             empty copy "Nothing here yet. Soon."
 *
 * The input is document metadata, not whole documents, so an index page does
 * not have to read and validate every band of every essay to list it.
 *
 * No DOM, no React, no Astro.
 */

import type { Doc, DocMeta } from '../../schema.ts';
import { attr, escapeText, joinParts, safeUrl } from '../escape.ts';
import { formatLedgerDate, renderMasthead } from './masthead.ts';
import type { LedgerDatePrecision } from './masthead.ts';

/** One row. Built from a `DocMeta` by `ledgerItemsFromMetas`. */
export type LedgerItem = {
  href: string;
  title: string;
  /** Shown on projects, not on essays. */
  summary?: string;
  /** YYYY-MM-DD. Formatted by the section's own precision. */
  date: string;
  /** `meta.cover`, carried only for a section laid out as covers. */
  cover?: string;
};

export type LedgerSectionId = 'essays' | 'projects';

type LedgerStyle = {
  heading: string;
  precision: LedgerDatePrecision;
  /**
   * `rows`: a title and a date per line, on hairlines. `covers`: one feature
   * per document, its cover across the column with the title on a card cut
   * into the lower-left corner (Paper: Personal Site, "Essays index",
   * "Try 1 · Letterbox").
   */
  layout: 'rows' | 'covers';
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
    precision: 'long',
    layout: 'covers',
    showSummary: false,
    empty: 'Nothing published yet. Soon.',
    hrefBase: '/essays/',
  },
  projects: {
    heading: 'Projects',
    precision: 'month',
    layout: 'rows',
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
    if (style.layout === 'covers' && meta.cover !== undefined) item.cover = meta.cover;
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

function renderRow(item: LedgerItem, precision: LedgerDatePrecision): string {
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
 * One essay as a feature: the whole thing is the link, the cover is the art
 * box, and the card holds the title and the date.
 *
 * The image is decorative here (`alt=""`): it sits inside a link whose name
 * is the title beside it, and a description read out before the title would
 * only delay it. The essay page itself carries `meta.coverAlt`.
 *
 * `safeUrl` on the src, as everywhere a document value becomes an attribute.
 * An essay with no cover, or one the renderer refuses, is still listed: as
 * the card alone (`.ledger-cover--bare`), never dropped, because a missing
 * picture is not a reason to hide an essay.
 *
 * Only the first cover is fetched eagerly, and at high priority; it is the
 * one above the fold. Every later one is lazy.
 */
function renderCoverRow(item: LedgerItem, precision: LedgerDatePrecision, index: number): string {
  const src = item.cover === undefined ? null : safeUrl(item.cover);
  const loading = index === 0 ? ' fetchpriority="high"' : ' loading="lazy"';
  const art =
    src === null
      ? ''
      : `<span class="ledger-cover-art"><img class="ledger-cover-img"${attr('src', src)} alt=""${loading} decoding="async"></span>`;
  return (
    `<li class="ledger-cover${src === null ? ' ledger-cover--bare' : ''}">` +
    `<a class="ledger-cover-link"${attr('href', item.href)}>` +
    art +
    '<span class="ledger-cover-card">' +
    `<span class="ledger-title">${escapeText(item.title)}</span>` +
    `<span class="ledger-date">${escapeText(formatLedgerDate(item.date, precision))}</span>` +
    '</span></a></li>'
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
  const sorted = sortNewestFirst(items);
  if (style.layout === 'covers') {
    const rows = sorted.map((item, index) => renderCoverRow(item, style.precision, index));
    return `<ul class="ledger ledger--covers">${joinParts(rows)}</ul>`;
  }
  const rows = sorted.map((item) => renderRow(item, style.precision));
  return `<ul class="ledger">${joinParts(rows)}</ul>`;
}

/** The whole surface, masthead included. */
export function renderLedgerPage(
  items: readonly LedgerItem[],
  section: LedgerSectionId,
): string {
  return renderMasthead(LEDGER[section].heading) + renderLedger(items, section);
}
