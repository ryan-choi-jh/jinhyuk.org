/**
 * src/cms/app/chrome/chrome-view.tsx
 *
 * The site's nav bar and footer, drawn around the page in the editor's middle
 * pane so a document is framed the way a reader meets it.
 *
 * It is the REAL thing, from the same `src/content/data/site.json` the site
 * builds from and the same icon artwork the footer uses — the labels, the
 * icons and the copyright line are the ones that will be published, not stand-
 * ins. That is the whole point: scenery with invented labels in it teaches you
 * the wrong page.
 *
 * Inert by design. `aria-hidden` and `pointer-events: none` (in
 * `../shell/styles.ts`), because clicking the nav inside an editing surface
 * should do nothing: it is scenery, not navigation.
 *
 * Nothing is drawn until the chrome has been read. A box of grey rectangles
 * would be a placeholder, and the one thing this file is for is not having one.
 */

import { getSection } from '../../sections.ts';
import { isNavCurrent, renderCopyright } from '../../schema.ts';
import type { SiteChrome } from '../../schema.ts';
import { SOCIAL_ICON_ART } from '../../site-icons.ts';
import { useSiteChromeOptional } from './context.tsx';

export type SiteChromeViewProps = {
  where: 'top' | 'bottom';
  /**
   * The section the open document belongs to, so its nav link is lit exactly as
   * it is on the live page. Undefined leaves nothing marked, which is what the
   * live homepage does.
   */
  section?: string | undefined;
  /** Override the content (harness). Otherwise it comes from the provider. */
  chrome?: SiteChrome | null;
};

export function SiteChromeView({ where, section, chrome: given }: SiteChromeViewProps) {
  const store = useSiteChromeOptional();
  const chrome = given ?? store?.chrome ?? null;
  if (chrome === null) return null;

  if (where === 'top') {
    // The live page highlights from the URL; there is no URL here, so the
    // section the document belongs to stands in for one. `indexUrl` is the
    // registry's, so this cannot drift from where the section actually is.
    const current = section === undefined ? null : getSection(section)?.indexUrl ?? null;
    return (
      <div className="cms-chrome" aria-hidden="true" data-testid="surface-chrome-top">
        <div className="cms-chrome__nav">
          <span className="cms-chrome__mark">Ryan Choi</span>
          <div className="cms-chrome__links">
            {chrome.nav.map((link, index) => (
              <span
                key={`${link.href}:${index}`}
                data-on={current !== null && isNavCurrent(link.href, current) ? '1' : undefined}
              >
                {link.label}
              </span>
            ))}
          </div>
          <div className="cms-chrome__toggle" />
        </div>
      </div>
    );
  }

  return (
    <div className="cms-chrome" aria-hidden="true" data-testid="surface-chrome-bottom">
      <div className="cms-chrome__footer">
        <span>{renderCopyright(chrome.footer.copyright, new Date().getFullYear())}</span>
        <span className="cms-chrome__social">
          {chrome.footer.social.map((link, index) => {
            const art = SOCIAL_ICON_ART[link.icon];
            return (
              <svg
                key={`${link.icon}:${index}`}
                viewBox={art.viewBox}
                aria-hidden="true"
                focusable="false"
              >
                <path d={art.path} fill="currentColor" />
              </svg>
            );
          })}
        </span>
      </div>
    </div>
  );
}

export default SiteChromeView;
