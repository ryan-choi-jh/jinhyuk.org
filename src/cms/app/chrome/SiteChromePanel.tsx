/**
 * src/cms/app/chrome/SiteChromePanel.tsx
 *
 * The nav bar and the footer, editable, under Home.
 *
 * It is in the Home editor's inspector because that is where the owner asked
 * for it ("in home, i also want to be able to edit the nav bar and the footer")
 * and because there is nowhere more honest: the nav and the footer are not part
 * of the homepage, they are part of every page, and the panel says so in its
 * first line. Everything it writes goes to `src/content/data/site.json`, which
 * `src/layouts/Base.astro` draws around all of them.
 *
 * What it can do, which is the list the brief asks for: add, remove, reorder and
 * rename nav links and edit their addresses; edit the copyright line; add,
 * remove and reorder social links, choosing an icon from the known set and
 * setting the address.
 *
 * Two decisions worth knowing.
 *
 *  1. AN ICON IS CHOSEN, NOT PASTED. The control is a `<select>` over
 *     `SOCIAL_ICONS` with that icon drawn beside it, so the only reachable
 *     values are the five the site has artwork for and the drawing is visible
 *     before saving. There is nowhere to put SVG path data, by construction.
 *  2. THE EDIT IS LIVE IN THE SURFACE. The panel writes to the same context the
 *     scenery around the page reads (`./chrome-view.tsx`), so renaming a link
 *     shows up in the nav above the document as it is typed, before anything is
 *     saved.
 *
 * The look is the record editors' look through this directory's own class
 * names; `./styles.ts` says why it is not literally their classes.
 */

import { MAX_NAV_LINKS, MAX_SOCIAL_LINKS, SOCIAL_ICONS, renderCopyright } from '../../schema.ts';
import type { SiteChrome, SocialIcon } from '../../schema.ts';
import { SOCIAL_ICON_ART, SOCIAL_ICON_LABELS } from '../../site-icons.ts';
import { useSiteChromeOptional } from './context.tsx';
import type { SiteChromeStore } from './context.tsx';
import {
  addNavLink,
  addSocialLink,
  copyrightProblem,
  hrefProblem,
  labelProblem,
  moveNavLink,
  moveSocialLink,
  nameProblem,
  removeNavLink,
  removeSocialLink,
  setNavField,
  setSocialIcon,
  setSocialText,
  withCopyright,
} from './edits.ts';
import { useChromeStyles } from './styles.ts';

export function SiteChromePanel() {
  useChromeStyles();
  const store = useSiteChromeOptional();
  // No provider: this host does not have the API wired up, and a panel that
  // cannot save anything is worse than no panel.
  if (store === null) return null;
  return <Panel store={store} />;
}

function Panel({ store }: { store: SiteChromeStore }) {
  const chrome = store.chrome;
  const busy = store.phase !== 'idle';

  if (chrome === null) {
    return (
      <div className="cms-chr" data-testid="site-chrome-panel">
        <div className="cms-chr__head">Nav &amp; footer</div>
        <div className="cms-chr__empty">
          {store.phase === 'loading' ? 'Reading it from the repository…' : 'Not loaded.'}
        </div>
        {store.notice !== null && <Notice store={store} />}
        <button
          type="button"
          className="cms-chr__btn cms-chr__btn--wide"
          disabled={busy}
          onClick={() => void store.reload()}
        >
          Reload
        </button>
      </div>
    );
  }

  const set = (next: SiteChrome): void => store.edit(next);

  return (
    <div className="cms-chr" data-testid="site-chrome-panel">
      <div className="cms-chr__head">
        Nav &amp; footer
        <span className="cms-chr__head-count">every page</span>
      </div>
      <div className="cms-chr__sub">
        One file, drawn around every page of the site. A change here moves all of
        them.
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* The nav                                                          */}
      {/* ---------------------------------------------------------------- */}

      <div className="cms-chr__group" data-testid="chrome-nav">
        <div className="cms-chr__head">
          Nav bar
          <span className="cms-chr__head-count">
            {chrome.nav.length}/{MAX_NAV_LINKS}
          </span>
        </div>

        {chrome.nav.length === 0 && (
          <div className="cms-chr__empty">No links. The nav bar is the wordmark alone.</div>
        )}

        {chrome.nav.map((link, index) => (
          <div className="cms-chr__row" key={`nav-${index}`} data-testid={`chrome-nav-${index}`}>
            <div className="cms-chr__row-top">
              <span className="cms-chr__num">{index + 1}</span>
              <input
                className={inputClass(labelProblem(link.label))}
                data-testid={`chrome-nav-label-${index}`}
                type="text"
                value={link.label}
                aria-label={`Nav link ${index + 1} label`}
                autoComplete="off"
                disabled={busy}
                onChange={(event) => set(setNavField(chrome, index, 'label', event.target.value))}
              />
              <Reorder
                index={index}
                count={chrome.nav.length}
                what="link"
                disabled={busy}
                onMove={(to) => set(moveNavLink(chrome, index, to))}
                onRemove={() => set(removeNavLink(chrome, index))}
                testPrefix={`chrome-nav-${index}`}
              />
            </div>
            <input
              className={`${inputClass(hrefProblem(link.href))} cms-chr__input--mono`}
              data-testid={`chrome-nav-href-${index}`}
              type="text"
              value={link.href}
              aria-label={`Nav link ${index + 1} address`}
              placeholder="/projects/"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => set(setNavField(chrome, index, 'href', event.target.value))}
            />
            <Problem text={labelProblem(link.label) ?? hrefProblem(link.href)} />
          </div>
        ))}

        <button
          type="button"
          className="cms-chr__btn cms-chr__btn--wide"
          data-testid="chrome-nav-add"
          disabled={busy || chrome.nav.length >= MAX_NAV_LINKS}
          title={
            chrome.nav.length >= MAX_NAV_LINKS
              ? `${MAX_NAV_LINKS} is as many as the bar holds.`
              : undefined
          }
          onClick={() => set(addNavLink(chrome))}
        >
          Add a nav link
        </button>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* The footer                                                       */}
      {/* ---------------------------------------------------------------- */}

      <div className="cms-chr__group" data-testid="chrome-footer">
        <div className="cms-chr__head">Footer</div>

        <div className="cms-chr__field">
          <span className="cms-chr__label">Copyright</span>
          <input
            className={inputClass(copyrightProblem(chrome.footer.copyright))}
            data-testid="chrome-copyright"
            type="text"
            value={chrome.footer.copyright}
            aria-label="Copyright line"
            autoComplete="off"
            disabled={busy}
            onChange={(event) => set(withCopyright(chrome, event.target.value))}
          />
          {copyrightProblem(chrome.footer.copyright) === null ? (
            <span className="cms-chr__help" data-testid="chrome-copyright-preview">
              {'{year}'} becomes the year the site is built, so it never goes stale.
              Prints as “{renderCopyright(chrome.footer.copyright, new Date().getFullYear())}”.
            </span>
          ) : (
            <Problem text={copyrightProblem(chrome.footer.copyright)} />
          )}
        </div>

        <div className="cms-chr__head">
          Social
          <span className="cms-chr__head-count">
            {chrome.footer.social.length}/{MAX_SOCIAL_LINKS}
          </span>
        </div>

        {chrome.footer.social.length === 0 && (
          <div className="cms-chr__empty">No icons. The footer is the copyright alone.</div>
        )}

        {chrome.footer.social.map((link, index) => (
          <div
            className="cms-chr__row"
            key={`social-${index}`}
            data-testid={`chrome-social-${index}`}
          >
            <div className="cms-chr__row-top">
              <span className="cms-chr__icon">
                <IconPreview icon={link.icon} />
              </span>
              <select
                className="cms-chr__select"
                data-testid={`chrome-social-icon-${index}`}
                value={link.icon}
                aria-label={`Social link ${index + 1} icon`}
                disabled={busy}
                onChange={(event) =>
                  set(setSocialIcon(chrome, index, event.target.value as SocialIcon))
                }
              >
                {SOCIAL_ICONS.map((icon) => (
                  <option key={icon} value={icon}>
                    {SOCIAL_ICON_LABELS[icon]}
                  </option>
                ))}
              </select>
              <Reorder
                index={index}
                count={chrome.footer.social.length}
                what="icon"
                disabled={busy}
                onMove={(to) => set(moveSocialLink(chrome, index, to))}
                onRemove={() => set(removeSocialLink(chrome, index))}
                testPrefix={`chrome-social-${index}`}
              />
            </div>
            <input
              className={inputClass(nameProblem(link.name))}
              data-testid={`chrome-social-name-${index}`}
              type="text"
              value={link.name}
              aria-label={`Social link ${index + 1} name`}
              placeholder="GitHub"
              autoComplete="off"
              disabled={busy}
              onChange={(event) => set(setSocialText(chrome, index, 'name', event.target.value))}
            />
            <input
              className={`${inputClass(hrefProblem(link.href))} cms-chr__input--mono`}
              data-testid={`chrome-social-href-${index}`}
              type="text"
              value={link.href}
              aria-label={`Social link ${index + 1} address`}
              placeholder="https://… or mailto:…"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => set(setSocialText(chrome, index, 'href', event.target.value))}
            />
            <Problem text={nameProblem(link.name) ?? hrefProblem(link.href)} />
          </div>
        ))}

        <button
          type="button"
          className="cms-chr__btn cms-chr__btn--wide"
          data-testid="chrome-social-add"
          disabled={busy || chrome.footer.social.length >= MAX_SOCIAL_LINKS}
          title={
            chrome.footer.social.length >= MAX_SOCIAL_LINKS
              ? `${MAX_SOCIAL_LINKS} is as many as the row holds.`
              : undefined
          }
          onClick={() => set(addSocialLink(chrome))}
        >
          Add a social link
        </button>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Saving                                                           */}
      {/* ---------------------------------------------------------------- */}

      <div className="cms-chr__acts">
        <button
          type="button"
          className="cms-chr__btn cms-chr__btn--primary"
          data-testid="chrome-save"
          disabled={busy || !store.dirty || store.problem !== null}
          title={store.problem ?? undefined}
          onClick={() => void store.save()}
        >
          {store.phase === 'saving' ? 'Saving…' : 'Save draft'}
        </button>
        <button
          type="button"
          className="cms-chr__btn"
          data-testid="chrome-publish"
          disabled={busy || !store.hasDraft || store.dirty}
          title={
            store.dirty
              ? 'Save the draft first; publishing only ever moves a saved draft.'
              : store.hasDraft
                ? undefined
                : 'Nothing to publish: there is no draft.'
          }
          onClick={() => void store.publish()}
        >
          {store.phase === 'publishing' ? 'Publishing…' : 'Publish'}
        </button>
        {store.hasDraft && (
          <button
            type="button"
            className="cms-chr__btn cms-chr__btn--quiet cms-chr__btn--danger"
            data-testid="chrome-discard"
            disabled={busy}
            onClick={() => void store.discard()}
          >
            Discard draft
          </button>
        )}
        <span
          className={store.dirty ? 'cms-chr__state cms-chr__state--dirty' : 'cms-chr__state'}
          data-testid="chrome-state"
        >
          {store.dirty ? 'unsaved' : store.hasDraft ? 'draft saved' : 'published'}
        </span>
      </div>

      {store.problem !== null && <Problem text={store.problem} />}
      {store.notice !== null && <Notice store={store} />}
      <span className="cms-chr__path">{store.path}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

function inputClass(problem: string | null): string {
  return problem === null ? 'cms-chr__input' : 'cms-chr__input cms-chr__input--bad';
}

function Problem({ text }: { text: string | null }) {
  if (text === null) return null;
  return <span className="cms-chr__problem">{text}</span>;
}

function Notice({ store }: { store: SiteChromeStore }) {
  const notice = store.notice;
  if (notice === null) return null;
  return (
    <div
      className={`cms-chr__notice cms-chr__notice--${notice.kind}`}
      data-testid="chrome-notice"
      onClick={() => store.dismiss()}
      title="Dismiss"
    >
      {notice.message}
    </div>
  );
}

function IconPreview({ icon }: { icon: SocialIcon }) {
  const art = SOCIAL_ICON_ART[icon];
  return (
    <svg viewBox={art.viewBox} aria-hidden="true" focusable="false">
      <path d={art.path} fill="currentColor" />
    </svg>
  );
}

/** Up, down, remove. The three things every row in both lists can do. */
function Reorder({
  index,
  count,
  what,
  disabled,
  onMove,
  onRemove,
  testPrefix,
}: {
  index: number;
  count: number;
  what: string;
  disabled: boolean;
  onMove: (to: number) => void;
  onRemove: () => void;
  testPrefix: string;
}) {
  return (
    <span className="cms-chr__row-acts">
      <button
        type="button"
        className="cms-chr__btn cms-chr__btn--micro"
        data-testid={`${testPrefix}-up`}
        aria-label={`Move this ${what} earlier`}
        title="Move earlier"
        disabled={disabled || index === 0}
        onClick={() => onMove(index - 1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="cms-chr__btn cms-chr__btn--micro"
        data-testid={`${testPrefix}-down`}
        aria-label={`Move this ${what} later`}
        title="Move later"
        disabled={disabled || index >= count - 1}
        onClick={() => onMove(index + 1)}
      >
        ↓
      </button>
      <button
        type="button"
        className="cms-chr__btn cms-chr__btn--micro cms-chr__btn--danger"
        data-testid={`${testPrefix}-remove`}
        aria-label={`Remove this ${what}`}
        title="Remove"
        disabled={disabled}
        onClick={onRemove}
      >
        ✕
      </button>
    </span>
  );
}

export default SiteChromePanel;
