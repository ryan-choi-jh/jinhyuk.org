/**
 * src/cms/render/video.ts
 *
 * WS-B. The client half of the filmography page: the poster-frame facade.
 *
 * `renderFilmography` emits a `<button class="video">` showing a still. This
 * replaces that still with the real YouTube player the first time the button is
 * clicked, and never before, so a page of four films loads four JPEGs instead
 * of four embedded players. That is the behaviour
 * `src/pages/filmography/index.astro` has today, and the one thing about the
 * filmography page worth protecting.
 *
 * It runs in the browser and nowhere else, and it imports nothing: the embed
 * URL is already in the markup (`data-embed`, which the renderer filled in
 * from `youtubeEmbedUrl`), so loading this does not drag zod into the page to
 * format one string. If `data-embed` is missing — markup written by hand, or an
 * older build — it falls back to assembling the same URL from
 * `data-video-id`, with the shape stated in one place below.
 *
 * Usage, from an Astro page or the editor:
 *
 *   import { initVideoFacades } from '../cms/render/video.ts';
 *   const stop = initVideoFacades();
 */

/**
 * The permissions the live page grants its player, verbatim. `web-share` is in
 * here and not in the renderer's canvas embeds, which is deliberate: this is
 * the filmography page's own string and changing it would change the page.
 */
const IFRAME_ALLOW =
  'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';

/**
 * The fallback embed URL. Must stay identical to `youtubeEmbedUrl(id, {
 * autoplay: true })` in src/cms/schema.ts. It is duplicated rather than
 * imported because importing the schema here would put zod in the page.
 */
function fallbackEmbed(youtubeId: string): string {
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeId)}?autoplay=1&rel=0`;
}

/** The player that replaces the still. */
function playerFor(button: HTMLElement, src: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.title = button.getAttribute('aria-label') ?? 'Video';
  iframe.allow = IFRAME_ALLOW;
  iframe.allowFullscreen = true;
  // The live page does not set these, and `.video iframe` in global.css
  // already positions the frame over the whole facade.
  return iframe;
}

/** Where this button's player should load from, or null when we cannot tell. */
export function embedUrlFor(button: HTMLElement): string | null {
  const explicit = button.dataset.embed;
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  const id = button.dataset.videoId;
  if (typeof id !== 'string' || id === '') return null;
  return fallbackEmbed(id);
}

/**
 * Wire every facade in `root` that is not wired already.
 *
 * Returns a function that unwires them, for the editor, where a preview is
 * rebuilt and the old nodes go away. Calling this twice over the same nodes is
 * safe: a wired button is marked, so a second pass does nothing.
 */
export function initVideoFacades(root: ParentNode = document): () => void {
  const buttons = Array.from(root.querySelectorAll<HTMLElement>('.video[data-video-id]'));
  const undo: (() => void)[] = [];

  for (const button of buttons) {
    if (button.dataset.videoWired === 'true') continue;
    button.dataset.videoWired = 'true';

    const play = (): void => {
      const src = embedUrlFor(button);
      if (src === null) return;
      // replaceChildren, not appendChild: the still and the play mark go away
      // together, which is what stops the triangle sitting over the player.
      button.replaceChildren(playerFor(button, src));
    };

    // `once` because there is nothing to do a second time, and because the
    // button's own children are gone by then.
    button.addEventListener('click', play, { once: true });
    undo.push(() => {
      button.removeEventListener('click', play);
      delete button.dataset.videoWired;
    });
  }

  return () => {
    for (const stop of undo) stop();
  };
}
