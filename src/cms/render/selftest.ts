/**
 * src/cms/render/selftest.ts
 *
 * WS-1. The half of the renderer a browser cannot tell you about: what the
 * string actually says.
 *
 *   node src/cms/render/selftest.ts
 *
 * verify.ts answers "does it lay out correctly", which needs Chrome and takes
 * half a minute. This answers "does it escape, does it drop what it should
 * drop, does it keep what it should keep", in well under a second, so it is
 * the one to run while editing. Every document here goes through validateDoc
 * first: a test that renders a document the schema would reject is testing
 * something that cannot happen.
 */

import { formatIssues, validateDoc } from '../schema.ts';
import type { Band, Doc, ProseBlock } from '../schema.ts';
import {
  drawsCover,
  fallbackGenerateShape,
  formatLedgerDate,
  ledgerItemsFromMetas,
  renderDoc,
  renderDocHead,
  renderLedgerPage,
  renderProjectHead,
  renderProseBlock,
  titleLines,
} from './index.ts';

/* -------------------------------------------------------------------------- */

let passed = 0;
const failures: string[] = [];

function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1;
  else failures.push(`${name}${detail === '' ? '' : `\n      ${detail}`}`);
}

function contains(name: string, haystack: string, needle: string): void {
  ok(name, haystack.includes(needle), `expected to find: ${needle}`);
}

function excludes(name: string, haystack: string, needle: string): void {
  ok(name, !haystack.includes(needle), `expected NOT to find: ${needle}`);
}

/** Build and validate, so a malformed test document fails loudly as a bug in
 *  the test rather than quietly as a bug in the renderer. */
function doc(bands: Band[], slug = 'selftest'): Doc {
  const candidate = {
    version: 1 as const,
    meta: { title: 'Selftest', slug, date: '2026-10-08' },
    bands,
  };
  const result = validateDoc(candidate);
  if (!result.ok) throw new Error(`test document is invalid:\n${formatIssues(result.issues)}`);
  return result.doc;
}

function prose(id: string, blocks: ProseBlock[]): Band {
  return { id, type: 'prose', blocks };
}

function render(bands: Band[]): string {
  return renderDoc(doc(bands));
}

/* -------------------------------------------------------------------------- */
/* Escaping                                                                   */
/* -------------------------------------------------------------------------- */

{
  const html = render([
    prose('b1', [
      { id: 'p1', kind: 'p', content: [{ type: 'text', text: '<script>alert("x")</script> & <b>' }] },
    ]),
  ]);
  excludes('text: a script tag cannot reach the output', html, '<script');
  contains('text: angle brackets are escaped', html, '&lt;script&gt;');
  contains('text: an ampersand is escaped once', html, '&amp; &lt;b&gt;');
}

{
  const html = render([
    prose('b1', [{ id: 'p1', kind: 'p', content: [{ type: 'text', text: 'hi' }] }]),
    {
      id: 'b2',
      type: 'canvas',
      height: 100,
      items: [
        {
          id: 'i1',
          kind: 'image',
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          src: '/a.png',
          alt: '" onerror="alert(1)',
          caption: '<em>not markup</em>',
        },
      ],
    },
  ]);
  excludes('attr: a quote cannot break out of alt', html, 'onerror="alert');
  contains('attr: the quote is escaped', html, '&quot; onerror=');
  contains('caption: markup in a caption is text', html, '&lt;em&gt;not markup&lt;/em&gt;');
}

/* -------------------------------------------------------------------------- */
/* Marks                                                                      */
/* -------------------------------------------------------------------------- */

{
  const marked = (marks: unknown[]): string =>
    render([prose('b1', [{ id: 'p1', kind: 'p', content: [{ type: 'text', marks, text: 'word' }] }])]);

  contains('mark: bold', marked([{ type: 'bold' }]), '<strong>word</strong>');
  contains('mark: italic', marked([{ type: 'italic' }]), '<em>word</em>');

  const link = marked([
    { type: 'link', attrs: { href: 'https://example.com/a?b=1&c=2', target: '_blank' } },
  ]);
  contains('mark: link href is escaped', link, 'href="https://example.com/a?b=1&amp;c=2"');
  contains('mark: a _blank link gets rel', link, 'rel="noopener noreferrer"');

  const evil = marked([{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]);
  excludes('mark: a javascript: href is dropped', evil, 'javascript');
  contains('mark: dropping a link keeps its text', evil, 'word');

  const sneaky = marked([{ type: 'link', attrs: { href: 'java\nscript:alert(1)' } }]);
  excludes('mark: a href with a newline in the scheme is dropped', sneaky, 'script:');

  contains(
    'mark: textStyle becomes an inline colour',
    marked([{ type: 'textStyle', attrs: { color: '#ff5722' } }]),
    '<span style="color:#ff5722">word</span>',
  );
  const badColor = marked([{ type: 'textStyle', attrs: { color: 'red; background:url(x)' } }]);
  excludes('mark: a non-hex colour never reaches the style attribute', badColor, 'background');
  contains('mark: dropping a colour keeps its text', badColor, 'word');

  const unknown = marked([{ type: 'underline' }, { type: 'bold' }]);
  excludes('mark: a mark outside PROSE_MARKS is ignored', unknown, '<u>');
  contains('mark: ignoring a mark keeps the rest', unknown, '<strong>word</strong>');

  // Order is fixed, whatever order TipTap hands them over in, so the bytes do
  // not depend on how the text was typed.
  const forward = marked([{ type: 'bold' }, { type: 'italic' }, { type: 'link', attrs: { href: '/x' } }]);
  const backward = marked([{ type: 'link', attrs: { href: '/x' } }, { type: 'italic' }, { type: 'bold' }]);
  ok('mark: nesting order does not depend on the input order', forward === backward);
  contains('mark: link is outermost', forward, '<a href="/x"><strong><em>word</em></strong></a>');
}

/* -------------------------------------------------------------------------- */
/* Block kinds                                                                */
/* -------------------------------------------------------------------------- */

{
  const html = render([
    prose('b1', [
      { id: 'h2', kind: 'h2', content: [{ type: 'text', text: 'Two' }] },
      { id: 'h3', kind: 'h3', content: [{ type: 'text', text: 'Three' }] },
      { id: 'empty', kind: 'p', content: [] },
      {
        id: 'q',
        kind: 'quote',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
        ],
      },
      {
        id: 'ul',
        kind: 'ul',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'outer' }] },
              {
                type: 'bulletList',
                content: [
                  {
                    type: 'listItem',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inner' }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'ol',
        kind: 'ol',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
        ],
      },
      { id: 'br', kind: 'p', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] },
      {
        id: 'hl',
        kind: 'p',
        content: [
          { type: 'text', text: 'plain ' },
          { type: 'text', marks: [{ type: 'highlight', attrs: { ink: 'blue' } }], text: 'inked' },
          { type: 'text', marks: [{ type: 'highlight', attrs: { ink: 'nonsense' } }], text: ' fallback' },
          {
            type: 'text',
            marks: [{ type: 'bold' }, { type: 'highlight', attrs: { ink: 'yellow' } }],
            text: ' bold too',
          },
        ],
      },
      { id: 'callout_default', kind: 'callout', content: [{ type: 'text', text: 'quiet aside' }] },
      { id: 'callout_blue', kind: 'callout', tone: 'blue', content: [{ type: 'text', text: 'a blue one' }] },
      {
        id: 'col',
        kind: 'p',
        content: [
          { type: 'text', marks: [{ type: 'textStyle', attrs: { color: 'var(--muted, #6b6b6b)' } }], text: 'muted' },
          { type: 'text', marks: [{ type: 'textStyle', attrs: { color: '#3a7f6d' } }], text: 'hexed' },
          { type: 'text', marks: [{ type: 'textStyle', attrs: { color: '#fff;background:url(//evil)' } }], text: 'injected' },
        ],
      },
    ]),
  ]);

  // The `id` is the anchor the markdown pipeline used to put on every
  // heading, so a `#fragment` link anyone has shared into the middle of an
  // essay still resolves. These two assertions predated it and were failing.
  contains('block: h2', html, '<h2 class="doc-h2" id="two" data-block-id="h2">Two</h2>');
  contains('block: h3', html, '<h3 class="doc-h3" id="three" data-block-id="h3">Three</h3>');
  contains('block: an empty paragraph still renders', html, '<p class="doc-p" data-block-id="empty"></p>');
  // The ink is a class, so the four pens live in the stylesheet and nothing
  // author-supplied reaches a style attribute.
  contains('highlight: the ink is a class', html, '<mark class="doc-hl doc-hl--blue">inked</mark>');
  // A token colour has to render. The editor's palette stores this form on
  // purpose, so the colour follows the theme instead of freezing the
  // light-mode hex; the renderer used to accept hex only and dropped it
  // silently, which showed the colour in the CMS and nowhere else.
  contains(
    'colour: a palette token renders',
    html,
    '<span style="color:var(--muted, #6b6b6b)">muted</span>',
  );
  contains('colour: a plain hex still renders', html, '<span style="color:#3a7f6d">hexed</span>');
  // A callout is an <aside>, which is what "set apart from the text" means,
  // and its tone is a class so the colour has a light and a dark value.
  contains(
    'callout: an aside with the default tone',
    html,
    '<aside class="doc-callout doc-callout--grey" data-block-id="callout_default">quiet aside</aside>',
  );
  contains(
    'callout: a chosen tone becomes a class',
    html,
    '<aside class="doc-callout doc-callout--blue" data-block-id="callout_blue">a blue one</aside>',
  );
  // A tone the schema would refuse cannot reach a stored document, so this
  // goes straight at the renderer: a hand-edited file must not produce a
  // class with nothing behind it.
  ok(
    'callout: a tone the schema would refuse falls back rather than emitting a dead class',
    renderProseBlock({
      id: 'x',
      kind: 'callout',
      tone: 'mauve',
      content: [{ type: 'text', text: 'hand edited' }],
    } as unknown as ProseBlock) ===
      '<aside class="doc-callout doc-callout--grey" data-block-id="x">hand edited</aside>',
    renderProseBlock({ id: 'x', kind: 'callout', tone: 'mauve', content: [] } as unknown as ProseBlock),
  );
  ok(
    'callout: and the schema refuses to store it in the first place',
    !validateDoc({
      version: 1,
      meta: { title: 'x', slug: 'x', date: '2026-01-01' },
      bands: [{ id: 'b', type: 'prose', blocks: [{ id: 'c', kind: 'callout', tone: 'mauve', content: [] }] }],
    }).ok,
  );
  // And the style attribute stays shut.
  contains('colour: an injection attempt is dropped, text kept', html, '>injected<');
  contains(
    'highlight: an unknown ink falls back rather than dropping the mark',
    html,
    '<mark class="doc-hl doc-hl--yellow"> fallback</mark>',
  );
  contains(
    'highlight: it nests inside bold, so the stroke hugs the words',
    html,
    '<strong><mark class="doc-hl doc-hl--yellow"> bold too</mark></strong>',
  );
  contains('block: a quote keeps its paragraphs', html, '<blockquote class="doc-quote" data-block-id="q"><p>one</p><p>two</p></blockquote>');
  contains('block: a single-paragraph list item has no inner p', html, '<li>outer<ul>');
  contains('block: a nested list survives', html, '<ul><li>inner</li></ul></li>');
  contains('block: ol', html, '<ol class="doc-list doc-list--ol" data-block-id="ol"><li>first</li></ol>');
  contains('block: a hard break', html, 'a<br />b');
}

/* -------------------------------------------------------------------------- */
/* Canvas, overlay and connectors                                             */
/* -------------------------------------------------------------------------- */

{
  const bands: Band[] = [
    prose('b_text', [{ id: 'p_target', kind: 'p', content: [{ type: 'text', text: 'anchor me' }] }]),
    {
      id: 'b_over',
      type: 'canvas',
      height: 400,
      overlay: true,
      items: [
        {
          id: 'i_ok',
          kind: 'shape',
          shape: 'arrow',
          x: 672,
          y: 100,
          w: 200,
          h: 100,
          color: '#ff5722',
          anchor: { bandId: 'b_text', blockId: 'p_target' },
        },
      ],
    },
    prose('b_after', [{ id: 'p_after', kind: 'p', content: [{ type: 'text', text: 'after' }] }]),
  ];
  const html = render(bands);

  contains('canvas: x becomes a percentage of the reference width', html, 'left:50%');
  contains('canvas: y becomes cqw, with a px fallback before it', html, 'top:100px;top:7.4405cqw');
  contains('canvas: w becomes a percentage', html, 'width:14.881%');
  contains('canvas: h becomes the frame aspect ratio', html, 'aspect-ratio:200 / 100');
  contains('overlay: the band carries the overlay class', html, 'doc-band--canvas doc-band--overlay');
  contains('overlay: the band reserves its height in cqw, with a px fallback', html, 'height:400px;height:29.7619cqw');

  // The overlay has to be inside the same group as the band it sits over, or
  // it has nothing to be positioned against.
  const group = /<div class="doc-group">(.*?)<\/div><div class="doc-group">/s.exec(html);
  ok('overlay: it is grouped with the band before it', group !== null && group[1]!.includes('b_over'));
  ok('overlay: the band after it starts a new group', html.includes('data-band-id="b_after"'));

  contains('connector: the anchor reaches the markup', html, 'data-anchor-block="p_target"');
  contains('connector: the seed travels with it', html, 'data-connector-seed="');
  contains('connector: so does the colour', html, 'data-connector-color="#ff5722"');
  contains('connector: the overlay svg is emitted', html, '<svg class="doc-connectors"');

  // A dangling anchor is legal and must simply not be drawn.
  const dangling = render([
    bands[0]!,
    {
      ...(bands[1] as Extract<Band, { type: 'canvas' }>),
      items: [
        {
          ...(bands[1] as Extract<Band, { type: 'canvas' }>).items[0]!,
          anchor: { bandId: 'b_text', blockId: 'p_gone' },
        },
      ],
    },
  ]);
  excludes('connector: a dangling anchor is not drawn', dangling, 'data-anchor-block');
  excludes('connector: and no overlay svg is emitted for it', dangling, 'doc-connectors');
  contains('connector: the item itself still renders', dangling, 'data-item-id="i_ok"');
}

{
  // rotate: 0 is not a rotation, and z is an integer in the style attribute.
  const html = render([
    prose('b1', [{ id: 'p1', kind: 'p', content: [] }]),
    {
      id: 'b2',
      type: 'canvas',
      height: 200,
      items: [
        { id: 'i_flat', kind: 'shape', shape: 'line', x: 0, y: 0, w: 100, h: 2, rotate: 0, z: 3 },
        { id: 'i_tilt', kind: 'shape', shape: 'line', x: 0, y: 0, w: 100, h: 2, rotate: -6 },
      ],
    },
  ]);
  contains('canvas: a non-zero rotation becomes a transform', html, 'transform:rotate(-6deg)');
  ok('canvas: rotate 0 emits no transform', html.split('transform:rotate').length === 2);
  contains('canvas: z becomes z-index', html, 'z-index:3');
}

{
  // Defence in depth. The schema already rejects a src that is not a
  // site-absolute path or an http(s) url, so this document cannot come out of
  // validateDoc; it is what the renderer does when somebody hands it one
  // anyway, which is the case that matters, because renderDoc is reachable
  // from the preview and from a migration script.
  const unvalidated = {
    version: 1,
    meta: { title: 'Selftest', slug: 'selftest', date: '2026-10-08' },
    bands: [
      { id: 'b1', type: 'prose', blocks: [{ id: 'p1', kind: 'p', content: [] }] },
      {
        id: 'b2',
        type: 'canvas',
        height: 200,
        items: [{ id: 'i_bad', kind: 'image', x: 0, y: 0, w: 10, h: 10, src: 'javascript:alert(1)' }],
      },
    ],
  } as unknown as Doc;
  ok('canvas: the schema rejects an unusable src', !validateDoc(unvalidated).ok);

  const html = renderDoc(unvalidated);
  excludes('canvas: an unusable src drops the item', html, 'data-item-id="i_bad"');
  excludes('canvas: and nothing of it reaches the page', html, 'javascript');
}

{
  // The two media kinds no fixture covers.
  const html = render([
    prose('b1', [{ id: 'p1', kind: 'p', content: [] }]),
    {
      id: 'b2',
      type: 'canvas',
      height: 400,
      items: [
        { id: 'i_vid', kind: 'video', x: 0, y: 0, w: 320, h: 180, src: '/media/x/clip.mp4' },
        {
          id: 'i_emb',
          kind: 'embed',
          x: 400,
          y: 0,
          w: 320,
          h: 180,
          src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          caption: 'A talk',
        },
      ],
    },
  ]);
  contains('media: a video is a real video element', html, '<video src="/media/x/clip.mp4" controls playsinline preload="metadata">');
  contains('media: a youtube link becomes a nocookie embed', html, 'src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
  contains('media: the embed is titled from its caption', html, 'title="A talk"');
  contains('media: both sit in an aspect-ratio frame', html, 'aspect-ratio:320 / 180');
}

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

{
  const spec = {
    shape: 'squiggle' as const,
    width: 300,
    height: 120,
    color: '#a68fd8',
    strokeWidth: 3,
    seed: 123456,
  };
  const first = fallbackGenerateShape(spec);
  const second = fallbackGenerateShape(spec);
  ok('shape: the generator is deterministic', first === second);
  ok(
    'shape: a different seed draws a different shape',
    first !== fallbackGenerateShape({ ...spec, seed: 654321 }),
  );

  for (const shape of ['line', 'rect', 'ellipse', 'squiggle', 'arrow'] as const) {
    const svg = fallbackGenerateShape(
      shape === 'rect' ? { ...spec, shape, radius: 12 } : { ...spec, shape },
    );
    ok(`shape: ${shape} is one root svg`, svg.startsWith('<svg ') && svg.endsWith('</svg>'));
    contains(`shape: ${shape} carries the frozen root attributes`, svg, 'preserveAspectRatio="none"');
    contains(`shape: ${shape} has the authored viewBox`, svg, 'viewBox="0 0 300 120"');
    excludes(`shape: ${shape} has no id`, svg, ' id=');
    excludes(`shape: ${shape} has no defs`, svg, '<defs');
    excludes(`shape: ${shape} has no style block`, svg, '<style');
    excludes(`shape: ${shape} has no class`, svg, 'class=');
    ok(`shape: ${shape} has one svg element`, svg.split('<svg').length === 2);
  }

  const filled = fallbackGenerateShape({ ...spec, shape: 'rect', fill: '#6aa3e022' });
  contains('shape: a fill is used when it is set', filled, 'fill="#6aa3e022"');
  contains('shape: and is "none" when it is not', fallbackGenerateShape(spec), 'fill="none"');
}

/* -------------------------------------------------------------------------- */

{
  const empty = renderDoc(doc([]));
  ok('doc: an empty document is still a .doc', empty === '<div class="doc" data-doc-slug="selftest"></div>');
}

/* -------------------------------------------------------------------------- */
/* Space above a block                                                        */
/* -------------------------------------------------------------------------- */

{
  const p = (id: string, space?: 'small' | 'medium' | 'large'): ProseBlock => {
    const block: ProseBlock = { id, kind: 'p', content: [{ type: 'text', text: id }] };
    if (space !== undefined) block.space = space;
    return block;
  };

  const html = renderDoc(doc([prose('b1', [p('one'), p('two', 'medium'), p('three')])]));
  contains(
    'space: the class is on the block that asked for it',
    html,
    '<p class="doc-p doc-space--medium" data-block-id="two">',
  );
  excludes('space: and not on the ones that did not', html, 'data-block-id="three" class');
  ok(
    'space: a block with no space has no space class',
    !/doc-space--[a-z]+" data-block-id="(one|three)"/.test(html),
  );

  // doc.css zeroes a first block's top margin, so the class would be inert
  // there; the editing surface withholds it for the same reason, and the two
  // agreeing is the point.
  const first = renderDoc(doc([prose('b1', [p('lead', 'large'), p('after')])]));
  excludes('space: the FIRST block of the document never gets the class', first, 'doc-space--large');

  // Only the first block of the first band. A band further down opens with a
  // block that does have something above it.
  const later = renderDoc(
    doc([prose('b1', [p('lead')]), prose('b2', [p('opener', 'large')])]),
  );
  contains(
    'space: but the first block of a LATER band does',
    later,
    '<p class="doc-p doc-space--large" data-block-id="opener">',
  );
}

/* -------------------------------------------------------------------------- */
/* Heading ids are unique within a document                                   */
/* -------------------------------------------------------------------------- */

{
  const h = (id: string, text: string): ProseBlock => ({
    id,
    kind: 'h2',
    content: [{ type: 'text', text }],
  });
  const idsIn = (html: string): string[] =>
    [...html.matchAll(/<h2 class="doc-h2" id="([^"]*)"/g)].map((match) => match[1] as string);

  // Two headings reading the same words. github-slugger, which headingSlug
  // copies, numbers the repeats; two elements sharing an id is a document
  // where the link to the second one silently goes to the first.
  const twice = renderDoc(
    doc([prose('b1', [h('ha', 'What I learned'), h('hb', 'What I learned'), h('hc', 'What I learned')])]),
  );
  const repeated = idsIn(twice);
  ok(
    'heading: a repeated heading is numbered, not duplicated',
    repeated.length === 3 &&
      repeated[0] === 'what-i-learned' &&
      repeated[1] === 'what-i-learned-1' &&
      repeated[2] === 'what-i-learned-2',
    JSON.stringify(repeated),
  );

  // The ledger belongs to the DOCUMENT, not the band: a heading in the third
  // band can collide with one in the first.
  const acrossBands = renderDoc(
    doc([prose('b1', [h('ha', 'Notes')]), prose('b2', [h('hb', 'Notes')])]),
  );
  const spread = idsIn(acrossBands);
  ok(
    'heading: the ledger spans bands, not just one of them',
    spread.length === 2 && spread[0] === 'notes' && spread[1] === 'notes-1',
    JSON.stringify(spread),
  );

  // headingSlug deletes everything that is not an ASCII letter or digit, so
  // these slug to '' and used to get no id at all. The block id is already
  // unique across the document and already in the markup, so it is the
  // fallback: a heading you can link to beats a heading you cannot.
  const unsluggable = renderDoc(
    doc([prose('b1', [h('hangul', '한국어 제목'), h('dots', '…')])]),
  );
  const fallbacks = idsIn(unsluggable);
  ok(
    'heading: text with nothing to slug falls back to the block id',
    fallbacks.length === 2 && fallbacks[0] === 'hangul' && fallbacks[1] === 'dots',
    JSON.stringify(fallbacks),
  );

  // Everything above must leave the ordinary case exactly as it was.
  const plain = renderDoc(doc([prose('b1', [h('only', 'Why a heatmap')])]));
  contains(
    'heading: a lone heading keeps its plain slug',
    plain,
    '<h2 class="doc-h2" id="why-a-heatmap" data-block-id="only">Why a heatmap</h2>',
  );
}

/* -------------------------------------------------------------------------- */
/* The 원고지 note (pages/home-note.ts, docs/wongoji-note.md)                  */
/* -------------------------------------------------------------------------- */

{
  // The real hero's shape in miniature: the grid at the back, one of the four
  // subjects, the skier who starts off the left edge, and one ordinary scene.
  // The alt carries every character escapeAttr has to deal with.
  const piece = (id: string, x: number, z: number) => ({
    id,
    kind: 'image' as const,
    src: `/home/hero/${id}.webp`,
    alt: id,
    x,
    y: 48,
    w: 100,
    h: 100,
    z,
  });
  const homeResult = validateDoc({
    version: 1,
    meta: { title: 'Ryan Choi', slug: 'home', date: '2026-10-14', section: 'home' },
    bands: [
      {
        id: 'b_hero',
        type: 'canvas',
        height: 789,
        items: [
          { ...piece('i_grid', 0, 0), w: 1344, h: 732, alt: 'A grid & "its" <scenes>' },
          piece('i_01_first_swing', 22, 1),
          piece('i_10_alpine_carve', -50, 2),
          piece('i_08_cricket', 1219, 3),
        ],
      },
      prose('b_intro', [{ id: 'p1', kind: 'p', content: [{ type: 'text', text: 'Hello.' }] }]),
    ],
  });
  if (!homeResult.ok) throw new Error(`home test document is invalid:\n${formatIssues(homeResult.issues)}`);
  const page = renderDoc(homeResult.doc);
  const lightboxAt = page.indexOf('<div class="lightbox"');
  const onPage = lightboxAt === -1 ? page : page.slice(0, lightboxAt);
  const inLightbox = lightboxAt === -1 ? '' : page.slice(lightboxAt);

  // The image role moved off .hero so the note can be text, onto the stage.
  // verify-sections greps for exactly `class="hero"`, so nothing is added to it.
  contains('note: .hero is a plain container', page, '<div class="hero" tabindex="-1"><button class="hero-open"');
  contains(
    'note: the stage is the one image, named by the grid, escaped',
    page,
    '<div class="hero-stage" role="img" aria-label="A grid &amp; &quot;its&quot; &lt;scenes&gt;"',
  );
  ok('note: one role="img" on the page, none in the lightbox', (onPage.match(/role="img"/g) ?? []).length === 1 && !inLightbox.includes('role="img"'));
  ok(
    'note: hero pieces are hidden from assistive tech, lightbox pieces are not',
    (onPage.match(/class="hero-piece"[^>]*aria-hidden="true"/g) ?? []).length === 4 && !inLightbox.includes('aria-hidden="true" style'),
  );

  // What each piece does while the note is up.
  contains('note: the piece at the back is the ground', page, 'data-item="i_grid" data-note="ground"');
  contains('note: a subject stays in colour', page, 'data-item="i_01_first_swing" data-note="keep"');
  contains('note: a scene steps back', page, 'data-item="i_08_cricket" data-note="step-back"');
  contains('note: the skier at x:-50 comes back first, not before the note leaves', page, '--note-x:0"');
  contains('note: the stagger is x over 1344', page, `--note-x:${Math.round((1219 / 1344) * 10000) / 10000}"`);

  // Inert without the player: the editor's preview runs no script.
  for (const [what, open] of [
    ['the note layer', '<div class="note-layer" hidden>'],
    ['the caption slot', '<div class="note-caption" hidden>'],
    ['the replay button', '<button class="note-replay" type="button" hidden>'],
    ['the rule beside it', '<span class="hero-hint-rule" aria-hidden="true" hidden>'],
  ] as const) {
    contains(`note: ${what} is rendered hidden`, page, open);
  }

  // Inside .hero, beside the button, never inside the stage or the lightbox.
  const heroEnd = onPage.indexOf('<div class="note-caption"');
  const layerAt = onPage.indexOf('<div class="note-layer"');
  const stageEnd = onPage.indexOf('</button>', onPage.indexOf('class="hero-open"'));
  ok('note: the layer is after the stage and inside .hero', stageEnd !== -1 && layerAt > stageEnd && layerAt < heroEnd);
  excludes('note: nothing of the note is enlarged in the lightbox', inLightbox, 'class="note');

  // The copy, as Ryan wrote it, and the two bits of markup in it.
  const note = page.slice(page.indexOf('<aside class="note"'), page.indexOf('</aside>') + 8);
  contains('note: an aside labelled by its heading', note, 'aria-labelledby="wongoji-note-title"');
  contains('note: the heading it is labelled by', note, '<p class="note-head" id="wongoji-note-title">');
  contains(
    'note: the heading is three squares, silent, then 원고지 said as one word and how it is said',
    note,
    '<span class="note-cells" lang="ko" aria-hidden="true"><span class="note-cell"><span class="note-glyph">원</span></span><span class="note-cell"><span class="note-glyph">고</span></span><span class="note-cell"><span class="note-glyph">지</span></span></span><span class="note-said" lang="ko">원고지</span> <span class="note-roman">won-go-ji</span>',
  );
  contains('note: paragraph one', note, '<p>Korean manuscript paper. One syllable to a square, spaces included.</p>');
  contains(
    'note: paragraph two',
    note,
    '<p>I learned to write on these as a kid, filling page after page with diary entries. The early ones were mostly drawings. Eventually, the words took over.</p>',
  );
  contains(
    'note: paragraph three, draft in italics, 원고 in Korean',
    note,
    '<p><span lang="ko">원고</span> (won-go) means <em>draft.</em> It felt like a fitting place to begin: a life still being written, one square at a time, with plenty of room for what comes next.</p>',
  );
  ok('note: no em or en dashes in the copy', !/[\u2013\u2014]/.test(note));
  contains('note: the replay button is named by its question', page, '<span class="note-replay-label">What is this grid?</span>');
  contains('note: the squares on the button are not read out', page, '<span class="note-replay-cells" lang="ko" aria-hidden="true">');

  // No hero, no note: a homepage that starts with prose gets none of it.
  const noHero = renderDoc(
    (() => {
      const r = validateDoc({
        version: 1,
        meta: { title: 'Ryan Choi', slug: 'home', date: '2026-10-14', section: 'home' },
        bands: [prose('b_intro', [{ id: 'p1', kind: 'p', content: [{ type: 'text', text: 'Hello.' }] }])],
      });
      if (!r.ok) throw new Error('no-hero test document is invalid');
      return r.doc;
    })(),
  );
  excludes('note: a homepage without a hero has no note', noHero, 'class="note');
}

{
  // The cover (`meta.cover`). It is drawn by the masthead, above the title,
  // and only by the essay masthead: a project's head is a different object.
  const withCover = (meta: Record<string, unknown>): Doc => {
    const r = validateDoc({
      version: 1,
      meta: { title: 'Selftest', slug: 'selftest', date: '2026-10-08', section: 'essays', ...meta },
      bands: [prose('b1', [{ id: 'p1', kind: 'p', content: [] }])],
    });
    if (!r.ok) throw new Error(`cover test document is invalid:\n${formatIssues(r.issues)}`);
    return r.doc;
  };

  const head = renderDocHead(withCover({ cover: '/media/essays/selftest/cover.jpg', coverAlt: 'A field of "holes" & a spade' }));
  contains(
    'cover: drawn above the title, the src and the escaped alt on the img',
    head,
    '<figure class="doc-cover"><img class="doc-cover-img" src="/media/essays/selftest/cover.jpg" alt="A field of &quot;holes&quot; &amp; a spade" decoding="async" fetchpriority="high"></figure><header class="doc-head doc-head--essays">',
  );
  ok(
    'cover: a sibling of the header, not inside its 720px measure',
    head.includes('</figure>') && head.indexOf('</figure>') < head.indexOf('<header'),
  );

  contains(
    'cover: no description is announced as decorative, not left without an alt',
    renderDocHead(withCover({ cover: '/media/essays/selftest/cover.jpg' })),
    'alt=""',
  );
  excludes('cover: none set, none drawn', renderDocHead(withCover({})), 'doc-cover');
  excludes('cover: a description with no image draws nothing', renderDocHead(withCover({ coverAlt: 'Orphan' })), 'doc-cover');

  // Defence in depth, as for a canvas image: the schema refuses this, and the
  // renderer must not publish it when handed one anyway.
  const evil = {
    version: 1,
    meta: { title: 'Selftest', slug: 'selftest', date: '2026-10-08', section: 'essays', cover: 'javascript:alert(1)' },
    bands: [prose('b1', [{ id: 'p1', kind: 'p', content: [] }])],
  } as unknown as Doc;
  ok('cover: the schema rejects an unusable src', !validateDoc(evil).ok);
  excludes('cover: an unusable src is not drawn', renderDocHead(evil), 'javascript');
  ok(
    'cover: the schema rejects an empty description',
    !validateDoc({ ...evil, meta: { ...evil.meta, cover: '/media/x/c.jpg', coverAlt: '' } }).ok,
  );

  // Which surfaces draw one is a table, and the editor offers the field from it.
  ok('cover: essays draw one', drawsCover('essays'));
  ok('cover: projects and the homepage do not', !drawsCover('projects') && !drawsCover('home'));
  ok('cover: a document with no section does not', !drawsCover(undefined));
  ok('cover: a record section does not', !drawsCover('photography'));
  excludes(
    'cover: renderDocHead draws none for a section-less document',
    renderDocHead(withCover({ cover: '/media/essays/selftest/cover.jpg', section: undefined })),
    'doc-cover',
  );

  // The editor's resolver: what it returns is what is drawn. The STORED value
  // is what safeUrl checks, before the resolver sees it, so an unusable src in
  // the document is refused even when a resolver would have rewritten it.
  const resolved = renderDocHead(withCover({ cover: '/media/essays/selftest/cover.jpg' }), {
    resolveSrc: (src) => `https://raw.example.com${src}`,
  });
  contains('cover: the editor can point the image at where the bytes are', resolved, 'src="https://raw.example.com/media/essays/selftest/cover.jpg"');
  contains(
    'cover: including a file: url, which is what the shell harness resolves to',
    renderDocHead(withCover({ cover: '/media/essays/selftest/cover.jpg' }), { resolveSrc: (src) => `file:///repo/public${src}` }),
    'src="file:///repo/public/media/essays/selftest/cover.jpg"',
  );
  excludes(
    'cover: an unusable stored src is refused before any resolver sees it',
    renderDocHead(evil, { resolveSrc: () => 'https://looks-fine.example/x.jpg' }),
    'looks-fine',
  );

  // A project page has its own masthead and does not draw a cover.
  excludes(
    'cover: the project masthead does not draw one',
    renderProjectHead(withCover({ cover: '/media/essays/selftest/cover.jpg', section: 'projects' })),
    'doc-cover',
  );
}

{
  // The essays index: the projects' rows, each led by a strip of its cover,
  // the date to the day. Projects keep their plain rows.
  const metas = [
    { title: 'Older', slug: 'older', date: '2026-06-02' },
    { title: 'Newest & best', slug: 'newest', date: '2026-10-14', cover: '/media/essays/newest/cover.jpg' },
    { title: 'Middle', slug: 'middle', date: '2026-08-01', cover: '/media/essays/middle/cover.jpg' },
  ];
  const html = renderLedgerPage(ledgerItemsFromMetas(metas, 'essays'), 'essays');
  contains('essays index: rows with a cover strip, not plain rows', html, '<ul class="ledger ledger--covers">');
  contains(
    'essays index: the newest first, its cover fetched first, the title escaped, the date to the day',
    html,
    '<li class="ledger-cover"><a class="ledger-cover-link" href="/essays/newest/"><span class="ledger-cover-art"><img class="ledger-cover-img" src="/media/essays/newest/cover.jpg" alt="" fetchpriority="high" decoding="async"></span><span class="ledger-title">Newest &amp; best</span><span class="ledger-date">2026.10.14</span></a></li>',
  );
  contains('essays index: every later cover is lazy', html, 'src="/media/essays/middle/cover.jpg" alt="" loading="lazy"');
  ok('essays index: newest first', html.indexOf('/essays/newest/') < html.indexOf('/essays/middle/') && html.indexOf('/essays/middle/') < html.indexOf('/essays/older/'));
  contains(
    'essays index: an essay with no cover is still listed, as the title and date alone',
    html,
    '<li class="ledger-cover ledger-cover--bare"><a class="ledger-cover-link" href="/essays/older/"><span class="ledger-title">Older</span><span class="ledger-date">2026.06.02</span></a></li>',
  );

  // The title breaks after its first clause, as the owner set both titles.
  const lines = (title: string) => JSON.stringify(titleLines(title));
  ok('title lines: after a colon', lines('The Doctor on the Other End of the Line: How Health Insurers Decide What Care Gets Covered') === JSON.stringify(['The Doctor on the Other End of the Line:', 'How Health Insurers Decide What Care Gets Covered']));
  ok('title lines: after a first sentence', lines('I Was Looking for a Startup Idea. I Needed to Ask a Different Question') === JSON.stringify(['I Was Looking for a Startup Idea.', 'I Needed to Ask a Different Question']));
  ok('title lines: after a question', lines('Why Now? Because the Rules Changed') === JSON.stringify(['Why Now?', 'Because the Rules Changed']));
  ok('title lines: the first boundary wins', lines('Two Parts: One. Two') === JSON.stringify(['Two Parts:', 'One. Two']));
  ok('title lines: one clause is one line', lines('Who I’m Looking For') === JSON.stringify(['Who I’m Looking For']));
  ok('title lines: not after an initialism', lines('The U.S. Health System') === JSON.stringify(['The U.S. Health System']));
  ok('title lines: not after a title', lines('Dr. Strange and the Insurers') === JSON.stringify(['Dr. Strange and the Insurers']));
  ok('title lines: not after vs.', lines('Payers vs. Providers') === JSON.stringify(['Payers vs. Providers']));
  ok('title lines: not inside a number or a time', lines('Version 2.5 at 10:30') === JSON.stringify(['Version 2.5 at 10:30']));
  ok('title lines: not before nothing', lines('A Title Ending in a Colon:') === JSON.stringify(['A Title Ending in a Colon:']));
  const twoLines = renderLedgerPage([{ href: '/essays/x/', title: 'A & B: C <D>', date: '2026-10-14' }], 'essays');
  contains(
    'essays index: two lines are two escaped block spans with a space between them',
    twoLines,
    '<span class="ledger-title"><span class="ledger-title-line">A &amp; B:</span> <span class="ledger-title-line">C &lt;D&gt;</span></span>',
  );
  ok('essays index: one title per essay, which the preview check counts', (html.match(/class="ledger-title"/g) ?? []).length === 3);

  const evil = renderLedgerPage(
    [{ href: '/essays/x/', title: 'X', date: '2026-10-14', cover: 'javascript:alert(1)' }],
    'essays',
  );
  excludes('essays index: an unusable cover src is not drawn', evil, 'javascript');
  contains('essays index: and the essay is listed bare instead of dropped', evil, 'ledger-cover--bare');

  const projects = renderLedgerPage(
    ledgerItemsFromMetas([{ title: 'P', slug: 'p', date: '2026-07-01', summary: 'S', cover: '/media/projects/p/c.jpg' }], 'projects'),
    'projects',
  );
  contains('projects index: still rows, with the summary and the month', projects, '<ul class="ledger"><li><div class="ledger-body"><a class="ledger-title" href="/projects/p/">P</a><span class="ledger-summary">S</span></div><span class="ledger-date">2026.07</span></li></ul>');
  excludes('projects index: a cover set on a project is not drawn there', projects, 'img');

  ok('the long date', formatLedgerDate('2026-01-05', 'long') === 'January 5, 2026');
  ok('the long date leaves something unparseable alone', formatLedgerDate('soon', 'long') === 'soon');
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  process.exitCode = 1;
}
