/**
 * src/cms/app/prose/css.ts
 *
 * WS-5. Editor chrome only.
 *
 * docs/cms-rebuild.md section 4: "Must not: style the page. It emits content,
 * WS-1 decides how it looks." So nothing here styles prose. There is no rule
 * for a paragraph, a heading, a quote, a list, a link or a coloured run.
 * Everything is either a `.pe-*` class, which only the toolbar and its
 * popovers use, or one of the handful of ProseMirror machinery rules an
 * editable surface cannot work without (white-space handling and the
 * separator image ProseMirror injects to keep empty blocks selectable).
 *
 * Shipped as a string rather than an imported .css file so the component works
 * under any bundler, and under none: injectProseEditorStyles() writes one
 * <style> tag per document and is safe to call from every instance.
 *
 * The chrome inherits the host's colours through --pe-* custom properties,
 * which fall back to plain greys. Set them on any ancestor to reskin the
 * toolbar without touching this file.
 */

export const PROSE_EDITOR_STYLE_ID = 'cms-prose-editor-chrome';

export const PROSE_EDITOR_CSS = `
.pe-root {
  --pe-bg: var(--pe-surface-bg, #ffffff);
  --pe-fg: var(--pe-surface-fg, #111111);
  --pe-dim: var(--pe-surface-dim, #6b6b6b);
  --pe-line: var(--pe-surface-line, #e4e4e4);
  --pe-on: var(--pe-surface-on, #ebebeb);
  --pe-focus: var(--pe-surface-focus, #2563a8);
  position: relative;
}

/* ProseMirror machinery. Not design: without these, spaces collapse and the
   caret cannot be placed in an empty block. */
.pe-surface .ProseMirror {
  position: relative;
  white-space: pre-wrap;
  word-wrap: break-word;
  outline: none;
  font-variant-ligatures: none;
}
.pe-surface .ProseMirror [contenteditable='false'] {
  white-space: normal;
}
.pe-surface img.ProseMirror-separator {
  display: inline !important;
  border: none !important;
  margin: 0 !important;
  width: 1px !important;
  height: 1px !important;
}
.pe-surface .ProseMirror-hideselection *::selection {
  background: transparent;
}

/* The floating toolbar. */
.pe-toolbar {
  position: fixed;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 420px;
  padding: 6px;
  border: 1px solid var(--pe-line, #e4e4e4);
  border-radius: 10px;
  background: var(--pe-bg, #ffffff);
  color: var(--pe-fg, #111111);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.14);
  font: 400 12px/1.2 var(--sans, system-ui, sans-serif);
  letter-spacing: 0;
}

.pe-row {
  display: flex;
  align-items: center;
  gap: 2px;
}

.pe-sep {
  flex: 0 0 1px;
  align-self: stretch;
  margin: 2px 4px;
  background: var(--pe-line, #e4e4e4);
}

.pe-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 26px;
  height: 26px;
  padding: 0 7px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.pe-btn:hover {
  background: var(--pe-on, #ebebeb);
}
.pe-btn:focus-visible {
  outline: 2px solid var(--pe-focus, #2563a8);
  outline-offset: 1px;
}
.pe-btn[aria-pressed='true'],
.pe-btn[data-on='true'] {
  background: var(--pe-on, #ebebeb);
  font-weight: 600;
}
.pe-btn--bold { font-weight: 700; }
.pe-btn--italic { font-style: italic; }

.pe-dot {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 1px solid rgba(0, 0, 0, 0.18);
  border-radius: 3px;
}

/* Popovers: the colour picker and the link field. */
.pe-popover {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 6px 4px;
  border-top: 1px solid var(--pe-line, #e4e4e4);
}

.pe-label {
  color: var(--pe-dim, #6b6b6b);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.pe-swatches {
  display: grid;
  grid-template-columns: repeat(8, 22px);
  gap: 4px;
}

.pe-swatch {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid rgba(0, 0, 0, 0.18);
  border-radius: 5px;
  cursor: pointer;
}
.pe-swatch[aria-pressed='true'] {
  box-shadow: 0 0 0 2px var(--pe-bg, #fff), 0 0 0 4px var(--pe-focus, #2563a8);
}
.pe-swatch:focus-visible {
  outline: 2px solid var(--pe-focus, #2563a8);
  outline-offset: 2px;
}

.pe-field {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pe-input {
  min-width: 0;
  height: 26px;
  padding: 0 7px;
  border: 1px solid var(--pe-line, #e4e4e4);
  border-radius: 6px;
  background: var(--pe-bg, #ffffff);
  color: inherit;
  font: inherit;
}
.pe-input--href { flex: 1 1 220px; }
.pe-input--hex { flex: 0 0 96px; font-variant-numeric: tabular-nums; }
.pe-input--color {
  flex: 0 0 34px;
  width: 34px;
  height: 26px;
  padding: 2px;
  cursor: pointer;
}

.pe-hint {
  color: var(--pe-dim, #6b6b6b);
  font-size: 11px;
}
.pe-hint--bad { color: #c0392b; }
`;

/**
 * One <style> tag per document, whatever how many editors mount. No-op outside
 * a browser, so a server render does not need to guard the call.
 */
export function injectProseEditorStyles(doc?: Document): void {
  const target = doc ?? (typeof document === 'undefined' ? undefined : document);
  if (target === undefined) return;
  if (target.getElementById(PROSE_EDITOR_STYLE_ID) !== null) return;
  const style = target.createElement('style');
  style.id = PROSE_EDITOR_STYLE_ID;
  style.textContent = PROSE_EDITOR_CSS;
  target.head.appendChild(style);
}
