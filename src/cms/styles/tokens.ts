/**
 * src/cms/styles/tokens.ts
 *
 * The site's design tokens, for the editor.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS BECAUSE OF
 * ---------------------------------------------------------------------------
 *
 * Every colour in the page drawn in the middle pane is written as
 * `var(--paper, #fff)`, `var(--ink, #111111)`, `var(--rule, #e4e4e4)` and so
 * on, so that the editor and the published page take their colour from one
 * place. They do not. Those tokens are declared in src/styles/global.css,
 * which the PUBLISHED page loads and the CMS route does not: /cms is a React
 * island, and nothing in its import graph pulls that stylesheet in.
 *
 * So every one of those var()s was resolving to its fallback, which is the
 * light value, in every theme, always. The Theme control in the toolbar set
 * `data-theme='dark'` on <html> exactly as the site's own pre-paint script
 * does, the attribute landed, and the page stayed white, because there was
 * nothing on the page defining what dark meant.
 *
 * It went unnoticed for as long as it did because the one harness that
 * compares editor type against page type — verify-typography.mjs — builds
 * its document by concatenating global.css itself. It was testing a page
 * that loads the tokens, which the editor is not.
 *
 * ---------------------------------------------------------------------------
 * WHY A COPY AND NOT AN IMPORT
 * ---------------------------------------------------------------------------
 *
 * Same reason as every other stylesheet in src/cms/styles/: this string has
 * to survive Astro, Vite, esbuild for the standalone harnesses and bare tsc
 * for a typecheck, and `import '../../styles/global.css'` is a module
 * resolution error in two of those. A string works everywhere.
 *
 * Importing all of global.css would also be wrong even where it works. It
 * styles `body`, the nav, the footer and the article, and the editor's chrome
 * is none of those; it would repaint the dark shell as a white page. The
 * editor needs the VOCABULARY, not the stylesheet.
 *
 * THE COPY IS CHECKED. `verify-tokens.ts` reads src/styles/global.css, pulls
 * the custom properties out of its `:root` and `:root[data-theme='dark']`
 * blocks, and asserts this table matches both of them, in both directions.
 * Adding a token to global.css without adding it here fails that check, which
 * is the drift this file would otherwise cause.
 *
 * `color-scheme` is deliberately NOT mirrored. It is not a custom property,
 * and it governs native widgets — scrollbars, form controls — which in the
 * editor belong to the dark chrome around the page and not to the page. The
 * Theme control changes the sheet in the middle, not the application.
 */

/** A token's value in each theme. `dark` equals `light` when it does not move. */
export type ThemeValues = { light: string; dark: string };

/**
 * Every custom property declared in global.css's `:root`, with its dark value.
 *
 * Lifted verbatim, including the ones the editor does not reference today:
 * a partial copy is how the next var() quietly resolves to a fallback, which
 * is the whole bug above. The verify insists on all of them.
 */
export const SITE_TOKENS: Readonly<Record<string, ThemeValues>> = {
  '--ink': { light: '#111111', dark: '#f2f2f2' },
  '--muted': { light: '#6b6b6b', dark: '#8a8a8a' },
  '--rule': { light: '#e4e4e4', dark: '#2a2a2a' },
  '--accent': { light: '#ff5722', dark: '#f5a623' },
  '--paper': { light: '#ffffff', dark: '#0f0f0f' },
  '--placeholder': { light: '#ededed', dark: '#1c1c1c' },
  '--toggle-on': { light: '#f0f0f0', dark: '#242424' },
  '--toggle-off': { light: '#9a9a9a', dark: '#6e6e6e' },
  '--code-bg': { light: '#f6f6f6', dark: '#1a1a1a' },
  // White in both themes, by design: the hero grid's paper stays paper.
  '--sheet': { light: '#ffffff', dark: '#ffffff' },
  '--media-edge': { light: '#e4e4e4', dark: '#3b3b3b' },

  '--page': { light: '1440px', dark: '1440px' },
  '--gutter': { light: '48px', dark: '48px' },
  '--section-gap': { light: '72px', dark: '72px' },

  '--sans': { light: "'Inter', system-ui, -apple-system, sans-serif", dark: "'Inter', system-ui, -apple-system, sans-serif" },
  '--sans-tight': { light: "'Inter Tight', 'Inter', system-ui, sans-serif", dark: "'Inter Tight', 'Inter', system-ui, sans-serif" },
  '--mono': { light: 'ui-monospace, SFMono-Regular, Menlo, monospace', dark: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  '--nav': { light: "'Bricolage Grotesque', system-ui, sans-serif", dark: "'Bricolage Grotesque', system-ui, sans-serif" },
  '--script': { light: "'Sarina', cursive", dark: "'Sarina', cursive" },
};

/** The tokens whose value differs between the two themes. */
export function themedTokens(): string[] {
  return Object.keys(SITE_TOKENS).filter((name) => SITE_TOKENS[name].light !== SITE_TOKENS[name].dark);
}

function declarations(which: 'light' | 'dark', only?: readonly string[]): string {
  const names = only ?? Object.keys(SITE_TOKENS);
  return names.map((name) => `  ${name}: ${SITE_TOKENS[name][which]};`).join('\n');
}

/**
 * `:root` and `:root[data-theme='dark']`, the same two selectors the site
 * resolves its theme with, and the same two CALLOUT_CSS already uses for the
 * callout grounds.
 *
 * Only the tokens that MOVE are repeated in the dark block, exactly as
 * global.css does it: repeating the rest would be eleven lines that can go
 * out of step with the eleven above them for no gain.
 *
 * There is no `prefers-color-scheme` branch, because there is nothing for it
 * to do here: the Theme control always resolves 'system' to an explicit
 * light or dark attribute before it writes it, the same way Base.astro's
 * pre-paint script does on the site.
 */
export const SITE_TOKENS_CSS = [
  ':root {',
  declarations('light'),
  '}',
  '',
  ":root[data-theme='dark'] {",
  declarations('dark', themedTokens()),
  '}',
].join('\n');

export const SITE_TOKENS_STYLE_ID = 'cms-site-tokens';

/**
 * Put the tokens in the document, once.
 *
 * First in <head>, before any stylesheet that reads them, which is not
 * required for custom properties — they resolve at use time regardless of
 * declaration order — but keeps the cascade readable when someone opens
 * DevTools wondering where `--paper` comes from.
 */
export function injectSiteTokens(doc?: Document): void {
  const target = doc ?? (typeof document === 'undefined' ? null : document);
  if (target === null) return;
  if (target.getElementById(SITE_TOKENS_STYLE_ID) !== null) return;
  const element = target.createElement('style');
  element.id = SITE_TOKENS_STYLE_ID;
  element.textContent = SITE_TOKENS_CSS;
  target.head.prepend(element);
}
