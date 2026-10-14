/**
 * src/cms/app/shell/use-type-scale.ts
 *
 * The body size, in the editor's own surface.
 *
 * The published page gets its scaled sizes from a `<style>` Base.astro emits
 * at build time. The editor cannot: the page in the middle pane is drawn by
 * the editor's mirror of the site's CSS (SHELL_CSS), it has to change the
 * instant the number in the panel changes, and there is no build between the
 * two. So the same generator runs here, in the editor's dialect, against the
 * WORKING COPY of the site chrome rather than the published one.
 *
 * That is the whole preview. Not a mock of the page at a different size: the
 * page, at that size, with the real renderer and the real rules, changing as
 * you hold the stepper down. A separate preview widget would be a second
 * implementation of the thing it is previewing, which is how a preview comes
 * to disagree with the result.
 *
 * REPLACED, NOT APPENDED. One element with a known id whose textContent is
 * rewritten, so dragging the size from 17.5 to 14 leaves one rule behind and
 * not eight. And it is appended LAST, after SHELL_CSS and after the callout
 * styles, because an essay's quote is scoped identically in both
 * (`.cms-surface--essays blockquote`) and a tie is settled by source order.
 */

import { useEffect } from 'react';

import { SECTION_IDS } from '../../schema.ts';
import {
  EDITOR_DIALECT,
  TYPE_SCALE_STYLE_ID,
  typeScaleCss,
  typeSettingsOf,
} from '../../styles/type-scale.ts';
import type { TypeSettings } from '../../styles/type-scale.ts';
import { useSiteChromeOptional } from '../chrome/index.ts';

/** Put this CSS in the document, as the last stylesheet, replacing any before it. */
export function applyTypeScaleCss(css: string, doc?: Document): void {
  const target = doc ?? (typeof document === 'undefined' ? null : document);
  if (target === null) return;
  const existing = target.getElementById(TYPE_SCALE_STYLE_ID);
  if (css === '') {
    existing?.remove();
    return;
  }
  if (existing !== null) {
    // Moved to the end as well as rewritten: the callout styles are injected
    // lazily, the first time a callout block mounts, and would otherwise be
    // appended after this and win the tie on the callout rule.
    existing.textContent = css;
    target.head.append(existing);
    return;
  }
  const element = target.createElement('style');
  element.id = TYPE_SCALE_STYLE_ID;
  element.textContent = css;
  target.head.append(element);
}

/**
 * Keep the surface at whatever body size the chrome's working copy asks for.
 *
 * Optional context on purpose: the shell harness and the standalone prose
 * harness mount editors with no chrome provider around them, and the right
 * behaviour there is the design's own size, not a crash.
 */
export function useTypeScale(): TypeSettings {
  const chrome = useSiteChromeOptional();
  const settings = typeSettingsOf(chrome?.chrome);

  // Stringified, so the effect runs when the NUMBERS change rather than
  // whenever the chrome object is replaced — which it is on every keystroke
  // in the nav editor next door.
  const key = JSON.stringify(settings);

  useEffect(() => {
    applyTypeScaleCss(typeScaleCss(settings, SECTION_IDS, EDITOR_DIALECT));
    // `key` is the dependency; `settings` is read through the closure and is
    // the object that produced it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return settings;
}
