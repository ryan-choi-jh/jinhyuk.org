/**
 * src/cms/render/home-note-player.ts
 *
 * The 원고지 note, in the browser: when it plays, how it closes, and the
 * flight of its heading into the replay button. The markup and the copy are
 * ./pages/home-note.ts; the look and the build timeline are the "원고지 note"
 * section of src/styles/global.css; the handoff is docs/wongoji-note.md.
 *
 *   import { initHomeNote } from '../cms/render/home-note-player.ts';
 *   const stop = initHomeNote();
 *
 * Runs on the homepage only, and does nothing on a page without the note. The
 * editor's preview renders the same markup and never calls this, which is how
 * the preview stays exactly as it was: everything is `hidden` until this runs.
 *
 * WHEN IT PLAYS. Once per browser, remembered under `wongoji-note-seen`. The
 * key is written when the note STARTS, so a visitor who leaves mid-note is not
 * shown it again. Whichever comes first:
 *
 *   - three seconds of the hero being at least half in view. The clock pauses
 *     while it is not, while the tab is hidden (a page opened in a background
 *     tab would otherwise play to nobody and mark itself seen), and while the
 *     lightbox is open;
 *   - on a desktop, the pointer resting on the grid for 600ms.
 *
 * Storage that throws (private browsing, blocked site data) reads as a first
 * visit: the note plays, the button still works, and next time it plays
 * again, which is the right way round for something this small.
 *
 * WHERE. Over the grid on a desktop. Wherever the lightbox's CAN_ZOOM holds
 * (touch, or 1024px and under) the grid's squares are too small to write in,
 * so the same element is moved into `.note-caption` under the sheet instead.
 *
 * HOW IT CLOSES. CLOSE, Escape, a click on the sheet (desktop), or the
 * twelve-second hold running out: all of those end in the same flight, the
 * heading's three squares shrinking along a curve into the replay button, so
 * the visitor sees where it went. Two ways out skip the flight: scrolling the
 * hero out of view (the button may be off screen; it just fades; on a phone
 * only once the caption is out of view too) and opening the lightbox
 * (instant, the overlay is on top of everything anyway).
 *
 * FOCUS. Never moved when the note plays by itself, and it never traps. A
 * keyboard user who replays it lands on the note; one who closes it from
 * inside lands on `.hero`, the same place the lightbox sends focus back to,
 * from where Tab reaches the replay button next.
 */

import { CAN_ZOOM } from './lightbox.ts';

type Teardown = () => void;

const SEEN_KEY = 'wongoji-note-seen';
const REDUCE = '(prefers-reduced-motion: reduce)';

/** How long the hero must be half in view before the note plays by itself. */
const DWELL_MS = 3000;
/** How long the pointer must rest on the grid, and how far it may wander. */
const HOVER_MS = 600;
const HOVER_SLOP_PX = 8;

/* The timeline, in ms from the trigger. The stylesheet holds the build's own
   delays; these are the moments this file has to act at. */
const BUILD_MS = 1400;
const REPLAY_BUILD_MS = 1180;
const FADE_MS = 200;
const FLIGHT_DELAY_MS = 100;
const FLIGHT_MS = 600;
const RETURN_MS = 800;
const UNDERLINE_MS = 1800;

/* The flight. x and y move on separate wrappers with different easings so the
   path bends instead of running straight: y leads, the squares drop first and
   then sweep across into the button. The scale uses the handoff's curve. */
const EASE_FLIGHT = 'cubic-bezier(0.5, 0, 0.2, 1)';
const EASE_X = 'cubic-bezier(0.6, 0, 0.3, 1)';
const EASE_Y = 'cubic-bezier(0.3, 0, 0.15, 1)';

type State = 'idle' | 'opening' | 'open' | 'closing';
type Mode = 'overlay' | 'caption';
type Exit = 'flight' | 'fade' | 'instant';

function storedSeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) !== null;
  } catch {
    return false;
  }
}

function storeSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* private browsing: it plays again next time, and that is fine */
  }
}

function query(media: string): MediaQueryList | null {
  try {
    return window.matchMedia(media);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* The flight                                                                 */
/* -------------------------------------------------------------------------- */

type Flight = { root: HTMLElement; done: Promise<void> };

/** A set of three squares, measured: where, how big, and in what pink. */
type Squares = { box: DOMRect; cell: number; colour: string | null };

function measure(cells: HTMLElement): Squares {
  const first = cells.firstElementChild as HTMLElement | null;
  const box = cells.getBoundingClientRect();
  return {
    box,
    cell: first?.getBoundingClientRect().width ?? box.width / 3,
    colour: first === null ? null : getComputedStyle(first).borderTopColor,
  };
}

/**
 * A copy of a set of squares, ready to fly.
 *
 * A COPY, on <body>, in fixed position: `.hero` has a clip-path that cuts off
 * anything leaving it downwards, and the button is below it. Built from
 * measured px rather than cloned, because the heading's sizes are in cqw and
 * mean nothing outside the note's container.
 *
 * Taken apart from `launch` because the two ends are not always measurable at
 * the same moment: on a phone the heading is in the caption and the button's
 * final place is where the caption will be once it has gone. So the caller
 * copies the one, rearranges the page, and then aims at the other.
 */
type Copy = {
  root: HTMLElement;
  alongY: HTMLElement;
  scaler: HTMLElement;
  copies: HTMLElement[];
  start: Squares;
};

function copySquares(from: HTMLElement): Copy {
  const start = measure(from);
  const root = document.createElement('div');
  root.className = 'note-flight';
  root.setAttribute('aria-hidden', 'true');
  const alongY = document.createElement('div');
  const scaler = document.createElement('div');
  root.append(alongY);
  alongY.append(scaler);

  const copies: HTMLElement[] = [];
  for (const cell of Array.from(from.children) as HTMLElement[]) {
    const box = cell.getBoundingClientRect();
    const look = getComputedStyle(cell);
    const copy = document.createElement('span');
    copy.style.cssText =
      'display:flex;align-items:center;justify-content:center;flex-shrink:0;box-sizing:border-box;' +
      `width:${box.width}px;height:${box.height}px;border-style:solid;` +
      `border-color:${look.borderTopColor};background:${look.backgroundColor};` +
      `border-width:${look.borderTopWidth} ${look.borderRightWidth} ${look.borderBottomWidth} ${look.borderLeftWidth}`;
    const glyph = cell.firstElementChild as HTMLElement | null;
    if (glyph !== null) {
      const type = getComputedStyle(glyph);
      const letter = document.createElement('span');
      letter.textContent = glyph.textContent;
      letter.style.cssText =
        `font-family:${type.fontFamily};font-size:${type.fontSize};line-height:${type.lineHeight};` +
        `color:${type.color};letter-spacing:0`;
      copy.append(letter);
    }
    scaler.append(copy);
    copies.push(copy);
  }

  root.style.transform = `translateX(${start.box.left}px)`;
  alongY.style.transform = `translateY(${start.box.top}px)`;
  document.body.append(root);
  return { root, alongY, scaler, copies, start };
}

/**
 * Fly a copy onto a set of squares, measured NOW: the destination has to be
 * in its final layout when this is called (the caller arranges that), because
 * the copy is aimed at where the squares will be, not where they are.
 */
function launch(copy: Copy, end: Squares, delay: number): Flight {
  const { root, alongY, scaler, copies, start } = copy;
  const scale = start.cell > 0 ? end.cell / start.cell : 1;
  const timing = { duration: FLIGHT_MS, delay, fill: 'both' as const };
  const moves = [
    root.animate(
      [{ transform: `translateX(${start.box.left}px)` }, { transform: `translateX(${end.box.left}px)` }],
      { ...timing, easing: EASE_X },
    ),
    alongY.animate(
      [{ transform: `translateY(${start.box.top}px)` }, { transform: `translateY(${end.box.top}px)` }],
      { ...timing, easing: EASE_Y },
    ),
    scaler.animate([{ transform: 'scale(1)' }, { transform: `scale(${scale})` }], {
      ...timing,
      easing: EASE_FLIGHT,
    }),
  ];
  // The heading's squares are a stronger pink than the button's (and the
  // other way round on a replay); each takes on the other's on the way, so
  // the swap at the end is invisible.
  if (end.colour !== null && end.colour !== start.colour) {
    for (const square of copies) {
      moves.push(
        square.animate([{ borderColor: start.colour ?? end.colour }, { borderColor: end.colour }], {
          ...timing,
          easing: EASE_FLIGHT,
        }),
      );
    }
  }

  const done = Promise.all(moves.map((move) => move.finished)).then(
    () => undefined,
    () => undefined, // cancelled by an instant close; the caller has moved on
  );
  return { root, done };
}

/* -------------------------------------------------------------------------- */
/* initHomeNote                                                               */
/* -------------------------------------------------------------------------- */

export function initHomeNote(root: ParentNode = document): Teardown {
  const hero = root.querySelector<HTMLElement>('.hero');
  const layer = hero?.querySelector<HTMLElement>('.note-layer') ?? null;
  const note = layer?.querySelector<HTMLElement>('.note') ?? null;
  const caption = root.querySelector<HTMLElement>('.note-caption');
  const captionInner = caption?.querySelector<HTMLElement>('.note-caption-inner') ?? null;
  const row = root.querySelector<HTMLElement>('.hero-hint');
  const replay = row?.querySelector<HTMLElement>('.note-replay') ?? null;
  const rule = row?.querySelector<HTMLElement>('.hero-hint-rule') ?? null;
  const headCells = note?.querySelector<HTMLElement>('.note-cells') ?? null;
  const replayCells = replay?.querySelector<HTMLElement>('.note-replay-cells') ?? null;
  const closeButton = note?.querySelector<HTMLElement>('.note-close') ?? null;
  const timerBar = note?.querySelector<HTMLElement>('.note-timer-bar') ?? null;
  if (
    hero === null || layer === null || note === null || caption === null || captionInner === null ||
    row === null || replay === null || rule === null || headCells === null || replayCells === null ||
    closeButton === null || timerBar === null
  ) {
    return () => {};
  }
  const lightbox = root.querySelector<HTMLElement>('#hero-lightbox');

  const canZoom = query(CAN_ZOOM);
  const reduce = query(REDUCE);
  const isCaptionMode = (): boolean => canZoom?.matches ?? false;
  const isReduced = (): boolean => reduce?.matches ?? false;
  const lightboxOpen = (): boolean => lightbox?.classList.contains('is-open') ?? false;

  let state: State = 'idle';
  let mode: Mode = 'overlay';
  let armed = false;
  let heroVisible = false;
  let pointerOnHero = false;
  let pointerOnCaption = false;
  let focusInNote = false;
  let flight: Flight | null = null;

  /* Every pending step, so an instant close or a teardown can cancel all of
     them at once rather than leaving a timer to undo what came after it. */
  const pending = new Set<number>();
  const later = (ms: number, step: () => void): void => {
    const id = window.setTimeout(() => {
      pending.delete(id);
      step();
    }, ms);
    pending.add(id);
  };
  const cancelLater = (): void => {
    for (const id of pending) window.clearTimeout(id);
    pending.clear();
  };

  // The pen font is only fetched once something on screen uses it, which
  // would be the first frame of the write-on: ask for it now instead.
  try {
    void document.fonts?.load('48px "Nanum Pen Script"', '원고지won-gji').catch(() => {});
  } catch {
    /* no FontFace API: it arrives when the note shows */
  }

  const showReplay = (visible: boolean): void => {
    replay.hidden = !visible;
    rule.hidden = !visible;
  };

  /* --- Stepping back, and the frozen build ------------------------------- */

  /** The parts the build animates, whose mid-build values `freeze` keeps. */
  const built = (): HTMLElement[] => [
    note,
    ...Array.from(note.querySelectorAll<HTMLElement>('.note-cell, .note-glyph, .note-roman, .note-body p, .note-foot')),
  ];

  /**
   * Close in the middle of the build without a flash. Taking `is-building`
   * off would snap every part that had not arrived yet to fully visible, and
   * the close then fades them out of it: a paragraph that was never shown
   * would blink. So the current values are pinned inline first, and the close
   * fades from those.
   */
  const freeze = (): void => {
    if (!note.classList.contains('is-building')) return;
    const now = built().map((el) => {
      const look = getComputedStyle(el);
      return { el, opacity: look.opacity, transform: look.transform, clip: look.clipPath };
    });
    note.classList.remove('is-building', 'is-replay');
    for (const { el, opacity, transform, clip } of now) {
      el.style.opacity = opacity;
      if (transform !== 'none') el.style.transform = transform;
      if (clip !== 'none') el.style.clipPath = clip;
    }
  };

  const unfreeze = (): void => {
    for (const el of built()) {
      el.style.removeProperty('opacity');
      el.style.removeProperty('transform');
      el.style.removeProperty('clip-path');
    }
  };

  const syncPause = (): void => {
    const hidden = typeof document.hidden === 'boolean' && document.hidden;
    note.classList.toggle('is-paused', pointerOnHero || pointerOnCaption || focusInNote || hidden);
  };

  /* --- Playing ----------------------------------------------------------- */

  /** Put the note where this window wants it, and make that place visible. */
  const reveal = (): void => {
    mode = isCaptionMode() ? 'caption' : 'overlay';
    if (mode === 'caption') {
      if (note.parentElement !== captionInner) captionInner.append(note);
      row.classList.add('is-away');
      caption.hidden = false;
      // A frame at 0fr has to exist for the height to animate from it.
      void caption.offsetHeight;
      caption.classList.add('is-open');
    } else {
      if (note.parentElement !== layer) layer.append(note);
      layer.hidden = false;
    }
  };

  const hold = (): void => {
    if (state !== 'opening') return;
    state = 'open';
    note.classList.remove('is-building', 'is-replay');
    note.classList.add('is-holding');
    syncPause();
  };

  const play = (from: 'auto' | 'replay'): void => {
    if (state !== 'idle' || lightboxOpen()) return;
    disarm();
    storeSeen();
    cancelLater();
    state = 'opening';

    const reduced = isReduced();
    const keyboard = document.activeElement === replay;
    // Copied before the button is hidden (and on a phone, before its row
    // is), or there is nothing to measure.
    const copy = from === 'replay' && !reduced && !replay.hidden ? copySquares(replayCells) : null;

    note.className = 'note';
    unfreeze();
    note.classList.add('is-building');
    if (from === 'replay' && !reduced) note.classList.add('is-replay');

    reveal();
    hero.classList.remove('is-returning');
    hero.classList.add('is-noting');

    if (copy !== null) {
      // Aimed at the heading in its final place: the note is laid out now,
      // and on a phone the heading is at the top of the caption already,
      // however far the caption has opened.
      note.classList.add('is-cells-away');
      flight = launch(copy, measure(headCells), 0);
      const mine = flight;
      void mine.done.then(() => {
        if (flight !== mine) return;
        mine.root.remove();
        flight = null;
        note.classList.remove('is-cells-away');
      });
    }
    showReplay(false);
    row.classList.remove('is-arriving', 'is-appearing');
    replay.classList.remove('is-landed', 'is-cells-away');

    if (keyboard) note.focus({ preventScroll: true });

    later(reduced ? FADE_MS : from === 'replay' ? REPLAY_BUILD_MS : BUILD_MS, hold);
  };

  /* --- Closing ----------------------------------------------------------- */

  const settle = (): void => {
    layer.hidden = true;
    caption.hidden = true;
    caption.classList.remove('is-open', 'is-collapsing');
    note.className = 'note';
    unfreeze();
    state = 'idle';
  };

  const close = (exit: Exit): void => {
    if (state !== 'opening' && state !== 'open') return;
    cancelLater();
    state = 'closing';
    const reduced = isReduced();
    const how: Exit = exit === 'flight' && reduced ? 'fade' : exit;

    // Focus leaves the note with the note, to the place the lightbox also
    // returns it to; Tab from there reaches the replay button.
    if (note.contains(document.activeElement)) hero.focus({ preventScroll: true });
    focusInNote = false;

    freeze();
    note.classList.remove('is-holding', 'is-paused');
    hero.classList.remove('is-noting');

    if (how === 'instant') {
      if (flight !== null) {
        flight.root.remove();
        flight = null;
      }
      hero.classList.remove('is-returning');
      row.classList.remove('is-away', 'is-arriving', 'is-appearing');
      replay.classList.remove('is-cells-away', 'is-landed');
      showReplay(true);
      settle();
      return;
    }

    hero.classList.add('is-returning');
    later(reduced ? FADE_MS : RETURN_MS, () => hero.classList.remove('is-returning'));

    if (how === 'fade') {
      note.classList.add('is-fading');
      row.classList.remove('is-away');
      row.classList.add('is-appearing');
      showReplay(true);
      if (mode === 'caption') caption.classList.remove('is-open');
      later(reduced ? FADE_MS : 300, () => {
        settle();
        row.classList.remove('is-appearing');
      });
      return;
    }

    // The flight. The button comes back first, its squares held invisible,
    // so there is a final place to aim at.
    const copy = copySquares(headCells);
    copy.root.style.visibility = 'hidden'; // until it takes off, at 100ms
    note.classList.add('is-closing');
    row.classList.remove('is-away');
    row.classList.add('is-arriving');
    replay.classList.add('is-cells-away');
    showReplay(true);
    let end: Squares;
    if (mode === 'caption') {
      // On a phone the row's final place is where the caption is now, once
      // it has shrunk away. Measured with the caption out of the layout for
      // a moment (no frame is painted in between), then the caption shrinks
      // over the flight so the row and the squares arrive together.
      caption.hidden = true;
      end = measure(replayCells);
      caption.hidden = false;
      caption.classList.add('is-collapsing');
      caption.classList.remove('is-open');
    } else {
      end = measure(replayCells);
    }
    const launched = launch(copy, end, FLIGHT_DELAY_MS);
    flight = launched;
    later(FLIGHT_DELAY_MS, () => {
      copy.root.style.removeProperty('visibility');
      note.classList.add('is-cells-away');
    });
    void launched.done.then(() => {
      if (flight !== launched) return;
      launched.root.remove();
      flight = null;
      replay.classList.remove('is-cells-away');
      row.classList.remove('is-arriving');
      if (!reduced) {
        replay.classList.add('is-landed');
        later(UNDERLINE_MS, () => replay.classList.remove('is-landed'));
      }
      settle();
    });
  };

  /* --- Triggers ---------------------------------------------------------- */

  let dwellLeft = DWELL_MS;
  let dwellStarted = 0;
  let dwellTimer = 0;
  let hoverTimer = 0;
  let hoverX = 0;
  let hoverY = 0;

  const runDwell = (): void => {
    const should = armed && heroVisible && !document.hidden && !lightboxOpen();
    if (should && dwellTimer === 0) {
      dwellStarted = performance.now();
      dwellTimer = window.setTimeout(() => {
        dwellTimer = 0;
        play('auto');
      }, dwellLeft);
    } else if (!should && dwellTimer !== 0) {
      window.clearTimeout(dwellTimer);
      dwellTimer = 0;
      dwellLeft = Math.max(0, dwellLeft - (performance.now() - dwellStarted));
    }
  };

  const cancelHover = (): void => {
    if (hoverTimer !== 0) window.clearTimeout(hoverTimer);
    hoverTimer = 0;
  };

  const startHover = (event: PointerEvent): void => {
    cancelHover();
    if (!armed || event.pointerType === 'touch' || isCaptionMode()) return;
    hoverX = event.clientX;
    hoverY = event.clientY;
    hoverTimer = window.setTimeout(() => {
      hoverTimer = 0;
      play('auto');
    }, HOVER_MS);
  };

  function disarm(): void {
    armed = false;
    if (dwellTimer !== 0) window.clearTimeout(dwellTimer);
    dwellTimer = 0;
    cancelHover();
  }

  /* --- Listeners --------------------------------------------------------- */

  const onHeroEnter = (event: PointerEvent): void => {
    pointerOnHero = true;
    syncPause();
    startHover(event);
  };
  const onHeroMove = (event: PointerEvent): void => {
    if (hoverTimer === 0) return;
    // Resting, not passing over: a pointer that keeps moving starts again.
    if (Math.hypot(event.clientX - hoverX, event.clientY - hoverY) > HOVER_SLOP_PX) startHover(event);
  };
  const onHeroLeave = (): void => {
    pointerOnHero = false;
    syncPause();
    cancelHover();
  };
  const onCaptionEnter = (): void => {
    pointerOnCaption = true;
    syncPause();
  };
  const onCaptionLeave = (): void => {
    pointerOnCaption = false;
    syncPause();
  };
  const onFocusIn = (): void => {
    focusInNote = true;
    syncPause();
  };
  const onFocusOut = (event: FocusEvent): void => {
    focusInNote = note.contains(event.relatedTarget as Node | null);
    syncPause();
  };

  const onClose = (): void => close('flight');
  const onReplay = (): void => play('replay');

  const onHoldEnd = (event: AnimationEvent): void => {
    if (event.target === timerBar && event.animationName === 'note-timer') close('flight');
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || lightboxOpen()) return;
    if (state === 'opening' || state === 'open') close('flight');
  };

  /** A click anywhere on the sheet, which is the hero's band across the whole
   *  window (the paper is painted out to the edges). Desktop only: on touch a
   *  tap on the grid is the lightbox's. Not a click that finished selecting
   *  some of the note's text, which is someone reading it. */
  const onDocumentClick = (event: MouseEvent): void => {
    if ((state !== 'opening' && state !== 'open') || mode !== 'overlay') return;
    if (event.target instanceof Node && replay.contains(event.target)) return;
    const band = hero.getBoundingClientRect();
    if (event.clientY < band.top || event.clientY > band.bottom) return;
    const selection = window.getSelection();
    if (selection !== null && !selection.isCollapsed && note.contains(selection.anchorNode)) return;
    close('flight');
  };

  const onVisibility = (): void => {
    syncPause();
    runDwell();
  };

  const onModeChange = (): void => {
    cancelHover();
    if (state === 'opening' || state === 'open') close('instant');
  };

  /*
   * Half in view. For the dwell that is the hero. For scrolling away it is
   * wherever the note is: over the grid that is the hero again, but on a
   * phone the note is the caption UNDER the hero, and a reader who scrolls a
   * little to read it takes the hero below half before the caption has gone
   * anywhere (measured at 390x844 by verify-home-note.mjs: 248px of scroll
   * leaves 40% of the hero and all of the caption on screen). So there it
   * closes only once both are mostly gone.
   */
  let captionVisible = false;
  const seeing = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const half = entry.isIntersecting && entry.intersectionRatio >= 0.5;
        if (entry.target === hero) heroVisible = half;
        else captionVisible = half;
      }
      runDwell();
      const away = !heroVisible && !(mode === 'caption' && captionVisible);
      if (away && (state === 'opening' || state === 'open')) close('fade');
    },
    { threshold: [0, 0.25, 0.5, 0.75, 1] },
  );

  // The lightbox owns the tap on the grid; this only watches it open. Then
  // the note goes at once and the clock waits, so it cannot start behind it.
  const watchingLightbox =
    lightbox === null
      ? null
      : new MutationObserver(() => {
          if (lightboxOpen()) close('instant');
          runDwell();
        });

  hero.addEventListener('pointerenter', onHeroEnter);
  hero.addEventListener('pointermove', onHeroMove);
  hero.addEventListener('pointerleave', onHeroLeave);
  caption.addEventListener('pointerenter', onCaptionEnter);
  caption.addEventListener('pointerleave', onCaptionLeave);
  note.addEventListener('focusin', onFocusIn);
  note.addEventListener('focusout', onFocusOut);
  note.addEventListener('animationend', onHoldEnd);
  closeButton.addEventListener('click', onClose);
  replay.addEventListener('click', onReplay);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('visibilitychange', onVisibility);
  try {
    canZoom?.addEventListener('change', onModeChange);
  } catch {
    /* older browsers: the note just stays where it opened */
  }
  watchingLightbox?.observe(lightbox!, { attributes: true, attributeFilter: ['class'] });
  seeing.observe(hero);
  seeing.observe(caption);

  if (storedSeen()) showReplay(true);
  else armed = true;

  return () => {
    disarm();
    cancelLater();
    seeing.disconnect();
    watchingLightbox?.disconnect();
    flight?.root.remove();
    hero.removeEventListener('pointerenter', onHeroEnter);
    hero.removeEventListener('pointermove', onHeroMove);
    hero.removeEventListener('pointerleave', onHeroLeave);
    caption.removeEventListener('pointerenter', onCaptionEnter);
    caption.removeEventListener('pointerleave', onCaptionLeave);
    note.removeEventListener('focusin', onFocusIn);
    note.removeEventListener('focusout', onFocusOut);
    note.removeEventListener('animationend', onHoldEnd);
    closeButton.removeEventListener('click', onClose);
    replay.removeEventListener('click', onReplay);
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('visibilitychange', onVisibility);
    try {
      canZoom?.removeEventListener('change', onModeChange);
    } catch {
      /* nothing to remove */
    }
  };
}
