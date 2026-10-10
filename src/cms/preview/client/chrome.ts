/**
 * src/cms/preview/client/chrome.ts
 *
 * WS-7. The toolbar's behaviour.
 *
 * The chrome works with this script switched off: every control is a real link
 * to a real URL, and the server renders whichever state the URL asks for. What
 * the script adds is the thing a preview is actually for, which is comparing:
 *
 *  - Switching draft/published swaps the iframe's src and nothing else, so the
 *    chrome keeps its scroll position and the two versions can be flicked
 *    between at the same point on the page. A full navigation would jump back
 *    to the top every time and make a small change nearly impossible to see.
 *  - Switching width does not reload the frame at all: the iframe element is
 *    resized, and because an iframe's width IS its viewport width, the 900px
 *    media query inside it fires exactly as it would on a phone.
 *  - The frame is never squashed to fit. It is laid out at the full preset
 *    width and then scaled down with a transform, which changes how big it
 *    looks and nothing about how it was laid out.
 *
 * The frame reports its own height, so the iframe is always exactly as tall as
 * its content and the chrome does the scrolling. One scrollbar, and a preview
 * that can be screenshotted end to end.
 */

import { FRAME_MESSAGE, PREVIEW_WIDTHS, frameHref, previewHref } from '../state.ts';
import type { FrameReport, PreviewTheme, PreviewVersion, PreviewWidth } from '../state.ts';

type Dom = {
  root: HTMLElement;
  stage: HTMLElement;
  viewport: HTMLElement;
  frame: HTMLIFrameElement;
  readout: HTMLElement | null;
};

const PROVISIONAL_HEIGHT = 1200;
/** Leave the band a little air when scrolling to it, under the sticky toolbar. */
const SCROLL_MARGIN = 96;

function parseWidthAttr(raw: string | null | undefined): PreviewWidth | null {
  const value = Number(raw);
  return PREVIEW_WIDTHS.find((width) => width === value) ?? null;
}

export function initPreviewChrome(): () => void {
  const root = document.getElementById('pv');
  const stage = document.getElementById('pv-stage');
  const viewport = document.getElementById('pv-viewport');
  const frame = document.getElementById('pv-frame');

  if (
    root === null ||
    stage === null ||
    viewport === null ||
    !(frame instanceof HTMLIFrameElement)
  ) {
    // No document to show: the chrome rendered an empty state, and there is
    // nothing here to drive.
    return () => {};
  }

  const dom: Dom = { root, stage, viewport, frame, readout: document.getElementById('pv-readout') };

  // The PATH, not a slug: `<section>` or `<section>/<key>`, already resolved
  // by the route. This script must not learn how to resolve one itself --
  // `target.ts` imports the registry, and the registry imports zod.
  const path = root.dataset.path ?? '';
  let width = parseWidthAttr(root.dataset.width) ?? 1440;
  let version = (root.dataset.version === 'published' ? 'published' : 'draft') as PreviewVersion;
  let theme: PreviewTheme = root.dataset.theme === 'dark' ? 'dark' : root.dataset.theme === 'light' ? 'light' : null;

  let report: FrameReport | null = null;
  let frameHeight = PROVISIONAL_HEIGHT;

  /* ---------------------------------------------------------------------- */
  /* Layout                                                                 */
  /* ---------------------------------------------------------------------- */

  function availableWidth(): number {
    const style = getComputedStyle(dom.stage);
    const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
    return Math.max(240, dom.stage.clientWidth - (Number.isFinite(padding) ? padding : 0));
  }

  function layout(): void {
    // Never scale up. A 390 frame shown at 200% would be a lie about the size
    // of the type on a phone, which is most of what the 390 preset is for.
    const scale = Math.min(1, availableWidth() / width);
    dom.frame.style.width = `${width}px`;
    dom.frame.style.height = `${frameHeight}px`;
    dom.frame.style.transform = scale === 1 ? 'none' : `scale(${scale})`;
    dom.viewport.style.width = `${Math.round(width * scale)}px`;
    dom.viewport.style.height = `${Math.round(frameHeight * scale)}px`;
    document.documentElement.dataset.pvScale = scale.toFixed(4);
    dom.root.dataset.scale = String(Math.round(scale * 100));
    const zoom = document.getElementById('pv-zoom');
    if (zoom !== null) zoom.textContent = scale === 1 ? '100%' : `${Math.round(scale * 100)}%`;
  }

  /* ---------------------------------------------------------------------- */
  /* The readout, and the same numbers as attributes for a test to read     */
  /* ---------------------------------------------------------------------- */

  function paintReport(): void {
    const data = document.documentElement.dataset;
    if (report === null) {
      data.pvReady = '0';
      return;
    }
    const r = report;
    data.pvWidth = String(r.width);
    data.pvHeight = String(r.height);
    data.pvMobile = r.mobile ? 'yes' : 'no';
    data.pvItems = String(r.items.total);
    data.pvPositioned = String(r.items.positioned);
    data.pvStacked = String(r.items.stacked);
    data.pvOverlays = String(r.overlays.total);
    data.pvOverlaysPositioned = String(r.overlays.positioned);
    data.pvConnectors = String(r.connectors);
    data.pvConnectorNodes = String(r.connectorNodes);
    data.pvOrder = r.inDocumentOrder ? 'yes' : 'no';
    data.pvImages = `${r.images.loaded}/${r.images.total}`;
    // Two flags, not one. "Ready" is about the page's own content, which is
    // what a screenshot has to wait for and what a test can rely on. Webfonts
    // come from fonts.googleapis.com, so folding them into the same flag would
    // make every assertion in verify.ts depend on somebody else's CDN.
    data.pvFonts = r.fontsReady ? 'yes' : 'no';
    // WS-H. What the frame actually rendered, and how many rows it found, so a
    // test can assert that asking for an album page produced an album page
    // with six photographs in it rather than an empty state that happened to
    // report a height.
    data.pvSurface = r.surface;
    data.pvEntries = String(r.entries.length);
    data.pvBands = String(r.bands.length);
    // The rows' geometry, compactly, as `top:height` pairs. The album page is
    // the only surface with no live counterpart to compare against
    // (docs/cms-sections.md 3.4), so the shape of its grid has to be asserted
    // rather than eyeballed, and this is the one channel a DOM dump gives
    // back. Generic: on a film list it is the rows of the grid, on a document
    // the bands.
    data.pvEntryBoxes = r.entries
      .map((box) => `${box.top}:${box.left}:${box.width}:${box.height}`)
      .join(',');
    data.pvOverflowX = r.scrollWidth > r.clientWidth + 1 ? 'yes' : 'no';
    data.pvFrameWidths = `${r.clientWidth}/${r.scrollWidth}`;
    data.pvDialogs = `${r.dialogs.open}/${r.dialogs.total}`;
    data.pvDialogsFixed = String(r.dialogs.fixed);
    data.pvReady = r.height > 0 && r.images.loaded === r.images.total ? '1' : '0';

    if (dom.readout !== null) {
      const parts = [
        r.surface,
        `${r.width} × ${r.height}`,
        r.mobile ? 'mobile fallback ON' : 'mobile fallback off',
        r.items.total === 0
          ? r.entries.length === 0
            ? 'no canvas items'
            : `${r.entries.length} row${r.entries.length === 1 ? '' : 's'}`
          : r.mobile
            ? `${r.items.stacked}/${r.items.total} items stacked${r.inDocumentOrder ? ', in document order' : ', OUT OF ORDER'}`
            : `${r.items.positioned}/${r.items.total} items positioned`,
        `${r.connectors} connector${r.connectors === 1 ? '' : 's'} drawn`,
        `${r.images.loaded}/${r.images.total} images`,
      ];
      dom.readout.textContent = parts.join('  ·  ');
      dom.readout.dataset.mobile = r.mobile ? 'yes' : 'no';
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Messages from the frame                                                */
  /* ---------------------------------------------------------------------- */

  function onMessage(event: MessageEvent): void {
    // Identity, not origin: the frame is the only window allowed to tell this
    // page how tall to be, and comparing against contentWindow is both
    // stricter than an origin check and still true when the preview is opened
    // from a file:// harness.
    if (event.source !== dom.frame.contentWindow) return;
    const data = event.data as FrameReport | null;
    if (data === null || typeof data !== 'object' || data.type !== FRAME_MESSAGE) return;
    report = data;
    if (data.height > 0 && Math.abs(data.height - frameHeight) > 1) {
      frameHeight = data.height;
      layout();
    }
    paintReport();
  }

  /* ---------------------------------------------------------------------- */
  /* Controls                                                               */
  /* ---------------------------------------------------------------------- */

  function syncUrl(): void {
    history.replaceState(null, '', previewHref(path, { version, width, theme }));
  }

  function syncPressed(): void {
    for (const el of document.querySelectorAll<HTMLElement>('[data-pv-width]')) {
      el.setAttribute('aria-pressed', String(parseWidthAttr(el.dataset.pvWidth) === width));
    }
    for (const el of document.querySelectorAll<HTMLElement>('[data-pv-version]')) {
      el.setAttribute('aria-pressed', String(el.dataset.pvVersion === version));
    }
    for (const el of document.querySelectorAll<HTMLElement>('[data-pv-theme]')) {
      const value = el.dataset.pvTheme === '' ? null : el.dataset.pvTheme;
      el.setAttribute('aria-pressed', String(value === theme));
    }
    dom.root.dataset.width = String(width);
    dom.root.dataset.version = version;
    dom.root.dataset.theme = theme ?? '';
  }

  function setWidth(next: PreviewWidth): void {
    if (next === width) return;
    width = next;
    // No reload: the frame keeps its scroll and its state, and only its
    // viewport changes. That is the whole trick behind checking the mobile
    // fallback without a phone.
    layout();
    syncPressed();
    syncUrl();
  }

  function reloadFrame(): void {
    document.documentElement.dataset.pvReady = '0';
    report = null;
    dom.frame.src = frameHref(path, { version, theme });
  }

  function setVersion(next: PreviewVersion): void {
    if (next === version) return;
    if (dom.root.dataset[next === 'draft' ? 'hasDraft' : 'hasPublished'] !== '1') return;
    version = next;
    syncPressed();
    syncUrl();
    reloadFrame();
  }

  function setTheme(next: PreviewTheme): void {
    if (next === theme) return;
    theme = next;
    syncPressed();
    syncUrl();
    reloadFrame();
  }

  function onClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const widthEl = target.closest<HTMLElement>('[data-pv-width]');
    if (widthEl !== null) {
      const next = parseWidthAttr(widthEl.dataset.pvWidth);
      if (next !== null) {
        event.preventDefault();
        setWidth(next);
      }
      return;
    }

    const versionEl = target.closest<HTMLElement>('[data-pv-version]');
    if (versionEl !== null) {
      const next = versionEl.dataset.pvVersion;
      if (next === 'draft' || next === 'published') {
        event.preventDefault();
        setVersion(next);
      }
      return;
    }

    const themeEl = target.closest<HTMLElement>('[data-pv-theme]');
    if (themeEl !== null) {
      event.preventDefault();
      const raw = themeEl.dataset.pvTheme;
      setTheme(raw === 'dark' ? 'dark' : raw === 'light' ? 'light' : null);
      return;
    }

    const bandEl = target.closest<HTMLElement>('[data-pv-band]');
    if (bandEl !== null) {
      event.preventDefault();
      scrollToBox('bands', bandEl.dataset.pvBand ?? '');
      return;
    }

    const entryEl = target.closest<HTMLElement>('[data-pv-entry]');
    if (entryEl !== null) {
      event.preventDefault();
      scrollToBox('entries', entryEl.dataset.pvEntry ?? '');
    }
  }

  /**
   * Scroll the CHROME, not the frame: the iframe is as tall as its content, so
   * it never scrolls, and the box's offset inside it has to be scaled by the
   * same factor the frame is displayed at.
   *
   * Two lists, because two kinds of surface. A document's rows are bands with
   * ids in the markup, so the chrome asks for a band by id. The other four
   * surfaces have no ids to ask for -- a film is a `.video`, and WS-B's
   * renderers are not mine to add an attribute to -- so the row carries the
   * index the diff gave it and the frame reports the boxes in page order.
   */
  function scrollToBox(which: 'bands' | 'entries', id: string): void {
    if (report === null || id === '') return;
    const box = report[which].find((entry) => entry.id === id);
    if (box === undefined) return;
    const scale = Math.min(1, availableWidth() / width);
    const frameTop = dom.viewport.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.max(0, frameTop + box.top * scale - SCROLL_MARGIN), behavior: 'smooth' });
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.isContentEditable) return;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

    if (event.key === '1') setWidth(1440);
    else if (event.key === '2') setWidth(1100);
    else if (event.key === '3') setWidth(390);
    else if (event.key === 'd') setVersion('draft');
    else if (event.key === 'p') setVersion('published');
    else if (event.key === 't') setVersion(version === 'draft' ? 'published' : 'draft');
    else return;
    event.preventDefault();
  }

  /* ---------------------------------------------------------------------- */
  /* Go                                                                     */
  /* ---------------------------------------------------------------------- */

  window.addEventListener('message', onMessage);
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeyDown);
  const onResize = (): void => layout();
  window.addEventListener('resize', onResize);

  syncPressed();
  layout();
  paintReport();

  return () => {
    window.removeEventListener('message', onMessage);
    document.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', onResize);
  };
}
