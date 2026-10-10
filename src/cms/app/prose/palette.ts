/**
 * src/cms/app/prose/palette.ts
 *
 * WS-5. The site palette, as the prose editor's text-colour swatches, plus the
 * helpers for turning a stored colour back into something an `<input
 * type="color">` can show.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING WS-1 NEEDS TO KNOW
 * ---------------------------------------------------------------------------
 *
 * A text colour is stored, per docs/cms-contracts.md 2.3, as the `textStyle`
 * mark's `color` attr:
 *
 *   { "type": "textStyle", "attrs": { "color": "<value>" } }
 *
 * `<value>` is one of exactly two forms, and nothing else:
 *
 *   1. A palette colour, as a CSS custom-property reference with a hex
 *      fallback:            "var(--accent, #ff5722)"
 *   2. An arbitrary colour the author picked, as a lowercase hex:
 *                           "#3a7f6d"
 *
 * Form 1 is what makes the palette survive the site's dark mode. WS-1 renders
 * either form the same way and does not have to branch:
 *
 *   <span style="color:var(--accent, #ff5722)">…</span>
 *   <span style="color:#3a7f6d">…</span>
 *
 * The fallback inside the var() is the light-mode hex, so a palette colour
 * still renders correctly in a context that has no tokens at all (WS-1's
 * screenshot harness, an email, a fixture rendered standalone). Nothing breaks
 * if WS-1 never defines a single token; dark mode just stops tracking.
 *
 * `--ink`, `--muted` and `--accent` already exist in src/styles/global.css and
 * already flip in dark mode, so those three work with no CSS from WS-1 at all.
 * The five named colours reference `--fc-red` … `--fc-purple`, which do NOT
 * exist yet: paste COLOR_TOKEN_CSS (below) into src/cms/styles/doc.css and they
 * flip the same way the current site flips its `.fc--*` classes.
 *
 * The value is deliberately safe to interpolate into a `style` attribute: no
 * semicolons, no braces, no quotes, no `url(`, no `expression(`. Validated by
 * isSafeStyleColorValue(), which the editor applies to everything it stores and
 * which WS-1 is welcome to re-apply on render.
 */

/* -------------------------------------------------------------------------- */
/* The palette                                                                 */
/* -------------------------------------------------------------------------- */

export const PALETTE_SWATCH_IDS = [
  'ink',
  'muted',
  'accent',
  'red',
  'orange',
  'green',
  'blue',
  'purple',
] as const;

export type PaletteSwatchId = (typeof PALETTE_SWATCH_IDS)[number];

export type PaletteSwatch = {
  id: PaletteSwatchId;
  /** What the toolbar calls it. */
  label: string;
  /** The CSS custom property the stored value references. */
  token: string;
  /** Exactly the string that lands in the textStyle mark's `color` attr. */
  value: string;
  /** Light-mode hex. Also the var() fallback. */
  hex: string;
  /** The hex the site uses below `prefers-color-scheme: dark`. */
  darkHex: string;
  /**
   * True when the token is already defined in src/styles/global.css, so the
   * swatch flips in dark mode with no new CSS. False for the five named
   * colours, which need COLOR_TOKEN_CSS.
   */
  tokenExists: boolean;
};

/**
 * Light and dark values are lifted verbatim from src/styles/global.css:
 * `:root` for light, `:root[data-theme='dark']` and the `.fc--*` dark overrides
 * for dark. If global.css changes, this table is the bug.
 */
export const PROSE_PALETTE: readonly PaletteSwatch[] = [
  {
    id: 'ink',
    label: 'Ink',
    token: '--ink',
    value: 'var(--ink, #111111)',
    hex: '#111111',
    darkHex: '#f2f2f2',
    tokenExists: true,
  },
  {
    id: 'muted',
    label: 'Muted',
    token: '--muted',
    value: 'var(--muted, #6b6b6b)',
    hex: '#6b6b6b',
    darkHex: '#8a8a8a',
    tokenExists: true,
  },
  {
    id: 'accent',
    label: 'Accent',
    token: '--accent',
    value: 'var(--accent, #ff5722)',
    hex: '#ff5722',
    darkHex: '#f5a623',
    tokenExists: true,
  },
  {
    id: 'red',
    label: 'Red',
    token: '--fc-red',
    value: 'var(--fc-red, #c0392b)',
    hex: '#c0392b',
    darkHex: '#e8695a',
    tokenExists: false,
  },
  {
    id: 'orange',
    label: 'Orange',
    token: '--fc-orange',
    value: 'var(--fc-orange, #d35400)',
    hex: '#d35400',
    darkHex: '#e8894a',
    tokenExists: false,
  },
  {
    id: 'green',
    label: 'Green',
    token: '--fc-green',
    value: 'var(--fc-green, #2e7d52)',
    hex: '#2e7d52',
    darkHex: '#5cb98a',
    tokenExists: false,
  },
  {
    id: 'blue',
    label: 'Blue',
    token: '--fc-blue',
    value: 'var(--fc-blue, #2563a8)',
    hex: '#2563a8',
    darkHex: '#6aa3e0',
    tokenExists: false,
  },
  {
    id: 'purple',
    label: 'Purple',
    token: '--fc-purple',
    value: 'var(--fc-purple, #6b4ea8)',
    hex: '#6b4ea8',
    darkHex: '#a68fd8',
    tokenExists: false,
  },
] as const;

/**
 * The token definitions the five named colours need. For WS-1 to paste into
 * src/cms/styles/doc.css. Selector shapes copied from src/styles/global.css so
 * the document and the rest of the site resolve the theme identically.
 *
 * Not injected by this module: WS-5 does not style the page.
 */
export const COLOR_TOKEN_CSS = `:root {
  --fc-red: #c0392b;
  --fc-orange: #d35400;
  --fc-green: #2e7d52;
  --fc-blue: #2563a8;
  --fc-purple: #6b4ea8;
}

:root[data-theme='dark'] {
  --fc-red: #e8695a;
  --fc-orange: #e8894a;
  --fc-green: #5cb98a;
  --fc-blue: #6aa3e0;
  --fc-purple: #a68fd8;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --fc-red: #e8695a;
    --fc-orange: #e8894a;
    --fc-green: #5cb98a;
    --fc-blue: #6aa3e0;
    --fc-purple: #a68fd8;
  }
}
`;

/* -------------------------------------------------------------------------- */
/* Hex                                                                         */
/* -------------------------------------------------------------------------- */

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/;

/**
 * Accepts what a person types into a hex field: with or without the `#`, any
 * case, 3/4/6/8 digits. Returns the canonical lowercase `#…` form, or null.
 * The canonical form is what gets stored, so two authors typing `#FF5722` and
 * `ff5722` produce the same document.
 */
export function normalizeHex(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  const candidate = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return HEX_RE.test(candidate) ? candidate : null;
}

/** `#abc` -> `#aabbcc`, `#rrggbbaa` -> `#rrggbb`. What `<input type="color">` needs. */
export function toSixDigitHex(hex: string): string {
  const value = normalizeHex(hex);
  if (value === null) return '#000000';
  const digits = value.slice(1);
  if (digits.length === 3 || digits.length === 4) {
    const rgb = digits.slice(0, 3);
    return `#${rgb[0]}${rgb[0]}${rgb[1]}${rgb[1]}${rgb[2]}${rgb[2]}`;
  }
  return `#${digits.slice(0, 6)}`;
}

/* -------------------------------------------------------------------------- */
/* Token references                                                            */
/* -------------------------------------------------------------------------- */

const TOKEN_RE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*(#[0-9a-fA-F]{3,8})\s*)?\)$/;

export type TokenColor = { token: string; fallback: string | null };

/** `var(--accent, #ff5722)` -> `{ token: '--accent', fallback: '#ff5722' }`. */
export function parseTokenColor(value: string): TokenColor | null {
  const match = TOKEN_RE.exec(value.trim());
  if (match === null) return null;
  const fallback = match[2] === undefined ? null : normalizeHex(match[2]);
  return { token: match[1], fallback };
}

export function isTokenColor(value: string): boolean {
  return parseTokenColor(value) !== null;
}

/** The swatch a stored value came from, by exact value then by token then by hex. */
export function swatchForValue(value: string): PaletteSwatch | undefined {
  const trimmed = value.trim();
  const exact = PROSE_PALETTE.find((swatch) => swatch.value === trimmed);
  if (exact !== undefined) return exact;
  const token = parseTokenColor(trimmed);
  if (token !== null) return PROSE_PALETTE.find((swatch) => swatch.token === token.token);
  const hex = normalizeHex(trimmed);
  if (hex !== null) return PROSE_PALETTE.find((swatch) => swatch.hex === hex);
  return undefined;
}

export type ColorTheme = 'light' | 'dark';

/**
 * A stored colour -> a concrete hex, for the swatch chip, the native picker and
 * any preview that cannot resolve custom properties. Palette tokens resolve
 * from the table above; an unknown token resolves to its own var() fallback.
 */
export function resolveColorToHex(value: string, theme: ColorTheme = 'light'): string {
  const swatch = swatchForValue(value);
  if (swatch !== undefined) return theme === 'dark' ? swatch.darkHex : swatch.hex;
  const token = parseTokenColor(value);
  if (token !== null) return token.fallback === null ? '#000000' : toSixDigitHex(token.fallback);
  const hex = normalizeHex(value);
  return hex === null ? '#000000' : toSixDigitHex(hex);
}

/** What the toolbar shows as the current colour's name. */
export function colorLabel(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'Default';
  const swatch = swatchForValue(value);
  return swatch === undefined ? value : swatch.label;
}

/* -------------------------------------------------------------------------- */
/* Safety                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The gate on everything stored in `attrs.color`. A stored colour ends up
 * inside a `style` attribute on both the published page and the editor, so it
 * must not be able to close the declaration, open a block, or reach the
 * network.
 *
 * Only the two documented forms pass: a canonical hex, or a var() reference
 * with an optional hex fallback.
 */
export function isSafeStyleColorValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 64) return false;
  if (/[;{}()'"\\<>]/.test(trimmed) && !isTokenColor(trimmed)) return false;
  return normalizeHex(trimmed) !== null || isTokenColor(trimmed);
}

/**
 * The single entry point the editor uses before storing a colour. Returns the
 * canonical stored form, or null if the value is not storable.
 *
 * Canonicalising means two authors cannot write the same colour two ways:
 * `#FF5722` and `ff5722` both store as `#ff5722`, and any reference to a
 * palette token stores as that swatch's exact value, fallback included. So
 * `var(--accent)` and `var(--accent, #000)` both become
 * `var(--accent, #ff5722)`, which is the one form WS-1 ever has to render.
 */
export function canonicalColorValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const swatch = PROSE_PALETTE.find(
    (candidate) => candidate.value === trimmed || candidate.token === parseTokenColor(trimmed)?.token,
  );
  if (swatch !== undefined) return swatch.value;
  if (isTokenColor(trimmed)) return isSafeStyleColorValue(trimmed) ? trimmed : null;
  return normalizeHex(trimmed);
}
