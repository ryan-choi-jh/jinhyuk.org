/**
 * src/cms/server/media-dimensions.ts
 *
 * WS-2. Intrinsic width and height, read from the file's own header.
 *
 * Why not `sharp`: it is present in node_modules only because astro pulls it
 * in as an optional, platform-specific dependency for image optimisation. It
 * is not a dependency of this project, the brief forbids adding one, and
 * depending on another package's transitive optional native binary is exactly
 * the sort of thing that works locally and fails on a deploy. A header parse
 * is a hundred lines, has no install step, and would be needed for video
 * anyway, which sharp cannot read.
 *
 * The editor needs these numbers to place an item at a sane size without
 * waiting for the browser to load the file (docs/cms-rebuild.md 3.5).
 *
 * Everything here is a pure function over a Buffer. No I/O, no throwing on
 * malformed input: a file this cannot read returns null and the caller
 * decides what to do about it.
 */

export type Dimensions = {
  w: number;
  h: number;
  /** What the bytes said they were, which is not always what the name said. */
  format: string;
  /**
   * 'intrinsic' when the numbers came out of the file.
   * 'declared'  when they came from markup that may be unitless (SVG).
   * 'fallback'  when the format is one this cannot read and a default was used.
   */
  source: 'intrinsic' | 'declared' | 'fallback';
};

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

const READERS: ((bytes: Buffer) => Dimensions | null)[] = [
  readPng,
  readJpeg,
  readGif,
  readWebp,
  readIsoImage,
  readIsoVideo,
  readSvg,
];

/**
 * Intrinsic size of an image or video, from its header. Null when the format
 * is not one of PNG, JPEG, GIF, WebP, AVIF/HEIC, SVG, MP4 or MOV, or when the
 * header is truncated or malformed.
 */
export function mediaDimensions(bytes: Buffer): Dimensions | null {
  for (const read of READERS) {
    const found = read(bytes);
    if (found !== null && found.w > 0 && found.h > 0) return found;
  }
  return null;
}

/**
 * Never-null variant, for the upload endpoint: a format this cannot read
 * still has to come back with numbers the editor can place a box with. A
 * 16:9 box is the least surprising guess, and `source` says it was a guess.
 */
export function mediaDimensionsOrFallback(bytes: Buffer, format: string): Dimensions {
  const found = mediaDimensions(bytes);
  if (found !== null) return found;
  return { w: 1280, h: 720, format, source: 'fallback' };
}

/* -------------------------------------------------------------------------- */
/* PNG                                                                         */
/* -------------------------------------------------------------------------- */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPng(bytes: Buffer): Dimensions | null {
  if (bytes.length < 24) return null;
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) return null;
  // The IHDR chunk is mandatory and first: length(4) type(4) width(4) height(4).
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return {
    w: bytes.readUInt32BE(16),
    h: bytes.readUInt32BE(20),
    format: 'png',
    source: 'intrinsic',
  };
}

/* -------------------------------------------------------------------------- */
/* JPEG                                                                        */
/* -------------------------------------------------------------------------- */

/** Start-of-frame markers, the ones that carry the frame size. */
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function readJpeg(bytes: Buffer): Dimensions | null {
  if (bytes.length < 4) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      // Fill bytes and entropy-coded data; resynchronise on the next marker.
      offset += 1;
      continue;
    }
    let marker = bytes[offset + 1] as number;
    // 0xFF padding before a marker is legal.
    let cursor = offset + 1;
    while (marker === 0xff && cursor + 1 < bytes.length) {
      cursor += 1;
      marker = bytes[cursor] as number;
    }
    // Standalone markers: no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = cursor + 1;
      continue;
    }
    if (marker === 0xd9) return null; // end of image, no frame found
    if (cursor + 3 >= bytes.length) return null;
    const length = bytes.readUInt16BE(cursor + 1);
    if (length < 2) return null;
    if (JPEG_SOF.has(marker)) {
      // SOF payload: length(2) precision(1) height(2) width(2)
      if (cursor + 8 > bytes.length) return null;
      return {
        h: bytes.readUInt16BE(cursor + 4),
        w: bytes.readUInt16BE(cursor + 6),
        format: 'jpeg',
        source: 'intrinsic',
      };
    }
    if (marker === 0xda) return null; // start of scan: the frame header is behind us
    offset = cursor + 1 + length;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* GIF                                                                         */
/* -------------------------------------------------------------------------- */

function readGif(bytes: Buffer): Dimensions | null {
  if (bytes.length < 10) return null;
  const magic = bytes.toString('ascii', 0, 6);
  if (magic !== 'GIF87a' && magic !== 'GIF89a') return null;
  return {
    w: bytes.readUInt16LE(6),
    h: bytes.readUInt16LE(8),
    format: 'gif',
    source: 'intrinsic',
  };
}

/* -------------------------------------------------------------------------- */
/* WebP                                                                        */
/* -------------------------------------------------------------------------- */

function readWebp(bytes: Buffer): Dimensions | null {
  if (bytes.length < 30) return null;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = bytes.toString('ascii', 12, 16);

  if (chunk === 'VP8X') {
    // Extended format. Canvas size is 24-bit little-endian, minus one, after
    // four bytes of feature flags. This is the authoritative size when the
    // file has an alpha or animation chunk, so it is checked first.
    const base = 20;
    const w = 1 + (bytes.readUIntLE(base + 4, 3) & 0xffffff);
    const h = 1 + (bytes.readUIntLE(base + 7, 3) & 0xffffff);
    return { w, h, format: 'webp', source: 'intrinsic' };
  }

  if (chunk === 'VP8 ') {
    // Lossy. Key frame: 3 bytes frame tag, then the sync code 9d 01 2a, then
    // two 16-bit little-endian fields whose low 14 bits are the dimensions.
    const base = 20;
    if (bytes[base + 3] !== 0x9d || bytes[base + 4] !== 0x01 || bytes[base + 5] !== 0x2a) {
      return null;
    }
    return {
      w: bytes.readUInt16LE(base + 6) & 0x3fff,
      h: bytes.readUInt16LE(base + 8) & 0x3fff,
      format: 'webp',
      source: 'intrinsic',
    };
  }

  if (chunk === 'VP8L') {
    // Lossless. One signature byte, then 14 bits of width-1 and 14 of height-1
    // packed little-endian.
    const base = 20;
    if (bytes[base] !== 0x2f) return null;
    const packed = bytes.readUInt32LE(base + 1);
    return {
      w: 1 + (packed & 0x3fff),
      h: 1 + ((packed >> 14) & 0x3fff),
      format: 'webp',
      source: 'intrinsic',
    };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* ISO base media (AVIF, HEIC, MP4, MOV)                                       */
/* -------------------------------------------------------------------------- */

type Box = { type: string; start: number; end: number };

/** Walk the boxes in [from, to). Tolerates truncation by stopping. */
function* boxes(bytes: Buffer, from: number, to: number): Generator<Box> {
  let offset = from;
  while (offset + 8 <= to) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    let start = offset + 8;
    if (size === 1) {
      if (offset + 16 > to) return;
      // 64-bit size. Anything over 2^53 is not a real file; readBigUInt64BE
      // then Number() is exact for every size that fits in a commit.
      size = Number(bytes.readBigUInt64BE(offset + 8));
      start = offset + 16;
    } else if (size === 0) {
      size = to - offset; // to end of file
    }
    if (size < 8) return;
    const end = Math.min(offset + size, to);
    if (start > end) return;
    yield { type, start, end };
    offset += size;
  }
}

function findBox(bytes: Buffer, from: number, to: number, type: string): Box | null {
  for (const box of boxes(bytes, from, to)) {
    if (box.type === type) return box;
  }
  return null;
}

function isoBrand(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  const first = findBox(bytes, 0, bytes.length, 'ftyp');
  if (first === null || first.start !== 8) return null;
  return bytes.toString('ascii', first.start, Math.min(first.start + 4, first.end));
}

/**
 * AVIF and HEIC. The size lives in an `ispe` box, buried four containers deep
 * inside `meta`. Two neighbours of it matter and are easy to miss:
 *
 *  - `clap`, the clean aperture, which crops the coded size down to the real
 *    display size. Apple's encoder pads to even dimensions, so a 37x11 image
 *    has ispe 38x12 and clap 37x11. Reading ispe alone is wrong by a pixel on
 *    every odd-sized image out of an Apple tool.
 *  - `irot`, a rotation in 90 degree steps, which every iPhone portrait photo
 *    carries. Without it, every portrait HEIC is placed as a landscape box.
 *
 * A file with thumbnails has several of each in one `ipco`, with no property
 * association parsed here; the first of each belongs to the primary item in
 * every encoder's output, and this is a size hint for an editor rather than a
 * decoder.
 */
function readIsoImage(bytes: Buffer): Dimensions | null {
  const brand = isoBrand(bytes);
  if (brand === null) return null;
  const imageBrands = new Set(['avif', 'avis', 'heic', 'heix', 'hevc', 'mif1', 'msf1']);
  if (!imageBrands.has(brand)) return null;

  const meta = findBox(bytes, 0, bytes.length, 'meta');
  if (meta === null) return null;
  // `meta` is a full box: four bytes of version and flags before its children.
  const iprp = findBox(bytes, meta.start + 4, meta.end, 'iprp');
  if (iprp === null) return null;
  const ipco = findBox(bytes, iprp.start, iprp.end, 'ipco');
  if (ipco === null) return null;

  let ispe: Box | null = null;
  let clap: Box | null = null;
  let irot: Box | null = null;
  for (const box of boxes(bytes, ipco.start, ipco.end)) {
    if (box.type === 'ispe' && ispe === null) ispe = box;
    else if (box.type === 'clap' && clap === null) clap = box;
    else if (box.type === 'irot' && irot === null) irot = box;
  }
  if (ispe === null || ispe.start + 12 > ispe.end) return null;

  // ispe is a full box: version and flags, then width and height.
  let w = bytes.readUInt32BE(ispe.start + 4);
  let h = bytes.readUInt32BE(ispe.start + 8);

  if (clap !== null && clap.start + 16 <= clap.end) {
    const widthN = bytes.readInt32BE(clap.start);
    const widthD = bytes.readInt32BE(clap.start + 4);
    const heightN = bytes.readInt32BE(clap.start + 8);
    const heightD = bytes.readInt32BE(clap.start + 12);
    if (widthD > 0 && heightD > 0 && widthN > 0 && heightN > 0) {
      const croppedW = Math.round(widthN / widthD);
      const croppedH = Math.round(heightN / heightD);
      // Only ever a crop. A clap claiming to be bigger than the coded frame is
      // a broken file, and trusting it would place the item at a wrong ratio.
      if (croppedW <= w && croppedH <= h) {
        w = croppedW;
        h = croppedH;
      }
    }
  }

  if (irot !== null && irot.start < irot.end) {
    const angle = (bytes[irot.start] as number) & 0x03; // 0, 1, 2, 3 => 0, 90, 180, 270
    if (angle === 1 || angle === 3) {
      const swap = w;
      w = h;
      h = swap;
    }
  }

  return {
    w,
    h,
    format: brand === 'avif' || brand === 'avis' ? 'avif' : 'heic',
    source: 'intrinsic',
  };
}

/**
 * MP4 and MOV. Display size comes from the first `trak` whose `tkhd` has a
 * non-zero size, which skips the audio track. A phone video stores its
 * portrait orientation in the track matrix rather than in the size, so a 90 or
 * 270 degree matrix swaps them; without that, every video shot on a phone
 * would be placed as a landscape box.
 */
function readIsoVideo(bytes: Buffer): Dimensions | null {
  const brand = isoBrand(bytes);
  if (brand === null) return null;
  const videoBrands = new Set([
    'isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'qt  ',
  ]);
  if (!videoBrands.has(brand)) return null;

  const moov = findBox(bytes, 0, bytes.length, 'moov');
  if (moov === null) return null;

  for (const trak of boxes(bytes, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue;
    const tkhd = findBox(bytes, trak.start, trak.end, 'tkhd');
    if (tkhd === null) continue;
    const version = bytes[tkhd.start];
    // version/flags(4) + times(20 or 32) + reserved(8) + layer+group(4)
    // + volume+reserved(4) = where the 9-element matrix starts.
    const matrixAt = tkhd.start + 4 + (version === 1 ? 32 : 20) + 8 + 4 + 4;
    const sizeAt = matrixAt + 36;
    if (sizeAt + 8 > tkhd.end) continue;
    const width = bytes.readUInt32BE(sizeAt) / 65536;
    const height = bytes.readUInt32BE(sizeAt + 4) / 65536;
    if (width <= 0 || height <= 0) continue;
    // Matrix is {a,b,u, c,d,v, x,y,w} in 16.16 except u,v,w. A rotation of 90
    // or 270 degrees has a == d == 0 and b, c non-zero.
    const a = bytes.readInt32BE(matrixAt);
    const b = bytes.readInt32BE(matrixAt + 4);
    const c = bytes.readInt32BE(matrixAt + 12);
    const d = bytes.readInt32BE(matrixAt + 16);
    const quarterTurn = a === 0 && d === 0 && b !== 0 && c !== 0;
    const w = Math.round(quarterTurn ? height : width);
    const h = Math.round(quarterTurn ? width : height);
    return { w, h, format: brand === 'qt  ' ? 'mov' : 'mp4', source: 'intrinsic' };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* SVG                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * SVG has no intrinsic pixel size, only what the markup declares, so this is
 * `source: 'declared'`. width and height win when they are plain numbers or
 * px; otherwise the viewBox gives the aspect ratio, which is what the editor
 * actually needs to place a box.
 */
function readSvg(bytes: Buffer): Dimensions | null {
  const head = bytes.subarray(0, Math.min(bytes.length, 4096)).toString('utf8');
  const tag = head.match(/<svg\b[^>]*>/i);
  if (tag === null) return null;
  const open = tag[0];

  const attr = (name: string): string | null => {
    const found = open.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
    if (found === null) return null;
    return found[2] ?? found[3] ?? null;
  };

  const asPx = (raw: string | null): number | null => {
    if (raw === null) return null;
    const found = raw.trim().match(/^(-?\d*\.?\d+)\s*(px)?$/i);
    if (found === null) return null;
    const value = Number(found[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  const w = asPx(attr('width'));
  const h = asPx(attr('height'));
  if (w !== null && h !== null) {
    return { w: Math.round(w), h: Math.round(h), format: 'svg', source: 'declared' };
  }

  const viewBox = attr('viewBox');
  if (viewBox !== null) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      const vw = parts[2] as number;
      const vh = parts[3] as number;
      if (vw > 0 && vh > 0) {
        return {
          w: Math.round(w ?? vw),
          h: Math.round(h ?? vh),
          format: 'svg',
          source: 'declared',
        };
      }
    }
  }
  return null;
}
