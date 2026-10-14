/**
 * src/cms/styles/verify-type-scale.ts
 *
 * The type scale's base numbers, checked against the stylesheets they were
 * copied from.
 *
 *   node src/cms/styles/verify-type-scale.ts
 *
 * ./type-scale.ts scales the site's running text from a table of base sizes.
 * Every number in that table is a copy of a declaration in global.css,
 * doc.css or SHELL_CSS, and a ratio computed against a stale base fails in
 * the quietest way there is: the text comes out a slightly different size
 * from the one that was asked for, on every page, and looks fine.
 *
 * So this reads the real stylesheets, finds the rule each role names, and
 * asserts the pair matches. Changing `body` to 18px in global.css then fails
 * HERE, with the role that needs updating, instead of skewing every scaled
 * page by 3%.
 *
 * It also asserts the two properties the design rests on:
 *
 *  1. Default settings generate NOTHING. A site that has not asked for a
 *     different size builds exactly what it built before this existed.
 *  2. A scaled section's rules out-specify the base rules they override.
 *     An override that loses the cascade is worse than no override: the
 *     editor would show one size and the page another.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SECTION_IDS } from '../schema.ts';
import type { SectionId } from '../schema.ts';
import { SHELL_CSS } from '../app/shell/styles.ts';
import { CALLOUT_CSS } from './callout.ts';
import {
  BODY_BASE_SIZE,
  DEFAULT_TYPE_SETTINGS,
  EDITOR_DIALECT,
  ROLE_BASE,
  SITE_DIALECT,
  TYPE_ROLES,
  effectiveSize,
  roundHalf,
  scaleRole,
  expandSelector,
  rolesFor,
  typeScaleCss,
} from './type-scale.ts';
import type { TypeRole } from './type-scale.ts';

const PROJECT = fileURLToPath(new URL('../../../', import.meta.url));

let passed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`);
}

/* -------------------------------------------------------------------------- */
/* Reading a declaration out of a stylesheet                                   */
/* -------------------------------------------------------------------------- */

const SOURCES: Record<string, string> = {
  'global.css': readFileSync(`${PROJECT}src/styles/global.css`, 'utf8'),
  'doc.css': readFileSync(`${PROJECT}src/cms/styles/doc.css`, 'utf8'),
  // Strings rather than files: these two ARE the stylesheet, and the editor
  // injects them directly.
  'SHELL_CSS': SHELL_CSS,
  'CALLOUT_CSS': CALLOUT_CSS,
};

/**
 * The font-size and line-height of the rule with exactly this selector list.
 *
 * `narrow` picks the copy inside the `max-width: 900px` block rather than
 * the one outside it, which is the whole reason this cannot be a naive
 * "first match": doc.css declares `.doc-quote` twice, and taking the wrong
 * one would have the phone scale computed from the desktop numbers.
 */
function declaration(
  css: string,
  selector: string,
  narrow: boolean,
): { size: number; leading: number } | null {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const phoneAt = clean.indexOf('@media (max-width: 900px)');
  const region =
    phoneAt < 0
      ? narrow
        ? ''
        : clean
      : narrow
        ? clean.slice(phoneAt)
        : clean.slice(0, phoneAt);

  // Every rule in the region, selector list normalised to single spaces so
  // a multi-line selector list matches a single-line one.
  const blocks = region.match(/[^{}]+\{[^{}]*\}/g) ?? [];
  for (const block of blocks) {
    const cut = block.indexOf('{');
    const head = block.slice(0, cut).trim().replace(/\s+/g, ' ');
    const parts = head.split(',').map((part) => part.trim().replace(/\s+/g, ' '));
    if (!parts.includes(selector)) continue;
    const body = block.slice(cut + 1);
    const size = /font-size:\s*([\d.]+)px/.exec(body);
    const leading = /line-height:\s*([\d.]+)px/.exec(body);
    if (size === null) continue;
    return { size: Number(size[1]), leading: leading === null ? NaN : Number(leading[1]) };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* 1. Every base value is what the stylesheet says                             */
/* -------------------------------------------------------------------------- */

/**
 * One row per (role, dialect, width): the selector that is expected to carry
 * the role's base pair, and the file expected to declare it.
 *
 * Only ONE selector per role is checked, not all of them. The others are
 * alternative names for the same rule (`.pb-quote` beside `.doc-quote`) and
 * checking each would say the same thing four times; the one checked is the
 * one the role's numbers were taken from.
 */
const WITNESS: { role: TypeRole; selector: string; file: string; narrow: boolean }[] = [
  { role: 'body', selector: 'body', file: 'global.css', narrow: false },
  { role: 'body', selector: 'body', file: 'global.css', narrow: true },
  { role: 'body', selector: '.doc', file: 'doc.css', narrow: false },
  { role: 'body', selector: '.doc', file: 'doc.css', narrow: true },
  { role: 'quote', selector: '.doc-quote', file: 'doc.css', narrow: false },
  { role: 'quote', selector: '.doc-quote', file: 'doc.css', narrow: true },
  { role: 'quote', selector: '.pb-quote', file: 'global.css', narrow: false },
  { role: 'quote-essays', selector: ".doc--essays .doc-quote", file: 'doc.css', narrow: false },
  { role: 'quote-essays', selector: ".doc--essays .doc-quote", file: 'doc.css', narrow: true },
  { role: 'callout', selector: '.doc-callout', file: 'CALLOUT_CSS', narrow: false },
  // The editor's mirror of the same four.
  { role: 'body', selector: '.cms-surface', file: 'SHELL_CSS', narrow: false },
  { role: 'quote', selector: '.cms-surface blockquote', file: 'SHELL_CSS', narrow: false },
  { role: 'quote-essays', selector: '.cms-surface--essays blockquote', file: 'SHELL_CSS', narrow: false },
];

for (const { role, selector, file, narrow } of WITNESS) {
  const which = narrow ? 'narrow' : 'wide';
  const expected = ROLE_BASE[role][which];
  const found = declaration(SOURCES[file], selector, narrow);
  const where = `${file} ${narrow ? '(phone) ' : ''}${selector}`;
  if (found === null) {
    check(
      `${role}: ${where} declares a size`,
      false,
      'no such rule. The selector moved, or the rule lost its font-size; ' +
        'src/cms/styles/type-scale.ts is scaling from a number nothing uses.',
    );
    continue;
  }
  check(
    `${role} ${which}: ${where} is ${expected.size}/${expected.leading}`,
    found.size === expected.size && found.leading === expected.leading,
    `the stylesheet says ${found.size}/${found.leading}`,
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Default settings generate nothing                                        */
/* -------------------------------------------------------------------------- */

const sections = SECTION_IDS as readonly SectionId[];

check(
  'default settings generate no site CSS at all',
  typeScaleCss(DEFAULT_TYPE_SETTINGS, sections, SITE_DIALECT) === '',
  JSON.stringify(typeScaleCss(DEFAULT_TYPE_SETTINGS, sections, SITE_DIALECT)).slice(0, 120),
);
check(
  'and no editor CSS either',
  typeScaleCss(DEFAULT_TYPE_SETTINGS, sections, EDITOR_DIALECT) === '',
);
check(
  'a section explicitly set to the base size is still left alone',
  typeScaleCss({ size: BODY_BASE_SIZE, sections: { essays: BODY_BASE_SIZE } }, sections, SITE_DIALECT) === '',
);

/* -------------------------------------------------------------------------- */
/* 3. Scoping: only what was asked for                                         */
/* -------------------------------------------------------------------------- */

{
  const only = { size: BODY_BASE_SIZE, sections: { essays: 16 } };
  const css = typeScaleCss(only, sections, SITE_DIALECT);
  check('one section scaled mentions that section', css.includes("body[data-section='essays']"));
  for (const section of sections.filter((id) => id !== 'essays')) {
    check(`and does not mention ${section}`, !css.includes(`body[data-section='${section}']`));
  }
  check('the whole document body is covered', css.includes("body[data-section='essays'] .doc"));
  check(
    'an essay gets the essay quote and not the pull quote',
    css.includes(".doc--essays .doc-quote") && !css.includes("body[data-section='essays'] .pb-quote"),
  );
  const projects = typeScaleCss({ size: BODY_BASE_SIZE, sections: { projects: 16 } }, sections, SITE_DIALECT);
  check(
    'and a project gets the pull quote and not the essay one',
    projects.includes(".pb-quote") && !projects.includes('.doc--essays'),
  );
  check('and so is the phone half', css.includes('@media (max-width: 900px)'));

  const everywhere = typeScaleCss({ size: 16, sections: {} }, sections, SITE_DIALECT);
  for (const section of sections) {
    check(`a global change reaches ${section}`, everywhere.includes(`body[data-section='${section}']`));
  }

  const excluded = typeScaleCss({ size: 16, sections: { home: BODY_BASE_SIZE } }, sections, SITE_DIALECT);
  check(
    'a section put back to the base size is excluded from a global change',
    !excluded.includes("body[data-section='home']"),
  );
  check('while the others still get it', excluded.includes("body[data-section='essays']"));
}

/* -------------------------------------------------------------------------- */
/* 4. The override wins the cascade                                            */
/* -------------------------------------------------------------------------- */

/**
 * Specificity, counted rather than argued about.
 *
 * An override that does not out-specify the rule it overrides is worse than
 * no override at all: it would apply in one place and not another, and the
 * editor and the page would disagree about the size of the words.
 */
function specificity(selector: string): [number, number, number] {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes =
    (selector.match(/\.[\w-]+/g) ?? []).length +
    (selector.match(/\[[^\]]+\]/g) ?? []).length +
    (selector.match(/:[\w-]+(?!\()/g) ?? []).length;
  const elements = (selector.replace(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g, '').match(/\b[a-z]+\b/g) ?? []).length;
  return [ids, classes, elements];
}

function beats(a: string, b: string): boolean {
  const x = specificity(a);
  const y = specificity(b);
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  // A tie is fine: the override stylesheet is loaded last, so source order
  // decides and it is the later one.
  return true;
}

for (const dialect of [SITE_DIALECT, EDITOR_DIALECT]) {
  const name = dialect === SITE_DIALECT ? 'site' : 'editor';
  for (const section of sections) {
    const scope = dialect.scope(section);
    for (const role of rolesFor(section)) {
      for (const selector of dialect.wide[role]) {
        const scoped = expandSelector(selector, scope);
        // The base selector is the role's own, with `&` meaning the element
        // the scope names: on the page that is `body`, in the editor the
        // surface.
        const base = selector === '&' ? (dialect === SITE_DIALECT ? 'body' : '.cms-surface') : selector;
        check(
          `${name}/${section}: "${scoped}" beats "${base}"`,
          beats(scoped, base),
          `${specificity(scoped).join(',')} vs ${specificity(base).join(',')}`,
        );
      }
    }
  }
}

/*
 * The selector that matches nothing.
 *
 * The first version of the generator joined every role's selector to the
 * scope with a descendant combinator, including the one that IS the scope,
 * producing `body[data-section='essays'] body` and
 * `.cms-surface--essays .cms-surface`. Both are valid CSS. Neither can ever
 * match an element, so the rule was simply inert and the text did not move.
 *
 * `&` fixed it; this is what stops it coming back. Nothing generated here
 * may name `body` or `.cms-surface` twice, or name its own scope twice.
 */
{
  const everything = sections
    .flatMap((section) => [
      typeScaleCss({ size: 16, sections: {} }, [section], SITE_DIALECT),
      typeScaleCss({ size: 16, sections: {} }, [section], EDITOR_DIALECT),
    ])
    .join('\n');
  const selectors = everything
    .split('\n')
    .filter((line) => line.includes('{') === false && line.trim() !== '' && !line.trim().startsWith('/*') && !line.includes(':'))
    .map((line) => line.replace(/,$/, '').trim())
    .filter((line) => line !== '');
  check('the generator produced selectors to look at', selectors.length > 0, String(selectors.length));
  const doubled = selectors.filter(
    (selector) =>
      / body\b/.test(selector) ||
      (selector.match(/\.cms-surface(?![\w-])/g) ?? []).length +
        (selector.match(/\.cms-surface--/g) ?? []).length >
        1,
  );
  check(
    'no selector is nested inside the element it already names',
    doubled.length === 0,
    doubled.join(' | '),
  );
}

/* -------------------------------------------------------------------------- */
/* 5. The arithmetic                                                           */
/* -------------------------------------------------------------------------- */

check('the base size is the one the stylesheets are written at', BODY_BASE_SIZE === 17.5);
check('scaling to the base size changes nothing', scaleRole('quote', BODY_BASE_SIZE, 'wide').size === 26);
check('half pixels survive', roundHalf(17.4) === 17.5 && roundHalf(17.3) === 17.5);
check('and nothing finer does', roundHalf(23.771428) === 24, String(roundHalf(23.771428)));

{
  // 16/17.5 = 0.9142857…
  const at16 = Object.fromEntries(
    TYPE_ROLES.map((role) => [role, scaleRole(role, 16, 'wide')]),
  );
  check('body 17.5 → 16', at16.body.size === 16 && at16.body.leading === 32, JSON.stringify(at16.body));
  check('pull quote 26/40 → 24/36.5', at16.quote.size === 24 && at16.quote.leading === 36.5, JSON.stringify(at16.quote));
  check('essay quote follows body', at16['quote-essays'].size === 16, JSON.stringify(at16['quote-essays']));
  check('callout 16/28 → 14.5/25.5', at16.callout.size === 14.5 && at16.callout.leading === 25.5, JSON.stringify(at16.callout));
  // The leading ratio is what stops a smaller size reading loose.
  check('leading scales with the size, not with nothing', at16.body.leading / at16.body.size < 2.01);
}

check('an unset section inherits the site size', effectiveSize({ size: 16, sections: {} }, 'essays') === 16);
check('a set one does not', effectiveSize({ size: 16, sections: { essays: 15 } }, 'essays') === 15);

/* -------------------------------------------------------------------------- */

console.log(
  `${passed} checks passed: ${WITNESS.length} base values confirmed against the stylesheets, ` +
    `${TYPE_ROLES.length} roles, ${sections.length} sections`,
);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  process.exitCode = 1;
}
