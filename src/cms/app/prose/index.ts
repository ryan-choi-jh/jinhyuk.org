/**
 * src/cms/app/prose/index.ts
 *
 * WS-5's public surface. Everything another workstream should import from
 * this tree, and nothing else.
 *
 *   import { ProseEditor } from '../prose/index.ts';
 *   <ProseEditor block={block} onChange={setBlock} />
 *
 * The component is the deliverable. The rest is here because WS-1, WS-3, WS-8
 * and WS-9 each need one piece of it:
 *
 *   WS-1  COLOR_TOKEN_CSS           the --fc-* tokens a palette colour needs
 *         resolveColorToHex         to flatten a colour for a static preview
 *   WS-3  convertBlockKind          change a block's kind from the outline
 *         emptyContentFor           content for a freshly inserted block
 *   WS-8  PROSE_EDITOR_CSS          to inline the chrome styles server side
 *   WS-9  normalizeProseBlock       coerce migrated content into the 3.2 shape
 *         normalizeProseContent
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS WS-8 WILL HIT IN THE FIRST TEN MINUTES
 * ---------------------------------------------------------------------------
 *
 * 1. ProseEditor emits a WHOLE ProseBlock, because the toolbar can change the
 *    block's kind and kind lives on the block, not inside the editor.
 *    WS-3's slot takes content only and owns kind through the store, so:
 *
 *      renderProseBlock: ({ store, band, block, onChange, onSelect }) => (
 *        <ProseEditor
 *          block={block}
 *          onChange={(next) => {
 *            if (next.kind !== block.kind) store.setBlockKind(band.id, block.id, next.kind);
 *            onChange(next.content);
 *          }}
 *          onFocusChange={(focused) => { if (focused) onSelect(); }}
 *        />
 *      )
 *
 *    Pass `showKindControls={false}` instead if the inspector should own kind.
 *
 * 2. A palette colour is stored as `var(--accent, #ff5722)`, not as a hex, so
 *    it survives the site's dark mode. WS-1's renderer currently drops any
 *    non-hex colour. See palette.ts for the exact two forms and the one-line
 *    change that makes the renderer accept both.
 */

export { ProseEditor } from './ProseEditor.tsx';
export type { ProseEditorProps } from './ProseEditor.tsx';

export { ProseToolbar, useEditorTick } from './Toolbar.tsx';
export type { ProseToolbarProps } from './Toolbar.tsx';

export { ColorControl, useColorTheme } from './ColorControl.tsx';
export { LinkControl, normalizeHrefInput } from './LinkControl.tsx';

export {
  PROSE_KINDS,
  PROSE_KIND_LABEL,
  PROSE_KIND_TITLE,
  getProseSchema,
  proseExtensions,
} from './extensions.ts';
export type { ProseExtensionOptions } from './extensions.ts';

export {
  MARK_ORDER,
  blockFromDoc,
  canonicalJson,
  collectProseColors,
  collectProseMarks,
  collectProseText,
  contentForKind,
  convertBlockKind,
  docFromBlock,
  emptyContentFor,
  isSafeHref,
  normalizeMarks,
  normalizeProseBlock,
  normalizeProseContent,
  paragraphGroups,
  sameProseContent,
  topNodeAttrsFor,
  topNodeTypeOf,
} from './block.ts';
export type { ProseEditorDoc, ProseMark, ProseNode } from './block.ts';

export {
  COLOR_TOKEN_CSS,
  PALETTE_SWATCH_IDS,
  PROSE_PALETTE,
  canonicalColorValue,
  colorLabel,
  isSafeStyleColorValue,
  isTokenColor,
  normalizeHex,
  parseTokenColor,
  resolveColorToHex,
  swatchForValue,
  toSixDigitHex,
} from './palette.ts';
export type { ColorTheme, PaletteSwatch, PaletteSwatchId, TokenColor } from './palette.ts';

export { PROSE_EDITOR_CSS, PROSE_EDITOR_STYLE_ID, injectProseEditorStyles } from './css.ts';
