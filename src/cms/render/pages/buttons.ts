/**
 * src/cms/render/pages/buttons.ts
 *
 * WS-B. The end-of-document call to action: `Doc.meta.buttons`.
 *
 * The live essays already carry exactly this in their frontmatter and render it
 * through `src/pages/essays/[...slug].astro`:
 *
 *   <div class="essay-buttons">
 *     <a class="button" href="mailto:…">Coffee on me ☕️</a>
 *   </div>
 *
 * So the markup here is that markup, with one extra class on each element.
 * `.essay-buttons` and `.button` are what global.css already styles, which is
 * what keeps the page looking the same; `.doc-buttons` and `.doc-button` are
 * what `src/cms/styles/doc.css` hangs the two things global.css cannot know
 * about on — the reading measure (the rule above the buttons has to stop at
 * 720px, not run the full canvas width) and the link underline that `.doc a`
 * would otherwise paint under a button.
 *
 * Any document may carry buttons (contracts 10.3), not only an essay, so this
 * is not essay-specific code; the class name is historical.
 *
 * No DOM, no React, no Astro.
 */

import type { Doc, DocButton } from '../../schema.ts';
import { attr, escapeText, joinParts, safeUrl } from '../escape.ts';

/**
 * External means a new tab, which is what the live page does. `mailto:` is not
 * external by this test and must not be: `target="_blank"` on a mail link
 * opens, and leaves behind, a blank tab.
 */
function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/**
 * One button. A button with no usable href is dropped entirely rather than
 * rendered as dead furniture: `safeUrl` rejects `javascript:` and friends, and
 * an end-of-post call to action that cannot be called is worse than nothing.
 */
function renderButton(button: DocButton): string {
  const href = safeUrl(button.href);
  if (href === null) return '';
  const external = isExternal(href);
  return (
    `<a class="button doc-button"${attr('href', href)}` +
    (external ? ' target="_blank" rel="noopener noreferrer"' : '') +
    `>${escapeText(button.label)}</a>`
  );
}

/**
 * The whole block, or '' when the document has no buttons. '' and not an empty
 * container: `.essay-buttons` carries a top rule, and a rule with nothing under
 * it reads as a mistake.
 */
export function renderDocButtons(doc: Doc): string {
  const buttons = doc.meta.buttons ?? [];
  if (buttons.length === 0) return '';
  const links = joinParts(buttons.map(renderButton));
  if (links === '') return '';
  return `<div class="essay-buttons doc-buttons">${links}</div>`;
}
