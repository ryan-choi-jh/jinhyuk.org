/**
 * src/cms/preflight.ts
 *
 * What is worth knowing before a page goes live.
 *
 * Publishing validated the schema and nothing else, and the schema is about
 * what the renderer can draw, not about whether a page is finished. The gap
 * between those two is where this lives: seven of the thirty-two published
 * images on the site have no alt text, all of them on one project page, and
 * the field has been sitting in the inspector the whole time with nothing
 * ever mentioning it.
 *
 * WARNINGS, NEVER BLOCKS. Every one of these is something a person might do
 * deliberately, and a CMS that refuses to publish because a decorative
 * image has no alt text is a CMS people learn to fight. Publishing anyway is
 * one more click, and the list is there so the choice is made rather than
 * missed.
 *
 * Pure: a Doc in, findings out. No React, no DOM, no network, so the check
 * at `verify-preflight.ts` can run it under bare node and the editor can
 * call it on every render without thinking about cost.
 */

import { isCanvasBand, isProseBand } from './schema.ts';
import type { Doc, ProseBlock } from './schema.ts';
import { headingSlug } from './render/prose.ts';

/**
 * `warn` is worth a look; `note` is information. Nothing here is an error,
 * because an error would imply the publish should stop, and it should not.
 */
export type PreflightLevel = 'warn' | 'note';

export type Finding = {
  level: PreflightLevel;
  /** Short enough for a list item. */
  message: string;
  /** Where to send someone who clicks it, when there is one thing to blame. */
  bandId?: string;
  blockId?: string;
  itemId?: string;
};

/** The plain text of a block, for deciding whether it is empty. */
function textOf(block: ProseBlock): string {
  const out: string[] = [];
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const raw of nodes) {
      if (raw === null || typeof raw !== 'object') continue;
      const node = raw as { text?: unknown; content?: unknown };
      if (typeof node.text === 'string') out.push(node.text);
      walk(node.content);
    }
  };
  walk(block.content);
  return out.join('').trim();
}

/**
 * An href that cannot work once the page is live.
 *
 * `/cms/...` is the editor, which readers cannot reach. A bare `#` goes
 * nowhere. Everything else, including an off-site link that happens to be
 * dead today, is not something this can know about.
 */
function brokenHref(href: string): string | null {
  if (href === '#') return 'a link to "#", which goes nowhere';
  if (href.startsWith('/cms/') || href === '/cms') {
    return `a link to ${href}, which is the editor and not a page a reader can open`;
  }
  if (href.startsWith('/api/')) return `a link to ${href}, which is an API route`;
  return null;
}

/** Every link href in a block's content. */
function hrefsIn(block: ProseBlock): string[] {
  const found: string[] = [];
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const raw of nodes) {
      if (raw === null || typeof raw !== 'object') continue;
      const node = raw as { marks?: unknown; content?: unknown };
      if (Array.isArray(node.marks)) {
        for (const mark of node.marks) {
          if (mark === null || typeof mark !== 'object') continue;
          const m = mark as { type?: unknown; attrs?: { href?: unknown } };
          if (m.type === 'link' && typeof m.attrs?.href === 'string') found.push(m.attrs.href);
        }
      }
      walk(node.content);
    }
  };
  walk(block.content);
  return found;
}

/**
 * Everything worth saying about this document before it is published, most
 * important first.
 */
export function preflight(doc: Doc): Finding[] {
  const findings: Finding[] = [];

  /* ---- images with nothing for a screen reader to read ------------------ */
  for (const band of doc.bands) {
    if (!isCanvasBand(band)) continue;
    for (const item of band.items) {
      if (item.kind !== 'image') continue;
      if (item.alt !== undefined && item.alt.trim() !== '') continue;
      // Name it by its caption where it has one, so a page with seven of
      // these is seven distinguishable lines rather than the same sentence
      // seven times. An EMPTY caption is not a name: `(“”)` is worse than
      // nothing.
      const named = item.caption !== undefined && item.caption.trim() !== '';
      findings.push({
        level: 'warn',
        message: `An image has no alt text${named ? ` (“${item.caption!.trim()}”)` : ''}. A screen reader will skip it.`,
        bandId: band.id,
        itemId: item.id,
      });
    }
  }

  /* ---- empty rows, and what they actually do ---------------------------- */
  let emptyRows = 0;
  for (const band of doc.bands) {
    if (!isProseBand(band)) continue;
    for (const block of band.blocks) if (textOf(block) === '') emptyRows += 1;
  }
  if (emptyRows > 0) {
    findings.push({
      level: 'note',
      message:
        `${emptyRows} empty row${emptyRows === 1 ? '' : 's'} in this page. ` +
        'An empty row is a full line in the editor and nothing at all on the page, because its ' +
        'margins collapse into its neighbours’. Use “Space above” on a block to ask for room.',
    });
  }

  /* ---- headings nobody can link to -------------------------------------- */
  for (const band of doc.bands) {
    if (!isProseBand(band)) continue;
    for (const block of band.blocks) {
      if (block.kind !== 'h2' && block.kind !== 'h3') continue;
      const text = textOf(block);
      if (text !== '' && headingSlug(text) !== '') continue;
      findings.push({
        level: text === '' ? 'warn' : 'note',
        message:
          text === ''
            ? 'A heading with no text in it. A screen reader announces it as “heading, blank”.'
            : `The heading “${text}” has no letters or digits to make a link out of, so it falls back to its block id.`,
        bandId: band.id,
        blockId: block.id,
      });
    }
  }

  /* ---- links that cannot work once it is live --------------------------- */
  for (const band of doc.bands) {
    if (!isProseBand(band)) continue;
    for (const block of band.blocks) {
      for (const href of hrefsIn(block)) {
        const trouble = brokenHref(href);
        if (trouble === null) continue;
        findings.push({ level: 'warn', message: trouble, bandId: band.id, blockId: block.id });
      }
    }
  }
  for (const button of doc.meta.buttons ?? []) {
    const trouble = brokenHref(button.href);
    if (trouble !== null) {
      findings.push({ level: 'warn', message: `The “${button.label}” button is ${trouble}.` });
    }
  }

  /* ---- a page with nothing on it ---------------------------------------- */
  const hasContent = doc.bands.some((band) =>
    isProseBand(band) ? band.blocks.some((block) => textOf(block) !== '') : band.items.length > 0,
  );
  if (!hasContent) {
    findings.push({ level: 'warn', message: 'This page has no content on it yet.' });
  }

  // Warnings above notes, order preserved within each.
  return [...findings.filter((f) => f.level === 'warn'), ...findings.filter((f) => f.level === 'note')];
}

/** One line for a button, or null when there is nothing to say. */
export function preflightSummary(findings: Finding[]): string | null {
  if (findings.length === 0) return null;
  const warn = findings.filter((f) => f.level === 'warn').length;
  if (warn === 0) return `${findings.length} thing${findings.length === 1 ? '' : 's'} to know`;
  return `${warn} thing${warn === 1 ? '' : 's'} worth a look`;
}
