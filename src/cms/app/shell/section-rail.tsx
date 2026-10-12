/**
 * src/cms/app/shell/section-rail.tsx
 *
 * The left-hand navigation with the words taken away: a 40px strip of glyphs,
 * shown in place of the section sidebar AND the entry list when the sidebar is
 * collapsed. It hands the editor back 424 of the 464 pixels those two columns
 * were holding, which on a 1344px page is the difference between seeing the
 * whole illustration and scrolling it.
 *
 * It is NAVIGATION, not a handle. A collapsed sidebar that only offers "expand
 * me again" makes the collapse a worse deal than it looks: you would reopen it
 * for every section change. So the five sections stay reachable, with the
 * current one lit and an unpublished draft still showing its dot, and the
 * tooltip carries the label and the count the row used to print.
 *
 * What it deliberately does NOT carry is the entry list. Picking one project
 * out of several needs their titles, and titles do not survive at 40px; the
 * bar's job is to get out of the way while you edit, and the crumbs along the
 * top say which entry is open. Clicking a section expands the sidebar back,
 * because choosing a section is exactly the moment you want to see its list.
 *
 * Glyphs and wording come from `./section-sidebar.tsx` rather than being
 * written again here, so the two cannot drift.
 */

import { SECTIONS } from '../../sections.ts';
import type { SectionId } from '../../schema.ts';
import type { SectionSummary } from '../state/site-api.ts';
import type { SiteStore } from '../state/site-store.ts';
import { describe, glyphFor } from './section-sidebar.tsx';

export type SectionRailProps = {
  store: SiteStore;
  /** One per section, in registry order. */
  sections: SectionSummary[];
  /** The section being looked at, or null on the overview. */
  current: SectionId | null;
  /** Put the sidebar back. Called by the chevron and by picking a section. */
  onExpand: () => void;
};

export function SectionRail({ store, sections, current, onExpand }: SectionRailProps) {
  const byId = new Map(sections.map((summary) => [summary.id, summary]));

  return (
    <section
      className="cms-site__col cms-site__col--rail"
      aria-label="Sections"
      data-testid="section-rail"
    >
      <header className="cms-site__head cms-site__head--rail">
        <button
          type="button"
          className="cms-rail__btn cms-rail__btn--chevron"
          data-testid="rail-expand"
          title="Show the sidebar"
          aria-label="Show the sidebar"
          aria-expanded={false}
          onClick={onExpand}
        >
          <span aria-hidden="true">»</span>
        </button>
      </header>

      <div className="cms-site__scroll">
        <nav className="cms-rail" aria-label="Sections">
          {SECTIONS.map((section) => {
            const summary = byId.get(section.id);
            const selected = current === section.id;
            return (
              <button
                key={section.id}
                type="button"
                className={`cms-rail__btn${selected ? ' cms-rail__btn--current' : ''}`}
                data-testid={`rail-row-${section.id}`}
                data-section={section.id}
                aria-current={selected ? 'page' : undefined}
                title={`${section.label} · ${describe(section, summary)}`}
                onClick={() => {
                  store.openSection(section.id);
                  onExpand();
                }}
              >
                <span className="cms-rail__glyph" aria-hidden="true">
                  {glyphFor(section)}
                </span>
                <span className="cms-rail__sr">{section.label}</span>
                {summary?.hasDraft === true && (
                  <span
                    className="cms-rail__dot"
                    data-testid={`rail-draft-${section.id}`}
                    title="Unpublished draft in this section"
                  />
                )}
              </button>
            );
          })}
        </nav>
      </div>
    </section>
  );
}
