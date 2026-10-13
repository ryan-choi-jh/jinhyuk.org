/**
 * src/cms/render/pages/project.ts
 *
 * A project page's masthead: the title, the date, the "Visit" row and the
 * italic standfirst.
 *
 * WHY THIS IS NOT `renderDocHead`. There are two mastheads on this site and
 * they are genuinely different objects. An essay's is `renderDocHead`'s
 * `.doc-visit`: a 15px row with a bold label, no rule, no arrow. A project's
 * is `.project-link`: 13px in the nav face, on a hairline underline, with an
 * arrow glyph. `src/pages/projects/[...slug].astro` said so and built its own
 * rather than flattening the two, and that judgement stands.
 *
 * WHY IT MOVED HERE ANYWAY. It was written out longhand in that Astro page,
 * which meant the editor had no way to draw it: the surface renders bands, and
 * the masthead was not a band. So a project opened in the CMS began at its
 * first paragraph, with the title, date, link and summary simply missing from
 * a pane whose job is to look like the page. One implementation, two callers:
 *
 *   src/pages/projects/[...slug].astro     the published page
 *   src/cms/app/shell/page-surface.tsx     the editing surface
 *
 * The markup is what the Astro page emitted, element for element and class for
 * class, so moving it changes no published byte.
 *
 * No DOM, no React, no Astro.
 */

import { formatLongDate } from '../../schema.ts';
import type { Doc } from '../../schema.ts';
import { attr, escapeText, safeUrl } from '../escape.ts';

/** "July 7, 2026", as `src/pages/projects/[...slug].astro` wrote it. */
export function formatProjectDate(date: string): string {
  // The implementation moved to the schema, which the editor can import and
  // this file cannot be: the Date field in the inspector now shows the same
  // string this prints, so the two cannot disagree about what a stored date
  // says. Kept as a named export because that is what this module's callers
  // and its tests ask for.
  return formatLongDate(date);
}

/** `habit-tracker-xi-gilt.vercel.app/welcome` — host and path, no scheme. */
export function prettyProjectUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return (url.hostname.replace(/^www\./, '') + url.pathname).replace(/\/$/, '');
  } catch {
    return raw;
  }
}

/** The arrow on the Visit row. */
const VISIT_ARROW =
  '<svg class="project-link-arrow" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M4.5 11.5 11.5 4.5M11.5 4.5H6M11.5 4.5V10" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>' +
  '</svg>';

export function renderProjectHead(doc: Doc): string {
  const { meta } = doc;

  // `safeUrl` rather than the raw string: this is the one field on a project
  // that becomes an href, and the editor will happily store whatever is typed.
  const href = meta.url === undefined ? null : safeUrl(meta.url);
  const visit =
    href === null
      ? ''
      : `<a class="project-link"${attr('href', href)} target="_blank" rel="noopener noreferrer">` +
        `<span class="project-link-label">${escapeText(meta.urlLabel ?? 'Visit')}</span>` +
        `<span class="project-link-url">${escapeText(prettyProjectUrl(meta.url as string))}</span>` +
        VISIT_ARROW +
        '</a>';

  const lead =
    meta.summary === undefined || meta.summary === ''
      ? ''
      : `<p class="lead project-lead">${escapeText(meta.summary)}</p>`;

  return (
    '<article class="project">' +
    `<h1>${escapeText(meta.title)}</h1>` +
    `<p class="post-meta">${escapeText(formatProjectDate(meta.date))}</p>` +
    visit +
    lead +
    '</article>'
  );
}
