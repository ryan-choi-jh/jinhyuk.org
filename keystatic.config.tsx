import { config, fields, collection, singleton } from '@keystatic/core';
import { block } from '@keystatic/core/content-components';
import * as React from 'react';

// Previews drawn inside the editor, so an inserted component shows what it
// holds instead of a grey bar you have to open to read.
const previewFrame: React.CSSProperties = {
  border: '1px solid #e1e1e1',
  borderRadius: 6,
  padding: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  background: '#fbfbfb',
};

const settingsLine: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: '#6b6b6b',
};

const captionLine: React.CSSProperties = { fontSize: 12, color: '#3b3b3b' };

// Keystatic's block chrome has no delete control: you select the node by
// clicking its label, then press Backspace. That is invisible unless said,
// and an empty block is exactly when you need to know it.
const emptyHint: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: '#8a6d3b',
  background: '#fcf8e3',
  border: '1px solid #faebcc',
  borderRadius: 4,
  padding: '8px 10px',
};

/** An image field's editor value is { data, filename, extension }, not a path,
 *  so a thumbnail has to be built from the bytes. */
function AssetThumb({ value, height }: { value: any; height: number }) {
  const [url, setUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    const raw = value?.data;
    if (!raw) {
      setUrl(null);
      return;
    }
    const bytes =
      raw instanceof Uint8Array
        ? raw
        : new Uint8Array(Object.values(raw) as number[]);
    const objectUrl = URL.createObjectURL(new Blob([bytes]));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [value]);

  if (!url) {
    return (
      <div
        style={{
          ...settingsLine,
          padding: '18px 12px',
          border: '1px dashed #d4d4d4',
          borderRadius: 3,
        }}
      >
        No image
      </div>
    );
  }

  return (
    <img
      src={url}
      alt=""
      style={{
        height,
        width: 'auto',
        maxWidth: 240,
        objectFit: 'contain',
        border: '1px solid #e8e8e8',
        borderRadius: 3,
        background: '#fff',
      }}
    />
  );
}


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
      // No trailing slash => each project is a single file:
      // src/content/projects/<slug>.mdoc  (frontmatter + a Markdoc body).
      path: 'src/content/projects/*',
      format: { contentField: 'content' },
      // The full-page writing surface, same as Writing. Without this the
      // editor is a stack of form fields instead of a page.
      entryLayout: 'content',
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
        // The body is one document you type straight into. Headings,
        // paragraphs, quotes and lists are native; the two components below
        // are inserted inline with the "/" menu and configured in place, so
        // media sits exactly where you put it in the text.
        content: fields.markdoc({
          label: 'Content',
          options: {
            image: {
              directory: 'public/projects',
              publicPath: '/projects/',
            },
          },
          components: {
            Media: block({
              label: 'Media',
              description:
                'Images and videos. Set how many, how they lay out and how wide they sit.',
              schema: {
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
              },
              ContentView: (props) => {
                const v = props.value as any;
                const items = (v.items ?? []).filter(
                  (it: any) => it?.source?.value
                );
                const bits = [
                  `${items.length} ${items.length === 1 ? 'item' : 'items'}`,
                  v.layout,
                  v.width,
                  v.align,
                  v.tall ? 'phones' : null,
                ].filter(Boolean);

                if (items.length === 0) {
                  return (
                    <div style={previewFrame}>
                      <div style={settingsLine}>{bits.join(' · ')}</div>
                      <div style={emptyHint}>
                        Empty. Add an item with Edit, or click <b>MEDIA</b> above
                        to select this block and press Backspace to delete it.
                      </div>
                    </div>
                  );
                }

                return (
                  <div style={previewFrame}>
                    <div style={settingsLine}>{bits.join(' · ')}</div>
                    {items.length > 0 && (
                      <div
                        style={{
                          display: 'flex',
                          gap: 8,
                          flexWrap: 'wrap',
                          justifyContent:
                            v.align === 'left' ? 'flex-start' : 'center',
                        }}
                      >
                        {items.map((it: any, i: number) =>
                          it.source.discriminant === 'image' ? (
                            <AssetThumb
                              key={i}
                              value={it.source.value}
                              height={v.tall ? 170 : 120}
                            />
                          ) : (
                            <div
                              key={i}
                              style={{
                                ...settingsLine,
                                padding: '18px 12px',
                                border: '1px dashed #d4d4d4',
                                borderRadius: 3,
                              }}
                            >
                              {it.source.discriminant === 'videoLink'
                                ? 'Video link'
                                : 'Video file'}
                            </div>
                          )
                        )}
                      </div>
                    )}
                    {v.caption ? <div style={captionLine}>{v.caption}</div> : null}
                  </div>
                );
              },
            }),

            TextMedia: block({
              label: 'Text beside media',
              description: 'A paragraph and an image side by side.',
              schema: {
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
              },
              ContentView: (props) => {
                const v = props.value as any;
                const flip = v.side === 'left';
                const media = v.image ? (
                  <div style={{ width: `${Number(v.split ?? 50)}%` }}>
                    <AssetThumb value={v.image} height={130} />
                  </div>
                ) : null;
                const text = (
                  <div
                    style={{
                      width: `${100 - Number(v.split ?? 50)}%`,
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: '#3b3b3b',
                    }}
                  >
                    {(v.text ?? '').slice(0, 220) || 'No text yet'}
                  </div>
                );

                return (
                  <div style={previewFrame}>
                    <div style={settingsLine}>
                      {['text + media', v.side ?? 'right', `${v.split ?? 50}/${100 - Number(v.split ?? 50)}`, v.width]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                      {flip ? media : text}
                      {flip ? text : media}
                    </div>
                    {v.caption ? <div style={captionLine}>{v.caption}</div> : null}
                  </div>
                );
              },
            }),
          },
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
