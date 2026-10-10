/**
 * src/cms/assets/palette.ts
 *
 * WS-6, internal. The swatches the picker offers and the catalogue draws with.
 *
 * Taken from src/styles/global.css (the site's own custom properties) plus the
 * three colours WS-0's fixtures use, so a shape dropped on a page is already
 * in the site's palette instead of being some arbitrary hex. Values are
 * duplicated rather than read from CSS on purpose: generateShape needs a hex
 * string, not a `var(--ink)` that resolves to nothing inside an SVG attribute.
 */

export type Swatch = { name: string; value: string };

export const SITE_PALETTE: readonly Swatch[] = [
  { name: 'ink', value: '#111111' },
  { name: 'muted', value: '#6b6b6b' },
  { name: 'rule', value: '#e4e4e4' },
  { name: 'accent', value: '#ff5722' },
  { name: 'amber', value: '#f5a623' },
  { name: 'violet', value: '#a68fd8' },
  { name: 'blue', value: '#6aa3e0' },
  { name: 'green', value: '#5cb98a' },
];

/** Light and dark page grounds, for previewing a stroke against both. */
export const SITE_PAPER = '#ffffff';
export const SITE_PAPER_DARK = '#0f0f0f';
export const SITE_INK_DARK = '#f2f2f2';

/** 20% alpha of a 6-digit hex, the fill the fixtures use under a stroke. */
export function tint(hex: string, alpha = '22'): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}${alpha}` : hex;
}
