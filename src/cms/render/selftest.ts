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
import { fallbackGenerateShape, renderDoc } from './index.ts';

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
    ]),
  ]);

  contains('block: h2', html, '<h2 class="doc-h2" data-block-id="h2">Two</h2>');
  contains('block: h3', html, '<h3 class="doc-h3" data-block-id="h3">Three</h3>');
  contains('block: an empty paragraph still renders', html, '<p class="doc-p" data-block-id="empty"></p>');
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

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  process.exitCode = 1;
}
