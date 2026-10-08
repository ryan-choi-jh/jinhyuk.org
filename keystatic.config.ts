import { config, fields, collection, singleton } from '@keystatic/core';

// The editor runs locally only (`npm run dev` → http://localhost:4321/keystatic)
// and edits the files in src/content/ directly; commit + push to publish.
// This config is also imported at build time by the pages (via
// @keystatic/core/reader) to read that content, so keep the schema here in
// sync with what the pages expect.
// Local storage when you're editing on your own machine; GitHub storage for
// the editor deployed to Vercel, which has no filesystem to write to and
// commits straight to the repo instead. The Pages build keeps the local
// reader either way, because it has the repo checked out.
//
// This has to be import.meta.env with a PUBLIC_ prefix, not process.env:
// Keystatic's admin UI is a browser bundle that imports this file, and
// process.env doesn't exist there — it would silently fall back to local
// storage and the editor would look fine while writing nowhere useful.
const isEditorDeploy = import.meta.env.PUBLIC_EDITOR_BUILD === '1';

export default config({
  storage: isEditorDeploy
    ? { kind: 'github', repo: { owner: 'ryan-choi-jh', name: 'jinhyuk.org' } }
    : { kind: 'local' },

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
        // The body is a list of blocks you add in any order. Everything
        // visual is the one Media block — you set how many items it has,
        // how they lay out, how wide they are and how they're captioned,
        // rather than picking from fixed presets.
        blocks: fields.array(
          fields.conditional(
            fields.select({
              label: 'Block type',
              options: [
                { label: 'Text', value: 'text' },
                { label: 'Heading', value: 'heading' },
                { label: 'Pull quote', value: 'quote' },
                { label: 'Media — images and videos', value: 'media' },
                { label: 'Text beside media', value: 'textMedia' },
              ],
              defaultValue: 'text',
            }),
            {
              text: fields.text({
                label: 'Text',
                description: 'Separate paragraphs with a blank line.',
                multiline: true,
              }),

              heading: fields.text({ label: 'Heading' }),

              quote: fields.text({
                label: 'Quote',
                description: 'Set bigger, with a rule down the side.',
                multiline: true,
              }),

              media: fields.object({
                items: fields.array(
                  fields.object({
                    source: fields.conditional(
                      fields.select({
                        label: 'Type',
                        options: [
                          { label: 'Image', value: 'image' },
                          { label: 'Video file', value: 'videoFile' },
                          { label: 'Video link', value: 'videoLink' },
                        ],
                        defaultValue: 'image',
                      }),
                      {
                        image: fields.image({
                          label: 'Image',
                          directory: 'public/projects',
                          publicPath: '/projects/',
                        }),
                        videoFile: fields.file({
                          label: 'Video file',
                          description: 'MP4 or WebM. Keep clips small.',
                          directory: 'public/projects',
                          publicPath: '/projects/',
                        }),
                        videoLink: fields.url({
                          label: 'Video link',
                          description: 'A YouTube or Vimeo link.',
                        }),
                      }
                    ),
                    alt: fields.text({
                      label: 'Description (alt text)',
                      description: 'Describes it for screen readers.',
                    }),
                    caption: fields.text({ label: 'Caption for this item' }),
                  }),
                  {
                    label: 'Items',
                    description: 'Add as many as you like.',
                    itemLabel: (props) => props.fields.caption.value || 'Item',
                  }
                ),
                layout: fields.select({
                  label: 'Layout',
                  options: [
                    { label: 'Row — side by side', value: 'row' },
                    { label: 'Grid — two per line', value: 'grid2' },
                    { label: 'Stacked — one above the other', value: 'stack' },
                  ],
                  defaultValue: 'row',
                }),
                width: fields.select({
                label: 'Width',
                description: 'How far across the page this sits.',
                options: [
                  { label: 'Text column', value: 'text' },
                  { label: 'Wide', value: 'wide' },
                  { label: 'Full width', value: 'full' },
                ],
                defaultValue: 'wide',
              }),
                align: fields.select({
                  label: 'Alignment',
                  options: [
                    { label: 'Centred', value: 'center' },
                    { label: 'Left', value: 'left' },
                  ],
                  defaultValue: 'center',
                }),
                tall: fields.checkbox({
                  label: 'These are phone screenshots',
                  description:
                    'Caps their height so a portrait screenshot does not take over the page.',
                  defaultValue: false,
                }),
                caption: fields.text({
                  label: 'Caption for the whole group',
                  description: 'Leave empty to use the per-item captions instead.',
                }),
              }),

              textMedia: fields.object({
                text: fields.text({
                  label: 'Text',
                  description: 'Separate paragraphs with a blank line.',
                  multiline: true,
                }),
                image: fields.image({
                  label: 'Image',
                  directory: 'public/projects',
                  publicPath: '/projects/',
                }),
                alt: fields.text({ label: 'Description (alt text)' }),
                caption: fields.text({ label: 'Caption' }),
                side: fields.select({
                  label: 'Media sits on the',
                  options: [
                    { label: 'Right', value: 'right' },
                    { label: 'Left', value: 'left' },
                  ],
                  defaultValue: 'right',
                }),
                split: fields.select({
                  label: 'Split',
                  options: [
                    { label: '50 / 50', value: '50' },
                    { label: '40 / 60 — more room for text', value: '40' },
                    { label: '60 / 40 — more room for media', value: '60' },
                  ],
                  defaultValue: '50',
                }),
                width: fields.select({
                label: 'Width',
                description: 'How far across the page this sits.',
                options: [
                  { label: 'Text column', value: 'text' },
                  { label: 'Wide', value: 'wide' },
                  { label: 'Full width', value: 'full' },
                ],
                defaultValue: 'wide',
              }),
              }),
            }
          ),
          {
            label: 'Content blocks',
            description: 'Build the page by adding blocks in order.',
            // A list of rows all saying "Text" and "Media" tells you nothing,
            // so each row summarises its own contents.
            itemLabel: (props) => {
              const kind = props.discriminant;
              const v: any = props.value;
              const snip = (s: unknown, n = 52) => {
                const t = String(s ?? '').replace(/\s+/g, ' ').trim();
                if (!t) return '';
                return t.length > n ? `${t.slice(0, n)}…` : t;
              };

              if (kind === 'text') return snip(v?.value) || 'Text';
              if (kind === 'heading') return `# ${snip(v?.value) || 'Heading'}`;
              if (kind === 'quote') return `“${snip(v?.value, 40) || 'Pull quote'}”`;

              if (kind === 'media') {
                const f = v?.fields;
                const n = f?.items?.elements?.length ?? 0;
                const bits = [
                  `${n} ${n === 1 ? 'item' : 'items'}`,
                  f?.layout?.value,
                  f?.width?.value,
                  f?.tall?.value ? 'phones' : null,
                ].filter(Boolean);
                const cap = snip(f?.caption?.value, 30);
                return `Media · ${bits.join(' · ')}${cap ? ` — ${cap}` : ''}`;
              }

              if (kind === 'textMedia') {
                const f = v?.fields;
                const side = f?.side?.value ?? 'right';
                const cap = snip(f?.caption?.value, 24) || snip(f?.text?.value, 24);
                return `Text + media ${side}${cap ? ` — ${cap}` : ''}`;
              }

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
        name: fields.text({
          label: 'Name',
          description: 'The bold first line under the hero illustration.',
          defaultValue: 'Ryan Choi (최진혁)',
        }),
        intro: fields.text({
          label: 'Intro',
          description:
            'The text under your name. Separate paragraphs with a blank line. ' +
            'Wrap words in *asterisks* to italicise them (used for film titles).',
          multiline: true,
        }),
      },
    }),
  },
});
