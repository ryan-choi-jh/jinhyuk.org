/**
 * scripts/build-hero-assets.mjs
 *
 * One-off: pull the homepage hero apart into the pieces it was drawn as.
 *
 * The hero shipped as ONE flattened 1344x824 export, so the CMS could only
 * ever treat it as a single image. In Paper it was never flat: a 원고지 grid
 * with 22 separately placed figures on it, every one of them a frame carrying
 * its own transparent PNG. This downloads those PNGs straight from Paper's
 * asset host and writes them into public/home/hero/, so the homepage document
 * can hold one canvas item per figure and each becomes editable on its own.
 *
 * THE GEOMETRY IS PAPER'S, NOT GUESSED. Every x/y/w/h below was read out of
 * the file with get_computed_styles. Positions are in the hero's own 1344x824
 * space: the grid frame sits at y=48 inside it, so a figure parented to the
 * grid has 48 added to its y, and the two figures parented to the hero itself
 * (the clapperboard and the cricketer) are already in that space. `z` is
 * document order, which is paint order, so a child that sat on top in Paper
 * sits on top here.
 *
 * SIZES. Each figure is written at 1.5x the size it is displayed at, never
 * larger than the source. The originals are 600-1250px for figures shown at
 * 29-485px, which would have put 2.3MB on the homepage to replace a 349KB
 * file. Measured alternatives, whole set: 1x/q90 is lighter than today but no
 * sharper, 1.5x/q86 is 517KB, 2x/q82 is 706KB. 1.5x is the pick because the
 * flattened hero it replaces was 1x — soft on any retina screen — so this is
 * sharper than the page is today for 168KB, and still leaves headroom to
 * enlarge a figure in the editor before it softens.
 *
 * Still on the table, not done: a second smaller set behind `srcset`. A phone
 * draws the hero about 342px wide, so it is being sent roughly six times the
 * pixels it can show.
 *
 * sharp rather than sips, which is what scripts/import-assets.ts uses and says
 * why: sips cannot write WebP. This script is a one-off run by hand on a Mac
 * with the repo installed, not something the site build depends on, so the
 * objection there (sharp is a transitive dependency of Astro, not ours) does
 * not apply the same way. Nothing it writes needs it again.
 *
 *   node scripts/build-hero-assets.mjs            # write the assets
 *   node scripts/build-hero-assets.mjs --manifest # just print the geometry
 */
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const FILE = '01M31033MRGGP0JYM3XMTVNECA';
const HOST = `https://app.paper.design/file-assets/${FILE}`;
const OUT = new URL('../public/home/hero/', import.meta.url).pathname;

/** How much bigger than its display size each figure is written, and at what quality. */
const SCALE = 2;
const QUALITY = 82;

/** The grid frame's offset inside the hero, added to every figure on it. */
const GRID_Y = 48;

/**
 * name, Paper asset id, x, y, w, h, z, and whether y is already hero-space.
 * `onGrid: false` means the node is a child of the hero, not of the grid.
 */
const PIECES = [
  ['grid',            '13G3CSXZWWGNX8Q261CVKG9KC2',    0,    48,   1344, 732, 0,  false],
  ['01-first-swing',  '45Z27WNE9WACZ0T04QA90T9PV6',   22,   -30,    174, 150, 1,  true],
  ['02-daejeon-family','4C8ZNFVC2V5TGT8ZW2YPM77HHS', 429,   126,    485, 319, 2,  true],
  ['03-cello-hedgehog','6N3T7QH2D2AFP3TSHQ43RWMPTM', 382,   502,    151, 157, 3,  true],
  ['04-eagles-77',    '2S727WXV8WGC102G3QJSTW8TYA', 1207,   141,    131, 104, 4,  true],
  ['06-rc-buggy',     '0HXSSH0N8JJXTEKSQB51PMN3SC',  849,    68,    124, 125, 5,  true],
  ['09-united',       '4N18XKHA9EZXYBT4G3M38ND9W4',  998,   432,    186, 170, 6,  true],
  ['10-alpine-carve', '45EVVTH4E2WCT1TBQFM2MXNESC',  -50, 249.5,    264, 163, 7,  true],
  ['12-books',        '7JFX4DT1K3ZJGWNDW06QFBPD0S', 1073,    31,    139,  90, 8,  true],
  ['15-hats',         '7QM3JYD4XW8415ZJ1DHSDT8J8A',  309, 391.5,     62,  90, 9,  true],
  ['13-beret',        '0VET2P0XY226667QGD90ZWNPCM',  713,   516,    214, 204, 10, true],
  ['brush-choi',      '3QJS6H9GX2X780Z3G59GXXN088',    7, 134.5,     33,  41, 11, true],
  ['brush-jin',       '7Q610VNTWM8NQFZP39WA9XRKAP',   50, 136.5,     42,  37, 12, true],
  ['brush-hyeok',     '1A27T4PDNX23KM5ADCMF77BJ1Z',  100, 134.5,     36,  41, 13, true],
  ['jeju-hareubang',  '01M4C5VK9YHW6A9F0T0PPS2WMR', 1140, 600.5,    204, 136, 14, true],
  ['07-rugby',        '5N53XTC084RYS8V87KVTWZRQRA',  197, 201.5,    112, 114, 15, true],
  ['14-desk-2am',     '24GZ56A62V3VMGSBRJ1P006SKH',  964,   249,    188, 117, 16, true],
  // A child of 14-desk-2am in Paper (offset -60, -20.5 from it), so it is
  // resolved into hero space here and paints directly above it.
  ['d6-golden-gate',  '1PGY46JPGBNHPSWBSGY7HD6X0N',  904, 228.5,    120,  74, 17, true],
  ['16-today',        '2HZKBZ4D805CKDJH7ZQ8YGG4WE',   12,   472,    176, 269, 18, true],
  ['d1-spinning-top', '2YQPR0E6HSFH9WD1DRDY1C317V',  196, 685.5,     29,  34, 19, true],
  ['d4-marigold',     '7JTNWE65HSXG3TMB8GVC73294Z',  657, 693.5,     66,  29, 20, true],
  ['11-clapperboard', '1PD7T4F0JN02HJWR8CKWX6VP0V',  412,    49,    200, 182, 21, false],
  ['08-cricket',      '6GC5Z0E1558ADWHYDPFWY7TYJK', 1219,   390,    119, 139, 22, false],
];

/** The manifest the homepage document is built from. */
export function manifest() {
  return PIECES.map(([name, asset, x, y, w, h, z, onGrid]) => ({
    name,
    asset,
    src: `/home/hero/${name}.webp`,
    x,
    y: onGrid ? y + GRID_Y : y,
    w,
    h,
    z,
  }));
}

async function main() {
  const rows = manifest();

  if (process.argv.includes('--manifest')) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  mkdirSync(OUT, { recursive: true });
  let total = 0;

  for (const row of rows) {
    const url = `${HOST}/${row.asset}.png`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${row.name}: ${response.status} from ${url}`);
    const source = Buffer.from(await response.arrayBuffer());

    const meta = await sharp(source).metadata();
    // Twice what it is displayed at, but never upscale past the original.
    const target = Math.min(meta.width ?? row.w * SCALE, Math.round(row.w * SCALE));
    const out = join(OUT, `${row.name}.webp`);

    await sharp(source)
      .resize({ width: target, withoutEnlargement: true })
      .webp({ quality: QUALITY, effort: 6 })
      .toFile(out);

    const bytes = statSync(out).size;
    total += bytes;
    const alpha = meta.hasAlpha === true ? 'alpha' : 'OPAQUE';
    console.log(
      `  ${row.name.padEnd(20)} ${String(meta.width).padStart(5)}px -> ${String(target).padStart(5)}px  ` +
        `${String(Math.round(bytes / 1024)).padStart(5)}KB  ${alpha}  @(${row.x},${row.y}) ${row.w}x${row.h}`,
    );
  }

  console.log(`\n  ${rows.length} pieces, ${Math.round(total / 1024)}KB total`);
  const flat = join(OUT, '..', 'hero.webp');
  if (existsSync(flat)) {
    console.log(`  the flattened hero it replaces: ${Math.round(statSync(flat).size / 1024)}KB`);
  }
}

// Only when run directly. `manifest()` is imported by other scripts to build
// the homepage document from the same geometry, and importing it must not
// re-download 23 files as a side effect.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
