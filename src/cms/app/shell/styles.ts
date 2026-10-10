/**
 * src/cms/app/shell/styles.ts
 *
 * WS-3. The shell's stylesheet, as a string, plus a hook that injects it once.
 *
 * Why a string and not a `.css` file: the shell has to work under three
 * different build setups without any of them configuring anything. Astro and
 * Vite for the real app, esbuild for the standalone harness, and plain `tsc`
 * for a typecheck. A `import './shell.css'` statement is a module resolution
 * error in the third and needs a loader flag in the second. A string works
 * everywhere, is injected once per document, and is still one source of truth.
 *
 * It also lets the one allowed breakpoint come from the schema constant
 * instead of being typed as a number in two places (docs/cms-rebuild.md rule 6:
 * reference width 1344, breakpoint 900, invent no others).
 *
 * This is the editor chrome only. It deliberately looks nothing like
 * jinhyuk.org: dense, dark, system font. The page surface in the middle is the
 * only light surface, and WS-1's stylesheet is what makes its contents look
 * like the site.
 */

import { useInsertionEffect } from 'react';

import { MOBILE_BREAKPOINT, REFERENCE_WIDTH } from '../../schema.ts';

export const SHELL_STYLE_ID = 'cms-shell-styles';

export const SHELL_CSS = `
.cms-root {
  --cms-bg: #15171a;
  --cms-panel: #1b1e22;
  --cms-panel-2: #22262b;
  --cms-line: #2d3238;
  --cms-line-strong: #3b424a;
  --cms-text: #e7eaed;
  --cms-muted: #8d969f;
  --cms-accent: #4c8dff;
  --cms-accent-dim: #1f3a66;
  --cms-danger: #e5534b;
  --cms-success: #3fb950;
  --cms-warn: #d6a327;
  --cms-outline-w: 268px;
  --cms-inspector-w: 304px;
  --cms-row: 26px;

  position: relative;
  display: flex;
  flex-direction: column;
  height: 100dvh;
  box-sizing: border-box;
  background: var(--cms-bg);
  color: var(--cms-text);
  font: 12px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}
.cms-root *, .cms-root *::before, .cms-root *::after { box-sizing: border-box; }
.cms-root button, .cms-root input, .cms-root select, .cms-root textarea {
  font: inherit;
  color: inherit;
}

/* ---------- generic controls ---------- */

.cms-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--cms-line-strong);
  border-radius: 5px;
  background: var(--cms-panel-2);
  color: var(--cms-text);
  cursor: pointer;
  white-space: nowrap;
}
.cms-btn:hover:not(:disabled) { background: #2a2f36; }
.cms-btn:active:not(:disabled) { background: #31373f; }
.cms-btn:disabled { opacity: 0.4; cursor: default; }
.cms-btn:focus-visible { outline: 2px solid var(--cms-accent); outline-offset: 1px; }
.cms-btn--primary { background: var(--cms-accent); border-color: var(--cms-accent); color: #fff; }
.cms-btn--primary:hover:not(:disabled) { background: #5e99ff; }
.cms-btn--quiet { background: transparent; border-color: transparent; color: var(--cms-muted); }
.cms-btn--quiet:hover:not(:disabled) { background: var(--cms-panel-2); color: var(--cms-text); }
.cms-btn--danger { color: var(--cms-danger); }
.cms-btn--icon { width: 24px; padding: 0; justify-content: center; }
.cms-btn--tiny { height: 20px; padding: 0 6px; font-size: 11px; }
.cms-btn--micro { width: 18px; height: 18px; padding: 0; justify-content: center; font-size: 10px; line-height: 1; }

.cms-input, .cms-select {
  width: 100%;
  height: 24px;
  min-width: 0;
  padding: 0 6px;
  border: 1px solid var(--cms-line-strong);
  border-radius: 5px;
  background: #14171a;
  color: var(--cms-text);
}
.cms-select { padding: 0 4px; }
.cms-input:focus, .cms-select:focus { outline: none; border-color: var(--cms-accent); }
.cms-input--num { font-variant-numeric: tabular-nums; }
.cms-input--color { padding: 0 2px; }

/* ---------- toolbar ---------- */

.cms-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  height: 40px;
  padding: 0 10px;
  border-bottom: 1px solid var(--cms-line);
  background: var(--cms-panel);
}
.cms-toolbar__title { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.cms-toolbar__name {
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 280px;
}
.cms-toolbar__slug { color: var(--cms-muted); font-size: 11px; }
.cms-toolbar__spacer { flex: 1 1 auto; }
.cms-toolbar__group { display: flex; align-items: center; gap: 4px; }
.cms-toolbar__sep { width: 1px; height: 20px; background: var(--cms-line); }

.cms-dirty {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--cms-muted);
  font-size: 11px;
  white-space: nowrap;
}
.cms-dirty__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--cms-line-strong);
}
.cms-dirty--dirty .cms-dirty__dot { background: var(--cms-warn); }
.cms-dirty--dirty { color: var(--cms-warn); }

.cms-zoom { display: flex; align-items: center; gap: 4px; color: var(--cms-muted); font-size: 11px; }
.cms-zoom .cms-select { width: 74px; }

/* ---------- three panes ---------- */

.cms-panes {
  display: grid;
  grid-template-columns: var(--cms-outline-w) minmax(0, 1fr) var(--cms-inspector-w);
  flex: 1 1 auto;
  min-height: 0;
}
.cms-pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.cms-pane--left { background: var(--cms-panel); border-right: 1px solid var(--cms-line); }
.cms-pane--centre { background: #0f1113; overflow: auto; }
.cms-pane--right { background: var(--cms-panel); border-left: 1px solid var(--cms-line); }
.cms-pane__head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  height: 28px;
  padding: 0 8px 0 10px;
  border-bottom: 1px solid var(--cms-line);
  color: var(--cms-muted);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}
.cms-pane__body { flex: 1 1 auto; min-height: 0; overflow: auto; }

/* ---------- band outline ---------- */

.cms-outline { padding: 4px 0 24px; user-select: none; }
.cms-outline__gap {
  position: relative;
  height: 8px;
  margin: 0 8px;
}
.cms-outline__gap-line {
  position: absolute;
  left: 0;
  right: 0;
  top: 3px;
  height: 2px;
  border-radius: 2px;
  background: transparent;
}
.cms-outline__gap--active .cms-outline__gap-line { background: var(--cms-accent); }
.cms-outline__insert {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  opacity: 0;
  transition: opacity 90ms linear;
}
.cms-outline__gap:hover .cms-outline__insert { opacity: 1; }
.cms-outline__insert button {
  height: 15px;
  padding: 0 5px;
  border: 1px solid var(--cms-line-strong);
  border-radius: 8px;
  background: var(--cms-panel-2);
  color: var(--cms-muted);
  font-size: 9.5px;
  letter-spacing: 0.03em;
  cursor: pointer;
}
.cms-outline__insert button:hover { color: var(--cms-text); border-color: var(--cms-accent); }

.cms-band {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0 8px;
  padding: 5px 6px 5px 4px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--cms-panel-2);
  cursor: default;
}
.cms-band:hover { border-color: var(--cms-line-strong); }
.cms-band--selected { border-color: var(--cms-accent); background: var(--cms-accent-dim); }
.cms-band--dragging { opacity: 0.45; }
.cms-band--overlay { margin-left: 22px; }
.cms-band__grip {
  flex: 0 0 auto;
  width: 14px;
  align-self: stretch;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--cms-muted);
  cursor: grab;
  font-size: 11px;
  line-height: 1;
}
.cms-band__grip:hover { background: #2c3238; color: var(--cms-text); }
.cms-band__grip:active { cursor: grabbing; }
.cms-band__main { display: block; flex: 1 1 auto; min-width: 0; text-align: left; border: 0; background: none; padding: 0; cursor: pointer; }
.cms-band__line1 { display: flex; align-items: center; gap: 6px; }
.cms-band__index {
  min-width: 15px;
  color: var(--cms-muted);
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
}
.cms-band__kind { font-weight: 600; }
.cms-band__tag {
  padding: 0 4px;
  border: 1px solid var(--cms-line-strong);
  border-radius: 3px;
  color: var(--cms-muted);
  font-size: 9.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.cms-band__tag--overlay { color: var(--cms-warn); border-color: #4a3c15; }
.cms-band__line2 {
  display: block;
  margin-top: 1px;
  padding-left: 21px;
  color: var(--cms-muted);
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cms-band__actions { flex: 0 0 auto; display: flex; gap: 2px; }

.cms-children { margin: 2px 8px 0 30px; display: flex; flex-direction: column; gap: 1px; }
.cms-child {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 20px;
  padding: 1px 5px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: none;
  text-align: left;
  cursor: pointer;
}
.cms-child:hover { background: #22262b; }
.cms-child--selected { border-color: var(--cms-accent); background: var(--cms-accent-dim); }
.cms-child__kind {
  flex: 0 0 auto;
  min-width: 34px;
  color: var(--cms-muted);
  font-size: 9.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.cms-child__text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cms-child__text--empty { color: var(--cms-muted); font-style: italic; }

/* ---------- centre pane: the page ---------- */

.cms-surface-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 18px 18px 72px; }
.cms-surface-measure { width: 100%; }
.cms-surface-frame { position: relative; margin: 0 auto; }
.cms-slot-host--canvas { position: absolute; inset: 0; }
/* The page in the middle has to be the page. These values are not invented:
   they are src/styles/global.css, which the published page loads, copied for
   the editor's own class names. The surface used to be 15px Georgia, which
   made every line break in the wrong place and every layout decision made
   here a guess. */
.cms-surface {
  position: absolute;
  top: 0;
  left: 0;
  width: ${REFERENCE_WIDTH}px;
  transform-origin: 0 0;
  background: var(--paper, #fff);
  color: var(--ink, #111111);
  font-family: Inter, system-ui, -apple-system, sans-serif;
  font-weight: 300;
  font-size: 17.5px;
  line-height: 35px;
  letter-spacing: -0.02em;
  font-synthesis: none;
  -webkit-font-smoothing: antialiased;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.5), 0 14px 40px rgba(0, 0, 0, 0.45);
}
.cms-surface__inner { padding: 0 0 0; }

/* Prose, at the site's scale. global.css: p 17.5/35, h2 22/32 600, h3 18/28,
   blockquote 26/40 300 behind a 2px accent rule, 28px between paragraphs. */
.cms-surface p { margin: 0 0 28px; }
.cms-surface h2 {
  margin: 56px 0 4px;
  font-size: 22px; line-height: 32px; letter-spacing: -0.02em; font-weight: 600;
}
.cms-surface h3 {
  margin: 40px 0 4px;
  font-size: 18px; line-height: 28px; letter-spacing: -0.01em; font-weight: 600;
}
.cms-surface blockquote {
  margin: 0 0 28px;
  padding-left: 20px;
  border-left: 2px solid var(--accent, #ff5722);
  font-size: 26px; line-height: 40px; letter-spacing: -0.02em; font-weight: 300;
}
.cms-surface ul, .cms-surface ol { margin: 0 0 28px; padding-left: 24px; }
.cms-surface li + li { margin-top: 6px; }
.cms-surface strong { font-weight: 600; }
.cms-surface a {
  color: inherit; text-decoration: underline; text-underline-offset: 3px;
  text-decoration-thickness: 1px; text-decoration-color: var(--rule, #e4e4e4);
}

/* The nav and the footer, so a page is framed the way a reader sees it.
   Inert on purpose: this is scenery, not navigation. */
.cms-chrome { padding: 0; pointer-events: none; user-select: none; }
.cms-chrome__nav {
  display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
  padding: 28px 0 24px;
}
.cms-chrome__mark {
  font-family: Sarina, cursive; font-size: 22px; font-weight: 400;
  letter-spacing: 0; color: var(--ink, #111111);
}
.cms-chrome__links { display: flex; gap: 28px; justify-self: center; }
.cms-chrome__links span {
  font-family: 'Bricolage Grotesque', system-ui, sans-serif;
  font-size: 13px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--muted, #6b6b6b);
}
.cms-chrome__links span[data-on='1'] { color: var(--ink, #111111); }
.cms-chrome__toggle {
  justify-self: end; width: 66px; height: 30px; border-radius: 999px;
  background: var(--toggle-on, #f0f0f0);
}
.cms-chrome__footer {
  display: flex; justify-content: space-between; align-items: center;
  margin-top: 120px; padding: 16px 0 0;
  border-top: 1px solid var(--rule, #e4e4e4);
  font-family: 'Inter Tight', Inter, system-ui, sans-serif;
  font-size: 12px; line-height: 16px; letter-spacing: 0.08em;
  color: var(--muted, #6b6b6b);
}
.cms-chrome__social { display: flex; gap: 16px; }
.cms-chrome__social i {
  display: block; width: 16px; height: 16px; border-radius: 3px;
  background: var(--muted, #6b6b6b); opacity: 0.55;
}

.cms-group { position: relative; }
.cms-band-box { position: relative; }
/* No horizontal inset. On the published page prose, canvas items and the
   nav and footer all begin at the content column's left edge, measured at 0
   for all three. A 72px inset here put the text out of line with every canvas
   beside it, which is the one judgement the canvas exists to support. */
.cms-band-box--prose { padding: 10px 0; }
.cms-prose-col { max-width: 760px; }
.cms-band-box--canvas { }
.cms-band-box--overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  pointer-events: none;
}
.cms-band-box--overlay .cms-ph-item,
.cms-band-box--overlay .cms-slot-host { pointer-events: auto; }
.cms-band-box--selected { outline: 2px solid var(--cms-accent); outline-offset: 0; }
.cms-band-box__label {
  position: absolute;
  top: -1px;
  left: -1px;
  z-index: 9;
  padding: 1px 6px;
  border-radius: 0 0 5px 0;
  background: var(--cms-accent);
  color: #fff;
  font: 600 10px/1.5 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  pointer-events: none;
}

.cms-stage { position: relative; width: 100%; }
.cms-stage--empty::after {
  content: "empty canvas band";
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #b4b4b4;
  font: 12px/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.cms-stage__frame {
  position: absolute;
  inset: 0;
  border: 1px dashed #d8d8d8;
  pointer-events: none;
}

/* Placeholder items: what the centre pane draws when no canvas slot is mounted. */
.cms-ph-item { position: absolute; }
.cms-ph-item__box {
  position: absolute;
  inset: 0;
  border: 1px solid rgba(17, 17, 17, 0.25);
  background: rgba(17, 17, 17, 0.03);
  overflow: hidden;
}
.cms-ph-item--selected .cms-ph-item__box { border-color: var(--cms-accent); box-shadow: 0 0 0 1px var(--cms-accent); }
.cms-ph-item__img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cms-ph-item__label {
  position: absolute;
  top: 0;
  left: 0;
  padding: 1px 5px;
  background: rgba(17, 17, 17, 0.72);
  color: #fff;
  font: 10px/1.4 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: 0.04em;
  white-space: nowrap;
}
.cms-ph-item__alt {
  position: absolute;
  inset: auto 0 0 0;
  padding: 3px 5px;
  color: #666;
  font: 10px/1.3 ui-sans-serif, system-ui, sans-serif;
}

/* Placeholder prose: plain text until WS-5's editor is mounted in the slot. */
.cms-ph-block { position: relative; padding: 2px 0; cursor: text; }
.cms-ph-block--selected { box-shadow: -10px 0 0 0 var(--cms-accent); }
.cms-ph-block__kind {
  position: absolute;
  left: -58px;
  top: 4px;
  width: 44px;
  text-align: right;
  color: #bdbdbd;
  font: 10px/1.4 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.cms-ph-p { margin: 0 0 14px; }
.cms-ph-h2 { margin: 26px 0 10px; font-size: 25px; line-height: 1.25; }
.cms-ph-h3 { margin: 22px 0 8px; font-size: 19px; line-height: 1.3; }
.cms-ph-quote { margin: 18px 0; padding-left: 16px; border-left: 3px solid #ddd; color: #444; font-style: italic; }
.cms-ph-list { margin: 0 0 14px; padding-left: 22px; }
.cms-ph-empty { color: #b0b0b0; font-style: italic; }

.cms-slot-note {
  position: absolute;
  right: 4px;
  bottom: 4px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(17, 17, 17, 0.06);
  color: #999;
  font: 9.5px/1.4 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  pointer-events: none;
}

/* ---------- inspector ---------- */

.cms-insp { padding: 8px 10px 40px; display: flex; flex-direction: column; gap: 14px; }
.cms-insp__crumb {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--cms-muted);
  font-size: 11px;
}
.cms-insp__title { font-size: 12.5px; font-weight: 600; color: var(--cms-text); }
.cms-section { display: flex; flex-direction: column; gap: 6px; }
.cms-section__head {
  color: var(--cms-muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}
.cms-field { display: grid; grid-template-columns: 58px minmax(0, 1fr); align-items: center; gap: 8px; }
.cms-field > label { color: var(--cms-muted); font-size: 11px; }
.cms-field--wide { grid-template-columns: 1fr; gap: 3px; }
.cms-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.cms-check { display: flex; align-items: center; gap: 6px; font-size: 11.5px; }
.cms-check input { margin: 0; }
.cms-hint { color: var(--cms-muted); font-size: 10.5px; }
.cms-row-actions { display: flex; gap: 5px; flex-wrap: wrap; }

.cms-issues { margin: 0; padding: 6px 8px 6px 20px; border: 1px solid #52241f; border-radius: 5px; background: #2a1715; color: #f0b3ae; font-size: 11px; }
.cms-issues li { margin: 1px 0; }

/* ---------- status bar ---------- */

.cms-status {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  height: 26px;
  padding: 0 10px;
  border-top: 1px solid var(--cms-line);
  background: var(--cms-panel);
  color: var(--cms-muted);
  font-size: 11px;
}
.cms-status__msg { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cms-status--error .cms-status__msg { color: #f0b3ae; }
.cms-status--success .cms-status__msg { color: #93e3a3; }
.cms-status__meta { flex: 0 0 auto; font-variant-numeric: tabular-nums; }

/* ---------- desktop only ---------- */

.cms-narrow { display: none; }
@media (max-width: ${MOBILE_BREAKPOINT - 1}px) {
  .cms-root > .cms-toolbar,
  .cms-root > .cms-panes,
  .cms-root > .cms-status { display: none; }
  .cms-narrow {
    display: flex;
    flex-direction: column;
    gap: 8px;
    justify-content: center;
    height: 100%;
    padding: 24px;
    text-align: center;
  }
  .cms-narrow h1 { margin: 0; font-size: 15px; }
  .cms-narrow p { margin: 0; color: var(--cms-muted); font-size: 12px; }
}
`;

/**
 * Inject the stylesheet once per document. Idempotent: mounting two shells, or
 * remounting one, does not duplicate it, and nothing removes it on unmount
 * because a second shell may still be using it.
 *
 * useInsertionEffect, not useEffect: it runs before the browser paints, so
 * there is no frame of unstyled editor chrome and no CSS transition kicking
 * off from the unstyled values. It is a no-op during SSR, which is what we
 * want, because the editor is client rendered.
 */
export function useShellStyles(): void {
  useInsertionEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(SHELL_STYLE_ID) !== null) return;
    const style = document.createElement('style');
    style.id = SHELL_STYLE_ID;
    style.textContent = SHELL_CSS;
    document.head.append(style);
  }, []);
}
