/**
 * src/lib/site-content.ts
 *
 * WS-11 CUTOVER. Where the published site gets its content.
 *
 * Everything under `src/pages/` reads through this file, and this file reads
 * the CMS's own JSON and nothing else:
 *
 *   src/content/pages/home.json                 the homepage          Doc
 *   src/content/pages/essays/<slug>.json        an essay              Doc
 *   src/content/pages/projects/<slug>.json      a project page        Doc
 *   src/content/data/filmography.json           the films             { films }
 *   src/content/data/photography.json           the albums            { albums }
 *   src/content/data/site.json                  the nav and footer    SiteChrome
 *
 * The five sources it replaces — `src/content/home.yaml`,
 * `src/content/writing/*.md`, the `.mdoc` files behind the Keystatic reader,
 * `src/data/filmography.ts` and `src/data/photography.ts` — are still in the
 * working tree, unreferenced, as a safety net. Nothing here looks at them.
 *
 * Three decisions worth knowing about:
 *
 *  1. `import.meta.glob`, not `node:fs`. The JSON is inlined by Vite at build
 *     time, so the content travels with the bundle. A filesystem read would
 *     work in the static GitHub Pages build and quietly fail in the Vercel
 *     editor build (`PUBLIC_EDITOR_BUILD=1`), where a page is rendered on
 *     demand in a serverless function that has no `src/` directory.
 *
 *  2. Invalid content fails the build, loudly. The alternative — skipping the
 *     file — publishes a site with an essay silently missing from it, which is
 *     worse than a red build. This is also what the site does today: a
 *     frontmatter field that does not match `src/content.config.ts` fails
 *     `astro build` already.
 *
 *  3. The file name is the URL. `meta.slug` is checked against it, because a
 *     document whose slug disagrees with its file name would be listed on the
 *     index at one address and built at another.
 *
 * Shapes are drawn by WS-6's generator, installed by the side-effect import
 * below. `renderDoc` falls back to its own built-in shapes without it, so this
 * is about which squiggle gets drawn, not about whether the page renders.
 */

import '../cms/render/with-shape-assets.ts';

import {
  formatIssues,
  validateDoc,
  validateFilmography,
  validatePhotography,
  validateSiteChrome,
} from '../cms/schema.ts';
import type { Album, Doc, DocMeta, Film, SiteChrome } from '../cms/schema.ts';
import { contentDirFor, requireSection, slugFromFilename } from '../cms/sections.ts';

import homeJson from '../content/pages/home.json';
import filmographyJson from '../content/data/filmography.json';
import photographyJson from '../content/data/photography.json';
import siteJson from '../content/data/site.json';

/* -------------------------------------------------------------------------- */
/* The globs                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Vite's glob takes an inline literal and nothing else — not a constant, not a
 * template — so the two collection directories are spelled out twice: once in
 * the pattern, once in the assertion below that checks them against the
 * registry. If a section ever moves, `src/cms/sections.ts` is the source of
 * truth and this file is the bug, so it says so at build time instead of
 * silently building an empty index.
 */
const essayFiles: Record<string, unknown> = import.meta.glob(
  '../content/pages/essays/*.json',
  { eager: true, import: 'default' },
);

const projectFiles: Record<string, unknown> = import.meta.glob(
  '../content/pages/projects/*.json',
  { eager: true, import: 'default' },
);

for (const [id, globbed] of [
  ['essays', 'src/content/pages/essays'],
  ['projects', 'src/content/pages/projects'],
] as const) {
  const expected = contentDirFor(requireSection(id));
  if (globbed !== expected) {
    throw new Error(
      `src/lib/site-content.ts globs "${globbed}" for ${id}, but ` +
        `src/cms/sections.ts says its content lives in "${expected}".`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function asDoc(source: string, value: unknown): Doc {
  const result = validateDoc(value);
  if (!result.ok) {
    throw new Error(`${source} is not a valid document:\n${formatIssues(result.issues)}`);
  }
  return result.doc;
}

/**
 * One collection of documents, in file-name order. Order does not matter for
 * `getStaticPaths`, and the index pages sort by date themselves
 * (`ledgerItemsFromMetas`), so a stable sort here is only so a build is
 * reproducible.
 */
function docsFrom(files: Record<string, unknown>, section: string): Doc[] {
  const docs: Doc[] = [];
  for (const path of Object.keys(files).sort()) {
    const file = path.slice(path.lastIndexOf('/') + 1);
    const slug = slugFromFilename(file);
    if (slug === null) continue;
    const doc = asDoc(path, files[path]);
    if (doc.meta.slug !== slug) {
      throw new Error(
        `${path}: meta.slug is "${doc.meta.slug}" but the file is named "${file}". ` +
          'The file name is the address, so the two have to agree.',
      );
    }
    if (doc.meta.section !== undefined && doc.meta.section !== section) {
      throw new Error(
        `${path}: meta.section is "${doc.meta.section}" but the file is in ${section}.`,
      );
    }
    docs.push(doc);
  }
  return docs;
}

/* -------------------------------------------------------------------------- */
/* Documents                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The homepage.
 *
 * `meta.section` has to be `'home'`: `renderDoc` dispatches on it to build the
 * site's own `.hero` and `.intro` instead of a generic band stack, so a
 * document without it would render the illustration as a bordered canvas item.
 */
export const homeDoc = (): Doc => {
  const doc = asDoc('src/content/pages/home.json', homeJson);
  if (doc.meta.section !== 'home') {
    throw new Error(
      'src/content/pages/home.json must carry meta.section: "home", or the homepage ' +
        'renders as a generic document instead of the hero and the intro.',
    );
  }
  return doc;
};

let essayCache: Doc[] | null = null;
export const essayDocs = (): Doc[] => (essayCache ??= docsFrom(essayFiles, 'essays'));

let projectCache: Doc[] | null = null;
export const projectDocs = (): Doc[] => (projectCache ??= docsFrom(projectFiles, 'projects'));

/** Just the metadata, which is all an index page needs. */
export const essayMetas = (): DocMeta[] => essayDocs().map((doc) => doc.meta);
export const projectMetas = (): DocMeta[] => projectDocs().map((doc) => doc.meta);

/* -------------------------------------------------------------------------- */
/* Records                                                                    */
/* -------------------------------------------------------------------------- */

export const films = (): Film[] => {
  const result = validateFilmography(filmographyJson);
  if (!result.ok) {
    throw new Error(
      `src/content/data/filmography.json is not a valid collection:\n${formatIssues(result.issues)}`,
    );
  }
  return result.data.films;
};

export const albums = (): Album[] => {
  const result = validatePhotography(photographyJson);
  if (!result.ok) {
    throw new Error(
      `src/content/data/photography.json is not a valid collection:\n${formatIssues(result.issues)}`,
    );
  }
  return result.data.albums;
};

/* -------------------------------------------------------------------------- */
/* The chrome                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The nav bar and the footer, for `src/layouts/Base.astro` and
 * `src/components/SocialLinks.astro` — the two files that draw them.
 *
 * Every page of the site goes through the layout, so this one JSON file is the
 * nav and the footer everywhere: editing it moves all of them at once, which is
 * the whole point of it being content rather than markup.
 *
 * The copyright line is stored with a literal `{year}` token in it and the year
 * is substituted at render time by `renderCopyright` from the schema. Do not
 * bake a year into the JSON, or it freezes on the day it was typed.
 *
 * Invalid content fails the build, loudly, for the same reason as a document:
 * a site that silently renders no nav is worse than a red build.
 */
export const siteChrome = (): SiteChrome => {
  const result = validateSiteChrome(siteJson);
  if (!result.ok) {
    throw new Error(
      `src/content/data/site.json is not a valid site chrome:\n${formatIssues(result.issues)}`,
    );
  }
  return result.data;
};
