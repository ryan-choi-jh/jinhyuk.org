/**
 * src/cms/styles/type-scale.ts
 *
 * The body size, as something the CMS can change.
 *
 * ---------------------------------------------------------------------------
 * WHAT "BODY SIZE" ACTUALLY IS
 * ---------------------------------------------------------------------------
 *
 * One number, in one place: `body { font-size: 17.5px; line-height: 35px }`
 * in src/styles/global.css. Everything you read at length on this site
 * inherits it — `article p`, `article ul`, `article ol`,
 * `article blockquote` and `.intro p` declare no size at all — so the whole
 * reading experience hangs off that one declaration.
 *
 * Four rules then restate a size of their own, and those are the ones that
 * would NOT move if you only changed `body`:
 *
 *   .doc                       17.5 / 35   a CMS document, same as body
 *   .doc-quote / .pb-quote     26 / 40     a project's pull quote
 *   .doc--essays .doc-quote    17.5 / 35   an essay's quote is not a pull quote
 *   .doc-callout               16 / 28     the tinted aside
 *
 * Plus the phone half of each, under `max-width: 900px`, where body steps to
 * 14 / 24.
 *
 * Headings are deliberately NOT in that list. They are the hierarchy, not the
 * reading, and holding them while body text shrinks is a design decision
 * rather than an omission.
 *
 * ---------------------------------------------------------------------------
 * WHY AN OVERRIDE STYLESHEET AND NOT AN EDIT TO global.css
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation is to replace those numbers with custom
 * properties and have the CMS set them. It is also the one that cannot be
 * verified: global.css is a hand-maintained design file, every page on the
 * site depends on it, and "the CMS now writes into the stylesheet" is a much
 * larger promise than "the CMS can make text smaller".
 *
 * So nothing here edits anything. This generates an ADDITIVE stylesheet that
 * restates the scaled values, scoped to the sections that asked for them, and
 * loaded after the base CSS. Two consequences worth having:
 *
 *  - WITH NO OVERRIDES IT IS THE EMPTY STRING, so a site with default type
 *    builds byte-for-byte what it built before this existed. That is a
 *    property a test can assert, and src/cms/styles/verify-type-scale.ts
 *    does.
 *  - A section that is left alone is genuinely untouched. Not "set back to
 *    the same number" — not mentioned at all.
 *
 * ---------------------------------------------------------------------------
 * THE TABLE IS CHECKED AGAINST THE STYLESHEETS
 * ---------------------------------------------------------------------------
 *
 * Every base value below is a copy of a number in global.css, doc.css or
 * SHELL_CSS, and a scale computed from a stale base is wrong in a way nobody
 * would notice: the text would simply be a slightly different size from the
 * one asked for. `verify-type-scale.ts` reads all three files and asserts
 * every row matches what they really declare, so changing 17.5 in global.css
 * fails a check here rather than quietly skewing every scaled page.
 */

import { TYPE_SIZE_MAX, TYPE_SIZE_MIN } from '../schema.ts';
import type { SectionId } from '../schema.ts';

/* -------------------------------------------------------------------------- */
/* The roles                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The four kinds of running text, as roles rather than selectors, because
 * the site and the editor name the same things differently and the SCALE is
 * the thing they have to agree on.
 */
export type TypeRole = 'body' | 'quote' | 'quote-essays' | 'callout';

export const TYPE_ROLES: readonly TypeRole[] = ['body', 'quote', 'quote-essays', 'callout'];

export type SizePair = { size: number; leading: number };

/** What each role is at the design's own body size, wide and narrow. */
export const ROLE_BASE: Readonly<Record<TypeRole, { wide: SizePair; narrow: SizePair }>> = {
  // global.css `body`, doc.css `.doc`. The one everything inherits.
  body: { wide: { size: 17.5, leading: 35 }, narrow: { size: 14, leading: 24 } },
  // doc.css `.doc-quote`, global.css `.pb-quote`. A project's pull quote.
  quote: { wide: { size: 26, leading: 40 }, narrow: { size: 14, leading: 24 } },
  // doc.css `.doc--essays .doc-quote`. An essay quotes at reading size.
  'quote-essays': { wide: { size: 17.5, leading: 35 }, narrow: { size: 14, leading: 24 } },
  // doc.css `.doc-callout`, from styles/callout.ts. No narrow rule exists.
  callout: { wide: { size: 16, leading: 28 }, narrow: { size: 16, leading: 28 } },
};

/** The body size the stylesheets are written at. Every ratio is against this. */
export const BODY_BASE_SIZE = ROLE_BASE.body.wide.size;

/**
 * What the control allows, from the schema that enforces it.
 *
 * Re-exported rather than restated: a slider whose bounds are not the
 * validator's bounds is a slider that can produce a value the server
 * refuses, and the author finds out at save time.
 */
export const BODY_SIZE_MIN = TYPE_SIZE_MIN;
export const BODY_SIZE_MAX = TYPE_SIZE_MAX;
export const BODY_SIZE_STEP = 0.5;

/* -------------------------------------------------------------------------- */
/* The two dialects                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Which selectors carry a role, on the published page and in the editor.
 *
 * They differ because the editor does not load doc.css: SHELL_CSS mirrors
 * those rules onto the surface's own class names (see cms/AGENTS.md on the
 * mirrored-CSS pattern). The ROLE is what makes them one thing.
 *
 * `scope` is what a per-section rule is prefixed with. On the page that is
 * `body[data-section='…']`, put there by Base.astro, which works for every
 * page including the ones that are not documents. In the editor it is the
 * surface's own section modifier.
 */
export type Dialect = {
  scope: (section: SectionId) => string;
  wide: Readonly<Record<TypeRole, readonly string[]>>;
  narrow: Readonly<Record<TypeRole, readonly string[]>>;
  /** Whether this dialect has a phone half at all. The editor does not. */
  hasNarrow: boolean;
};

/**
 * `&` is the scoped element ITSELF, not a descendant of it.
 *
 * It is here because the first version of this generated
 * `body[data-section='essays'] body`, which matches nothing: a body inside a
 * body does not exist. The same mistake in the editor dialect produced
 * `.cms-surface--essays .cms-surface`, equally empty. Both looked perfectly
 * reasonable in the source and silently styled nothing.
 */
const SELF = '&';

function expand(selector: string, scope: string): string {
  return selector === SELF ? scope : `${scope} ${selector}`;
}

export const SITE_DIALECT: Dialect = {
  scope: (section) => `body[data-section='${section}']`,
  wide: {
    // The body itself, and `.doc`, which restates it for a CMS document.
    body: [SELF, '.doc'],
    quote: ['.doc-quote', '.pb-quote'],
    'quote-essays': ['.doc--essays .doc-quote'],
    callout: ['.doc-callout'],
  },
  narrow: {
    body: [SELF, '.doc'],
    quote: ['.doc-quote'],
    // doc.css names the paragraph inside it too, so both are restated.
    'quote-essays': ['.doc--essays .doc-quote', '.doc--essays .doc-quote p'],
    callout: [],
  },
  hasNarrow: true,
};

export const EDITOR_DIALECT: Dialect = {
  // The surface already carries its section, which is how an essay's quote
  // is drawn differently from a project's in the middle pane.
  scope: (section) => `.cms-surface--${section}`,
  wide: {
    // The surface IS the body: paragraphs and list items inherit from it.
    body: [SELF],
    quote: ['blockquote'],
    'quote-essays': ['blockquote'],
    // Injected from styles/callout.ts, in the editor and on the page alike,
    // and the live editing surface for a callout block is the second one.
    callout: ['.doc-callout', ".pe-root[data-prose-kind='callout'] .pe-content"],
  },
  narrow: { body: [], quote: [], 'quote-essays': [], callout: [] },
  hasNarrow: false,
};

/**
 * Which roles a section has.
 *
 * An essay's quote and a project's pull quote are the SAME ELEMENT styled two
 * ways — `.doc-quote` at 26/40, narrowed to 17.5/35 by `.doc--essays` — so a
 * section has one or the other, never both. Emitting both would put two rules
 * of equal weight on one element and let source order decide which size a
 * quote came out at.
 *
 * Only essays are set the essay way. A home document carries no `doc--`
 * modifier at all and therefore takes the pull quote, exactly as it does on
 * the live site today.
 */
export function rolesFor(section: SectionId): readonly TypeRole[] {
  return ['body', section === 'essays' ? 'quote-essays' : 'quote', 'callout'];
}

/* -------------------------------------------------------------------------- */
/* The settings                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What the CMS stores, in src/content/data/type.json.
 *
 * `size` is the site-wide body size; `sections` holds the ones that differ.
 * A section that is not a key here inherits `size` — which is why applying
 * globally and applying to a selection are the same operation with different
 * arguments, rather than two code paths.
 */
export type TypeSettings = {
  size: number;
  sections: Partial<Record<SectionId, number>>;
};

/** Settings from a site chrome that may not carry any. */
export function typeSettingsOf(carrier: { type?: TypeSettings } | null | undefined): TypeSettings {
  return carrier?.type ?? DEFAULT_TYPE_SETTINGS;
}

export const DEFAULT_TYPE_SETTINGS: TypeSettings = { size: BODY_BASE_SIZE, sections: {} };

/** The body size a section actually renders at. */
export function effectiveSize(settings: TypeSettings, section: SectionId): number {
  return settings.sections[section] ?? settings.size;
}

/** True when this section is drawn at anything other than the design's own size. */
export function isScaled(settings: TypeSettings, section: SectionId): boolean {
  return effectiveSize(settings, section) !== BODY_BASE_SIZE;
}

/* -------------------------------------------------------------------------- */
/* The arithmetic                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Half-pixel steps.
 *
 * Not whole pixels: body is 17.5 and a scale that cannot express a half
 * cannot express the size the site is already set at. Not full precision
 * either — 23.771428571428572px in a stylesheet is noise, and two numbers
 * that differ in the eighth decimal place look like a bug when you read the
 * generated CSS.
 */
export function roundHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

/** What one role becomes at a given body size. */
export function scaleRole(role: TypeRole, size: number, which: 'wide' | 'narrow'): SizePair {
  const base = ROLE_BASE[role][which];
  const ratio = size / BODY_BASE_SIZE;
  return { size: roundHalf(base.size * ratio), leading: roundHalf(base.leading * ratio) };
}

/**
 * Every role at a given body size, for showing someone what they are about
 * to do. Ordered as the table at the top of this file.
 */
export function scalePreview(size: number): { role: TypeRole; from: SizePair; to: SizePair }[] {
  return TYPE_ROLES.map((role) => ({
    role,
    from: ROLE_BASE[role].wide,
    to: scaleRole(role, size, 'wide'),
  }));
}

/** What the panel calls each role. */
export const ROLE_LABEL: Readonly<Record<TypeRole, string>> = {
  body: 'Paragraphs and lists',
  quote: 'Pull quote',
  'quote-essays': 'Essay quote',
  callout: 'Callout',
};

/* -------------------------------------------------------------------------- */
/* The stylesheet                                                              */
/* -------------------------------------------------------------------------- */

function rules(selectors: readonly string[], scope: string, pair: SizePair, indent: string): string[] {
  if (selectors.length === 0) return [];
  const head = selectors.map((selector) => `${indent}${expand(selector, scope)}`).join(',\n');
  return [
    `${head} {`,
    `${indent}  font-size: ${pair.size}px;`,
    `${indent}  line-height: ${pair.leading}px;`,
    `${indent}}`,
  ];
}

/** One section's block, or nothing at all when it is at the design's size. */
function sectionCss(settings: TypeSettings, section: SectionId, dialect: Dialect): string {
  const size = effectiveSize(settings, section);
  if (size === BODY_BASE_SIZE) return '';

  const roles = rolesFor(section);
  const wide: string[] = [];
  for (const role of roles) {
    wide.push(...rules(dialect.wide[role], dialect.scope(section), scaleRole(role, size, 'wide'), ''));
  }
  if (wide.length === 0) return '';

  const out = [`/* ${section} — body ${size}px */`, ...wide];

  if (dialect.hasNarrow) {
    const narrow: string[] = [];
    for (const role of roles) {
      narrow.push(...rules(dialect.narrow[role], dialect.scope(section), scaleRole(role, size, 'narrow'), '  '));
    }
    if (narrow.length > 0) out.push('@media (max-width: 900px) {', ...narrow, '}');
  }

  return out.join('\n');
}

/**
 * The whole override stylesheet.
 *
 * EMPTY when every section is at the design's own size, which is the
 * property that makes this safe: a site that has not asked for anything
 * builds exactly what it built before.
 */
export function typeScaleCss(
  settings: TypeSettings,
  sections: readonly SectionId[],
  dialect: Dialect,
): string {
  return sections
    .map((section) => sectionCss(settings, section, dialect))
    .filter((block) => block !== '')
    .join('\n\n');
}

/** A role's selector resolved against a scope. Exported for the checks. */
export function expandSelector(selector: string, scope: string): string {
  return expand(selector, scope);
}

export const TYPE_SCALE_STYLE_ID = 'cms-type-scale';
