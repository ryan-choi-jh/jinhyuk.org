/**
 * src/cms/app/records/styles.ts
 *
 * WS-E. The record editors' stylesheet, as a string, plus a hook that injects
 * it once per document.
 *
 * A string and not a `.css` file for the same reason as `../shell/styles.ts`:
 * this code is bundled three ways (Astro/Vite for the app, esbuild for the
 * standalone harness, plain `tsc` for a typecheck) and only one of them
 * resolves `import './records.css'`.
 *
 * Every colour comes through `var(--cms-*, <fallback>)`, so nested inside
 * WS-D's shell the editors inherit the shell's palette, and mounted on their
 * own in the harness they still look like the CMS rather than like a browser
 * default form. Nothing here redefines a `--cms-*` token: that would override
 * the shell.
 *
 * The one allowed breakpoint comes from the schema constant (900px,
 * docs/cms-rebuild.md rule 6). No other width is invented here.
 */

import { useInsertionEffect } from 'react';

import { MOBILE_BREAKPOINT } from '../../schema.ts';

export const RECORDS_STYLE_ID = 'cms-records-styles';

export const RECORDS_CSS = `
.cms-rec {
  --rec-bg: var(--cms-bg, #15171a);
  --rec-panel: var(--cms-panel, #1b1e22);
  --rec-panel-2: var(--cms-panel-2, #22262b);
  --rec-line: var(--cms-line, #2d3238);
  --rec-line-strong: var(--cms-line-strong, #3b424a);
  --rec-text: var(--cms-text, #e7eaed);
  --rec-muted: var(--cms-muted, #8d969f);
  --rec-accent: var(--cms-accent, #4c8dff);
  --rec-accent-dim: var(--cms-accent-dim, #1f3a66);
  --rec-danger: var(--cms-danger, #e5534b);
  --rec-success: var(--cms-success, #3fb950);
  --rec-warn: var(--cms-warn, #d6a327);
  --rec-tile: 168px;

  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  box-sizing: border-box;
  background: var(--rec-bg);
  color: var(--rec-text);
  font: 12px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.cms-rec *, .cms-rec *::before, .cms-rec *::after { box-sizing: border-box; }
.cms-rec button, .cms-rec input, .cms-rec select, .cms-rec textarea {
  font: inherit;
  color: inherit;
}

/* ---------- controls ---------- */

.cms-rec__btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--rec-line-strong);
  border-radius: 5px;
  background: var(--rec-panel-2);
  color: var(--rec-text);
  cursor: pointer;
  white-space: nowrap;
}
.cms-rec__btn:hover:not(:disabled) { background: #2a2f36; }
.cms-rec__btn:active:not(:disabled) { background: #31373f; }
.cms-rec__btn:disabled { opacity: 0.4; cursor: default; }
.cms-rec__btn:focus-visible { outline: 2px solid var(--rec-accent); outline-offset: 1px; }
.cms-rec__btn--primary { background: var(--rec-accent); border-color: var(--rec-accent); color: #fff; }
.cms-rec__btn--primary:hover:not(:disabled) { background: #5e99ff; }
.cms-rec__btn--quiet { background: transparent; border-color: transparent; color: var(--rec-muted); }
.cms-rec__btn--quiet:hover:not(:disabled) { background: var(--rec-panel-2); color: var(--rec-text); }
.cms-rec__btn--danger { color: var(--rec-danger); }
.cms-rec__btn--tiny { height: 20px; padding: 0 6px; font-size: 11px; }
.cms-rec__btn--micro {
  width: 20px;
  height: 20px;
  padding: 0;
  justify-content: center;
  font-size: 11px;
  line-height: 1;
}

.cms-rec__input, .cms-rec__textarea {
  width: 100%;
  min-width: 0;
  padding: 0 7px;
  border: 1px solid var(--rec-line-strong);
  border-radius: 5px;
  background: #15181c;
  color: var(--rec-text);
}
.cms-rec__input { height: 26px; }
.cms-rec__textarea { padding: 5px 7px; min-height: 58px; resize: vertical; line-height: 1.5; }
.cms-rec__input:focus, .cms-rec__textarea:focus { outline: none; border-color: var(--rec-accent); }
.cms-rec__input--bad, .cms-rec__textarea--bad { border-color: var(--rec-danger); }
.cms-rec__input--mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }

/* ---------- layout ---------- */

.cms-rec__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  height: 34px;
  padding: 0 12px;
  border-bottom: 1px solid var(--rec-line);
  background: var(--rec-panel);
}
.cms-rec__kicker {
  font-size: 10px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--rec-muted);
}
.cms-rec__title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cms-rec__spacer { flex: 1 1 auto; }

.cms-rec__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 14px 12px 36px;
}
.cms-rec__cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}
.cms-rec__col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }

.cms-rec__group {
  border: 1px solid var(--rec-line);
  border-radius: 7px;
  background: var(--rec-panel);
  padding: 10px 11px 12px;
}
.cms-rec__group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: -2px 0 9px;
  font-size: 10px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--rec-muted);
}
/* The kicker is small caps; the controls beside it are not. */
.cms-rec__group-head .cms-rec__help,
.cms-rec__group-head .cms-rec__btn,
.cms-rec__group-head label {
  text-transform: none;
  letter-spacing: 0;
  font-size: 11px;
}

/* ---------- fields ---------- */

.cms-rec__field { display: flex; flex-direction: column; gap: 4px; }
.cms-rec__field + .cms-rec__field { margin-top: 10px; }
.cms-rec__label {
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-size: 11px;
  color: var(--rec-muted);
}
.cms-rec__req { color: var(--rec-warn); }
.cms-rec__help { font-size: 11px; color: var(--rec-muted); }
.cms-rec__problem { font-size: 11px; color: var(--rec-danger); }
.cms-rec__ok { font-size: 11px; color: var(--rec-success); }
.cms-rec__url {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--rec-muted);
  word-break: break-all;
}
.cms-rec__row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

/* ---------- the film stage ---------- */

.cms-rec__stage {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  border: 1px solid var(--rec-line-strong);
  border-radius: 7px;
  overflow: hidden;
  background: #0d0f11;
}
.cms-rec__stage--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  border-style: dashed;
  color: var(--rec-muted);
  text-align: center;
  padding: 16px;
}
.cms-rec__stage img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cms-rec__stage iframe { width: 100%; height: 100%; border: 0; display: block; }
.cms-rec__play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  cursor: pointer;
  padding: 0;
}
.cms-rec__play::before {
  content: "";
  position: absolute;
  inset: 0;
  background: radial-gradient(60% 60% at 50% 50%, rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.55));
}
.cms-rec__play-dot {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 54px;
  height: 54px;
  border-radius: 50%;
  background: rgba(16, 18, 21, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.4);
  color: #fff;
  font-size: 18px;
  padding-left: 4px;
}
.cms-rec__play:hover .cms-rec__play-dot { background: rgba(16, 18, 21, 0.9); }
.cms-rec__badge {
  position: absolute;
  left: 7px;
  bottom: 7px;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(13, 15, 17, 0.82);
  border: 1px solid var(--rec-line-strong);
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--rec-muted);
}
.cms-rec__badge--own { color: var(--rec-text); }

/* ---------- poster ---------- */

.cms-rec__poster { display: flex; gap: 10px; align-items: flex-start; }
.cms-rec__poster-thumb {
  flex: none;
  width: 124px;
  aspect-ratio: 16 / 9;
  border: 1px solid var(--rec-line-strong);
  border-radius: 5px;
  overflow: hidden;
  background: #0d0f11;
}
.cms-rec__poster-thumb { position: relative; }
.cms-rec__poster-thumb img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cms-rec__poster-side { display: flex; flex-direction: column; gap: 6px; min-width: 0; }

/* ---------- the photo grid ---------- */

.cms-rec__drop {
  position: relative;
  border: 1px dashed var(--rec-line-strong);
  border-radius: 7px;
  padding: 10px;
  background: #16191d;
}
.cms-rec__drop[data-dropping="true"] {
  border-color: var(--rec-accent);
  background: var(--rec-accent-dim);
}
.cms-rec__drop-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: center;
  padding: 22px 10px;
  color: var(--rec-muted);
  text-align: center;
}

.cms-rec__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--rec-tile), 1fr));
  gap: 10px;
}
.cms-rec__tile {
  position: relative;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--rec-line);
  border-radius: 7px;
  background: var(--rec-panel);
  overflow: hidden;
}
.cms-rec__tile[data-cover="true"] { border-color: var(--rec-accent); box-shadow: 0 0 0 1px var(--rec-accent); }
.cms-rec__tile[data-dragging="true"] {
  z-index: 3;
  border-color: var(--rec-accent);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.55);
  opacity: 0.97;
}
.cms-rec__tile[data-shifted="true"] { transition: transform 110ms ease; }
.cms-rec__thumb {
  position: relative;
  aspect-ratio: 4 / 3;
  background: #0d0f11;
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.cms-rec__tile[data-dragging="true"] .cms-rec__thumb { cursor: grabbing; }
/* Absolute, so a tall photograph cannot stretch the cell past its 4:3 box and
   turn the grid into one screen per picture. */
.cms-rec__thumb img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  pointer-events: none;
}
.cms-rec__thumb--blank {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--rec-muted);
  font-size: 11px;
}
.cms-rec__num {
  position: absolute;
  top: 5px;
  left: 5px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: rgba(13, 15, 17, 0.82);
  border: 1px solid var(--rec-line-strong);
  font-size: 10px;
  color: var(--rec-muted);
}
.cms-rec__tile-acts {
  position: absolute;
  top: 5px;
  right: 5px;
  display: flex;
  gap: 4px;
}
.cms-rec__tile-acts .cms-rec__btn {
  background: rgba(13, 15, 17, 0.82);
  backdrop-filter: blur(2px);
}
.cms-rec__btn--star[data-on="true"] {
  background: var(--rec-accent);
  border-color: var(--rec-accent);
  color: #fff;
}
.cms-rec__cover-tag {
  position: absolute;
  left: 5px;
  bottom: 5px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--rec-accent);
  color: #fff;
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.cms-rec__tile-foot { display: flex; flex-direction: column; gap: 4px; padding: 6px; }
.cms-rec__tile-foot .cms-rec__input { height: 22px; font-size: 11px; }
.cms-rec__tile-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  justify-content: space-between;
  color: var(--rec-muted);
  font-size: 10px;
}
.cms-rec__dims { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

/* ---------- upload tiles ---------- */

.cms-rec__tile--task { border-style: dashed; }
.cms-rec__task {
  display: flex;
  flex-direction: column;
  gap: 6px;
  aspect-ratio: 4 / 3;
  padding: 8px;
  justify-content: center;
}
.cms-rec__task-name {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cms-rec__task-state { font-size: 10px; color: var(--rec-muted); text-transform: uppercase; letter-spacing: 0.06em; }
.cms-rec__task--failed { border-color: var(--rec-danger); }
.cms-rec__task--failed .cms-rec__task-state { color: var(--rec-danger); }
.cms-rec__bar {
  height: 4px;
  border-radius: 999px;
  background: #0d0f11;
  overflow: hidden;
  border: 1px solid var(--rec-line);
}
.cms-rec__bar-fill { height: 100%; background: var(--rec-accent); transition: width 90ms linear; }
.cms-rec__bar--waiting .cms-rec__bar-fill { background: var(--rec-line-strong); }
.cms-rec__task-err {
  font-size: 10px;
  color: var(--rec-danger);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

/* ---------- undo ---------- */

.cms-rec__undo {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 6px 8px;
  border: 1px solid var(--rec-line-strong);
  border-radius: 6px;
  background: var(--rec-panel-2);
}
.cms-rec__undo-text { flex: 1 1 auto; min-width: 0; color: var(--rec-muted); }

/* ---------- validity line ---------- */

.cms-rec__issues {
  margin-top: 12px;
  padding: 8px 10px;
  border: 1px solid #4a2320;
  border-radius: 6px;
  background: #241617;
  color: #f0a8a3;
}
.cms-rec__issues ul { margin: 4px 0 0; padding-left: 16px; }

@media (max-width: ${MOBILE_BREAKPOINT - 1}px) {
  .cms-rec__cols { grid-template-columns: minmax(0, 1fr); }
  .cms-rec { --rec-tile: 136px; }
}
`;

/**
 * Inject `RECORDS_CSS` once per document. Idempotent across any number of
 * mounted editors, and safe under StrictMode's double render.
 */
export function useRecordsStyles(): void {
  useInsertionEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(RECORDS_STYLE_ID) !== null) return;
    const style = document.createElement('style');
    style.id = RECORDS_STYLE_ID;
    style.textContent = RECORDS_CSS;
    document.head.append(style);
  }, []);
}
