/**
 * src/cms/app/integration/styles.ts
 *
 * WS-8. The CSS the wiring needs, and nothing else.
 *
 * Everything here exists because two components that were built apart are now
 * inside one another, and the seam needs a rule. Each block says which seam.
 * There is deliberately no theming, no layout and no component styling: WS-3
 * owns the shell's chrome, WS-5 owns the prose chrome, WS-1 owns the published
 * page.
 *
 * Injected the same way WS-3 and WS-5 inject theirs — one <style> per
 * document, id-guarded, SSR no-op — so there is no stylesheet to add to a
 * build and no import to configure.
 */

import { useInsertionEffect } from 'react';

export const INTEGRATION_STYLE_ID = 'cms-integration';

export const INTEGRATION_CSS = `
/* ---------------------------------------------------------------------------
   SEAM 1: an overlay band holding a real canvas editor.
   WS-4's stage paints itself white (it is normally the whole editing surface).
   Inside an overlay band it is drawn OVER the prose it is meant to sit beside
   (docs/cms-rebuild.md 2.2), so an opaque stage hides the paragraph. The
   stage's hairline shadow goes with it: the band already has its own frame.
--------------------------------------------------------------------------- */
.cms-band-box--overlay .cv-stage {
  background: transparent;
  box-shadow: none;
}

/* ---------------------------------------------------------------------------
   SEAM 2: dropping a file on a canvas band.
   The drop target is a transparent layer the wiring puts behind WS-4's root,
   so it never intercepts a drag of an item. It only lights up while a file is
   over it.
--------------------------------------------------------------------------- */
.ws8-canvas { position: absolute; inset: 0; }
.ws8-canvas[data-dropping='true']::after {
  content: "Drop to upload";
  position: absolute;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  border: 2px dashed var(--cms-accent, #ff5722);
  background: rgba(255, 87, 34, 0.1);
  color: var(--cms-accent, #ff5722);
  font: 600 13px/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  pointer-events: none;
}
.ws8-canvas[data-busy='true']::after {
  content: "Uploading…";
  position: absolute;
  inset: 0;
  z-index: 41;
  display: grid;
  place-items: center;
  background: rgba(255, 255, 255, 0.55);
  color: #111;
  font: 600 13px/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  pointer-events: none;
}

/* ---------------------------------------------------------------------------
   SEAM 3: prose, inside the page surface rather than inside a harness.
   WS-5 is forbidden from styling prose and WS-1's stylesheet belongs to the
   published page, so without this the editing surface would show browser
   defaults: a 32px h2 margin, an indented blockquote, no list bullets inside
   a flex column. This is the editing surface only. It is not a preview, and
   it does not try to be: /cms/preview/<slug> renders the real stylesheet.
--------------------------------------------------------------------------- */
.cms-surface .pe-root { margin: 0; }
.cms-surface .pe-content { outline: none; min-height: 1.6em; }
.cms-surface .pe-content:empty::before {
  content: attr(aria-label);
  color: #bdbdbd;
  font-style: italic;
}
.cms-surface .pe-content p { margin: 0 0 14px; }
.cms-surface .pe-content h2 { margin: 26px 0 10px; font-size: 25px; line-height: 1.25; font-weight: 600; }
.cms-surface .pe-content h3 { margin: 20px 0 8px; font-size: 19px; line-height: 1.3; font-weight: 600; }
.cms-surface .pe-content blockquote {
  margin: 18px 0;
  padding-left: 16px;
  border-left: 3px solid #ddd;
  color: #444;
  font-style: italic;
}
.cms-surface .pe-content ul,
.cms-surface .pe-content ol { margin: 0 0 14px; padding-left: 24px; }
.cms-surface .pe-content li { margin: 2px 0; }
.cms-surface .pe-content li > p { margin: 0; }
.cms-surface .pe-content a { color: #ff5722; text-decoration: underline; }
/* The focused block, so it is obvious which one the floating toolbar belongs
   to. The shell's own selection outline is on the band, not the block. */
.cms-surface .cms-slot-host:focus-within .pe-root::before {
  content: "";
  position: absolute;
  inset: -4px -10px;
  border-left: 2px solid var(--cms-accent, #ff5722);
  pointer-events: none;
}

/* ---------------------------------------------------------------------------
   SEAM 4: WS-6's asset picker, inside WS-3's dark inspector.
   The picker is light-mode only by design (inline styles, no global CSS), so
   the wiring gives it a light plate to stand on instead of asking WS-6 for a
   theme it does not have.
--------------------------------------------------------------------------- */
.ws8-insert { display: flex; flex-direction: column; gap: 8px; }
.ws8-plate {
  border-radius: 9px;
  background: #ffffff;
  color: #111111;
  color-scheme: light;
}
.ws8-plate input,
.ws8-plate button,
.ws8-plate select { color-scheme: light; }
.ws8-file {
  display: block;
  width: 100%;
  font: 11px/1.4 ui-sans-serif, system-ui, sans-serif;
  color: var(--cms-muted, #8c8c8c);
}
.ws8-file input { display: block; width: 100%; margin-top: 4px; font-size: 11px; }
.ws8-warn {
  padding: 5px 7px;
  border: 1px solid #52241f;
  border-radius: 5px;
  background: #2a1715;
  color: #f0b3ae;
  font-size: 10.5px;
}

/* ---------------------------------------------------------------------------
   SEAM 5: the toolbar extras — who is signed in, which page, reload.
--------------------------------------------------------------------------- */
.ws8-toolbar { display: flex; align-items: center; gap: 7px; min-width: 0; }
.ws8-who {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 190px;
  overflow: hidden;
  color: var(--cms-muted, #8c8c8c);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ws8-who__dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4f7a4f;
}
.ws8-who--out .ws8-who__dot { background: #8a4a3f; }
.ws8-who[data-signed-in='unknown'] .ws8-who__dot { background: #5a5a5a; }
.ws8-who a { color: var(--cms-accent, #ff5722); }
.ws8-pages { max-width: 190px; }
`;

/**
 * Appended before paint, once per document. The three style blocks in this
 * app (WS-3's shell, WS-5's prose chrome, this) are all injected the same way
 * and in that order, which is also their specificity order, so a rule here
 * can correct a seam without `!important`.
 */
export function useIntegrationStyles(): void {
  useInsertionEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(INTEGRATION_STYLE_ID) !== null) return;
    const element = document.createElement('style');
    element.id = INTEGRATION_STYLE_ID;
    element.textContent = INTEGRATION_CSS;
    document.head.appendChild(element);
  }, []);
}
