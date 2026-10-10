/**
 * src/cms/render/lightbox.ts
 *
 * WS-B. The enlarge overlay, for two surfaces.
 *
 *   the homepage hero   `#hero-lightbox`. Ported from the inline script in
 *                       `src/pages/index.astro` with its behaviour intact,
 *                       including the two awkward bits that are there for a
 *                       reason: focus goes to the overlay rather than the
 *                       close button (Safari treats a programmatic focus as
 *                       keyboard-ish and would paint a focus ring over the
 *                       artwork), and the trigger is only in the tab order
 *                       where enlarging does something — touch, or a window
 *                       under 1024px, because the grid is already legible on a
 *                       desktop.
 *   an album            `.album-grid` + `.album-lightbox`. The same overlay,
 *                       filled from whichever photograph was clicked, with
 *                       arrows and a counter because an album has more than
 *                       one picture.
 *
 * Runs in the browser and nowhere else, and imports nothing.
 *
 *   import { initLightboxes } from '../cms/render/lightbox.ts';
 *   const stop = initLightboxes();
 */

/** Matches `body.is-locked` in global.css: stops the page behind scrolling. */
const LOCK_CLASS = 'is-locked';
const OPEN_CLASS = 'is-open';

/**
 * The media query the homepage uses to decide whether enlarging is worth
 * offering. Verbatim from src/pages/index.astro.
 */
const CAN_ZOOM = '(pointer: coarse), (max-width: 1024px)';

type Teardown = () => void;

/* -------------------------------------------------------------------------- */
/* Shared overlay mechanics                                                   */
/* -------------------------------------------------------------------------- */

function centreStage(stage: HTMLElement): void {
  // Start in the middle of a picture that is wider than the window, rather
  // than at its left edge.
  stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
  stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2;
}

/**
 * Open and close, plus the two listeners every overlay wants: click the
 * backdrop (but not the picture), and Escape.
 *
 * `returnFocusTo` is where focus goes on close. On the homepage that is the
 * `.hero` container and not the trigger inside it, for the Safari reason in
 * the file header.
 */
function overlay(
  box: HTMLElement,
  options: {
    /** Read at close time, so an album can send focus back to the tile that
     *  opened the overlay rather than always to the first one. */
    returnFocusTo?: () => HTMLElement | null;
    onKey?: (event: KeyboardEvent) => boolean;
  } = {},
): { show: () => void; hide: () => void; isOpen: () => boolean; stop: Teardown } {
  const stage = box.querySelector<HTMLElement>('.lightbox-stage');
  const close = box.querySelector<HTMLElement>('.lightbox-close');

  const isOpen = (): boolean => box.classList.contains(OPEN_CLASS);

  const show = (): void => {
    box.classList.add(OPEN_CLASS);
    document.body.classList.add(LOCK_CLASS);
    if (stage !== null) centreStage(stage);
    box.focus();
  };

  const hide = (): void => {
    box.classList.remove(OPEN_CLASS);
    document.body.classList.remove(LOCK_CLASS);
    const back = options.returnFocusTo?.() ?? null;
    if (back !== null) back.focus();
  };

  const onBackdrop = (event: MouseEvent): void => {
    // The backdrop and the scroll area close; the picture itself does not.
    if (event.target === box || event.target === stage) hide();
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (!isOpen()) return;
    if (options.onKey !== undefined && options.onKey(event)) return;
    if (event.key === 'Escape') hide();
  };

  const onClose = (): void => hide();

  box.addEventListener('click', onBackdrop);
  document.addEventListener('keydown', onKeydown);
  if (close !== null) close.addEventListener('click', onClose);

  return {
    show,
    hide,
    isOpen,
    stop: () => {
      box.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKeydown);
      if (close !== null) close.removeEventListener('click', onClose);
      if (isOpen()) hide();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The homepage hero                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Wire the hero's enlarge. Does nothing when the page has no hero, so it is
 * safe to call from a layout that every page shares.
 */
export function initHeroLightbox(root: ParentNode = document): Teardown {
  const box = root.querySelector<HTMLElement>('#hero-lightbox');
  const hero = root.querySelector<HTMLElement>('.hero');
  const open = root.querySelector<HTMLElement>('.hero-open');
  if (box === null || hero === null || open === null) return () => {};

  const { show, stop } = overlay(box, { returnFocusTo: () => hero });

  // Enlarging is for touch devices and small windows. On a desktop the grid is
  // already legible, so the trigger is inert there and stays out of the tab
  // order — tab order only, never aria-hidden, or the illustration's alt text
  // disappears from screen readers with it.
  const canZoom = window.matchMedia(CAN_ZOOM);
  const syncTrigger = (): void => {
    open.tabIndex = canZoom.matches ? 0 : -1;
  };

  const onOpen = (): void => {
    if (canZoom.matches) show();
  };

  open.addEventListener('click', onOpen);
  try {
    canZoom.addEventListener('change', syncTrigger);
  } catch {
    /* older browsers: the resize listener and the click guard still hold */
  }
  window.addEventListener('resize', syncTrigger);
  syncTrigger();

  return () => {
    open.removeEventListener('click', onOpen);
    try {
      canZoom.removeEventListener('change', syncTrigger);
    } catch {
      /* nothing to remove */
    }
    window.removeEventListener('resize', syncTrigger);
    stop();
  };
}

/* -------------------------------------------------------------------------- */
/* An album                                                                   */
/* -------------------------------------------------------------------------- */

type AlbumSlide = { src: string; alt: string };

/**
 * The slides, read off the grid rather than duplicated into a data attribute:
 * the photograph the overlay shows is the file the tile already loaded, so the
 * browser has it cached and the enlarge is instant.
 */
function slidesOf(grid: HTMLElement): { buttons: HTMLElement[]; slides: AlbumSlide[] } {
  const buttons = Array.from(grid.querySelectorAll<HTMLElement>('.album-open'));
  const slides = buttons.map((button) => {
    const img = button.querySelector('img');
    return {
      src: img?.getAttribute('src') ?? '',
      alt: img?.getAttribute('alt') ?? '',
    };
  });
  return { buttons, slides };
}

/** Wire one album grid to its overlay. */
export function initAlbumLightbox(grid: HTMLElement): Teardown {
  const id = grid.dataset.lightbox;
  if (id === undefined || id === '') return () => {};
  const box = document.getElementById(id);
  if (box === null) return () => {};

  const stage = box.querySelector<HTMLElement>('.lightbox-stage');
  const picture = stage?.querySelector('img') ?? null;
  if (stage === null || picture === null) return () => {};

  const counter = box.querySelector<HTMLElement>('.lightbox-count');
  const prev = box.querySelector<HTMLElement>('.lightbox-prev');
  const next = box.querySelector<HTMLElement>('.lightbox-next');

  const { buttons, slides } = slidesOf(grid);
  if (slides.length === 0) return () => {};

  let index = 0;
  let opener: HTMLElement | null = null;

  const paint = (): void => {
    const slide = slides[index];
    if (slide === undefined) return;
    picture.setAttribute('src', slide.src);
    picture.setAttribute('alt', slide.alt);
    if (counter !== null) counter.textContent = `${index + 1} / ${slides.length}`;
  };

  // `returnFocusTo` is a getter, so focus goes back to whichever photograph
  // was clicked rather than always to the first.
  const chrome = overlay(box, {
    returnFocusTo: () => opener,
    onKey: (event) => {
      if (slides.length < 2) return false;
      if (event.key === 'ArrowRight') {
        step(1);
        return true;
      }
      if (event.key === 'ArrowLeft') {
        step(-1);
        return true;
      }
      return false;
    },
  });

  function step(delta: number): void {
    index = (index + delta + slides.length) % slides.length;
    paint();
    centreStage(stage!);
  }

  const openAt = (at: number, from: HTMLElement): void => {
    index = at;
    opener = from;
    paint();
    chrome.show();
    // The first paint of a new src has no layout yet, so centring has to wait
    // for the picture to have a size.
    if (picture.complete) centreStage(stage);
    else picture.addEventListener('load', () => centreStage(stage), { once: true });
  };

  const wired: Teardown[] = [];
  buttons.forEach((button, at) => {
    const onClick = (): void => openAt(at, button);
    button.addEventListener('click', onClick);
    wired.push(() => button.removeEventListener('click', onClick));
  });

  const onPrev = (): void => step(-1);
  const onNext = (): void => step(1);
  if (prev !== null) prev.addEventListener('click', onPrev);
  if (next !== null) next.addEventListener('click', onNext);

  return () => {
    for (const stop of wired) stop();
    if (prev !== null) prev.removeEventListener('click', onPrev);
    if (next !== null) next.removeEventListener('click', onNext);
    chrome.stop();
  };
}

/* -------------------------------------------------------------------------- */
/* Both                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Wire every overlay in the page: the hero if there is one, and every album
 * grid. Safe on a page with neither.
 */
export function initLightboxes(root: ParentNode = document): Teardown {
  const stops: Teardown[] = [initHeroLightbox(root)];
  for (const grid of Array.from(root.querySelectorAll<HTMLElement>('.album-grid[data-lightbox]'))) {
    stops.push(initAlbumLightbox(grid));
  }
  return () => {
    for (const stop of stops) stop();
  };
}
