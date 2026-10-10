/**
 * src/cms/render/escape.ts
 *
 * WS-1. String hygiene for the renderer.
 *
 * renderDoc() builds HTML by concatenation, so every piece of document text
 * that lands in the output goes through here first. A document can contain
 * anything the editor let somebody type or paste, so this is the only thing
 * standing between a pasted `<script>` and the published page.
 *
 * No DOM, no dependencies.
 */

/**
 * Text that lands between tags. `&` first, or the other replacements get
 * double-escaped.
 */
export function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Text that lands inside a double-quoted attribute. Quotes and angle brackets
 * both, so the value cannot break out of the attribute or out of the tag.
 */
export function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Schemes a link or an embed may use. Everything else is dropped. */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
/** Tabs, newlines and other control characters, which hide `java\nscript:`. */
const CONTROL_RE = /[\u0000- \u007f-\u009f]/g;

/**
 * Returns the url if it is safe to put in an `href` or `src`, or null.
 *
 * Safe means: a fragment, a site-absolute or relative path, or one of
 * SAFE_SCHEMES. `javascript:`, `data:` and `vbscript:` are not safe, including
 * when they are spelled with embedded control characters.
 *
 * Returns null rather than a placeholder, so the caller decides whether to drop
 * the link and keep its text, or drop the element entirely.
 */
export function safeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const stripped = raw.replace(CONTROL_RE, '');
  if (stripped === '') return null;

  const scheme = SCHEME_RE.exec(stripped);
  if (scheme !== null) {
    return SAFE_SCHEMES.has(scheme[1]!.toLowerCase()) ? stripped : null;
  }

  // No scheme. A protocol-relative url inherits the page's scheme, so it is as
  // safe as the page itself; everything else is a path or a fragment.
  return stripped;
}

/** `attr="value"`, or '' when the value is undefined. Pre-escaped keys only. */
export function attr(name: string, value: string | number | undefined | null): string {
  if (value === undefined || value === null) return '';
  return ` ${name}="${escapeAttr(String(value))}"`;
}

/**
 * Drop empty strings and join. Keeps the call sites free of `.filter(Boolean)`
 * noise when a part is conditional.
 */
export function joinParts(parts: (string | false | null | undefined)[], separator = ''): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(separator);
}

/**
 * A number, formatted for CSS. Trims float noise (0.1 + 0.2 territory) without
 * losing enough precision to move anything a visible amount: at a 1344px
 * reference width, four decimals of a percentage is a twentieth of a pixel.
 */
export function css(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Math.round(value * 10000) / 10000);
}
