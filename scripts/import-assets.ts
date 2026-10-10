/**
 * scripts/import-assets.ts
 *
 * Bring a folder of exported artwork into the CMS component library.
 *
 *   node scripts/import-assets.ts <dir> [options]
 *
 * For every image it finds it will:
 *
 *   1. copy the file into public/library/ under a stable, path-derived name;
 *   2. read its intrinsic width and height from the file itself;
 *   3. detect an alpha channel, so the library draws it on a chequerboard
 *      instead of on a flat panel where a transparent PNG is invisible;
 *   4. write a thumbnail for anything over --thumb-max px on its long edge,
 *      because a 1206x2622 phone screenshot is 1.8MB and must not be what a
 *      90px grid tile downloads;
 *   5. add or update the entry in the catalogue JSON.
 *
 * ---------------------------------------------------------------------------
 * The two promises this script makes
 *
 * IDEMPOTENT. Run it twice and the second run copies nothing, writes no
 * thumbnail and leaves the catalogue byte-identical. Entry ids are derived
 * from the file's path relative to the scanned directory, not from a counter,
 * so nothing renumbers.
 *
 * NEVER CLOBBERS CURATION. `name`, `category`, `tags` and `note` on an entry
 * that already exists are hand-curated and are never written again, only read.
 * Re-running after renaming "IMG 2065" to "Track, week view" keeps the new
 * name. Everything measured from the file (src, width, height, transparent,
 * format, bytes, preview) is refreshed, because that is what the file says.
 *
 * ---------------------------------------------------------------------------
 * Options
 *
 *   --dry-run            print the plan, touch nothing
 *   --catalogue <path>   default src/cms/app/library/catalogue.seed.json
 *   --dest <dir>         default public/library
 *   --public-base <path> default /library    (the URL prefix for --dest)
 *   --in-place           do not copy; reference the files where they already
 *                        are. Only valid for a directory inside public/.
 *                        This is how the seed catalogue was built from the
 *                        images already on the site.
 *   --category <slug>    category for NEW entries (default: inferred from the
 *                        first path segment under <dir>, else "imported")
 *   --tag <slug>         extra tag for NEW entries; repeatable
 *   --thumb-max <px>     long-edge threshold and thumbnail size, default 600
 *   --no-recursive       do not walk subdirectories
 *   --force-thumbs       rewrite thumbnails that already exist
 *   --quiet              only print the summary
 *
 * ---------------------------------------------------------------------------
 * Why sips
 *
 * Measuring and resizing are done with /usr/bin/sips, the image tool that
 * ships with macOS. The alternative was `sharp`, which is in node_modules only
 * because astro pulls it in as an optional, platform-specific dependency;
 * WS-2's media-dimensions.ts rejected it for that reason and this agrees. sips
 * needs no install, reads PNG, JPEG, WebP, GIF, HEIC and AVIF, and reports
 * `hasAlpha` correctly for palette PNGs with a tRNS chunk, which a hand-rolled
 * header parse usually gets wrong.
 *
 * The cost is that this script is macOS-only. It is an import tool run by one
 * person on one laptop, so that is the right trade. SVG is handled in pure JS
 * below, because sips cannot read it.
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCatalogue } from '../src/cms/app/library/schema.ts';
import type { AssetEntry, LibraryCatalogue, LibraryEntry } from '../src/cms/app/library/schema.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

type Options = {
  dir: string;
  cataloguePath: string;
  destDir: string;
  publicBase: string;
  inPlace: boolean;
  category: string | null;
  tags: string[];
  thumbMax: number;
  recursive: boolean;
  dryRun: boolean;
  forceThumbs: boolean;
  quiet: boolean;
};

const USAGE = `usage: node scripts/import-assets.ts <dir> [--dry-run] [--catalogue p] [--dest d]
       [--public-base /library] [--in-place] [--category slug] [--tag slug]...
       [--thumb-max 600] [--no-recursive] [--force-thumbs] [--quiet]`;

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dir: '',
    cataloguePath: join(REPO, 'src/cms/app/library/catalogue.seed.json'),
    destDir: join(REPO, 'public/library'),
    publicBase: '/library',
    inPlace: false,
    category: null,
    tags: [],
    thumbMax: 600,
    recursive: true,
    dryRun: false,
    forceThumbs: false,
    quiet: false,
  };

  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--help':
      case '-h':
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--in-place':
        options.inPlace = true;
        break;
      case '--no-recursive':
        options.recursive = false;
        break;
      case '--force-thumbs':
        options.forceThumbs = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--catalogue':
        options.cataloguePath = resolve(next(index, arg));
        index += 1;
        break;
      case '--dest':
        options.destDir = resolve(next(index, arg));
        index += 1;
        break;
      case '--public-base':
        options.publicBase = `/${next(index, arg).replace(/^\/+|\/+$/g, '')}`;
        index += 1;
        break;
      case '--category':
        options.category = slugify(next(index, arg));
        index += 1;
        break;
      case '--tag':
        options.tags.push(slugify(next(index, arg)));
        index += 1;
        break;
      case '--thumb-max': {
        const value = Number(next(index, arg));
        if (!Number.isFinite(value) || value < 32) throw new Error('--thumb-max must be >= 32');
        options.thumbMax = Math.round(value);
        index += 1;
        break;
      }
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
        if (options.dir !== '') throw new Error('only one directory, please');
        options.dir = resolve(arg);
        break;
    }
  }

  if (options.dir === '') throw new Error(`no directory given\n${USAGE}`);
  if (!existsSync(options.dir) || !statSync(options.dir).isDirectory()) {
    throw new Error(`not a directory: ${options.dir}`);
  }
  if (options.inPlace) {
    const publicDir = join(REPO, 'public');
    if (relative(publicDir, options.dir).startsWith('..')) {
      throw new Error('--in-place only works for a directory inside public/');
    }
  }
  return options;
}

/* -------------------------------------------------------------------------- */
/* Naming                                                                      */
/* -------------------------------------------------------------------------- */

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.heic']);

function slugify(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Slug for a file path. Unlike `slugify` this does NOT split camel case, so a
 * YouTube id stays `eudrajwcwwg` rather than becoming `eudraj-wcwwg`.
 */
function slugifyPath(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/**
 * Stable slug from the path relative to the scanned directory.
 *
 * The whole path is used, not the basename, so `blocks/2/value/src.png` and
 * `blocks/6/value/src.png` do not both become "src". The extension is kept
 * too, so `hero.webp` and `hero.jpg` are two assets rather than one asset
 * that flickers between two formats on every run. Long paths are truncated
 * and hashed, which keeps the id inside `IdSchema`'s 64 characters without
 * ever colliding.
 */
function slugForRelative(relativePath: string): string {
  const full = slugifyPath(relativePath.split(sep).join('-'));
  if (full === '') return fnv1a(relativePath);
  if (full.length <= 54) return full;
  return `${full.slice(0, 44).replace(/-+$/, '')}-${fnv1a(relativePath)}`;
}

/** "img-2065" -> "Img 2065"; "track-daily-habit-tracker" -> "Track daily habit tracker". */
function titleFor(relativePath: string): string {
  const stem = basename(relativePath, extname(relativePath));
  const words = slugify(stem).replace(/-/g, ' ').trim();
  if (words === '') return basename(relativePath);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Inferred category: the first path segment under the scanned directory. */
function categoryFor(relativePath: string, fallback: string | null): string {
  if (fallback !== null) return fallback;
  const segments = relativePath.split(sep);
  if (segments.length > 1) {
    const slug = slugify(segments[0]);
    if (slug !== '') return slug;
  }
  return 'imported';
}

/**
 * Tags inferred for a NEW entry only: the directory segments it came from,
 * plus its format. Enough to find the thing again; the owner curates from
 * there and the curation is never overwritten.
 */
function tagsFor(relativePath: string, format: string, extra: readonly string[]): string[] {
  const segments = relativePath.split(sep).slice(0, -1).map(slugify).filter((one) => one !== '');
  const unique = new Set<string>([...segments, format, ...extra]);
  unique.delete('');
  return [...unique].slice(0, 24);
}

/* -------------------------------------------------------------------------- */
/* Probing                                                                     */
/* -------------------------------------------------------------------------- */

type Probe = { width: number; height: number; format: string; transparent: boolean };

function sips(args: string[]): string {
  return execFileSync('/usr/bin/sips', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // /usr/bin tools on this machine need the command-line tools dev dir until
    // the Xcode licence is accepted; harmless when it already is.
    env: { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? '/Library/Developer/CommandLineTools' },
  });
}

function sipsProbe(file: string): Probe | null {
  let out: string;
  try {
    out = sips(['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'hasAlpha', '-g', 'format', file]);
  } catch {
    return null;
  }
  const read = (key: string): string | null => {
    const match = out.match(new RegExp(`${key}:\\s*(\\S+)`));
    return match === null ? null : match[1];
  };
  const width = Number(read('pixelWidth'));
  const height = Number(read('pixelHeight'));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return {
    width: Math.round(width),
    height: Math.round(height),
    format: (read('format') ?? extname(file).slice(1)).toLowerCase(),
    transparent: read('hasAlpha') === 'yes',
  };
}

/**
 * SVG, in pure JS, because sips cannot read it. Width and height attributes
 * first, falling back to the viewBox, which is what a Paper export usually
 * carries. A vector always counts as transparent.
 */
function svgProbe(file: string): Probe | null {
  const text = readFileSync(file, 'utf8').slice(0, 4096);
  const tag = text.match(/<svg\b[^>]*>/i);
  if (tag === null) return null;
  const attr = (name: string): number | null => {
    const match = tag[0].match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
    if (match === null) return null;
    const value = Number.parseFloat(match[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  let width = attr('width');
  let height = attr('height');
  if (width === null || height === null) {
    const viewBox = tag[0].match(/\bviewBox\s*=\s*["']([^"']+)["']/i);
    if (viewBox !== null) {
      const parts = viewBox[1].trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every((value) => Number.isFinite(value))) {
        width = width ?? parts[2];
        height = height ?? parts[3];
      }
    }
  }
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return { width: Math.round(width), height: Math.round(height), format: 'svg', transparent: true };
}

function probe(file: string): Probe | null {
  return extname(file).toLowerCase() === '.svg' ? svgProbe(file) : sipsProbe(file);
}

/* -------------------------------------------------------------------------- */
/* Thumbnails                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * sips reads WebP but cannot write it, so a thumbnail comes out as PNG when
 * the source has an alpha channel to preserve and as JPEG when it does not.
 * JPEG is roughly a third of the size at this scale.
 */
function thumbExtFor(probed: Probe): { ext: string; sipsFormat: string } {
  return probed.transparent ? { ext: '.png', sipsFormat: 'png' } : { ext: '.jpg', sipsFormat: 'jpeg' };
}

function predictThumbSize(probed: Probe, max: number): { w: number; h: number } {
  const scale = max / Math.max(probed.width, probed.height);
  return { w: Math.max(1, Math.round(probed.width * scale)), h: Math.max(1, Math.round(probed.height * scale)) };
}

/**
 * Write the thumbnail, and return null when it was not worth having.
 *
 * A 1200x918 PNG with an alpha channel comes back out of sips at 600px wide
 * and LARGER than the file it was made from, because the original was WebP and
 * the thumbnail cannot be. A "thumbnail" that costs more to download than the
 * asset is a pure loss, so it is deleted and the entry carries no preview; the
 * grid then loads the real file, which is what it would have done anyway.
 */
function writeThumb(
  source: string,
  dest: string,
  probed: Probe,
  max: number,
): { w: number; h: number } | null {
  const { sipsFormat } = thumbExtFor(probed);
  mkdirSync(dirname(dest), { recursive: true });
  const args = ['-Z', String(max), '-s', 'format', sipsFormat];
  if (sipsFormat === 'jpeg') args.push('-s', 'formatOptions', '72');
  sips([...args, '--out', dest, source]);

  if (statSync(dest).size >= statSync(source).size) {
    rmSync(dest, { force: true });
    return null;
  }

  const measured = sipsProbe(dest);
  return measured === null ? predictThumbSize(probed, max) : { w: measured.width, h: measured.height };
}

/* -------------------------------------------------------------------------- */
/* Walking                                                                     */
/* -------------------------------------------------------------------------- */

function walk(dir: string, recursive: boolean, skip: readonly string[]): string[] {
  const found: string[] = [];
  const visit = (current: string) => {
    if (skip.some((one) => resolve(current) === resolve(one))) return;
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (IMAGE_EXTS.has(extname(entry.name).toLowerCase())) found.push(full);
    }
  };
  visit(dir);
  return found;
}

/* -------------------------------------------------------------------------- */
/* Catalogue I/O                                                               */
/* -------------------------------------------------------------------------- */

function readCatalogue(path: string): LibraryCatalogue {
  if (!existsSync(path)) return { version: 1, entries: [] };
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const parsed = parseCatalogue(raw);
  if (!parsed.ok) {
    throw new Error(`${path} is not a valid catalogue:\n  ${parsed.errors.join('\n  ')}`);
  }
  return parsed.catalogue;
}

/** Fixed key order, so a re-run produces a byte-identical file. */
function orderEntry(entry: LibraryEntry): LibraryEntry {
  if (entry.kind !== 'asset') return entry;
  const ordered: Record<string, unknown> = {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    category: entry.category,
    tags: entry.tags,
  };
  if (entry.note !== undefined) ordered.note = entry.note;
  ordered.src = entry.src;
  ordered.width = entry.width;
  ordered.height = entry.height;
  if (entry.transparent !== undefined) ordered.transparent = entry.transparent;
  if (entry.format !== undefined) ordered.format = entry.format;
  if (entry.bytes !== undefined) ordered.bytes = entry.bytes;
  if (entry.preview !== undefined) ordered.preview = entry.preview;
  return ordered as unknown as AssetEntry;
}

function serialise(catalogue: LibraryCatalogue): string {
  return `${JSON.stringify(
    { version: catalogue.version, entries: catalogue.entries.map(orderEntry) },
    null,
    2,
  )}\n`;
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

type Action = 'new' | 'updated' | 'unchanged' | 'skipped';

type Report = {
  action: Action;
  id: string;
  relativePath: string;
  detail: string;
};

function sameMeasured(before: AssetEntry, after: AssetEntry): boolean {
  return (
    before.src === after.src &&
    before.width === after.width &&
    before.height === after.height &&
    before.transparent === after.transparent &&
    before.format === after.format &&
    before.bytes === after.bytes &&
    JSON.stringify(before.preview ?? null) === JSON.stringify(after.preview ?? null)
  );
}

function run(options: Options): number {
  const catalogue = readCatalogue(options.cataloguePath);
  const byId = new Map(catalogue.entries.map((entry) => [entry.id, entry]));
  const publicDir = join(REPO, 'public');

  // Never re-import our own output.
  const files = walk(options.dir, options.recursive, [options.destDir]);
  const reports: Report[] = [];
  const fresh: AssetEntry[] = [];
  let copied = 0;
  let thumbed = 0;

  for (const file of files) {
    const relativePath = relative(options.dir, file);
    /*
     * The id is derived from a path, and which path matters.
     *
     * In --in-place mode it is the path under public/, so the same file gets
     * the same id whether the scan started at public/ or at public/projects/.
     * In copy mode the source lives outside the repo and public/ means
     * nothing, so it is the path under the scanned directory: point the
     * script at the same folder each time and the ids are stable, point it
     * one level up and you will get a second set of entries.
     */
    const idBasis = options.inPlace ? relative(publicDir, file) : relativePath;
    const slug = slugForRelative(idBasis);
    const id = `a_${slug}`;
    const probed = probe(file);
    if (probed === null) {
      reports.push({ action: 'skipped', id, relativePath, detail: 'could not read its size' });
      continue;
    }

    const ext = extname(file).toLowerCase();

    /* ---- where the file will be served from ---- */
    let src: string;
    if (options.inPlace) {
      src = `/${relative(publicDir, file).split(sep).join('/')}`;
    } else {
      // The slug already ends in the format ("hero-webp"), so strip that tail
      // before adding the real extension: "hero-webp.webp" reads as a mistake.
      const stem = slug.replace(new RegExp(`-${ext.slice(1)}$`), '');
      const dest = join(options.destDir, `${stem}${ext}`);
      src = `${options.publicBase}/${stem}${ext}`;
      const needsCopy = !existsSync(dest) || statSync(dest).size !== statSync(file).size;
      if (needsCopy) {
        if (!options.dryRun) {
          mkdirSync(options.destDir, { recursive: true });
          copyFileSync(file, dest);
        }
        copied += 1;
      }
    }

    const existing = byId.get(id);
    const priorAsset = existing !== undefined && existing.kind === 'asset' ? existing : null;

    /* ---- thumbnail ---- */
    let preview: { src: string; w: number; h: number } | undefined;
    const longEdge = Math.max(probed.width, probed.height);
    if (longEdge > options.thumbMax && ext !== '.svg') {
      const { ext: thumbExt } = thumbExtFor(probed);
      const thumbFile = join(options.destDir, 'thumbs', `${slug}${thumbExt}`);
      const thumbSrc = `${options.publicBase}/thumbs/${slug}${thumbExt}`;
      const exists = existsSync(thumbFile);
      if (exists && !options.forceThumbs) {
        const measured = sipsProbe(thumbFile);
        const size = measured === null ? predictThumbSize(probed, options.thumbMax) : { w: measured.width, h: measured.height };
        preview = { src: thumbSrc, ...size };
      } else if (options.dryRun) {
        /*
         * A real run may write a thumbnail and then throw it away because it
         * came out bigger than the file it was made from, and a dry run
         * cannot know that without writing it. So for an entry that already
         * exists, the dry run reports whatever the last real run decided;
         * only something brand new is predicted. Otherwise `--dry-run` would
         * claim an update that the real run then declines to make.
         */
        if (priorAsset !== null) {
          preview = priorAsset.preview;
        } else {
          preview = { src: thumbSrc, ...predictThumbSize(probed, options.thumbMax) };
          thumbed += 1;
        }
      } else {
        const written = writeThumb(file, thumbFile, probed, options.thumbMax);
        if (written !== null) {
          preview = { src: thumbSrc, ...written };
          thumbed += 1;
        }
      }
    }

    /* ---- the entry ---- */
    const curated =
      priorAsset === null
        ? null
        : { name: priorAsset.name, category: priorAsset.category, tags: priorAsset.tags, note: priorAsset.note };

    const entry: AssetEntry = {
      id,
      kind: 'asset',
      // Hand-curated fields: taken from the existing entry whenever there is
      // one, and inferred only for something brand new.
      name: curated?.name ?? titleFor(relativePath),
      category: curated?.category ?? categoryFor(relativePath, options.category),
      tags: curated?.tags ?? tagsFor(relativePath, probed.format, options.tags),
      ...(curated?.note !== undefined ? { note: curated.note } : {}),
      // Measured fields: always refreshed from the file.
      src,
      width: probed.width,
      height: probed.height,
      ...(probed.transparent ? { transparent: true } : {}),
      format: probed.format,
      bytes: statSync(file).size,
      ...(preview !== undefined ? { preview } : {}),
    };

    if (existing === undefined) {
      reports.push({
        action: 'new',
        id,
        relativePath,
        detail: `${probed.width}x${probed.height} ${probed.format}${probed.transparent ? ' alpha' : ''}` +
          `${preview !== undefined ? ` thumb ${preview.w}x${preview.h}` : ''} -> ${entry.category}`,
      });
      fresh.push(entry);
      byId.set(id, entry);
      continue;
    }

    if (existing.kind !== 'asset') {
      reports.push({ action: 'skipped', id, relativePath, detail: 'id is taken by a shape entry' });
      continue;
    }

    if (sameMeasured(existing, entry)) {
      reports.push({ action: 'unchanged', id, relativePath, detail: `${entry.width}x${entry.height}` });
      byId.set(id, existing);
      continue;
    }

    const changes: string[] = [];
    if (existing.src !== entry.src) changes.push(`src ${existing.src} -> ${entry.src}`);
    if (existing.width !== entry.width || existing.height !== entry.height) {
      changes.push(`size ${existing.width}x${existing.height} -> ${entry.width}x${entry.height}`);
    }
    if (existing.transparent !== entry.transparent) changes.push(`alpha -> ${String(entry.transparent === true)}`);
    if (existing.bytes !== entry.bytes) changes.push(`bytes ${existing.bytes ?? '?'} -> ${entry.bytes}`);
    if (JSON.stringify(existing.preview ?? null) !== JSON.stringify(entry.preview ?? null)) {
      changes.push(`thumb -> ${entry.preview === undefined ? 'none' : `${entry.preview.w}x${entry.preview.h}`}`);
    }
    reports.push({ action: 'updated', id, relativePath, detail: changes.join(', ') });
    byId.set(id, entry);
  }

  /* ---- assemble: existing order preserved, new entries appended by id ---- */
  const kept = catalogue.entries.map((entry) => byId.get(entry.id) ?? entry);
  const appended = fresh.sort((a, b) => a.id.localeCompare(b.id));
  const next: LibraryCatalogue = { version: catalogue.version, entries: [...kept, ...appended] };

  const validated = parseCatalogue(next);
  if (!validated.ok) {
    process.stderr.write(`refusing to write: the result is not a valid catalogue\n  ${validated.errors.join('\n  ')}\n`);
    return 1;
  }

  const before = existsSync(options.cataloguePath) ? readFileSync(options.cataloguePath, 'utf8') : '';
  const after = serialise(validated.catalogue);
  const catalogueChanged = before !== after;

  const counts = (action: Action) => reports.filter((report) => report.action === action).length;

  if (!options.quiet) {
    const order: Action[] = ['new', 'updated', 'unchanged', 'skipped'];
    for (const action of order) {
      const group = reports.filter((report) => report.action === action);
      if (group.length === 0) continue;
      process.stdout.write(`\n  ${action.toUpperCase()} (${group.length})\n`);
      for (const report of group) {
        process.stdout.write(`    ${report.relativePath}\n      ${report.id}  ${report.detail}\n`);
      }
    }
  }

  const verb = options.dryRun ? 'would be' : 'were';
  process.stdout.write(
    `\n  ${files.length} image${files.length === 1 ? '' : 's'} under ${relative(REPO, options.dir) || '.'}\n` +
      `  ${counts('new')} new, ${counts('updated')} updated, ${counts('unchanged')} unchanged, ${counts('skipped')} skipped\n` +
      `  ${options.inPlace ? `${files.length - counts('skipped')} referenced in place` : `${copied} file${copied === 1 ? '' : 's'} ${verb} copied to ${relative(REPO, options.destDir)}`}` +
      `, ${thumbed} thumbnail${thumbed === 1 ? '' : 's'} ${verb} written\n` +
      `  catalogue ${relative(REPO, options.cataloguePath)}: ${catalogueChanged ? `${validated.catalogue.entries.length} entries` : 'unchanged'}\n`,
  );

  if (options.dryRun) {
    process.stdout.write('\n  --dry-run: nothing was written.\n');
    return 0;
  }

  if (catalogueChanged) {
    mkdirSync(dirname(options.cataloguePath), { recursive: true });
    writeFileSync(options.cataloguePath, after);
  }
  return 0;
}

/* -------------------------------------------------------------------------- */

try {
  process.exit(run(parseArgs(process.argv.slice(2))));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
