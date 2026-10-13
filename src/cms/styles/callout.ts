/**
 * src/cms/styles/callout.ts
 *
 * The callout box, in one place.
 *
 * A callout is a paragraph set apart: a tinted box with a left edge, for the
 * aside that is not part of the argument but should not be missed either (a
 * link to a guide, a caveat, a note on where something came from).
 *
 * ---------------------------------------------------------------------------
 * WHY THE TONES ARE TOKENS AND NOT HEXES
 * ---------------------------------------------------------------------------
 *
 * A background has to answer to the theme. The light tints below would be a
 * glaring white-ish slab on the dark page, so every tone is a PAIR: a light
 * value and a dark one, switched by the same `[data-theme='dark']` the rest
 * of the site uses. Storing a hex on the block would freeze one of them.
 *
 * They are deliberately much lighter than the highlighter inks and the text
 * palette. Those colour a few words; this one sits behind a whole paragraph,
 * and at that size the same saturation would shout.
 *
 * Grey is the default, and is lighter than --muted (#6b6b6b, the resting nav
 * link) by a long way: it is a ground for text, not text.
 *
 * ---------------------------------------------------------------------------
 * ONE COPY
 * ---------------------------------------------------------------------------
 *
 * The published page gets these rules from doc.css, which carries a copy
 * between its CALLOUT markers because a stylesheet cannot import TypeScript;
 * cms:verify asserts the copy is byte-identical. The editor injects this
 * string directly. The editor's own selector is in here too, so a callout
 * looks the same in the CMS as it does on the page, which for a box whose
 * whole purpose is to look different from the text is the only thing that
 * matters.
 */

import { CALLOUT_TONES } from '../schema.ts';
import type { CalloutTone } from '../schema.ts';

/** Light ground, dark ground, and the edge that goes with each. */
type TonePalette = { light: string; lightEdge: string; dark: string; darkEdge: string };

export const CALLOUT_PALETTE: Readonly<Record<CalloutTone, TonePalette>> = {
  grey: { light: '#f4f4f4', lightEdge: '#d8d8d8', dark: '#1b1b1b', darkEdge: '#3a3a3a' },
  yellow: { light: '#fdf6e0', lightEdge: '#e8d79a', dark: '#241f10', darkEdge: '#4d421f' },
  blue: { light: '#eef5fc', lightEdge: '#bdd6ef', dark: '#141c25', darkEdge: '#2f4459' },
  green: { light: '#eef7ef', lightEdge: '#bedcc2', dark: '#141f16', darkEdge: '#2f4a35' },
  pink: { light: '#fdeef3', lightEdge: '#efbfd0', dark: '#241419', darkEdge: '#512f3c' },
};

const token = (tone: CalloutTone, which: 'bg' | 'edge'): string => `--callout-${tone}-${which}`;

function vars(mode: 'light' | 'dark'): string {
  return (CALLOUT_TONES as readonly CalloutTone[])
    .flatMap((tone) => {
      const palette = CALLOUT_PALETTE[tone];
      return [
        `  ${token(tone, 'bg')}: ${mode === 'light' ? palette.light : palette.dark};`,
        `  ${token(tone, 'edge')}: ${mode === 'light' ? palette.lightEdge : palette.darkEdge};`,
      ];
    })
    .join('\n');
}

function toneRules(): string {
  return (CALLOUT_TONES as readonly CalloutTone[])
    .flatMap((tone) => [
      `.doc-callout--${tone},`,
      `.pe-root[data-prose-kind='callout'][data-tone='${tone}'] .pe-content {`,
      `  background: var(${token(tone, 'bg')});`,
      `  border-left-color: var(${token(tone, 'edge')});`,
      '}',
      '',
    ])
    .join('\n');
}

export const CALLOUT_CSS = [
  ':root {',
  vars('light'),
  '}',
  '',
  ":root[data-theme='dark'] {",
  vars('dark'),
  '}',
  '',
  '/* The box. The editor selector is the same box around the live editor, so',
  '   a callout is a callout in both places. */',
  '.doc-callout,',
  ".pe-root[data-prose-kind='callout'] .pe-content {",
  '  /* The reading measure, like every other block of text in a document. */',
  '  max-width: min(var(--doc-measure, 720px), 100%);',
  '  margin: 28px 0;',
  '  padding: 16px 20px;',
  '  border-left: 3px solid var(--callout-grey-edge);',
  '  border-radius: 3px;',
  '  background: var(--callout-grey-bg);',
  '  color: var(--ink, #111111);',
  '  font-size: 16px;',
  '  line-height: 28px;',
  '  font-weight: 300;',
  '  letter-spacing: -0.01em;',
  '}',
  '',
  '/* Inside the box, spacing is the padding\'s job. The editor puts a real',
  '   paragraph in there and it arrives with a margin of its own, which made',
  '   the box 92px tall in the CMS against 60px on the page. */',
  '.doc-callout > :first-child,',
  ".pe-root[data-prose-kind='callout'] .pe-content > :first-child {",
  '  margin-top: 0;',
  '}',
  '',
  '.doc-callout > :last-child,',
  ".pe-root[data-prose-kind='callout'] .pe-content > :last-child {",
  '  margin-bottom: 0;',
  '}',
  '',
  '/* A callout opening a document. The masthead above it already leaves the',
  '   space a first block needs, and the box adds 16px of its own before its',
  '   text, so the lead-in read as nearly double a paragraph\'s. Pulling back',
  '   by exactly that padding puts the callout\'s TEXT where a paragraph\'s text',
  '   would have started. */',
  '.doc > .doc-group:first-child > .doc-band:first-child > .doc-callout:first-child {',
  '  margin-top: -16px;',
  '}',
  '',
  '/* A callout is usually one link, and it should look like one. */',
  '.doc-callout a {',
  '  color: inherit;',
  '  text-decoration: underline;',
  '  text-underline-offset: 3px;',
  '  text-decoration-thickness: 1px;',
  '  text-decoration-color: var(--callout-grey-edge);',
  '}',
  '',
  '.doc-callout a:hover {',
  '  text-decoration-color: var(--accent, #ff5722);',
  '}',
  '',
  toneRules().trimEnd(),
].join('\n');

export const CALLOUT_STYLE_ID = 'cms-callout';

/**
 * Put the rules in the document, once. The published page gets them from
 * doc.css; the editor, which does not load doc.css, gets them from here.
 */
export function injectCalloutStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(CALLOUT_STYLE_ID) !== null) return;
  const element = document.createElement('style');
  element.id = CALLOUT_STYLE_ID;
  element.textContent = CALLOUT_CSS;
  document.head.appendChild(element);
}
