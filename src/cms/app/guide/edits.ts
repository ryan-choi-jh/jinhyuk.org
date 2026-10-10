/**
 * src/cms/app/guide/edits.ts
 *
 * Every change the guide editor can make, as a pure function from content to
 * content. Nothing here touches React, and nothing mutates its argument.
 *
 * Why separate: the editor is then a form that calls these, each one is
 * readable on its own, and an out-of-range index is handled once instead of
 * at nine call sites. An operation that cannot apply returns the content it
 * was given, unchanged and identical by reference, so `onChange` can be
 * skipped when nothing happened.
 */

import { newGuideCard, newGuideId, newGuideRow, rowIsKeyCap } from './schema.ts';
import type { GuideCard, GuideContent, GuideRow } from './schema.ts';

/*
 * Both of these rebuild an object in the schema's key order.
 *
 * Not cosmetic: the edited content is written to a JSON file that lives in
 * git. Spreading an existing object and then adding a generated id, or
 * deleting an optional field and setting it again, quietly moves keys to the
 * end and turns a one-word edit into a rewritten block in the diff. Building
 * in a fixed order makes the file a function of its content and nothing else.
 */
function canonicalRow(row: GuideRow): GuideRow {
  const next: GuideRow = { term: row.term, text: row.text };
  const ordered: GuideRow = {} as GuideRow;
  if (row.id !== undefined) ordered.id = row.id;
  ordered.term = next.term;
  ordered.text = next.text;
  if (row.key !== undefined) ordered.key = row.key;
  return ordered;
}

function canonicalCard(card: GuideCard): GuideCard {
  const ordered: GuideCard = {} as GuideCard;
  ordered.id = card.id;
  ordered.title = card.title;
  if (card.lead !== undefined) ordered.lead = card.lead;
  ordered.rows = card.rows;
  if (card.note !== undefined) ordered.note = card.note;
  if (card.keys !== undefined) ordered.keys = card.keys;
  return ordered;
}

function inRange(index: number, length: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < length;
}

/** Move `from` to `to`, clamped. Returns the same array if nothing moves. */
function moved<T>(list: readonly T[], from: number, to: number): T[] | null {
  if (!inRange(from, list.length)) return null;
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (target === from) return null;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item as T);
  return next;
}

function withCards(content: GuideContent, cards: GuideCard[]): GuideContent {
  return { ...content, cards };
}

function withCard(content: GuideContent, index: number, card: GuideCard): GuideContent {
  const cards = content.cards.slice();
  cards[index] = card;
  return withCards(content, cards);
}

/* -------------------------------------------------------------------------- */
/* The document                                                                */
/* -------------------------------------------------------------------------- */

export function setTitle(content: GuideContent, title: string): GuideContent {
  return { ...content, title };
}

export function setLead(content: GuideContent, lead: string): GuideContent {
  return { ...content, lead };
}

/* -------------------------------------------------------------------------- */
/* Cards                                                                       */
/* -------------------------------------------------------------------------- */

export function addCard(content: GuideContent, at = content.cards.length): GuideContent {
  const cards = content.cards.slice();
  cards.splice(Math.max(0, Math.min(cards.length, at)), 0, newGuideCard());
  return withCards(content, cards);
}

/** The last card is never removed: a guide with no cards is an empty panel. */
export function removeCard(content: GuideContent, index: number): GuideContent {
  if (!inRange(index, content.cards.length) || content.cards.length <= 1) return content;
  return withCards(content, content.cards.filter((_, i) => i !== index));
}

export function moveCard(content: GuideContent, from: number, to: number): GuideContent {
  const cards = moved(content.cards, from, to);
  return cards === null ? content : withCards(content, cards);
}

/**
 * Change a card's own fields. `undefined` leaves a field alone; an empty
 * string on `lead` or `note` removes it, because an empty optional string in
 * the file would be noise in a diff.
 */
export function patchCard(
  content: GuideContent,
  index: number,
  patch: { title?: string; lead?: string; note?: string; keys?: boolean },
): GuideContent {
  if (!inRange(index, content.cards.length)) return content;
  const card = { ...(content.cards[index] as GuideCard) };

  if (patch.title !== undefined) card.title = patch.title;
  if (patch.keys !== undefined) card.keys = patch.keys;
  if (patch.lead !== undefined) {
    if (patch.lead === '') delete card.lead;
    else card.lead = patch.lead;
  }
  if (patch.note !== undefined) {
    if (patch.note === '') delete card.note;
    else card.note = patch.note;
  }

  return withCard(content, index, canonicalCard(card));
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

export function addRow(content: GuideContent, cardIndex: number, at?: number): GuideContent {
  if (!inRange(cardIndex, content.cards.length)) return content;
  const card = content.cards[cardIndex] as GuideCard;
  const rows = card.rows.slice();
  const where = at === undefined ? rows.length : Math.max(0, Math.min(rows.length, at));
  // No explicit `key`: the new row inherits the card's default, so a row
  // added to a card of key caps is a key cap and a row added anywhere else
  // is plain. Either way the editor's toggle can override it.
  rows.splice(where, 0, newGuideRow());
  return withCard(content, cardIndex, { ...card, rows });
}

export function removeRow(content: GuideContent, cardIndex: number, rowIndex: number): GuideContent {
  if (!inRange(cardIndex, content.cards.length)) return content;
  const card = content.cards[cardIndex] as GuideCard;
  if (!inRange(rowIndex, card.rows.length)) return content;
  return withCard(content, cardIndex, { ...card, rows: card.rows.filter((_, i) => i !== rowIndex) });
}

export function moveRow(
  content: GuideContent,
  cardIndex: number,
  from: number,
  to: number,
): GuideContent {
  if (!inRange(cardIndex, content.cards.length)) return content;
  const card = content.cards[cardIndex] as GuideCard;
  const rows = moved(card.rows, from, to);
  return rows === null ? content : withCard(content, cardIndex, { ...card, rows });
}

export function patchRow(
  content: GuideContent,
  cardIndex: number,
  rowIndex: number,
  patch: { term?: string; text?: string; key?: boolean },
): GuideContent {
  if (!inRange(cardIndex, content.cards.length)) return content;
  const card = content.cards[cardIndex] as GuideCard;
  if (!inRange(rowIndex, card.rows.length)) return content;

  const row: GuideRow = { ...(card.rows[rowIndex] as GuideRow) };
  if (patch.term !== undefined) row.term = patch.term;
  if (patch.text !== undefined) row.text = patch.text;
  if (patch.key !== undefined) row.key = patch.key;
  // Every row the editor touches gets an id, so reordering it is stable from
  // then on. Content authored before row ids existed keeps working either way.
  if (row.id === undefined) row.id = newGuideId('gr');

  const rows = card.rows.slice();
  rows[rowIndex] = canonicalRow(row);
  return withCard(content, cardIndex, { ...card, rows });
}

/**
 * Flip a row between key cap and plain, writing an explicit boolean so the
 * row no longer depends on the card's default.
 */
export function toggleRowKey(content: GuideContent, cardIndex: number, rowIndex: number): GuideContent {
  if (!inRange(cardIndex, content.cards.length)) return content;
  const card = content.cards[cardIndex] as GuideCard;
  if (!inRange(rowIndex, card.rows.length)) return content;
  const row = card.rows[rowIndex] as GuideRow;
  return patchRow(content, cardIndex, rowIndex, { key: !rowIsKeyCap(card, row) });
}
