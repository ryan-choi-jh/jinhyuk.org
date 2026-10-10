/**
 * src/cms/app/chrome/chrome-view.tsx
 *
 * The site's nav bar and footer, drawn around the page in the editor's middle
 * pane so a document is framed the way a reader meets it.
 *
 * It is the REAL thing, from the same `src/content/data/site.json` the site
 * builds from and the same artwork (`../../site-icons.ts`) both ends draw — the
 * wordmark, the nav labels, the theme toggle, the social icons and the
 * copyright line are the ones that will be published, not stand-ins. That is
 * the whole point: scenery with invented labels in it teaches you the wrong
 * page. Nothing in this file is hardcoded; when the toggle is switched off in
 * the panel, it is absent here too.
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
import { SOCIAL_ICON_ART, THEME_ICONS, themeIconArt } from '../../site-icons.ts';
import type { ThemeIconKey, ThemeIconPart } from '../../site-icons.ts';
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
          <span className="cms-chrome__mark" data-testid="surface-chrome-mark">
            {chrome.wordmark.label}
          </span>
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
          {chrome.themeToggle.show && <ThemeToggleArt initial={chrome.themeToggle.initial} />}
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

/**
 * The light/dark control, drawn the way the published one is drawn, from the
 * same artwork (`../../site-icons.ts`) at the same 66×30. It used to be an
 * empty grey pill — a placeholder in a pane whose whole purpose is not having
 * any.
 *
 * The lit half is THE ONE A FIRST-TIME VISITOR SEES, so the `initial` setting
 * is visible here rather than being a word in a panel whose effect you have to
 * imagine. `system` shows light, because this surface renders light.
 *
 * Inert like the rest of the scenery: spans, not buttons.
 */
function ThemeToggleArt({ initial }: { initial: SiteChrome['themeToggle']['initial'] }) {
  const lit: ThemeIconKey = initial === 'dark' ? 'dark' : 'light';
  return (
    <div className="cms-chrome__toggle" data-testid="surface-chrome-toggle">
      {THEME_ICONS.map((key) => {
        const art = themeIconArt(key);
        return (
          <span
            key={key}
            className="cms-chrome__toggle-cell"
            data-theme-cell={key}
            data-on={key === lit ? '1' : undefined}
          >
            <svg viewBox={art.viewBox} aria-hidden="true" focusable="false">
              {art.parts.map((part, index) => (
                <IconPart key={index} part={part} />
              ))}
            </svg>
          </span>
        );
      })}
    </div>
  );
}

/** One element of a stroked icon, with the attributes every part shares. */
function IconPart({ part }: { part: ThemeIconPart }) {
  if (part.shape === 'circle') {
    return (
      <circle cx={part.cx} cy={part.cy} r={part.r} fill="none" stroke="currentColor" strokeWidth="2" />
    );
  }
  return (
    <path
      d={part.d}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap={part.linecap}
      strokeLinejoin={part.linejoin}
    />
  );
}

export default SiteChromeView;
