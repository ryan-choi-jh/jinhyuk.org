/**
 * src/cms/app/shell/site-styles.ts
 *
 * WS-D. The navigation shell's stylesheet, as a string, plus a hook that
 * injects it once — the same arrangement and the same reasons as
 * `./styles.ts` (one source of truth that works under Astro, esbuild and bare
 * tsc alike, with no loader and no `.css` import).
 *
 * It is additive. Phase 1's `SHELL_CSS` still defines `.cms-root`, the
 * buttons, the inputs, the toolbar and the three panes; this adds the frame
 * around them and reuses those controls rather than restyling them. The one
 * override is `.cms-root--embedded`: the document editor sets its own height
 * to `100dvh` because it used to be the whole page, and inside the site shell
 * it is one region of a grid.
 *
 * 900px is still the only breakpoint (docs/cms-rebuild.md rule 6), and it
 * comes from the schema constant rather than being typed again.
 */

import { useInsertionEffect } from 'react';

import { MOBILE_BREAKPOINT } from '../../schema.ts';
import { SHELL_CSS, SHELL_STYLE_ID } from './styles.ts';

export const SITE_STYLE_ID = 'cms-site-styles';

export const SITE_CSS = `
.cms-site {
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
  --cms-nav-w: 188px;
  --cms-list-w: 276px;

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
.cms-site *, .cms-site *::before, .cms-site *::after { box-sizing: border-box; }
.cms-site button, .cms-site input, .cms-site select, .cms-site textarea { font: inherit; color: inherit; }

/* The document editor is a region here, not the page. */
.cms-root--embedded { height: 100%; }

/* ---------- top bar ---------- */

.cms-site__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  height: 36px;
  padding: 0 10px;
  border-bottom: 1px solid var(--cms-line);
  background: var(--cms-panel);
}
.cms-site__brand {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 0;
  padding: 0;
  background: none;
  color: var(--cms-text);
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
}
.cms-site__brand:hover { color: var(--cms-accent); }
.cms-site__crumbs { display: flex; align-items: center; gap: 6px; color: var(--cms-muted); min-width: 0; }
.cms-site__crumb {
  border: 0;
  padding: 0;
  background: none;
  color: var(--cms-muted);
  cursor: pointer;
  white-space: nowrap;
}
.cms-site__crumb:hover { color: var(--cms-text); }
.cms-site__crumb--current { color: var(--cms-text); cursor: default; overflow: hidden; text-overflow: ellipsis; }
.cms-site__spacer { flex: 1 1 auto; }
.cms-site__auth { color: var(--cms-muted); font-variant-numeric: tabular-nums; }
.cms-site__auth--out { color: var(--cms-warn); }

/* ---------- body ---------- */

.cms-site__body {
  display: grid;
  grid-template-columns: var(--cms-nav-w) var(--cms-list-w) minmax(0, 1fr);
  flex: 1 1 auto;
  min-height: 0;
}
.cms-site__body--nolist { grid-template-columns: var(--cms-nav-w) minmax(0, 1fr); }
.cms-site__col { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.cms-site__col--nav { background: var(--cms-panel); border-right: 1px solid var(--cms-line); }
.cms-site__col--list { background: var(--cms-panel); border-right: 1px solid var(--cms-line); }
.cms-site__col--main { background: #0f1113; }
.cms-site__head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  height: 28px;
  padding: 0 6px 0 10px;
  border-bottom: 1px solid var(--cms-line);
  color: var(--cms-muted);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}
.cms-site__head-count { margin-left: auto; font-weight: 400; letter-spacing: 0; }
.cms-site__scroll { flex: 1 1 auto; min-height: 0; overflow: auto; }

/* ---------- section navigation ---------- */

.cms-nav { padding: 4px 0 16px; }
.cms-nav__row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: calc(100% - 12px);
  margin: 2px 6px;
  padding: 5px 7px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--cms-text);
  text-align: left;
  cursor: pointer;
}
.cms-nav__row:hover { background: var(--cms-panel-2); }
.cms-nav__row--current { background: var(--cms-accent-dim); border-color: var(--cms-accent); }
.cms-nav__glyph {
  flex: 0 0 auto;
  width: 16px;
  text-align: center;
  color: var(--cms-muted);
  font-size: 11px;
}
.cms-nav__row--current .cms-nav__glyph { color: var(--cms-accent); }
.cms-nav__label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cms-nav__count {
  flex: 0 0 auto;
  color: var(--cms-muted);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
.cms-nav__dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--cms-warn);
}
.cms-nav__kind {
  margin: 10px 12px 2px;
  color: var(--cms-muted);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

/* ---------- entry list ---------- */

.cms-list { padding: 4px 0 24px; }
.cms-list__row {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: calc(100% - 12px);
  margin: 2px 6px;
  padding: 6px 7px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--cms-panel-2);
  color: var(--cms-text);
  text-align: left;
  cursor: pointer;
}
.cms-list__row:hover { border-color: var(--cms-line-strong); }
.cms-list__row--current { border-color: var(--cms-accent); background: var(--cms-accent-dim); }
.cms-list__row--invalid { border-color: var(--cms-danger); }
.cms-list__open {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  padding: 0;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.cms-list__open:focus-visible { outline: 2px solid var(--cms-accent); outline-offset: 2px; border-radius: 4px; }
.cms-list__thumb {
  flex: 0 0 auto;
  width: 44px;
  height: 32px;
  border-radius: 4px;
  border: 1px solid var(--cms-line);
  background: #0f1113 center/cover no-repeat;
  overflow: hidden;
}
.cms-list__thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cms-list__thumb--empty { display: flex; align-items: center; justify-content: center; color: var(--cms-muted); font-size: 14px; }
.cms-list__text { flex: 1 1 auto; min-width: 0; }
.cms-list__title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cms-list__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  color: var(--cms-muted);
  font-size: 10.5px;
}
.cms-list__badge {
  display: inline-flex;
  align-items: center;
  height: 14px;
  padding: 0 5px;
  border-radius: 7px;
  background: #3a2f10;
  color: var(--cms-warn);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.cms-list__badge--new { background: #10243a; color: var(--cms-accent); }
.cms-list__badge--invalid { background: #3a1513; color: #f0b3ae; }
/* Overlaid, not in the flow: four 18px buttons in a column would set every
   row's height, and a list of films should be a list of films. */
.cms-list__actions {
  position: absolute;
  top: 4px;
  right: 5px;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 6px;
  background: var(--cms-panel-2);
  box-shadow: 0 0 0 1px var(--cms-line-strong);
  opacity: 0;
  transition: opacity 90ms linear;
}
.cms-list__row--current .cms-list__actions { background: #203456; }
.cms-list__row:hover .cms-list__actions,
.cms-list__row--current .cms-list__actions,
.cms-list__actions:focus-within { opacity: 1; }
.cms-list__bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-top: 1px solid var(--cms-line); }
.cms-list__empty { padding: 14px 12px; color: var(--cms-muted); }

/* ---------- overview ---------- */

.cms-overview { padding: 22px 24px 40px; max-width: 760px; }
.cms-overview h1 { margin: 0 0 4px; font-size: 17px; font-weight: 600; }
.cms-overview p { margin: 0 0 18px; color: var(--cms-muted); max-width: 54ch; }
.cms-overview__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(214px, 1fr)); gap: 10px; }
.cms-overview__card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 11px 12px;
  border: 1px solid var(--cms-line-strong);
  border-radius: 8px;
  background: var(--cms-panel);
  color: var(--cms-text);
  text-align: left;
  cursor: pointer;
}
.cms-overview__card:hover { border-color: var(--cms-accent); background: var(--cms-panel-2); }
.cms-overview__card-title { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.cms-overview__card-meta { color: var(--cms-muted); font-size: 10.5px; }
.cms-overview__card-path { color: var(--cms-muted); font-size: 10.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; }

/* ---------- editor region ---------- */

.cms-site__editor { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.cms-site__empty {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
  text-align: center;
  color: var(--cms-muted);
}
.cms-site__empty h2 { margin: 0; color: var(--cms-text); font-size: 14px; font-weight: 600; }
.cms-site__empty p { margin: 0; max-width: 42ch; }

/* ---------- record editor frame ---------- */

.cms-rec { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.cms-rec__body { flex: 1 1 auto; min-height: 0; overflow: auto; }
.cms-rec__inner { max-width: 760px; padding: 18px 22px 48px; }
.cms-rec__stub { display: flex; flex-direction: column; gap: 10px; }
.cms-rec__note {
  padding: 9px 11px;
  border: 1px dashed var(--cms-line-strong);
  border-radius: 7px;
  background: var(--cms-panel);
  color: var(--cms-muted);
}
.cms-rec__note strong { color: var(--cms-text); font-weight: 600; }
.cms-rec__fields { display: flex; flex-direction: column; gap: 1px; border: 1px solid var(--cms-line); border-radius: 7px; overflow: hidden; }
.cms-rec__field { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 10px; padding: 8px 11px; background: var(--cms-panel); }
.cms-rec__label { color: var(--cms-muted); }
.cms-rec__meta { display: block; margin-top: 2px; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.7; }
.cms-rec__value { min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.cms-rec__value--empty { color: var(--cms-muted); font-style: italic; }
.cms-rec__req { color: var(--cms-danger); }
.cms-rec__thumbs { display: flex; flex-wrap: wrap; gap: 6px; }
.cms-rec__thumb { width: 72px; height: 52px; border: 1px solid var(--cms-line); border-radius: 4px; object-fit: cover; background: #0f1113; }

/* ---------- status line ---------- */

.cms-site__status {
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
.cms-site__status--error .cms-site__status-msg { color: #f0b3ae; }
.cms-site__status--success .cms-site__status-msg { color: #93e3a3; }
.cms-site__status-msg { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cms-site__status-meta { flex: 0 0 auto; font-variant-numeric: tabular-nums; }

/* ---------- desktop only ---------- */

.cms-site__narrow { display: none; }
@media (max-width: ${MOBILE_BREAKPOINT - 1}px) {
  .cms-site > .cms-site__bar,
  .cms-site > .cms-site__body,
  .cms-site > .cms-site__status { display: none; }
  .cms-site__narrow {
    display: flex;
    flex-direction: column;
    gap: 8px;
    justify-content: center;
    height: 100%;
    padding: 24px;
    text-align: center;
  }
  .cms-site__narrow h1 { margin: 0; font-size: 15px; }
  .cms-site__narrow p { margin: 0; color: var(--cms-muted); font-size: 12px; }
}
`;

/**
 * Inject both stylesheets once per document, phase 1's first so this one's
 * `.cms-root--embedded` override wins on specificity ties. Idempotent, and a
 * no-op during SSR: the editor is client rendered.
 */
export function useSiteStyles(): void {
  useInsertionEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(SHELL_STYLE_ID) === null) {
      const shell = document.createElement('style');
      shell.id = SHELL_STYLE_ID;
      shell.textContent = SHELL_CSS;
      document.head.append(shell);
    }
    if (document.getElementById(SITE_STYLE_ID) === null) {
      const site = document.createElement('style');
      site.id = SITE_STYLE_ID;
      site.textContent = SITE_CSS;
      document.head.append(site);
    }
  }, []);
}
