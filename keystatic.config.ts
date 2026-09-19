import { config, fields, collection, singleton } from '@keystatic/core';

// The editor runs locally only (`npm run dev` → http://localhost:4321/keystatic)
// and edits the files in src/content/ directly; commit + push to publish.
// This config is also imported at build time by the pages (via
// @keystatic/core/reader) to read that content, so keep the schema here in
// sync with what the pages expect.
export default config({
  storage: { kind: 'local' },

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

    projects: collection({
      label: 'Projects',
      slugField: 'title',
      // No trailing slash => each project is a single data file:
      // src/content/projects/<slug>.yaml
      path: 'src/content/projects/*',
      format: { data: 'yaml' },
      columns: ['title', 'date'],
      schema: {
        title: fields.slug({
          name: { label: 'Project name' },
          slug: {
            label: 'URL slug',
            description: 'The address of the project page, e.g. "offline".',
          },
        }),
        // Shown as a prominent link at the top of the project page.
        url: fields.url({
          label: 'Project URL',
          description:
            'The main link to the project (https://…). Shown at the top of the project page.',
        }),
        date: fields.date({
          label: 'Date',
          defaultValue: { kind: 'today' },
        }),
        summary: fields.text({
          label: 'Short description',
          description: 'One line shown on the Projects list.',
          multiline: true,
        }),
        draft: fields.checkbox({
          label: 'Draft',
          description:
            'Leave unchecked to publish. Check to hide it from the site while you work on it.',
          defaultValue: false,
        }),
        cover: fields.image({
          label: 'Cover image (optional)',
          description: 'Thumbnail shown next to this project on the list page.',
          directory: 'public/projects',
          publicPath: '/projects/',
        }),
        // The body is built from blocks you add in any order: text, images,
        // and videos (uploaded files or links like YouTube / Vimeo).
        blocks: fields.array(
          fields.conditional(
            fields.select({
              label: 'Block type',
              options: [
                { label: 'Text', value: 'text' },
                { label: 'Image', value: 'image' },
                { label: 'Video (upload a file)', value: 'videoFile' },
                { label: 'Video (paste a link)', value: 'videoLink' },
              ],
              defaultValue: 'text',
            }),
            {
              text: fields.text({
                label: 'Text',
                description: 'Separate paragraphs with a blank line.',
                multiline: true,
              }),
              image: fields.object({
                src: fields.image({
                  label: 'Image',
                  directory: 'public/projects',
                  publicPath: '/projects/',
                }),
                alt: fields.text({
                  label: 'Description (alt text)',
                  description: 'Describes the image for screen readers.',
                }),
                caption: fields.text({ label: 'Caption (optional)' }),
              }),
              videoFile: fields.object({
                file: fields.file({
                  label: 'Video file',
                  description:
                    'Upload a short clip (MP4 or WebM). Keep clips small — large files bloat the site.',
                  directory: 'public/projects',
                  publicPath: '/projects/',
                }),
                caption: fields.text({ label: 'Caption (optional)' }),
              }),
              videoLink: fields.object({
                url: fields.url({
                  label: 'Video link',
                  description:
                    'Paste a YouTube or Vimeo link, or a direct link to an MP4/WebM file.',
                }),
                caption: fields.text({ label: 'Caption (optional)' }),
              }),
            }
          ),
          {
            label: 'Content blocks',
            description:
              'Build the project page by adding blocks in order — text, images, and videos.',
            itemLabel: (props) => {
              const kind = props.discriminant;
              if (kind === 'text') return 'Text';
              if (kind === 'image') return 'Image';
              if (kind === 'videoFile') return 'Video (file)';
              if (kind === 'videoLink') return 'Video (link)';
              return 'Block';
            },
          }
        ),
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
