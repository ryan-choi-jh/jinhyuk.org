/**
 * src/content.config.ts
 *
 * No content collections. Deliberately, and this file has to exist to say so.
 *
 * It used to define a `writing` collection over `src/content/writing/*.md`,
 * which Keystatic edited and the site rendered. The cutover moved every page
 * to `src/content/pages/**.json`, read through `src/lib/site-content.ts` with
 * `import.meta.glob` and validated against `src/cms/schema.ts`; Keystatic and
 * the collection outlived it by months, editing files nothing read.
 *
 * Why keep the file at all: without it Astro also warns, per folder, that it
 * found no markdown to load, which is three more lines of noise about files
 * that are deliberately JSON.
 *
 * It does NOT silence the "auto-generating collections" deprecation notice
 * at startup. Astro emits that for any folder under `src/content/` with no
 * collection declared, and this project declares none on purpose, so the
 * notice lists `data, pages, projects, writing` every time `astro dev`
 * starts. It was already doing that for three of the four before the
 * `writing` collection went. Harmless, dev only, and the alternative is
 * declaring four collections nothing reads.
 */
import type { CollectionConfig } from 'astro:content';

export const collections: Record<string, CollectionConfig> = {};
