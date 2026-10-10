/**
 * src/cms/app/library/styles.ts
 *
 * The library's stylesheet, as a string, plus a hook that injects it once.
 *
 * Same approach as `../guide/styles.ts`, for the same reason: a string works
 * under Astro, Vite, esbuild and a bare `tsc` without any of them configuring
 * a CSS loader, and the harness needs no build step beyond the bundle.
 *
 * Every colour is `var(--cms-token, fallback)` with the fallback set to the
 * editor's own value. Mounted inside the editor the tokens come from
 * `.cms-root`; mounted alone in the harness the fallbacks are identical, so it
 * looks the same either way and this file does not import the shell.
 *
 * Two deliberate departures from the editor's instrument-panel chrome:
 *
 *  - Thumbnails sit on paper, not on panel. A black squiggle on a #1b1e22
 *    panel is invisible, and so is the white edge of a photograph. Shapes get
 *    a white ground and transparent assets get a chequerboard, because that is
 *    the only way to tell "transparent PNG" from "white PNG" at 90px.
 *  - The grid tile is a fixed 4:3 and the artwork is fitted inside it. Letting
 *    tiles take the asset's own aspect makes a wall with a 1206x2622 phone
 *    screenshot in it unreadable; every row would be 300px tall.
 */

import { useInsertionEffect } from 'react';

export const LIBRARY_STYLE_ID = 'cms-library-styles';

/** The grid tile's aspect ratio. ./LibraryBrowser.tsx fits artwork against it. */
export const TILE_ASPECT = 4 / 3;

/** The detail panel's preview stage aspect ratio. */
export const STAGE_ASPECT = 16 / 10;

export const LIBRARY_CSS = `
.cms-lib {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: var(--cms-bg, #15171a);
  color: var(--cms-text, #e7eaed);
  font: 12px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.cms-lib *, .cms-lib *::before, .cms-lib *::after { box-sizing: border-box; }

/* ---------- header ---------- */

.cms-lib__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  padding: 10px 14px;
  border-bottom: 1px solid var(--cms-line, #2d3238);
  background: var(--cms-panel, #1b1e22);
}
.cms-lib__title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--cms-muted, #8d969f);
  white-space: nowrap;
}
.cms-lib__search {
  position: relative;
  flex: 1 1 auto;
  min-width: 120px;
  max-width: 420px;
}
.cms-lib__search input {
  width: 100%;
  height: 26px;
  padding: 0 24px 0 9px;
  border: 1px solid var(--cms-line-strong, #3b424a);
  border-radius: 5px;
  background: var(--cms-bg, #15171a);
  color: var(--cms-text, #e7eaed);
  font: inherit;
}
.cms-lib__search input::placeholder { color: var(--cms-muted, #8d969f); }
.cms-lib__search input:focus { outline: none; border-color: var(--cms-accent, #4c8dff); }
.cms-lib__clear {
  position: absolute;
  top: 50%;
  right: 4px;
  transform: translateY(-50%);
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--cms-muted, #8d969f);
  font: inherit;
  line-height: 1;
  cursor: pointer;
}
.cms-lib__clear:hover { background: var(--cms-panel-2, #22262b); color: var(--cms-text, #e7eaed); }

.cms-lib__seg {
  display: flex;
  flex: 0 0 auto;
  padding: 2px;
  border: 1px solid var(--cms-line-strong, #3b424a);
  border-radius: 5px;
  background: var(--cms-bg, #15171a);
}
.cms-lib__seg button {
  height: 20px;
  padding: 0 9px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--cms-muted, #8d969f);
  font: inherit;
  cursor: pointer;
}
.cms-lib__seg button:hover { color: var(--cms-text, #e7eaed); }
.cms-lib__seg button[aria-pressed='true'] {
  background: var(--cms-panel-2, #22262b);
  color: var(--cms-text, #e7eaed);
  box-shadow: inset 0 0 0 1px var(--cms-line-strong, #3b424a);
}
.cms-lib__close {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--cms-muted, #8d969f);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.cms-lib__close:hover { border-color: var(--cms-line-strong, #3b424a); color: var(--cms-text, #e7eaed); }

/* ---------- category chips ---------- */

.cms-lib__cats {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  flex: 0 0 auto;
  padding: 8px 14px;
  border-bottom: 1px solid var(--cms-line, #2d3238);
  background: var(--cms-panel, #1b1e22);
}
.cms-lib__chip {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  height: 22px;
  padding: 0 9px;
  border: 1px solid var(--cms-line-strong, #3b424a);
  border-radius: 11px;
  background: transparent;
  color: var(--cms-muted, #8d969f);
  font: inherit;
  cursor: pointer;
}
.cms-lib__chip:hover { color: var(--cms-text, #e7eaed); border-color: var(--cms-accent, #4c8dff); }
.cms-lib__chip[aria-pressed='true'] {
  border-color: var(--cms-accent, #4c8dff);
  background: var(--cms-accent-dim, #1f3a66);
  color: #fff;
}
.cms-lib__chip-n { font-size: 10px; opacity: 0.7; font-variant-numeric: tabular-nums; }
.cms-lib__chip--empty { opacity: 0.4; }

/* ---------- body ---------- */

.cms-lib__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  flex: 1 1 auto;
  min-height: 0;
}
@media (max-width: 1100px) { .cms-lib__body { grid-template-columns: minmax(0, 1fr) 290px; } }

.cms-lib__grid {
  min-width: 0;
  overflow: auto;
  padding: 14px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(146px, 1fr));
  gap: 12px;
  align-content: start;
}
.cms-lib__grid::-webkit-scrollbar, .cms-lib__detail::-webkit-scrollbar { width: 10px; }
.cms-lib__grid::-webkit-scrollbar-thumb, .cms-lib__detail::-webkit-scrollbar-thumb {
  border: 3px solid transparent;
  border-radius: 6px;
  background: var(--cms-line-strong, #3b424a) content-box;
}

.cms-lib__empty {
  grid-column: 1 / -1;
  padding: 40px 0;
  color: var(--cms-muted, #8d969f);
  text-align: center;
}
.cms-lib__empty b { color: var(--cms-text, #e7eaed); font-weight: 600; }

/* ---------- a tile ---------- */

.cms-lib-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 0;
  border: 1px solid var(--cms-line, #2d3238);
  border-radius: 7px;
  background: var(--cms-panel, #1b1e22);
  font: inherit;
  text-align: left;
  color: inherit;
  cursor: pointer;
  overflow: hidden;
}
.cms-lib-card:hover { border-color: var(--cms-line-strong, #3b424a); }
.cms-lib-card:focus-visible { outline: 2px solid var(--cms-accent, #4c8dff); outline-offset: 1px; }
.cms-lib-card--on { border-color: var(--cms-accent, #4c8dff); box-shadow: 0 0 0 1px var(--cms-accent, #4c8dff); }

.cms-lib-thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 4 / 3;
  padding: 8px;
  border-bottom: 1px solid var(--cms-line, #2d3238);
  overflow: hidden;
}
.cms-lib-thumb--panel { background: var(--cms-panel-2, #22262b); }
/* Shapes are ink on paper. On a dark panel there is nothing to see. */
.cms-lib-thumb--paper { background: #fbfaf8; }
/*
 * A chequerboard, so a transparent PNG is distinguishable from a white one.
 * Two gradients rather than an image, so nothing is fetched.
 */
.cms-lib-thumb--alpha {
  background-color: #efece7;
  background-image:
    linear-gradient(45deg, #d9d4cb 25%, transparent 25%, transparent 75%, #d9d4cb 75%),
    linear-gradient(45deg, #d9d4cb 25%, transparent 25%, transparent 75%, #d9d4cb 75%);
  background-size: 14px 14px;
  background-position: 0 0, 7px 7px;
}
.cms-lib-thumb img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
}
/*
 * The generated SVG is width="100%" height="100%" preserveAspectRatio="none",
 * so it takes whatever box it is given. The box is sized in percentages by
 * LibraryBrowser.tsx against TILE_ASPECT, which is how the drawing keeps its
 * own proportions without measuring anything.
 */
.cms-lib-fit { display: block; }
.cms-lib-fit svg { display: block; width: 100%; height: 100%; }

.cms-lib-card__body { padding: 7px 9px 8px; min-width: 0; }
.cms-lib-card__name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 500;
  color: var(--cms-text, #e7eaed);
}
.cms-lib-card__meta {
  display: block;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--cms-muted, #8d969f);
  font-variant-numeric: tabular-nums;
}
.cms-lib-card__badge {
  position: absolute;
  top: 5px;
  right: 5px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(10, 11, 13, 0.72);
  color: #e7eaed;
  font-size: 9px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/* ---------- detail ---------- */

.cms-lib__detail {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: auto;
  border-left: 1px solid var(--cms-line, #2d3238);
  background: var(--cms-panel, #1b1e22);
}
.cms-lib__detail-empty {
  margin: auto;
  padding: 24px;
  color: var(--cms-muted, #8d969f);
  text-align: center;
}

.cms-lib-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 16 / 10;
  padding: 14px;
  border-bottom: 1px solid var(--cms-line, #2d3238);
  overflow: hidden;
}
.cms-lib-stage img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }

.cms-lib-detail__head { padding: 12px 14px 10px; border-bottom: 1px solid var(--cms-line, #2d3238); }
.cms-lib-detail__name { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -0.005em; }
.cms-lib-detail__sub {
  margin: 3px 0 0;
  color: var(--cms-muted, #8d969f);
  font-variant-numeric: tabular-nums;
}
.cms-lib-detail__note { margin: 8px 0 0; color: #b9c0c7; font-size: 12px; }
.cms-lib-detail__tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 9px; }
.cms-lib-tag {
  padding: 1px 6px;
  border: 1px solid var(--cms-line, #2d3238);
  border-radius: 9px;
  background: var(--cms-panel-2, #22262b);
  color: var(--cms-muted, #8d969f);
  font-size: 10.5px;
  cursor: pointer;
}
.cms-lib-tag:hover { color: var(--cms-text, #e7eaed); border-color: var(--cms-accent, #4c8dff); }

.cms-lib-rows { padding: 10px 14px; border-bottom: 1px solid var(--cms-line, #2d3238); }
.cms-lib-row {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  min-height: 26px;
}
.cms-lib-row + .cms-lib-row { margin-top: 6px; }
.cms-lib-row__label { color: var(--cms-muted, #8d969f); }
.cms-lib-row__value { min-width: 0; font-variant-numeric: tabular-nums; }
.cms-lib-row__value--path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: #b9c0c7;
}
.cms-lib-row__pair { display: flex; align-items: center; gap: 6px; }

.cms-lib-input, .cms-lib-num {
  height: 24px;
  min-width: 0;
  padding: 0 7px;
  border: 1px solid var(--cms-line-strong, #3b424a);
  border-radius: 5px;
  background: var(--cms-bg, #15171a);
  color: var(--cms-text, #e7eaed);
  font: inherit;
  font-variant-numeric: tabular-nums;
}
.cms-lib-num { width: 62px; text-align: right; }
.cms-lib-input:focus, .cms-lib-num:focus { outline: none; border-color: var(--cms-accent, #4c8dff); }
.cms-lib-input--hex { width: 86px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.cms-lib-input--bad { border-color: var(--cms-danger, #e5534b); }

.cms-lib-swatches { display: flex; flex-wrap: wrap; gap: 4px; }
.cms-lib-swatch {
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--cms-line-strong, #3b424a);
  border-radius: 4px;
  cursor: pointer;
}
.cms-lib-swatch[aria-pressed='true'] { box-shadow: 0 0 0 2px var(--cms-accent, #4c8dff); }
.cms-lib-swatch--none {
  position: relative;
  background: var(--cms-bg, #15171a);
  overflow: hidden;
}
.cms-lib-swatch--none::after {
  content: '';
  position: absolute;
  top: 50%;
  left: -2px;
  right: -2px;
  height: 1px;
  background: var(--cms-danger, #e5534b);
  transform: rotate(-45deg);
}

.cms-lib-range { width: 100%; accent-color: var(--cms-accent, #4c8dff); }

.cms-lib-step { display: flex; align-items: center; gap: 4px; }
.cms-lib-step__btn {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--cms-line-strong, #3b424a);
  border-radius: 4px;
  background: var(--cms-panel-2, #22262b);
  color: var(--cms-text, #e7eaed);
  font: inherit;
  line-height: 1;
  cursor: pointer;
}
.cms-lib-step__btn:hover { border-color: var(--cms-accent, #4c8dff); }
.cms-lib-step__btn:disabled { opacity: 0.4; cursor: default; }
.cms-lib-step__value {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: #b9c0c7;
}

.cms-lib-hint { margin: 7px 0 0; color: var(--cms-muted, #8d969f); font-size: 10.5px; }

.cms-lib-detail__foot { margin-top: auto; padding: 12px 14px; }
.cms-lib-insert {
  width: 100%;
  height: 30px;
  border: 1px solid var(--cms-accent, #4c8dff);
  border-radius: 6px;
  background: var(--cms-accent, #4c8dff);
  color: #fff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.cms-lib-insert:hover { filter: brightness(1.08); }
.cms-lib-insert:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
.cms-lib-insert__size { margin-left: 6px; font-weight: 400; opacity: 0.8; font-variant-numeric: tabular-nums; }

/* ---------- footer ---------- */

.cms-lib__foot {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  padding: 7px 14px;
  border-top: 1px solid var(--cms-line, #2d3238);
  background: var(--cms-panel, #1b1e22);
  color: var(--cms-muted, #8d969f);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.cms-lib__problems { color: var(--cms-warn, #d6a327); cursor: help; }
`;

/**
 * Inject the stylesheet once per document. `useInsertionEffect` so the rules
 * land before React commits the first paint, which is what stops a flash of
 * unstyled grid.
 */
export function useLibraryStyles(): void {
  useInsertionEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(LIBRARY_STYLE_ID) !== null) return;
    const style = document.createElement('style');
    style.id = LIBRARY_STYLE_ID;
    style.textContent = LIBRARY_CSS;
    document.head.append(style);
  }, []);
}
