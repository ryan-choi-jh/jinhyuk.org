/**
 * src/cms/app/chrome/styles.ts
 *
 * The nav-and-footer panel's stylesheet, as a string, plus a hook that injects
 * it once per document — the same arrangement as `../shell/styles.ts` and
 * `../records/styles.ts`, for the same reason: this code is bundled three ways
 * and only one of them resolves `import './chrome.css'`.
 *
 * It takes the record editors' look — the same `--cms-*` tokens, the same
 * control metrics, the same small-caps group heads — through its own
 * `.cms-chr*` class names rather than by reusing `.cms-rec*`. That is a
 * deliberate choice and worth the duplication: `.cms-rec__field` and
 * `.cms-rec__label` are defined TWICE in this application, once in
 * `../records/styles.ts` (a column) and once in `../shell/site-styles.ts` (a
 * 150px/auto grid for the read-only record stub), so what a `.cms-rec__field`
 * looks like in a third place depends on which stylesheet was injected last.
 * A panel in a 304px inspector cannot afford to find out.
 *
 * Every colour comes through `var(--cms-*, <fallback>)`, so the panel inherits
 * the shell's palette and nothing here redefines a token.
 */

import { useInsertionEffect } from 'react';

export const CHROME_STYLE_ID = 'cms-chrome-panel-styles';

export const CHROME_CSS = `
.cms-chr {
  --chr-panel: var(--cms-panel, #1b1e22);
  --chr-panel-2: var(--cms-panel-2, #22262b);
  --chr-line: var(--cms-line, #2d3238);
  --chr-line-strong: var(--cms-line-strong, #3b424a);
  --chr-text: var(--cms-text, #e7eaed);
  --chr-muted: var(--cms-muted, #8d969f);
  --chr-accent: var(--cms-accent, #4c8dff);
  --chr-danger: var(--cms-danger, #e5534b);
  --chr-success: var(--cms-success, #3fb950);
  --chr-warn: var(--cms-warn, #d6a327);

  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  box-sizing: border-box;
  border: 1px solid var(--chr-line);
  border-radius: 7px;
  background: var(--chr-panel);
  padding: 9px 10px 11px;
  color: var(--chr-text);
  font: 12px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.cms-chr *, .cms-chr *::before, .cms-chr *::after { box-sizing: border-box; }
.cms-chr button, .cms-chr input, .cms-chr select { font: inherit; color: inherit; }

/* ---------- heads ---------- */

.cms-chr__head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--chr-muted);
}
.cms-chr__head-count { margin-left: auto; letter-spacing: 0; }
.cms-chr__sub { font-size: 11px; color: var(--chr-muted); }
.cms-chr__group { display: flex; flex-direction: column; gap: 6px; }

/* ---------- controls ---------- */

.cms-chr__input, .cms-chr__select {
  width: 100%;
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--chr-line-strong);
  border-radius: 5px;
  background: #15181c;
  color: var(--chr-text);
}
.cms-chr__select { padding: 0 2px; }
.cms-chr__input:focus, .cms-chr__select:focus { outline: none; border-color: var(--chr-accent); }
.cms-chr__input--bad { border-color: var(--chr-danger); }
.cms-chr__input--mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}

.cms-chr__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--chr-line-strong);
  border-radius: 5px;
  background: var(--chr-panel-2);
  color: var(--chr-text);
  cursor: pointer;
  white-space: nowrap;
}
.cms-chr__btn:hover:not(:disabled) { background: #2a2f36; }
.cms-chr__btn:disabled { opacity: 0.4; cursor: default; }
.cms-chr__btn:focus-visible { outline: 2px solid var(--chr-accent); outline-offset: 1px; }
.cms-chr__btn--primary { background: var(--chr-accent); border-color: var(--chr-accent); color: #fff; }
.cms-chr__btn--primary:hover:not(:disabled) { background: #5e99ff; }
.cms-chr__btn--quiet { background: transparent; border-color: transparent; color: var(--chr-muted); }
.cms-chr__btn--quiet:hover:not(:disabled) { background: var(--chr-panel-2); color: var(--chr-text); }
.cms-chr__btn--danger { color: var(--chr-danger); }
.cms-chr__btn--micro { width: 20px; height: 20px; padding: 0; font-size: 11px; line-height: 1; }
.cms-chr__btn--wide { width: 100%; }

/* ---------- one row of the two lists ---------- */

.cms-chr__row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--chr-line);
  border-radius: 6px;
  background: #15181c;
}
.cms-chr__row-top { display: flex; align-items: center; gap: 4px; min-width: 0; }
.cms-chr__num {
  flex: none;
  width: 14px;
  text-align: center;
  font-size: 10px;
  color: var(--chr-muted);
}
.cms-chr__row-acts { display: flex; gap: 2px; flex: none; }
.cms-chr__icon {
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--chr-muted);
}
.cms-chr__icon svg { display: block; width: 16px; height: 16px; }

.cms-chr__field { display: flex; flex-direction: column; gap: 3px; }
.cms-chr__label { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--chr-muted); }
.cms-chr__help { font-size: 11px; color: var(--chr-muted); }
.cms-chr__problem { font-size: 11px; color: var(--chr-danger); }
.cms-chr__empty {
  padding: 8px 6px;
  border: 1px dashed var(--chr-line-strong);
  border-radius: 6px;
  color: var(--chr-muted);
  text-align: center;
}

/* ---------- the action bar ---------- */

.cms-chr__acts { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.cms-chr__state { font-size: 11px; color: var(--chr-muted); }
.cms-chr__state--dirty { color: var(--chr-warn); }
.cms-chr__notice {
  padding: 5px 7px;
  border: 1px solid var(--chr-line-strong);
  border-radius: 5px;
  background: var(--chr-panel-2);
  font-size: 11px;
  white-space: pre-wrap;
}
.cms-chr__notice--error { border-color: #4a2320; background: #241617; color: #f0a8a3; }
.cms-chr__notice--ok { border-color: #1f3d28; background: #15211a; color: #9bd6ab; }
.cms-chr__path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  color: var(--chr-muted);
  overflow-wrap: anywhere;
}
`;

/** Inject `CHROME_CSS` once per document. Idempotent under StrictMode. */
export function useChromeStyles(): void {
  useInsertionEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(CHROME_STYLE_ID) !== null) return;
    const style = document.createElement('style');
    style.id = CHROME_STYLE_ID;
    style.textContent = CHROME_CSS;
    document.head.append(style);
  }, []);
}
