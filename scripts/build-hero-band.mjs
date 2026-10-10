/**
 * scripts/build-hero-band.mjs
 *
 * Rewrite the homepage document's first band from one flattened image into the
 * 23 pieces the illustration was drawn as, using the geometry in
 * ./build-hero-assets.mjs — which is Paper's, read out of the file, not
 * measured off a screenshot.
 *
 * Only band 0 is touched. The prose band after it, and every `meta` field, are
 * written back exactly as they were found.
 *
 * ALT TEXT. Each piece carries a short name rather than a sentence, because
 * the renderer wraps the hero in `role="img"` with the one describing sentence
 * on it, which makes the whole subtree presentational: a screen reader says
 * the sentence once instead of reading 23 labels. The names are still worth
 * storing — they are what the editor lists down the side, and they are the
 * owner's own words from the component library.
 *
 *   node scripts/build-hero-band.mjs --check   # print, write nothing
 *   node scripts/build-hero-band.mjs           # rewrite home.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { manifest } from './build-hero-assets.mjs';

const DOC = new URL('../src/content/pages/home.json', import.meta.url).pathname;

/** Short, human, and the owner's own names where the library already had one. */
const NAMES = {
  // The ground the rest sit on, and the one piece whose alt describes the
  // WHOLE illustration: the renderer puts it on the hero's role="img"
  // wrapper, so a screen reader hears this sentence once. It is the alt the
  // single flattened hero carried before it was taken apart.
  grid:
    'A Korean 원고지 manuscript grid filled with hand-drawn scenes from Ryan Choi’s life, '
    + 'from a toddler swinging a golf club to a desk overlooking San Francisco.',
  '01-first-swing': 'First swing',
  '02-daejeon-family': 'Daejeon, family',
  '03-cello-hedgehog': 'Cello and hedgehog',
  '04-eagles-77': 'Eagles 77',
  '06-rc-buggy': 'RC buggy',
  '09-united': 'Manchester United',
  '10-alpine-carve': 'Alpine carve',
  '12-books': 'Books',
  '15-hats': 'Hats',
  '13-beret': 'Beret',
  'brush-choi': '최, in brush',
  'brush-jin': '진, in brush',
  'brush-hyeok': '혁, in brush',
  'jeju-hareubang': 'Jeju 하르방',
  '07-rugby': 'Rugby',
  '14-desk-2am': 'Desk at 2am',
  'd6-golden-gate': 'Golden Gate',
  '16-today': 'Today, San Francisco',
  'd1-spinning-top': 'Spinning top',
  'd4-marigold': 'Marigold',
  '11-clapperboard': 'Clapperboard',
  '08-cricket': 'Cricket',
};

/** `i_` then the piece name, with anything not a word character as `_`. */
function idFor(name) {
  return `i_${name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

function build() {
  const doc = JSON.parse(readFileSync(DOC, 'utf8'));
  const band = doc.bands[0];
  if (band === undefined || band.type !== 'canvas') {
    throw new Error('band 0 of the homepage is not a canvas band');
  }

  const items = manifest().map((piece) => {
    const alt = NAMES[piece.name];
    if (alt === undefined) throw new Error(`no name for piece "${piece.name}"`);
    return {
      id: idFor(piece.name),
      kind: 'image',
      src: piece.src,
      alt,
      x: piece.x,
      y: piece.y,
      w: piece.w,
      h: piece.h,
      z: piece.z,
    };
  });

  // The band keeps its height: the export carried 44px of bleed below the
  // 780px hero so the pencil in "Today" is complete, and global.css leans on
  // that number for the gap under the illustration.
  doc.bands[0] = { ...band, items };
  return doc;
}

const doc = build();
const json = `${JSON.stringify(doc, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const band = doc.bands[0];
  console.log(`band 0: ${band.items.length} items, ${band.height}px tall`);
  for (const item of band.items) {
    console.log(
      `  z${String(item.z).padStart(2)}  ${item.id.padEnd(26)} ` +
        `@(${item.x}, ${item.y}) ${item.w}x${item.h}  ${item.src}`,
    );
  }
} else {
  writeFileSync(DOC, json);
  console.log(`wrote ${DOC} — band 0 now holds ${doc.bands[0].items.length} items`);
}
