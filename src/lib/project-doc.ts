import Markdoc, { type RenderableTreeNode } from '@markdoc/markdoc';

// Turns the Markdoc body of a project into HTML.
//
// The body is one document typed in the Keystatic editor. Prose nodes
// (paragraphs, headings, quotes, lists) come through as themselves; the two
// custom tags, {% Media %} and {% TextMedia %}, are the things you insert
// inline and configure in place. Both render to the same markup the page
// styled before this was a document, so global.css needed no new rules for
// them — see "Project page blocks" there.

type MediaItem = {
  source?: { discriminant?: string; value?: string } | null;
  alt?: string;
  caption?: string;
};

/** Turn a pasted video link into an embeddable src. */
export const embedFor = (url: string): string | null => {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const id = u.searchParams.get('v');
      if (id) return `https://www.youtube-nocookie.com/embed/${id}`;
    }
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1);
      if (id) return `https://www.youtube-nocookie.com/embed/${id}`;
    }
    if (host === 'vimeo.com') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      if (id) return `https://player.vimeo.com/video/${id}`;
    }
  } catch {
    /* not a URL we can embed */
  }
  return null;
};

const { Tag } = Markdoc;

/** The reference width every canvas position is expressed against: the
 *  content column at full size. Positions are stored as plain numbers in this
 *  space and converted to percentages, so the layout scales with the page. */
const CANVAS_W = 1344;

/** Lines, boxes and ellipses, drawn as SVG so they scale and take a colour. */
function shapeTag(it: any): RenderableTreeNode {
  const w = it.w ?? 200;
  const h = it.h ?? 200;
  const stroke = it.color || 'currentColor';
  const sw = it.strokeWidth ?? 2;
  const fill = it.fill || 'none';
  let inner: RenderableTreeNode;

  if (it.shape === 'rect') {
    inner = new Tag('rect', {
      x: String(sw / 2), y: String(sw / 2),
      width: String(Math.max(0, w - sw)), height: String(Math.max(0, h - sw)),
      fill, stroke, 'stroke-width': String(sw),
      rx: String(it.radius ?? 0),
    });
  } else if (it.shape === 'ellipse') {
    inner = new Tag('ellipse', {
      cx: String(w / 2), cy: String(h / 2),
      rx: String(Math.max(0, w / 2 - sw / 2)), ry: String(Math.max(0, h / 2 - sw / 2)),
      fill, stroke, 'stroke-width': String(sw),
    });
  } else if (it.shape === 'squiggle') {
    // The same hand-drawn feel as the connectors, as a standalone flourish.
    const d =
      `M 0 ${h * 0.7} C ${w * 0.18} ${h * 0.1}, ${w * 0.32} ${h * 0.95}, ${w * 0.5} ${h * 0.45}` +
      ` C ${w * 0.68} ${h * -0.05}, ${w * 0.82} ${h * 0.9}, ${w} ${h * 0.3}`;
    inner = new Tag('path', { d, fill: 'none', stroke, 'stroke-width': String(sw), 'stroke-linecap': 'round' });
  } else {
    // A plain line, corner to corner of its box.
    inner = new Tag('line', {
      x1: '0', y1: String(h / 2), x2: String(w), y2: String(h / 2),
      stroke, 'stroke-width': String(sw), 'stroke-linecap': 'round',
    });
  }

  return new Tag(
    'svg',
    { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    [inner]
  );
}


/** Every positioned thing carries a width and an alignment. */
const boxClass = (width?: string, align?: string) =>
  ['pb', `pb--${width ?? 'wide'}`, `pb--${align ?? 'center'}`].join(' ');

const paragraphs = (text: string) =>
  (text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

function renderMediaItem(item: MediaItem, groupCaption: string): RenderableTreeNode {
  const kind = item?.source?.discriminant;
  const value = item?.source?.value ?? '';
  const children: RenderableTreeNode[] = [];

  if (kind === 'image' && value) {
    children.push(
      new Tag('img', { src: value, alt: item.alt || '', loading: 'lazy' })
    );
  } else if (kind === 'videoFile' && value) {
    children.push(
      new Tag('video', { src: value, controls: '', playsinline: '', preload: 'metadata' })
    );
  } else if (kind === 'videoLink' && value) {
    const embed = embedFor(value);
    if (embed) {
      children.push(
        new Tag('div', { class: 'video-frame' }, [
          new Tag('iframe', {
            src: embed,
            loading: 'lazy',
            allow:
              'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
            allowfullscreen: '',
            title: item.caption || 'Embedded video',
          }),
        ])
      );
    } else {
      children.push(
        new Tag('a', { href: value, target: '_blank', rel: 'noopener noreferrer' }, [value])
      );
    }
  }

  // A per-item caption only shows when the group isn't captioned as a whole.
  if (!groupCaption && item?.caption) {
    children.push(new Tag('figcaption', { class: 'media-caption' }, [item.caption]));
  }

  return new Tag('div', { class: 'media-item' }, children);
}

export const markdocConfig = {
  tags: {
    Media: {
      attributes: {
        items: { type: Array },
        layout: { type: String },
        width: { type: String },
        align: { type: String },
        tall: { type: Boolean },
        caption: { type: String },
      },
      transform(node: any, config: any) {
        const a = node.transformAttributes(config);
        const items: MediaItem[] = (a.items ?? []).filter(
          (it: MediaItem) => it?.source?.value
        );
        if (items.length === 0) return null;

        const groupCaption = (a.caption ?? '').trim();
        const listClass = [
          'media-items',
          `media-items--${a.layout ?? 'row'}`,
          `media-items--${a.align ?? 'center'}`,
          a.tall ? 'media-items--tall' : '',
        ]
          .filter(Boolean)
          .join(' ');

        const children: RenderableTreeNode[] = [
          new Tag(
            'div',
            { class: listClass },
            items.map((it) => renderMediaItem(it, groupCaption))
          ),
        ];

        if (groupCaption) {
          children.push(
            new Tag('figcaption', { class: 'media-caption media-caption--group' }, [
              groupCaption,
            ])
          );
        }

        return new Tag('figure', { class: boxClass(a.width, a.align) }, children);
      },
    },

    // The inline text-colour mark. Accent and Muted ride the theme tokens, so
    // they are a class; the named colours are fixed and carry a literal.
    Color: {
      attributes: { tone: { type: String } },
      transform(node: any, config: any) {
        const a = node.transformAttributes(config);
        const tone = a.tone ?? 'accent';
        return new Tag(
          'span',
          { class: `fc fc--${tone}` },
          node.transformChildren(config)
        );
      },
    },

    // A free-placement layer. Items carry a position and size expressed
    // against a 1344px reference width, so the whole thing scales with the
    // page instead of being pinned to one viewport. Below the breakpoint the
    // CSS throws the positioning away and stacks them in order, which is why
    // every item also keeps its document order.
    Canvas: {
      attributes: {
        items: { type: Array },
        height: { type: Number },
      },
      transform(node: any, config: any) {
        const a = node.transformAttributes(config);
        const items: any[] = a.items ?? [];
        if (items.length === 0) return null;

        // Reserve the right vertical space in the flow. Falls back to the
        // tallest item if the editor has not stamped a height.
        const height =
          a.height ??
          items.reduce(
            (h, it) => Math.max(h, (it.y ?? 0) + (it.h ?? 200)),
            0
          ) + 24;

        const children = items.map((it) => {
          const pct = (n: number) => `${(n / CANVAS_W) * 100}%`;
          const style = [
            `left:${pct(it.x ?? 0)}`,
            `top:${it.y ?? 0}px`,
            `width:${pct(it.w ?? 300)}`,
            it.rotate ? `transform:rotate(${it.rotate}deg)` : '',
            it.z ? `z-index:${it.z}` : '',
          ]
            .filter(Boolean)
            .join(';');

          const kids: RenderableTreeNode[] = [];

          if (it.kind === 'image' && it.src) {
            kids.push(new Tag('img', { src: it.src, alt: it.alt || '', loading: 'lazy' }));
          } else if (it.kind === 'video' && it.src) {
            kids.push(
              new Tag('video', { src: it.src, controls: '', playsinline: '', preload: 'metadata' })
            );
          } else if (it.kind === 'embed' && it.src) {
            const embed = embedFor(it.src);
            if (embed) {
              kids.push(
                new Tag('div', { class: 'video-frame' }, [
                  new Tag('iframe', {
                    src: embed,
                    loading: 'lazy',
                    allow:
                      'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
                    allowfullscreen: '',
                    title: it.caption || 'Embedded video',
                  }),
                ])
              );
            }
          } else if (it.kind === 'shape') {
            kids.push(shapeTag(it));
          }

          if (it.caption) {
            kids.push(new Tag('figcaption', { class: 'media-caption' }, [it.caption]));
          }

          return new Tag(
            'div',
            {
              class: `cv-item cv-item--${it.kind ?? 'image'}`,
              style,
              // Keeps the aspect box while the image loads, so nothing jumps.
              'data-h': String(it.h ?? ''),
            },
            kids
          );
        });

        return new Tag(
          'div',
          { class: 'canvas', style: `height:${height}px` },
          children
        );
      },
    },

    // Lives in the empty space to the right of the 720px text column. It is a
    // float, not an absolutely positioned box, so it sits level with the text
    // that follows it and can never land on top of another one.
    Margin: {
      attributes: {
        source: { type: Object },
        alt: { type: String },
        caption: { type: String },
        size: { type: String },
        connect: { type: Boolean },
        connectColor: { type: String },
        connectStyle: { type: String },
      },
      transform(node: any, config: any) {
        const a = node.transformAttributes(config);
        const kind = a.source?.discriminant;
        const value = a.source?.value;
        if (!value) return null;

        const inner: RenderableTreeNode[] = [];
        if (kind === 'image') {
          inner.push(new Tag('img', { src: value, alt: a.alt || '', loading: 'lazy' }));
        } else if (kind === 'videoFile') {
          inner.push(
            new Tag('video', { src: value, controls: '', playsinline: '', preload: 'metadata' })
          );
        } else if (kind === 'videoLink') {
          const embed = embedFor(value);
          inner.push(
            embed
              ? new Tag('div', { class: 'video-frame' }, [
                  new Tag('iframe', {
                    src: embed,
                    loading: 'lazy',
                    allow:
                      'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
                    allowfullscreen: '',
                    title: a.caption || 'Embedded video',
                  }),
                ])
              : new Tag('a', { href: value, target: '_blank', rel: 'noopener noreferrer' }, [value])
          );
        }

        if (a.caption) {
          inner.push(new Tag('figcaption', { class: 'media-caption' }, [a.caption]));
        }

        const attrs: Record<string, string> = {
          class: `margin-item margin-item--${a.size ?? 'medium'}`,
        };
        // The connector is drawn in the browser, where the two boxes have real
        // positions. These say what to join and in what colour.
        if (a.connect) {
          attrs['data-connect'] = a.connectStyle || 'curve';
          if (a.connectColor) attrs['data-connect-color'] = a.connectColor;
        }

        return new Tag('aside', attrs, [new Tag('figure', {}, inner)]);
      },
    },

    TextMedia: {
      attributes: {
        text: { type: String },
        image: { type: String },
        alt: { type: String },
        caption: { type: String },
        side: { type: String },
        split: { type: String },
        width: { type: String },
      },
      transform(node: any, config: any) {
        const a = node.transformAttributes(config);
        if (!a.image && !a.text) return null;

        const mediaPct = Number(a.split ?? '50');
        const children: RenderableTreeNode[] = [
          new Tag(
            'div',
            { class: 'tm-text prose', style: `flex-basis:${100 - mediaPct}%` },
            paragraphs(a.text).map((p) => new Tag('p', {}, [p]))
          ),
        ];

        if (a.image) {
          const figureKids: RenderableTreeNode[] = [
            new Tag('img', { src: a.image, alt: a.alt || '', loading: 'lazy' }),
          ];
          if (a.caption) {
            figureKids.push(new Tag('figcaption', { class: 'media-caption' }, [a.caption]));
          }
          children.push(
            new Tag(
              'figure',
              { class: 'tm-media', style: `flex-basis:${mediaPct}%` },
              figureKids
            )
          );
        }

        return new Tag(
          'div',
          { class: `${boxClass(a.width, 'center')} tm tm--media-${a.side ?? 'right'}` },
          children
        );
      },
    },
  },

  nodes: {
    // Markdoc wraps a document in <article> by default. The page already
    // provides .project-body, and the width rules there select on direct
    // children, so hand back the children bare instead of nesting them.
    document: {
      ...Markdoc.nodes.document,
      transform(node: any, config: any) {
        return node.transformChildren(config);
      },
    },
    // Headings in the body sit below the page's own h1, so start at h2.
    heading: {
      ...Markdoc.nodes.heading,
      transform(node: any, config: any) {
        const a = node.transformAttributes(config);
        const level = Math.min(Number(a.level ?? 2) + 1, 6);
        return new Tag(
          `h${level}`,
          { class: 'pb-heading' },
          node.transformChildren(config)
        );
      },
    },
    blockquote: {
      ...Markdoc.nodes.blockquote,
      transform(node: any, config: any) {
        return new Tag(
          'blockquote',
          { class: 'pb-quote' },
          node.transformChildren(config)
        );
      },
    },
    // A plain inline image, dropped in without the Media component.
    image: {
      ...Markdoc.nodes.image,
      transform(node: any, config: any) {
        const a = node.transformAttributes(config);
        return new Tag('figure', { class: 'pb pb--wide pb--center' }, [
          new Tag('div', { class: 'media-items media-items--row media-items--center' }, [
            new Tag('div', { class: 'media-item' }, [
              new Tag('img', { src: a.src, alt: a.alt || '', loading: 'lazy' }),
            ]),
          ]),
        ]);
      },
    },
  },
};

/** Markdoc AST (what the Keystatic reader hands back) to an HTML string. */
export function renderProjectBody(node: any): string {
  const tree = Markdoc.transform(node, markdocConfig as any);
  return Markdoc.renderers.html(tree);
}
