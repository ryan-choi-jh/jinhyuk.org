/**
 * scripts/add-hero-library-assets.mjs
 *
 * One-off: put the four hero pieces that were never in the component library
 * into it — the three 최진혁 brush strokes and the Jeju 하르방.
 *
 * The other nineteen pieces of the illustration were imported long ago by
 * scripts/import-assets.ts and are in the catalogue already. These four only
 * ever existed inside the flattened hero, so taking the hero apart is the
 * first time they have been files at all. They now go in alongside the rest,
 * so they can be dropped onto any page rather than only living on the
 * homepage.
 *
 * Conventions copied from the existing entries rather than invented:
 *   /library/<name>.webp          the asset at its SOURCE size, not the hero's
 *   /library/thumbs/<id>.png      a preview, longest side 600
 *   id `a_<name>-png`             the importer's id, from the original file
 *   width/height                  the source's, which is what the browser gets
 *
 * Idempotent: an id already in the catalogue is left exactly as it is, so a
 * second run cannot overwrite a name or a tag list that has been curated since.
 *
 *   node scripts/add-hero-library-assets.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const FILE = '01M31033MRGGP0JYM3XMTVNECA';
const HOST = `https://app.paper.design/file-assets/${FILE}`;
const ROOT = new URL('../', import.meta.url).pathname;
const CATALOGUE = join(ROOT, 'src/cms/app/library/catalogue.seed.json');
const LIB = join(ROOT, 'public/library');
const THUMBS = join(LIB, 'thumbs');

/** Longest side of a preview, matching every other entry in the catalogue. */
const THUMB_MAX = 600;

const NEW = [
  {
    name: 'brush-choi',
    asset: '3QJS6H9GX2X780Z3G59GXXN088',
    label: '최, in brush',
    category: 'signature',
    tags: ['brush', 'hangul', 'ink', 'name', 'paper'],
  },
  {
    name: 'brush-jin',
    asset: '7Q610VNTWM8NQFZP39WA9XRKAP',
    label: '진, in brush',
    category: 'signature',
    tags: ['brush', 'hangul', 'ink', 'name', 'paper'],
  },
  {
    name: 'brush-hyeok',
    asset: '1A27T4PDNX23KM5ADCMF77BJ1Z',
    label: '혁, in brush',
    category: 'signature',
    tags: ['brush', 'hangul', 'ink', 'name', 'paper'],
  },
  {
    name: 'jeju-hareubang',
    asset: '01M4C5VK9YHW6A9F0T0PPS2WMR',
    label: 'Jeju 하르방',
    category: 'hero-scene',
    tags: ['jeju', 'korea', 'paper', 'scene', 'stone'],
    note: 'The three stone grandfathers and the 한라봉, bottom right of the hero grid.',
  },
];

async function main() {
  mkdirSync(THUMBS, { recursive: true });
  const catalogue = JSON.parse(readFileSync(CATALOGUE, 'utf8'));
  const have = new Set(catalogue.entries.map((entry) => entry.id));
  let added = 0;

  for (const piece of NEW) {
    const id = `a_${piece.name}-png`;
    if (have.has(id)) {
      console.log(`  ${piece.name.padEnd(18)} already in the catalogue, left alone`);
      continue;
    }

    const response = await fetch(`${HOST}/${piece.asset}.png`);
    if (!response.ok) throw new Error(`${piece.name}: ${response.status}`);
    const source = Buffer.from(await response.arrayBuffer());
    const meta = await sharp(source).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;

    const webp = join(LIB, `${piece.name}.webp`);
    await sharp(source).webp({ quality: 90, effort: 6 }).toFile(webp);

    const scale = THUMB_MAX / Math.max(width, height);
    const tw = Math.max(1, Math.round(width * Math.min(1, scale)));
    const th = Math.max(1, Math.round(height * Math.min(1, scale)));
    const thumb = join(THUMBS, `${id.slice(2)}.png`);
    await sharp(source).resize(tw, th).png().toFile(thumb);

    catalogue.entries.push({
      id,
      kind: 'asset',
      name: piece.label,
      category: piece.category,
      tags: piece.tags,
      ...(piece.note === undefined ? {} : { note: piece.note }),
      src: `/library/${piece.name}.webp`,
      width,
      height,
      transparent: meta.hasAlpha === true,
      format: 'webp',
      bytes: statSync(webp).size,
      preview: { src: `/library/thumbs/${id.slice(2)}.png`, w: tw, h: th },
    });
    added++;
    console.log(
      `  ${piece.name.padEnd(18)} ${width}x${height}  ${Math.round(statSync(webp).size / 1024)}KB  ` +
        `-> ${piece.category}`,
    );
  }

  if (added > 0) {
    writeFileSync(CATALOGUE, `${JSON.stringify(catalogue, null, 2)}\n`);
  }
  console.log(`\n  ${added} added, ${catalogue.entries.length} entries in the catalogue`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
