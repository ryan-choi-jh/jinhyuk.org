/**
 * src/cms/assets/catalogue.ts
 *
 * WS-6's deliverable catalogue. Builds one self-contained HTML file showing
 * every asset at several sizes, stroke widths, seeds, colours and fills, plus
 * the exact shapes WS-0's fixtures contain and what happens to a drawing when
 * its container is narrower than the 1344px reference width.
 *
 *   node src/cms/assets/catalogue.ts [outfile]
 *
 * Default outfile: src/cms/assets/catalogue.html. No build, no server, no
 * other workstream: open the file. Every cell is drawn at its authored
 * reference pixel size, 1:1, with a faint box so clipping is visible.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  REFERENCE_WIDTH,
  SHAPE_DEFAULTS,
  isCanvasBand,
  seedFromId,
  shapeSpecFromItem,
  validateDocJson,
} from '../schema.ts';
import type { ShapeKind, ShapeSpec } from '../schema.ts';
import { SHAPE_KINDS, generateShape } from './shapes.ts';
import { SITE_INK_DARK, SITE_PALETTE, SITE_PAPER_DARK, tint } from './palette.ts';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const INK = SHAPE_DEFAULTS.color;
const ACCENT = '#ff5722';

function colour(name: string): string {
  return SITE_PALETTE.find((swatch) => swatch.name === name)?.value ?? INK;
}

function spec(
  shape: ShapeKind,
  width: number,
  height: number,
  extra: Partial<ShapeSpec> = {},
): ShapeSpec {
  return {
    shape,
    width,
    height,
    color: INK,
    strokeWidth: 2,
    seed: seedFromId(`${shape}-${width}x${height}`),
    ...extra,
  };
}

/** Every spec that lands on the page, so the determinism check covers all of it. */
const drawn: ShapeSpec[] = [];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type CellOptions = { widthScale?: number; note?: string };

function cell(item: ShapeSpec, label: string, options: CellOptions = {}): string {
  drawn.push(item);
  const scale = options.widthScale ?? 1;
  const boxWidth = Math.round(item.width * scale);
  return [
    '<figure class="cell">',
    `<div class="stage" style="width:${boxWidth}px;height:${Math.round(item.height)}px">`,
    generateShape(item),
    '</div>',
    `<figcaption>${escapeHtml(label)}`,
    options.note ? `<span class="note">${escapeHtml(options.note)}</span>` : '',
    '</figcaption>',
    '</figure>',
  ].join('');
}

function section(id: string, title: string, blurb: string, body: string): string {
  return [
    `<section id="${id}">`,
    `<h2>${escapeHtml(title)}</h2>`,
    `<p class="blurb">${escapeHtml(blurb)}</p>`,
    body,
    '</section>',
  ].join('\n');
}

function row(body: string): string {
  return `<div class="row">${body}</div>`;
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                    */
/* -------------------------------------------------------------------------- */

/** The hero: the squiggle is the one that has to read as a pen, so it goes first and big. */
function heroSection(): string {
  const seeds = ['a', 'b', 'c', 'd', 'e', 'f'];
  const big = seeds
    .map((tag, index) =>
      cell(
        spec('squiggle', 440, 190, {
          color: index % 2 === 0 ? ACCENT : INK,
          strokeWidth: 3,
          seed: seedFromId(`i_hero_${tag}`),
        }),
        `squiggle 440x190 sw3 seed i_hero_${tag}`,
      ),
    )
    .join('');
  return section(
    'hero',
    'Squiggle, six seeds',
    'One continuous looping pen line. Loops cross back over the line they came in on and the stroke ends on a flick. Same seed, same path, forever.',
    row(big),
  );
}

function kindsSection(): string {
  const body = SHAPE_KINDS.map((shape) => {
    const cells = ['one', 'two', 'three', 'four']
      .map((tag) =>
        cell(
          spec(shape, 300, 160, {
            seed: seedFromId(`i_${shape}_${tag}`),
            ...(shape === 'rect' ? { radius: 0 } : {}),
          }),
          `${shape} seed i_${shape}_${tag}`,
        ),
      )
      .join('');
    return `<h3>${shape}</h3>${row(cells)}`;
  }).join('\n');
  return section(
    'kinds',
    'Every kind, four seeds',
    'All five shape kinds at 300x160, stroke 2, --ink. Four different seeds each, so the wobble is visibly per-item rather than one canned drawing.',
    body,
  );
}

function sizeSection(): string {
  const sizes: [number, number][] = [
    [120, 48],
    [220, 110],
    [340, 180],
    [560, 140],
    [200, 240],
    [900, 220],
  ];
  const body = SHAPE_KINDS.map((shape) => {
    const cells = sizes
      .map(([width, height]) =>
        cell(
          spec(shape, width, height, { seed: seedFromId(`i_size_${shape}`), strokeWidth: 2 }),
          `${width}x${height}`,
        ),
      )
      .join('');
    return `<h3>${shape}</h3>${row(cells)}`;
  }).join('\n');
  return section(
    'sizes',
    'Six sizes, one seed per kind',
    'The same seed at six sizes. The number of humps, loops and waypoints never changes with the box, so dragging a resize handle scales the drawing instead of re-rolling it.',
    body,
  );
}

function strokeSection(): string {
  const widths = [1, 1.5, 2, 3, 5, 8];
  const body = (['squiggle', 'rect', 'ellipse', 'arrow', 'line'] as ShapeKind[])
    .map((shape) => {
      const cells = widths
        .map((strokeWidth) =>
          cell(
            spec(shape, 260, 130, {
              strokeWidth,
              seed: seedFromId(`i_stroke_${shape}`),
              ...(shape === 'rect' ? { radius: 10 } : {}),
            }),
            `sw ${strokeWidth}`,
          ),
        )
        .join('');
      return `<h3>${shape}</h3>${row(cells)}`;
    })
    .join('\n');
  return section(
    'strokes',
    'Stroke widths',
    'Stroke 1 to 8 at a fixed size and seed. Padding scales with the stroke, so a fat pen does not get its round caps clipped.',
    body,
  );
}

function colourSection(): string {
  const strokes = SITE_PALETTE.map((swatch) =>
    cell(
      spec('squiggle', 220, 110, {
        color: swatch.value,
        strokeWidth: 3,
        seed: seedFromId('i_colour_squiggle'),
      }),
      `${swatch.name} ${swatch.value}`,
    ),
  ).join('');

  const fills = (['rect', 'ellipse'] as ShapeKind[])
    .flatMap((shape) =>
      ['accent', 'blue', 'green', 'violet'].map((name) =>
        cell(
          spec(shape, 220, 150, {
            color: colour(name),
            fill: tint(colour(name)),
            strokeWidth: 2,
            seed: seedFromId(`i_fill_${shape}_${name}`),
            ...(shape === 'rect' ? { radius: 14 } : {}),
          }),
          `${shape} fill ${name}`,
        ),
      ),
    )
    .join('');

  const radii = [0, 4, 12, 28, 60, 400]
    .map((radius) =>
      cell(
        spec('rect', 240, 160, { radius, seed: seedFromId('i_radius'), strokeWidth: 2 }),
        `radius ${radius}`,
        { note: radius === 400 ? 'clamped to half the short side' : undefined },
      ),
    )
    .join('');

  return section(
    'colour',
    'Colour, fill and corner radius',
    'Stroke colour across the site palette; fill at 20% alpha under the stroke on rect and ellipse only; corner radius on rect only, clamped to half the short side.',
    `<h3>stroke colour</h3>${row(strokes)}<h3>fill</h3>${row(fills)}<h3>rect radius</h3>${row(radii)}`,
  );
}

function extremesSection(): string {
  const cells = [
    cell(spec('line', 420, 2, { color: colour('rule'), seed: seedFromId('i_dense_rule') }), 'line 420x2 (fixture rule)'),
    cell(spec('line', 400, 8, { seed: seedFromId('i_flat_line') }), 'line 400x8'),
    cell(spec('squiggle', 1100, 70, { strokeWidth: 2, seed: seedFromId('i_long_squiggle') }), 'squiggle 1100x70'),
    cell(spec('squiggle', 80, 300, { strokeWidth: 3, seed: seedFromId('i_tall_squiggle') }), 'squiggle 80x300'),
    cell(spec('arrow', 90, 280, { strokeWidth: 3, seed: seedFromId('i_tall_arrow') }), 'arrow 90x280'),
    cell(spec('ellipse', 40, 40, { strokeWidth: 2, seed: seedFromId('i_tiny_ellipse') }), 'ellipse 40x40'),
    cell(spec('rect', 36, 36, { strokeWidth: 3, radius: 6, seed: seedFromId('i_tiny_rect') }), 'rect 36x36 r6'),
    cell(spec('squiggle', 60, 60, { strokeWidth: 4, seed: seedFromId('i_tiny_squiggle') }), 'squiggle 60x60 sw4'),
    cell(spec('arrow', 120, 24, { strokeWidth: 2, seed: seedFromId('i_flat_arrow') }), 'arrow 120x24'),
    cell(spec('rect', 600, 30, { strokeWidth: 2, radius: 8, seed: seedFromId('i_flat_rect') }), 'rect 600x30 r8'),
  ].join('');
  return section(
    'extremes',
    'Degenerate boxes',
    'The shapes an author will actually make by accident: a 2px high rule, a very long thin squiggle, a taller-than-wide arrow, a 36px shape with a 3px pen. Nothing may escape its box or collapse.',
    row(cells),
  );
}

function fixtureSection(): string {
  const files = ['simple.json', 'canvas.json', 'dense.json'] as const;
  const blocks: string[] = [];
  for (const file of files) {
    const text = readFileSync(fileURLToPath(new URL(`../fixtures/${file}`, import.meta.url)), 'utf8');
    const result = validateDocJson(text);
    if (!result.ok) {
      blocks.push(`<h3>${file}</h3><p class="blurb">fixture did not validate</p>`);
      continue;
    }
    const items = result.doc.bands
      .filter(isCanvasBand)
      .flatMap((band) => band.items)
      .filter((item) => item.kind === 'shape');
    if (items.length === 0) {
      blocks.push(`<h3>${file}</h3><p class="blurb">no shape items</p>`);
      continue;
    }
    const cells = items
      .map((item) => {
        const itemSpec = shapeSpecFromItem(item);
        if (itemSpec === null) return '';
        return cell(
          itemSpec,
          `${item.id}`,
          { note: `${item.shape} ${item.w}x${item.h} sw${itemSpec.strokeWidth}` },
        );
      })
      .join('');
    blocks.push(`<h3>${file}</h3>${row(cells)}`);
  }
  return section(
    'fixtures',
    'WS-0 fixture parity',
    'Every shape item in the three fixtures, converted with shapeSpecFromItem and drawn at its authored size. This is exactly what WS-1 will put on the page and what WS-4 will show in the editor.',
    blocks.join('\n'),
  );
}

function scaleSection(): string {
  const ratios: [number, string][] = [
    [1, `1344px container (reference)`],
    [1100 / REFERENCE_WIDTH, '1100px container'],
    [390 / REFERENCE_WIDTH, '390px container'],
  ];
  const body = (['squiggle', 'rect', 'ellipse'] as ShapeKind[])
    .map((shape) => {
      const cells = ratios
        .map(([ratio, label]) =>
          cell(
            spec(shape, 420, 160, {
              strokeWidth: 3,
              seed: seedFromId(`i_scale_${shape}`),
              ...(shape === 'rect' ? { radius: 16 } : {}),
            }),
            label,
            { widthScale: ratio },
          ),
        )
        .join('');
      return `<h3>${shape}</h3>${row(cells)}`;
    })
    .join('\n');
  return section(
    'scaling',
    'Narrower containers',
    'preserveAspectRatio="none" is in the contract, so a drawing squashes horizontally when the content width is below 1344. Same SVG string, three container widths. The stroke goes slightly elliptical; the drawing stays a drawing.',
    body,
  );
}

function darkSection(): string {
  const cells = SHAPE_KINDS.map((shape) =>
    cell(
      spec(shape, 240, 130, {
        color: SITE_INK_DARK,
        strokeWidth: 2,
        seed: seedFromId(`i_dark_${shape}`),
        ...(shape === 'rect' ? { radius: 10 } : {}),
      }),
      shape,
    ),
  ).join('');
  const accent = SHAPE_KINDS.map((shape) =>
    cell(
      spec(shape, 240, 130, {
        color: ACCENT,
        strokeWidth: 2,
        seed: seedFromId(`i_dark_accent_${shape}`),
        ...(shape === 'rect' ? { radius: 10 } : {}),
      }),
      `${shape} accent`,
    ),
  ).join('');
  return `<section id="dark" class="dark"><h2>Dark ground</h2><p class="blurb">${escapeHtml(
    'The site has a dark mode. Shapes carry their own hex, so a stroke chosen on white has to be checked on #0f0f0f too.',
  )}</p>${row(cells)}${row(accent)}</section>`;
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

const sections = [
  heroSection(),
  kindsSection(),
  sizeSection(),
  strokeSection(),
  colourSection(),
  extremesSection(),
  fixtureSection(),
  scaleSection(),
  darkSection(),
].join('\n');

// Determinism, measured on exactly the specs this page drew.
let identical = 0;
const payload: string[] = [];
for (const item of drawn) {
  const once = generateShape(item);
  const twice = generateShape(item);
  if (once === twice) identical += 1;
  payload.push(once);
}
const digest = createHash('sha256').update(payload.join('')).digest('hex').slice(0, 16);
const banner =
  `${drawn.length} shapes drawn · ${identical}/${drawn.length} byte-identical when generated twice · ` +
  `payload sha256 ${digest}`;

const css = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #ffffff;
  color: #111111;
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { width: ${REFERENCE_WIDTH}px; margin: 0 auto; padding: 56px 0 120px; }
header h1 { font-size: 34px; margin: 0 0 6px; letter-spacing: -0.02em; }
header .sub { color: #6b6b6b; font-size: 14px; margin: 0 0 18px; }
.banner {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; color: #111111; background: #f6f6f6;
  border: 1px solid #e4e4e4; border-radius: 6px; padding: 10px 12px; margin-bottom: 10px;
}
nav { font-size: 13px; color: #6b6b6b; margin-bottom: 40px; }
nav a { color: #6b6b6b; text-decoration: none; margin-right: 14px; border-bottom: 1px solid #e4e4e4; }
nav a:hover { color: #ff5722; border-color: #ff5722; }
section { padding: 34px 0; border-top: 1px solid #e4e4e4; }
section h2 { font-size: 21px; margin: 0 0 6px; letter-spacing: -0.01em; }
section h3 {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
  color: #6b6b6b; font-weight: 500; margin: 26px 0 10px;
}
.blurb { color: #6b6b6b; font-size: 14px; line-height: 1.55; max-width: 76ch; margin: 0 0 8px; }
.row { display: flex; flex-wrap: wrap; gap: 26px 28px; align-items: flex-end; }
.cell { margin: 0; }
.stage { position: relative; outline: 1px dashed #ededed; outline-offset: 0; }
figcaption {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px; color: #9a9a9a; margin-top: 7px; max-width: 320px; line-height: 1.5;
}
figcaption .note { display: block; color: #c4c4c4; }
.dark { background: ${SITE_PAPER_DARK}; color: ${SITE_INK_DARK}; margin: 34px -40px 0; padding: 34px 40px 44px; border-radius: 10px; border-top: none; }
.dark h2 { color: ${SITE_INK_DARK}; }
.dark .blurb, .dark h3 { color: #8a8a8a; }
.dark .stage { outline-color: #2a2a2a; }
.dark figcaption { color: #6e6e6e; }
`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WS-6 asset catalogue</title>
<style>${css}</style>
</head>
<body>
<div class="wrap">
<header>
<h1>Asset catalogue</h1>
<p class="sub">WS-6 · src/cms/assets/shapes.ts · generateShape(spec) · drawn at reference pixels, 1:1, dashed outline is the item box</p>
<div class="banner">${escapeHtml(banner)}</div>
<nav>
<a href="#hero">squiggle</a><a href="#kinds">kinds</a><a href="#sizes">sizes</a><a href="#strokes">strokes</a><a href="#colour">colour</a><a href="#extremes">extremes</a><a href="#fixtures">fixtures</a><a href="#scaling">scaling</a><a href="#dark">dark</a>
</nav>
</header>
${sections}
</div>
</body>
</html>
`;

const target =
  process.argv[2] ?? fileURLToPath(new URL('./catalogue.html', import.meta.url));
writeFileSync(target, html, 'utf8');
console.log(`catalogue -> ${target}`);
console.log(banner);
if (identical !== drawn.length) {
  console.error('FAIL: generateShape is not deterministic');
  process.exit(1);
}
