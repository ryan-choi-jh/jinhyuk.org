import { config, fields, collection, singleton } from '@keystatic/core';

// Locally (npm run dev) Keystatic edits your files directly with no login.
// In production (on Vercel) it uses GitHub mode: you log in with GitHub and
// every save is committed to the repo, which triggers a Vercel rebuild.
const isDev = process.env.NODE_ENV !== 'production';

export default config({
  storage: isDev
    ? { kind: 'local' }
    : { kind: 'github', repo: 'ryan-choi-jh/personal-site' },

  ui: {
    brand: { name: 'Ryan Choi' },
  },

  collections: {
    writing: collection({
      label: 'Writing',
      slugField: 'title',
      // No trailing slash => each essay is a single file:
      // src/content/writing/<slug>.md  (matches the existing posts exactly).
      path: 'src/content/writing/*',
      format: { contentField: 'content' },
      entryLayout: 'content',
      columns: ['title', 'date'],
      schema: {
        // The readable name is stored as `title` in frontmatter; the URL slug
        // becomes the filename — same shape the site already uses.
        title: fields.slug({
          name: { label: 'Title' },
          slug: {
            label: 'URL slug',
            description: 'The address of the post, e.g. "whos-choosing".',
          },
        }),
        date: fields.date({
          label: 'Date',
          defaultValue: { kind: 'today' },
        }),
        draft: fields.checkbox({
          label: 'Draft',
          description:
            'Leave unchecked to publish. Check to hide it from the site while you work on it.',
          defaultValue: false,
        }),
        buttons: fields.array(
          fields.object({
            label: fields.text({ label: 'Button text' }),
            href: fields.text({
              label: 'Link',
              description: 'A full URL (https://…) or an internal path (/writing/…).',
            }),
          }),
          {
            label: 'Buttons',
            description: 'Optional buttons shown at the end of the essay.',
            itemLabel: (props) => props.fields.label.value || 'Button',
          }
        ),
        content: fields.markdoc({
          label: 'Content',
          // Keep writing plain .md so the existing Astro setup renders it unchanged.
          extension: 'md',
        }),
      },
    }),
  },

  singletons: {
    home: singleton({
      label: 'Home page',
      // No trailing slash => stored as a single file: src/content/home.yaml
      path: 'src/content/home',
      format: { data: 'yaml' },
      schema: {
        intro: fields.text({
          label: 'Intro',
          description:
            'The text at the top of your home page. Separate paragraphs with a blank line.',
          multiline: true,
        }),
        photo: fields.image({
          label: 'Photo',
          description: 'Upload straight from your phone — JPG, PNG or HEIC.',
          directory: 'public/home',
          publicPath: '/home/',
        }),
        photoAlt: fields.text({
          label: 'Photo description (alt text)',
          defaultValue: 'Ryan Choi',
        }),
      },
    }),
  },
});
