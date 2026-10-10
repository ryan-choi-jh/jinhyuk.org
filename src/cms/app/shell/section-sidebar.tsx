/**
 * src/cms/app/shell/section-sidebar.tsx
 *
 * WS-D. The left-hand navigation: the site, as a list.
 *
 * It renders whatever `SECTIONS` holds, in registry order, and it never writes
 * a section name. The row's glyph comes from `shape` and `storage`, the label
 * and the entry noun come from the `SectionDef`, the count and the draft dot
 * come from the `SectionSummary`. Add a sixth section to
 * `src/cms/sections.ts` and a sixth row appears here with no edit, which is
 * the property docs/cms-contracts.md 9 asks for.
 */

import { SECTIONS } from '../../sections.ts';
import type { SectionDef } from '../../sections.ts';
import type { SectionId } from '../../schema.ts';
import type { SectionSummary } from '../state/site-api.ts';
import type { SiteStore } from '../state/site-store.ts';

export type SectionSidebarProps = {
  store: SiteStore;
  /** One per section, in registry order. */
  sections: SectionSummary[];
  /** The section being looked at, or null on the overview. */
  current: SectionId | null;
};

/**
 * A one-character stand-in for an icon set this tool does not have. Keyed off
 * what the section *is*, never off its id: one entry, many documents, many
 * records.
 */
function glyphFor(section: SectionDef): string {
  if (section.shape === 'singleton') return '◆';
  return section.storage === 'records' ? '▦' : '¶';
}

/** 'One page', '3 projects', '4 films'. */
function describe(section: SectionDef, summary: SectionSummary | undefined): string {
  const noun = section.storage === 'records' && section.records !== null ? section.records.noun : section.noun;
  if (section.shape === 'singleton') return `one ${noun}`;
  const count = summary?.count ?? 0;
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/** The heading above a run of rows of the same kind, or null inside a run. */
function kindLabel(index: number): string | null {
  const section = SECTIONS[index] as SectionDef;
  const previous = index === 0 ? null : (SECTIONS[index - 1] as SectionDef);
  if (previous !== null && previous.storage === section.storage) return null;
  return section.storage === 'records' ? 'Collections' : 'Pages';
}

export function SectionSidebar({ store, sections, current }: SectionSidebarProps) {
  const byId = new Map(sections.map((summary) => [summary.id, summary]));

  return (
    <nav className="cms-nav" aria-label="Sections" data-testid="section-nav">
      {SECTIONS.map((section, index) => {
        const summary = byId.get(section.id);
        const label = kindLabel(index);
        const selected = current === section.id;
        return (
          <div key={section.id}>
            {label !== null && <div className="cms-nav__kind">{label}</div>}
            <button
              type="button"
              className={`cms-nav__row${selected ? ' cms-nav__row--current' : ''}`}
              data-testid={`section-row-${section.id}`}
              data-section={section.id}
              data-storage={section.storage}
              data-shape={section.shape}
              aria-current={selected ? 'page' : undefined}
              title={`${section.label} · ${describe(section, summary)} · ${section.indexUrl}`}
              onClick={() => store.openSection(section.id)}
            >
              <span className="cms-nav__glyph" aria-hidden="true">
                {glyphFor(section)}
              </span>
              <span className="cms-nav__label">{section.label}</span>
              {summary?.hasDraft === true && (
                <span
                  className="cms-nav__dot"
                  data-testid={`section-draft-${section.id}`}
                  title="Unpublished draft in this section"
                />
              )}
              <span className="cms-nav__count" data-testid={`section-count-${section.id}`}>
                {section.shape === 'singleton' ? '1' : String(summary?.count ?? 0)}
              </span>
            </button>
          </div>
        );
      })}
    </nav>
  );
}
