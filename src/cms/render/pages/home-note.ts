/**
 * src/cms/render/pages/home-note.ts
 *
 * The 원고지 note: the homepage explaining its own grid, once.
 *
 * Most visitors do not know what the grid behind the drawings is. On a first
 * visit the drawings step back, 원 · 고 · 지 is written into three of the
 * grid's own squares in red pen, and three short paragraphs say what the paper
 * is and why the site sits on it. When the note closes, those three squares
 * shrink and fly into a small replay button under the sheet, so the way back
 * in is the thing the visitor just watched leave. The handoff, with every
 * value and the reasons for them, is docs/wongoji-note.md; the design is the
 * Paper file "Personal Site", page "Homepage", artboards "원고지 note · 1-4".
 *
 * This module is the MARKUP and the COPY, and nothing else. The behaviour is
 * src/cms/render/home-note-player.ts, which runs in the browser only.
 *
 * Everything here is rendered with the `hidden` attribute, and only the
 * player takes it off. That is load-bearing rather than tidy:
 *
 *  - The editor previews the homepage through this same renderer and never
 *    runs the player, so the preview must look exactly as it did before the
 *    note existed. A stylesheet cannot be relied on for that, because the
 *    editor's own surface does not load global.css; `hidden` needs none.
 *  - With no script at all there is nothing to replay and nothing to close,
 *    so there is no button and no note either.
 *
 * The note is rendered ONCE, inside `.hero`, in a layer over the grid. On a
 * phone (and any window the lightbox treats as one) the player moves that same
 * element into `.note-caption` under the sheet instead, because the grid's
 * squares are about twelve pixels there and nothing fits in them. One copy
 * means one id for `aria-labelledby` and one set of words to keep right.
 *
 * The copy is Ryan's, final, and deliberately here rather than in home.json:
 * making it editable in the CMS would mean a schema change, which the handoff
 * puts out of scope. No em dashes, by request.
 *
 * No DOM, no React, no Astro.
 */

import { attr, escapeText } from '../escape.ts';

/* -------------------------------------------------------------------------- */
/* Copy                                                                       */
/* -------------------------------------------------------------------------- */

/** The three syllables, one to a square, written in the order they are read. */
export const NOTE_SYLLABLES = ['원', '고', '지'] as const;

/** How the heading is said, beside the squares. */
export const NOTE_ROMANISED = 'won-go-ji';

/**
 * The paragraphs, as runs so the one italic word can be marked up without
 * writing HTML into a string. `ko` runs are tagged `lang="ko"`, so a screen
 * reader reading an English page says 원고 in Korean rather than spelling it.
 */
type Run = string | { em: string } | { ko: string };

export const NOTE_PARAGRAPHS: readonly (readonly Run[])[] = [
  ['Korean manuscript paper. One syllable to a square, spaces included.'],
  [
    'I learned to write on these as a kid, filling page after page with diary entries. ' +
      'The early ones were mostly drawings. Eventually, the words took over.',
  ],
  [
    { ko: '원고' },
    ' (won-go) means ',
    // The period sits inside the <em>, as it does in Paper: italic Inter's
    // full stop next to an upright one reads as a stray mark.
    { em: 'draft.' },
    ' It felt like a fitting place to begin: a life still being written, one square at a time, ' +
      'with plenty of room for what comes next.',
  ],
];

/** Visible text; the stylesheet sets it in capitals. Kept in sentence case so
 *  a screen reader says the word rather than spelling the letters. */
export const NOTE_CLOSE_LABEL = 'Close';
export const NOTE_REPLAY_LABEL = 'What is this grid?';

/* -------------------------------------------------------------------------- */
/* Which pieces stay in colour                                                */
/* -------------------------------------------------------------------------- */

/**
 * While the note is up, the grid fades to 0.38 and every drawing to 0.10 in
 * grey, except these four: the toddler with the golf club and 최 · 진 · 혁 in
 * brush, which are the subject of the page and stay in full colour.
 *
 * These are item ids from src/content/pages/home.json, the author's own. If
 * one is renamed in the CMS, that piece simply steps back with the others,
 * which is the right way for this to fail. The GRID is not named here: it is
 * the piece at the back, found the same way `heroLabel` finds it.
 */
export const NOTE_KEEP_IDS: readonly string[] = [
  'i_01_first_swing',
  'i_brush_choi',
  'i_brush_jin',
  'i_brush_hyeok',
];

/** What a piece does while the note is up. */
export type NoteRole = 'ground' | 'keep' | 'step-back';

export function noteRoleOf(itemId: string, isGround: boolean): NoteRole {
  if (isGround) return 'ground';
  return NOTE_KEEP_IDS.includes(itemId) ? 'keep' : 'step-back';
}

/* -------------------------------------------------------------------------- */
/* Markup                                                                     */
/* -------------------------------------------------------------------------- */

/** The id the aside is labelled by, and that the player looks up. */
export const NOTE_TITLE_ID = 'wongoji-note-title';

/**
 * The close mark, the lightbox's path at Paper's 2px stroke (the lightbox's
 * own is 1.8 at 18px; at 10px that reads as hairline).
 */
const NOTE_CLOSE_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path d="M3 3l10 10M13 3L3 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />' +
  '</svg>';

function renderRun(run: Run): string {
  if (typeof run === 'string') return escapeText(run);
  if ('em' in run) return `<em>${escapeText(run.em)}</em>`;
  return `<span lang="ko">${escapeText(run.ko)}</span>`;
}

/**
 * Three squares with a syllable in each.
 *
 * The glyph sits in its own span because that is what is written on: the
 * player's stylesheet reveals it left to right with a clip-path, and the
 * square around it has to stay put while it does.
 */
function cells(cellClass: string, glyphClass: string): string {
  return NOTE_SYLLABLES.map(
    (syllable) =>
      `<span class="${cellClass}"><span class="${glyphClass}">${escapeText(syllable)}</span></span>`,
  ).join('');
}

/**
 * The note itself. An `<aside>` with real text, labelled by its heading, so it
 * is a landmark a screen reader can find and read, unlike anything inside the
 * illustration's `role="img"`.
 *
 * `tabindex="-1"` is for the replay: a keyboard user who presses the replay
 * button watches it disappear, and focus has to land somewhere that is not the
 * top of the page. It is never focused when the note plays by itself.
 */
export function renderNote(): string {
  const paragraphs = NOTE_PARAGRAPHS.map((runs) => `<p>${runs.map(renderRun).join('')}</p>`).join('');
  return (
    `<aside class="note" tabindex="-1"${attr('aria-labelledby', NOTE_TITLE_ID)}>` +
    `<p class="note-head"${attr('id', NOTE_TITLE_ID)}>` +
    // The squares are a drawing of one word. Each is its own box, so a
    // browser names them "원 고 지", three syllables (measured, in Chrome's
    // tree); the word is said once, by the text beside them that only
    // assistive technology reads.
    `<span class="note-cells" lang="ko" aria-hidden="true">${cells('note-cell', 'note-glyph')}</span>` +
    `<span class="note-said" lang="ko">${escapeText(NOTE_SYLLABLES.join(''))}</span> ` +
    `<span class="note-roman">${escapeText(NOTE_ROMANISED)}</span>` +
    '</p>' +
    `<div class="note-body">${paragraphs}</div>` +
    '<div class="note-foot">' +
    `<button class="note-close" type="button"><span>${escapeText(NOTE_CLOSE_LABEL)}</span>${NOTE_CLOSE_SVG}</button>` +
    // The hold timer: a red pen line that un-draws over the twelve seconds
    // the note stays up. Decoration, so it is hidden from assistive tech;
    // the note does not close on someone who is reading it (the player
    // pauses it on hover and on focus).
    '<span class="note-timer" aria-hidden="true"><span class="note-timer-bar"></span></span>' +
    '</div>' +
    '</aside>'
  );
}

/**
 * The layer the note sits in over the grid. A sibling of `.hero-open`, not a
 * child of `.hero-stage`, for two reasons:
 *
 *  - the stage carries `role="img"`, and nothing inside an image should be
 *    text a reader is meant to reach;
 *  - the lightbox reuses the stage markup (`renderHeroLightbox`), and the note
 *    must not be enlarged along with the drawings.
 *
 * It covers the stage exactly and is its own inline-size container, so the
 * note is positioned in `cqw` against the same width the pieces are, and its
 * squares stay locked onto the grid's at every window width.
 */
export function renderNoteLayer(): string {
  return `<div class="note-layer" hidden>${renderNote()}</div>`;
}

/**
 * Where the note goes on a phone: under the sheet, in place of the hint row.
 * Empty until the player moves the note into it. The outer box animates its
 * height from 0 (`grid-template-rows: 0fr` to `1fr`), the inner one clips.
 */
export function renderNoteCaption(): string {
  return '<div class="note-caption" hidden><div class="note-caption-inner"></div></div>';
}

/**
 * The replay button: three small squares with 원고지 in them and the question
 * the note answers. Hidden until the player shows it, which on a first visit
 * is the moment the note's own heading lands in it.
 *
 * The squares are `aria-hidden`: the button's name is its question, and
 * "원고지 What is this grid?" would be read as a stranger sentence than either.
 */
export function renderNoteReplay(): string {
  return (
    '<button class="note-replay" type="button" hidden>' +
    `<span class="note-replay-cells" lang="ko" aria-hidden="true">${cells('note-replay-cell', 'note-replay-glyph')}</span>` +
    `<span class="note-replay-label">${escapeText(NOTE_REPLAY_LABEL)}</span>` +
    '</button>'
  );
}

/** The 1px rule between "TAP THE GRID TO ENLARGE" and the replay button on a
 *  phone. Shown and hidden with the button. */
export function renderNoteRule(): string {
  return '<span class="hero-hint-rule" aria-hidden="true" hidden></span>';
}
