import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Each Markdown file in src/content/writing/ becomes a published essay.
const writing = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/writing' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    // Set to true to keep a post unpublished while you draft it.
    draft: z.boolean().optional().default(false),
  }),
});

export const collections = { writing };
