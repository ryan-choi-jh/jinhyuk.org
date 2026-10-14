/**
 * src/cms/app/chrome/TypeScalePanel.tsx
 *
 * The body size, and who gets it.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF THE DECISION
 * ---------------------------------------------------------------------------
 *
 * Changing the size of the text on a whole site is not a setting, it is a
 * decision, and the thing that makes it hard is not the number. It is not
 * knowing what the number will do. So the panel is built around the three
 * questions you actually have, in the order you have them:
 *
 *   1. What does 16px look like?        a sample, set at the real values
 *   2. What else moves when body does?  the scale, from and to
 *   3. Which pages does this touch?     the sections, with their page counts
 *
 * And only then: apply, to the ones ticked.
 *
 * NOTHING HAPPENS UNTIL YOU APPLY, AND NOTHING IS LIVE UNTIL YOU PUBLISH.
 * The stepper moves a proposal, which is local state here. Apply writes it
 * into the working copy of the site chrome, which repaints the page in the
 * middle pane — that is the real preview, the real renderer at the real size
 * — and leaves a draft. The site is unchanged until the chrome is published,
 * the same as the nav and the footer above.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SAMPLE IS INLINE-STYLED AND NOT A CLASS
 * ---------------------------------------------------------------------------
 *
 * It is showing a size that does not exist yet. A class would mean generating
 * a stylesheet for a proposal, and then the panel would have two ways of
 * computing a size — one for the sample, one for the real thing — which is
 * exactly the drift this whole feature is built to avoid. `scaleRole` is
 * called directly and its answer is put on the element.
 */

import { useMemo, useState } from 'react';

import { SECTION_IDS } from '../../schema.ts';
import type { SectionId } from '../../schema.ts';
import { SECTIONS } from '../../sections.ts';
import {
  BODY_BASE_SIZE,
  BODY_SIZE_MAX,
  BODY_SIZE_MIN,
  BODY_SIZE_STEP,
  ROLE_LABEL,
  effectiveSize,
  rolesFor,
  scaleRole,
  typeSettingsOf,
} from '../../styles/type-scale.ts';
import { useOptionalSiteStore, useSiteStoreState } from '../state/use-site-store.ts';
import type { SiteStore } from '../state/site-store.ts';
import { applyBodySize, clearBodySize } from './edits.ts';
import { useSiteChrome } from './context.tsx';

/** What each section's pages are, in words, for the "what this affects" list. */
const AFFECTS: Readonly<Record<SectionId, string>> = {
  home: 'the homepage',
  projects: 'every project page, and the projects index',
  essays: 'every essay, and the essays index',
  filmography: 'the filmography page',
  photography: 'every album, and the photography index',
};

const LABEL = new Map(SECTIONS.map((section) => [section.id, section.label]));

/** `17.5` reads better than `17.50`, and `16` better than `16.0`. */
function px(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}px`;
}

/**
 * The panel, and the page counts if this is running inside the site shell.
 *
 * Split at a component boundary rather than branched inside one, because
 * `useSiteStoreState` cannot be called conditionally and the store is absent
 * in the standalone document editor and in the harnesses. Each component
 * below calls a fixed set of hooks.
 */
export function TypeScalePanel() {
  const store = useOptionalSiteStore();
  return store === null ? <TypeScaleBody counts={{}} hasCounts={false} /> : <WithCounts store={store} />;
}

function WithCounts({ store }: { store: SiteStore }) {
  const state = useSiteStoreState(store);
  const counts = Object.fromEntries(state.sections.map((summary) => [summary.id, summary.count]));
  return <TypeScaleBody counts={counts} hasCounts />;
}

function TypeScaleBody({
  counts,
  hasCounts,
}: {
  counts: Partial<Record<SectionId, number>>;
  hasCounts: boolean;
}) {
  const chromeStore = useSiteChrome();
  const chrome = chromeStore.chrome;
  const busy = chromeStore.phase === 'saving' || chromeStore.phase === 'publishing';

  const settings = typeSettingsOf(chrome);

  /**
   * The proposal. Seeded from whatever the sections already differ at, so
   * reopening the panel after setting essays to 16 starts at 16 rather than
   * at the baseline, and the first thing you see is what you last did.
   */
  const current = useMemo(() => {
    const overridden = SECTION_IDS.map((id) => effectiveSize(settings, id)).filter(
      (size) => size !== BODY_BASE_SIZE,
    );
    return overridden.length > 0 ? (overridden[0] as number) : BODY_BASE_SIZE;
  }, [settings]);

  const [size, setSize] = useState(current);
  const [picked, setPicked] = useState<Set<SectionId>>(
    () => new Set(SECTION_IDS.filter((id) => effectiveSize(settings, id) !== BODY_BASE_SIZE)),
  );

  const chosen = SECTION_IDS.filter((id) => picked.has(id));
  const toggle = (id: SectionId): void =>
    setPicked((before) => {
      const next = new Set(before);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const step = (by: number): void =>
    setSize((before) => {
      const next = Math.round((before + by) * 2) / 2;
      return Math.min(BODY_SIZE_MAX, Math.max(BODY_SIZE_MIN, next));
    });

  if (chrome === null) return null;

  const apply = (): void => {
    chromeStore.edit(applyBodySize(chrome, size, chosen));
  };
  const reset = (): void => {
    chromeStore.edit(clearBodySize(chrome, chosen));
    setSize(BODY_BASE_SIZE);
  };

  // Every role that any chosen section would use. Essays and projects differ
  // on exactly one — the quote — so ticking both shows both, which is right:
  // they are two different objects and both are about to move.
  const roles = [...new Set(chosen.flatMap((id) => rolesFor(id)))];
  const changes = roles.map((role) => ({
    role,
    from: scaleRole(role, BODY_BASE_SIZE, 'wide'),
    to: scaleRole(role, size, 'wide'),
  }));

  const changedCount = SECTION_IDS.filter((id) => effectiveSize(settings, id) !== BODY_BASE_SIZE).length;
  const sample = scaleRole('body', size, 'wide');
  const pages = chosen.reduce((total, id) => total + (counts[id] ?? 0), 0);
  const nothingChosen = chosen.length === 0;
  const atBaseline = size === BODY_BASE_SIZE;

  return (
    <div className="cms-chr__group" data-testid="chrome-type">
      <div className="cms-chr__head">
        Body size
        <span className="cms-chr__head-count" data-testid="type-status">
          {changedCount === 0
            ? 'default'
            : `${changedCount} section${changedCount === 1 ? '' : 's'} changed`}
        </span>
      </div>
      <div className="cms-chr__sub">
        The size of the text you read: paragraphs, lists, quotes and callouts.
        Headings keep their own sizes. The design is drawn at {px(BODY_BASE_SIZE)}.
      </div>

      {/* ------------------------------------------------------------ */}
      {/* 1. The number, and what it looks like                        */}
      {/* ------------------------------------------------------------ */}

      <div className="cms-chr__field">
        <span className="cms-chr__label">Size</span>
        <div className="cms-type__stepper">
          <button
            type="button"
            className="cms-chr__btn"
            data-testid="type-smaller"
            aria-label="Smaller"
            disabled={busy || size <= BODY_SIZE_MIN}
            onClick={() => step(-BODY_SIZE_STEP)}
          >
            −
          </button>
          <input
            className="cms-chr__input cms-type__value"
            data-testid="type-size"
            type="number"
            inputMode="decimal"
            min={BODY_SIZE_MIN}
            max={BODY_SIZE_MAX}
            step={BODY_SIZE_STEP}
            value={size}
            aria-label="Body size in pixels"
            disabled={busy}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (!Number.isFinite(next)) return;
              setSize(Math.min(BODY_SIZE_MAX, Math.max(BODY_SIZE_MIN, Math.round(next * 2) / 2)));
            }}
          />
          <button
            type="button"
            className="cms-chr__btn"
            data-testid="type-bigger"
            aria-label="Bigger"
            disabled={busy || size >= BODY_SIZE_MAX}
            onClick={() => step(BODY_SIZE_STEP)}
          >
            +
          </button>
          <span className="cms-chr__help">
            {atBaseline ? 'the design’s own size' : `${px(BODY_BASE_SIZE)} → ${px(size)}`}
          </span>
        </div>
      </div>

      <p
        className="cms-type__sample"
        data-testid="type-sample"
        style={{ fontSize: `${sample.size}px`, lineHeight: `${sample.leading}px` }}
      >
        I was looking for a startup idea. I needed to ask a different question —
        set at {px(sample.size)} over {px(sample.leading)}, which is what a
        paragraph on the page will measure.
      </p>

      {/* ------------------------------------------------------------ */}
      {/* 2. What else moves                                           */}
      {/* ------------------------------------------------------------ */}

      {!atBaseline && !nothingChosen && (
        <table className="cms-type__scale" data-testid="type-scale">
          <tbody>
            {changes.map(({ role, from, to }) => (
              <tr key={role}>
                <th scope="row">{ROLE_LABEL[role]}</th>
                <td className="cms-type__from">
                  {px(from.size)}/{px(from.leading)}
                </td>
                <td aria-hidden="true">→</td>
                <td className="cms-type__to">
                  {px(to.size)}/{px(to.leading)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* ------------------------------------------------------------ */}
      {/* 3. Which pages                                               */}
      {/* ------------------------------------------------------------ */}

      <div className="cms-chr__label cms-type__who">Apply to</div>
      {SECTION_IDS.map((id) => {
        const now = effectiveSize(settings, id);
        const ticked = picked.has(id);
        return (
          <label className="cms-chr__check cms-type__row" key={id}>
            <input
              type="checkbox"
              data-testid={`type-pick-${id}`}
              checked={ticked}
              disabled={busy}
              onChange={() => toggle(id)}
            />
            <span className="cms-type__name">{LABEL.get(id) ?? id}</span>
            <span className="cms-type__affects">
              {AFFECTS[id]}
              {counts[id] === undefined ? '' : ` · ${counts[id]}`}
            </span>
            <span className="cms-type__now" data-testid={`type-now-${id}`}>
              {ticked && now !== size ? `${px(now)} → ${px(size)}` : px(now)}
            </span>
          </label>
        );
      })}

      <div className="cms-chr__row cms-type__actions">
        <button
          type="button"
          className="cms-chr__btn cms-chr__btn--primary"
          data-testid="type-apply"
          disabled={busy || nothingChosen}
          onClick={apply}
        >
          {nothingChosen
            ? 'Pick a section'
            : `Apply ${px(size)} to ${chosen.length === SECTION_IDS.length ? 'the whole site' : `${chosen.length} section${chosen.length === 1 ? '' : 's'}`}`}
        </button>
        <button
          type="button"
          className="cms-chr__btn"
          data-testid="type-reset"
          disabled={busy || nothingChosen}
          onClick={reset}
        >
          Reset to {px(BODY_BASE_SIZE)}
        </button>
      </div>

      <div className="cms-chr__help" data-testid="type-consequence">
        {nothingChosen
          ? 'Nothing selected, so nothing would change.'
          : `Changes ${AFFECTS[chosen[0] as SectionId]}${chosen.length > 1 ? `, and ${chosen.length - 1} more section${chosen.length > 2 ? 's' : ''}` : ''}${pages > 0 ? ` — ${pages} page${pages === 1 ? '' : 's'} in all` : ''}. ` +
            'Applying writes a draft and repaints the page in the middle. The live site does not move until you publish.'}
      </div>

      {!hasCounts && (
        <div className="cms-chr__help">
          Page counts are not available here; the list above is still exact
          about which pages each section covers.
        </div>
      )}
    </div>
  );
}
