/**
 * src/cms/app/guide/styles.ts
 *
 * The guide's stylesheet, as a string, plus a hook that injects it once.
 *
 * Same shape as the shell's stylesheet and for the same reasons: a string
 * works under Astro, Vite, esbuild and a bare `tsc` without any of them
 * configuring a CSS loader.
 *
 * The guide is deliberately self-contained. It imports nothing from
 * `../shell/`, so every colour is written as `var(--cms-token, fallback)`.
 * Mounted inside the editor it inherits the shell's tokens from `.cms-root`;
 * mounted alone in the harness the fallbacks are the same values, so it looks
 * identical either way and neither file has to know about the other.
 *
 * The one place it departs from the editor chrome: body text is 13px rather
 * than 12px, and sits at a lighter grey than `--cms-muted`. The editor is a
 * dense instrument panel. This is a page you read.
 */

import { useInsertionEffect } from 'react';

export const GUIDE_STYLE_ID = 'cms-guide-styles';

export const GUIDE_CSS = `
.cms-guide-backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 36px 28px;
  background: rgba(8, 9, 11, 0.66);
  font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
  animation: cms-guide-fade 110ms ease-out;
}
.cms-guide-backdrop *, .cms-guide-backdrop *::before, .cms-guide-backdrop *::after { box-sizing: border-box; }

.cms-guide {
  /*
   * A container, so the panel lays itself out from its own width and not the
   * window's. That is what lets the identical component be right at 1240px
   * in the modal and at 700px in the editor's preview column.
   */
  container-type: inline-size;
  container-name: guide;
  display: flex;
  flex-direction: column;
  width: min(1240px, 100%);
  max-height: 100%;
  border: 1px solid var(--cms-line-strong, #3b424a);
  border-radius: 10px;
  background: var(--cms-panel, #1b1e22);
  color: var(--cms-text, #e7eaed);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
  animation: cms-guide-rise 140ms cubic-bezier(0.2, 0.7, 0.3, 1);
}
.cms-guide:focus { outline: none; }
/* The preview is not opening, it is just there. */
.cms-guide--still { animation: none; }

@keyframes cms-guide-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes cms-guide-rise {
  from { opacity: 0; transform: translateY(8px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .cms-guide-backdrop, .cms-guide { animation: none; }
}

/* ---------- header ---------- */

.cms-guide__head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  flex: 0 0 auto;
  padding: 18px 22px 15px;
  border-bottom: 1px solid var(--cms-line, #2d3238);
}
.cms-guide__heading { flex: 1 1 auto; min-width: 0; }
.cms-guide__title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.005em;
}
.cms-guide__lead {
  margin: 5px 0 0;
  max-width: 68ch;
  color: var(--cms-muted, #8d969f);
  font-size: 12.5px;
}

/* ---------- body ---------- */

/*
 * CSS columns rather than a grid. The cards are different heights, and a
 * grid leaves a hole wherever the next card is taller than the gap left for
 * it; columns pack them. break-inside: avoid is what keeps a card whole.
 * Three columns is what makes the whole guide fit a 1600x1000 window with
 * nothing to scroll, which is the difference between skimming it and
 * reading it.
 */
.cms-guide__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 16px 22px 6px;
  column-count: 3;
  column-gap: 16px;
}
@container guide (max-width: 1140px) { .cms-guide__body { column-count: 2; } }
@container guide (max-width: 740px) { .cms-guide__body { column-count: 1; } }
.cms-guide__body::-webkit-scrollbar { width: 10px; }
.cms-guide__body::-webkit-scrollbar-thumb {
  border: 3px solid transparent;
  border-radius: 6px;
  background: var(--cms-line-strong, #3b424a) content-box;
}

.cms-guide-card {
  break-inside: avoid;
  min-width: 0;
  margin: 0 0 14px;
  padding: 13px 15px 14px;
  border: 1px solid var(--cms-line, #2d3238);
  border-radius: 8px;
  background: var(--cms-panel-2, #22262b);
}
.cms-guide-card__title {
  margin: 0 0 3px;
  font-size: 13px;
  font-weight: 600;
}
.cms-guide-card__lead {
  margin: 0 0 9px;
  max-width: 76ch;
  color: var(--cms-muted, #8d969f);
  font-size: 12px;
}
.cms-guide-card__note {
  margin: 10px 0 0;
  padding-top: 9px;
  border-top: 1px solid var(--cms-line, #2d3238);
  color: var(--cms-muted, #8d969f);
  font-size: 11.5px;
}

/* ---------- the term / description rows ---------- */

.cms-guide-rows {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 7px 14px;
  margin: 7px 0 0;
  align-items: baseline;
}
.cms-guide-rows__term {
  margin: 0;
  font-weight: 600;
  color: var(--cms-text, #e7eaed);
}
.cms-guide-rows__text {
  margin: 0;
  max-width: 62ch;
  color: #c2c9d1;
}
.cms-guide-rows__term--key {
  justify-self: start;
  padding: 1px 7px;
  border: 1px solid var(--cms-line-strong, #3b424a);
  border-radius: 4px;
  background: #14171a;
  font: 500 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
}

/* ---------- footer ---------- */

.cms-guide__foot {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 0 0 auto;
  padding: 11px 22px 12px;
  border-top: 1px solid var(--cms-line, #2d3238);
  color: var(--cms-muted, #8d969f);
  font-size: 11.5px;
}
.cms-guide__foot-spacer { flex: 1 1 auto; }

/* ---------- buttons, replicating the editor's .cms-btn ---------- */

.cms-guide-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--cms-line-strong, #3b424a);
  border-radius: 5px;
  background: var(--cms-panel-2, #22262b);
  color: var(--cms-text, #e7eaed);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}
.cms-guide-btn:hover { background: #2a2f36; }
.cms-guide-btn:active { background: #31373f; }
.cms-guide-btn:focus-visible { outline: 2px solid var(--cms-accent, #4c8dff); outline-offset: 1px; }
.cms-guide-btn--icon { width: 24px; padding: 0; font-size: 13px; }
.cms-guide-btn--on {
  border-color: var(--cms-accent, #4c8dff);
  background: var(--cms-accent-dim, #1f3a66);
  color: #fff;
}
.cms-guide-btn--close { font-size: 15px; }
.cms-guide-btn--tiny { height: 20px; padding: 0 6px; font-size: 11px; }
.cms-guide-btn--danger { color: var(--cms-danger, #e5534b); }
.cms-guide-btn:disabled { opacity: 0.35; cursor: default; }
.cms-guide-btn:disabled:hover { background: var(--cms-panel-2, #22262b); }

/* ---------- Hint ---------- */

.cms-hint-wrap { position: relative; display: inline-flex; }
.cms-hint-bubble {
  position: absolute;
  z-index: 300;
  top: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  max-width: 260px;
  padding: 4px 8px;
  border: 1px solid var(--cms-line-strong, #3b424a);
  border-radius: 5px;
  background: #0f1113;
  color: var(--cms-text, #e7eaed);
  font: 11.5px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif;
  text-align: left;
  white-space: normal;
  width: max-content;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
  pointer-events: none;
}
.cms-hint-bubble--above { top: auto; bottom: calc(100% + 6px); }

/* ---------- narrow windows ---------- */

/* The column count is a container query, above. This is only the margin. */
@media (max-width: 900px) {
  .cms-guide-backdrop { padding: 16px; }
}

/* ---------- the guide editor ---------- */

.cms-ge {
  display: grid;
  grid-template-columns: minmax(360px, 1fr) minmax(0, 1.15fr);
  gap: 0;
  height: 100%;
  min-height: 0;
  background: var(--cms-bg, #15171a);
  color: var(--cms-text, #e7eaed);
  font: 12px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.cms-ge *, .cms-ge *::before, .cms-ge *::after { box-sizing: border-box; }
.cms-ge--no-preview { grid-template-columns: minmax(0, 1fr); }

.cms-ge__form {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 12px 14px 40px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-right: 1px solid var(--cms-line, #2d3238);
  background: var(--cms-panel, #1b1e22);
}
.cms-ge--no-preview .cms-ge__form { border-right: 0; }

.cms-ge__preview { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: #0f1113; }
.cms-ge__preview-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border-bottom: 1px solid var(--cms-line, #2d3238);
}
.cms-ge__preview-stage {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 16px;
  display: flex;
  justify-content: center;
  align-items: flex-start;
}
/* In the preview the panel is a block on a page, not a thing over the editor. */
.cms-ge__preview-stage .cms-guide { max-height: none; box-shadow: none; }

.cms-ge-label {
  color: var(--cms-muted, #8d969f);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.cms-ge-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 11px 11px;
  border: 1px solid var(--cms-line, #2d3238);
  border-radius: 7px;
  background: var(--cms-panel-2, #22262b);
}
.cms-ge-block__head { display: flex; align-items: center; gap: 6px; }
.cms-ge-block__spacer { flex: 1 1 auto; }
.cms-ge-block__index {
  flex: 0 0 auto;
  min-width: 14px;
  color: var(--cms-muted, #8d969f);
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
}
.cms-ge-block__foot { display: flex; }

.cms-ge-field { display: grid; grid-template-columns: 58px minmax(0, 1fr); align-items: start; gap: 8px; }
.cms-ge-field > span { padding-top: 5px; color: var(--cms-muted, #8d969f); font-size: 11px; }

.cms-ge-input {
  width: 100%;
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--cms-line-strong, #3b424a);
  border-radius: 5px;
  background: #14171a;
  color: var(--cms-text, #e7eaed);
  font: inherit;
}
.cms-ge-input:focus { outline: none; border-color: var(--cms-accent, #4c8dff); }
.cms-ge-input--heading { flex: 1 1 auto; font-weight: 600; }
.cms-ge-area { height: auto; min-height: 38px; padding: 4px 6px; line-height: 1.45; resize: vertical; }

.cms-ge-rows { display: flex; flex-direction: column; gap: 6px; }
.cms-ge-row {
  display: grid;
  grid-template-columns: 34px minmax(88px, 0.55fr) minmax(0, 1.45fr) auto;
  align-items: start;
  gap: 6px;
  padding: 6px;
  border: 1px solid var(--cms-line, #2d3238);
  border-radius: 6px;
  background: #1a1d21;
}
/* Across, not down: stacked buttons made every row three buttons tall. */
.cms-ge-row__actions { display: flex; gap: 3px; }
.cms-ge-row__key { width: 34px; padding: 0; justify-content: center; }

.cms-ge-add { align-self: flex-start; }

.cms-ge-issues {
  margin: 0;
  padding: 6px 9px;
  border: 1px solid #52241f;
  border-radius: 6px;
  background: #2a1715;
  color: #f0b3ae;
  font-size: 11px;
}

/* One column once there is no room for a form and a panel side by side. */
@media (max-width: 1100px) {
  .cms-ge { grid-template-columns: minmax(0, 1fr); grid-template-rows: 1fr 1fr; }
  .cms-ge__form { border-right: 0; border-bottom: 1px solid var(--cms-line, #2d3238); }
}
`;

/**
 * Inject the stylesheet once per document. Idempotent, and nothing removes it
 * on unmount because the button may still be on screen with the panel closed.
 *
 * useInsertionEffect runs before paint, so the panel never shows a frame of
 * unstyled markup and its open animation starts from the styled values.
 */
export function useGuideStyles(): void {
  useInsertionEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(GUIDE_STYLE_ID) !== null) return;
    const style = document.createElement('style');
    style.id = GUIDE_STYLE_ID;
    style.textContent = GUIDE_CSS;
    document.head.append(style);
  }, []);
}
