/**
 * src/cms/app/guide/content.ts
 *
 * The guide's default copy.
 *
 * It lives apart from the component for one reason: the text is the thing
 * that will be edited, and editing a string in a list is safer than editing
 * JSX. Nothing here knows about React.
 *
 * This is the FALLBACK, not the source of truth. The guide is content now:
 * the CMS stores an edited copy, `loadGuideContent()` reads it, and this is
 * what the panel falls back to when that file is missing or invalid. Keep it
 * valid against `GuideContentSchema`; `default-guide.json` is generated from
 * it and the harness fails if the two drift.
 *
 * Rules for the copy: plain English, short, no marketing, written for the one
 * person who owns the site. Describe the tool that exists, not one that might.
 *
 * Keys are written in the schema's order (id, title, lead, rows, note, keys),
 * which is also the order the editor writes. That is what lets the harness
 * assert an exact round trip instead of a fuzzy one, and it keeps a one-word
 * edit from rewriting a whole block in the content file's diff.
 */

import { GUIDE_CONTENT_VERSION } from './schema.ts';
import type { GuideCard, GuideContent } from './schema.ts';

export const GUIDE_TITLE = 'How this works';
export const GUIDE_LEAD = 'Six things worth knowing before you start. Nothing here is required reading.';

export const GUIDE_CARDS: GuideCard[] = [
  {
    id: 'sections',
    title: 'The five sections',
    lead: 'The list on the left is the site. Pick a section, then an entry inside it.',
    rows: [
      { term: 'Home', text: 'The front page. One document, always there.' },
      { term: 'Projects', text: 'One document per project.' },
      { term: 'Essays', text: 'One document per piece of writing.' },
      { term: 'Filmography', text: 'YouTube films. One record each: link, title, kind, year, poster.' },
      { term: 'Photography', text: 'Albums. One record each: title, year, cover, and the photos in it.' },
    ],
  },
  {
    id: 'kinds',
    title: 'Documents and records',
    lead: 'Two editors, because there are two kinds of content.',
    rows: [
      {
        term: 'A document',
        text: 'Home, projects and essays. A stack of bands you arrange yourself, so every page can be laid out differently.',
      },
      {
        term: 'A record',
        text: 'Films and albums. A fixed set of fields plus media. No bands, no canvas, nothing to lay out.',
      },
    ],
  },
  {
    id: 'bands',
    title: 'Bands',
    lead: 'A document is a vertical stack of bands. Hover a gap in the outline on the left and press + text or + canvas to add one.',
    rows: [
      {
        term: 'Prose band',
        text: 'Text in normal flow: headings, paragraphs, quotes, lists, bold, italic, links and colour.',
      },
      {
        term: 'Canvas band',
        text: 'A free area with its own height. Images, video, embeds and shapes sit wherever you put them.',
      },
      {
        term: 'Overlay',
        text: 'A canvas band set to overlay takes no height of its own and sits on top of the band above it. That is how a photo ends up beside a paragraph instead of under it.',
      },
    ],
    note: 'Drag the grip to reorder a band. The first band cannot overlay; there is nothing above it.',
  },
  {
    id: 'canvas',
    title: 'Moving things on a canvas',
    rows: [
      { term: 'drag', text: 'Move the item.' },
      { term: 'corner', text: 'Resize from that corner. Hold shift to keep the ratio.' },
      { term: 'top handle', text: 'Rotate about the centre. Hold shift to snap to 15 degrees.' },
      { term: 'arrows', text: 'Nudge by 1px. With shift, 10px.' },
      { term: 'guides', text: 'Blue lines appear when an edge or a centre lines up with something else. Hold alt to ignore them.' },
      { term: 'shift-click', text: 'Add to or remove from the selection. Drag empty space for a marquee.' },
      { term: '[ and ]', text: 'Send backward, bring forward. Add cmd for all the way back or front.' },
      { term: 'esc', text: 'Abandon the drag you are in, then clear the selection.' },
    ],
    keys: true,
  },
  {
    id: 'publish',
    title: 'Draft and publish',
    rows: [
      {
        term: 'Save',
        text: 'Writes the draft. The draft is stored, but it is not on the live site and visitors cannot reach it. Cmd-S does the same thing.',
      },
      {
        term: 'Publish',
        text: 'Copies the draft over the live page. This is the only step that changes what the site shows.',
      },
      {
        term: 'Unsaved changes',
        text: 'The dot in the top bar. Amber means the last edit is still only in this browser.',
      },
    ],
  },
  {
    id: 'preview',
    title: 'Preview',
    lead: 'Preview saves the draft first, then opens the page drawn by the same renderer the live site uses. What you see is what publishing would give you.',
    rows: [
      { term: '1440', text: 'As designed. The width the layout is built against.' },
      { term: '1100', text: 'Narrow desktop.' },
      { term: '390', text: 'Phone. Below 900px the canvas stops positioning: items stack in order, full width, and overlay is ignored.' },
    ],
    note: 'Switching width does not reload the page, so you can flip between them quickly.',
    keys: true,
  },
];

/**
 * The whole default document, which is what the loader falls back to and what
 * `default-guide.json` is a copy of.
 */
export const DEFAULT_GUIDE_CONTENT: GuideContent = {
  version: GUIDE_CONTENT_VERSION,
  title: GUIDE_TITLE,
  lead: GUIDE_LEAD,
  cards: GUIDE_CARDS,
};
