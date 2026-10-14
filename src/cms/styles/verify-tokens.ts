/**
 * src/cms/styles/verify-tokens.ts
 *
 * The editor's copy of the site's design tokens, checked against the site.
 *
 *   node src/cms/styles/verify-tokens.ts
 *
 * ./tokens.ts carries a copy of global.css's `:root` and
 * `:root[data-theme='dark']` custom properties, because the CMS route cannot
 * load that stylesheet (see the long comment at the top of that file). A copy
 * that nothing checks is a copy that goes stale, and the failure mode is
 * silent: a var() resolves to its fallback and the page in the editor is a
 * slightly different colour from the page on the site, which is exactly the
 * class of bug the whole mirrored-CSS discipline exists to stop.
 *
 * So this reads the real stylesheet and asserts, in both directions:
 *
 *   1. every token global.css declares at `:root` is in the table
 *   2. with the same value
 *   3. every token global.css overrides for dark is in the table
 *   4. with the same dark value
 *   5. a token global.css does NOT override for dark has the same value in
 *      both columns here, so nothing silently invents a dark variant
 *   6. the table has nothing global.css does not
 *
 * And then that the generated CSS actually contains them, so a mistake in
 * the generator is caught as well as a mistake in the table.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SITE_TOKENS, SITE_TOKENS_CSS, themedTokens } from './tokens.ts';

const PROJECT = fileURLToPath(new URL('../../../', import.meta.url));
const GLOBAL_CSS = 'src/styles/global.css';

const failures: string[] = [];
let passed = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`);
}

/* -------------------------------------------------------------------------- */
/* Reading the real stylesheet                                                 */
/* -------------------------------------------------------------------------- */

const css = readFileSync(`${PROJECT}${GLOBAL_CSS}`, 'utf8');

/**
 * The body of the first rule with this exact selector.
 *
 * Crude on purpose: these two blocks contain nothing but declarations, so
 * the first `}` after the opening brace is the end of the block. A real CSS
 * parser here would be a dependency to read nineteen lines.
 */
function blockBody(selector: string): string | null {
  const open = css.indexOf(`${selector} {`);
  if (open < 0) return null;
  const close = css.indexOf('}', open);
  if (close < 0) return null;
  return css.slice(open + selector.length + 2, close);
}

/** The custom properties declared in a block, with comments stripped. */
function customProperties(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const match = /^(--[a-z0-9-]+)\s*:\s*([^;]+);/.exec(line);
    if (match !== null) out.set(match[1], match[2].trim());
  }
  return out;
}

const lightBody = blockBody(':root');
const darkBody = blockBody(":root[data-theme='dark']");

if (lightBody === null || darkBody === null) {
  console.log(
    `  FAIL  ${GLOBAL_CSS} has no ${lightBody === null ? ':root' : ":root[data-theme='dark']"} block. ` +
      'The selectors moved; this check and src/cms/styles/tokens.ts both need updating.',
  );
  process.exit(1);
}

const light = customProperties(lightBody);
const dark = customProperties(darkBody);

check(`${GLOBAL_CSS} declares tokens at :root`, light.size > 0, `${light.size} found`);
check(`${GLOBAL_CSS} overrides tokens for dark`, dark.size > 0, `${dark.size} found`);

/* -------------------------------------------------------------------------- */
/* 1, 2, 6: the light column                                                   */
/* -------------------------------------------------------------------------- */

for (const [name, value] of light) {
  const mirrored = SITE_TOKENS[name];
  if (mirrored === undefined) {
    check(
      `${name} is mirrored`,
      false,
      `declared in ${GLOBAL_CSS} and missing from src/cms/styles/tokens.ts. ` +
        `Any var(${name}) in the editor silently falls back.`,
    );
    continue;
  }
  check(`${name} light value matches`, mirrored.light === value, `site ${value}, editor ${mirrored.light}`);
}

for (const name of Object.keys(SITE_TOKENS)) {
  check(
    `${name} exists on the site`,
    light.has(name),
    `in src/cms/styles/tokens.ts and not in ${GLOBAL_CSS}. Either it was removed there, or it was invented here.`,
  );
}

/* -------------------------------------------------------------------------- */
/* 3, 4, 5: the dark column                                                    */
/* -------------------------------------------------------------------------- */

for (const [name, value] of dark) {
  const mirrored = SITE_TOKENS[name];
  if (mirrored === undefined) continue; // already reported above
  check(`${name} dark value matches`, mirrored.dark === value, `site ${value}, editor ${mirrored.dark}`);
}

for (const name of Object.keys(SITE_TOKENS)) {
  if (dark.has(name)) continue;
  const mirrored = SITE_TOKENS[name];
  check(
    `${name} does not move in the dark, here either`,
    mirrored.light === mirrored.dark,
    `${GLOBAL_CSS} gives it one value (${mirrored.light}); the editor flips it to ${mirrored.dark}.`,
  );
}

/* -------------------------------------------------------------------------- */
/* The generated CSS                                                           */
/* -------------------------------------------------------------------------- */

check(
  'the generated CSS opens with :root',
  SITE_TOKENS_CSS.startsWith(':root {'),
  SITE_TOKENS_CSS.slice(0, 20),
);
check(
  'and carries the dark branch on the same selector the site uses',
  SITE_TOKENS_CSS.includes(":root[data-theme='dark'] {"),
);

for (const [name, values] of Object.entries(SITE_TOKENS)) {
  check(`the CSS declares ${name}`, SITE_TOKENS_CSS.includes(`  ${name}: ${values.light};`));
}
for (const name of themedTokens()) {
  const afterDark = SITE_TOKENS_CSS.slice(SITE_TOKENS_CSS.indexOf("[data-theme='dark']"));
  check(`the dark branch redeclares ${name}`, afterDark.includes(`  ${name}: ${SITE_TOKENS[name].dark};`));
}

// A token that does not move must NOT appear in the dark branch: repeating it
// is how the two copies start disagreeing.
{
  const afterDark = SITE_TOKENS_CSS.slice(SITE_TOKENS_CSS.indexOf("[data-theme='dark']"));
  const themed = new Set(themedTokens());
  for (const name of Object.keys(SITE_TOKENS)) {
    if (themed.has(name)) continue;
    check(`the dark branch leaves ${name} alone`, !afterDark.includes(`  ${name}:`));
  }
}

// Balanced, for the same reason verify-css-strings.ts counts braces: an
// unclosed block swallows everything after it and nothing says so.
{
  let depth = 0;
  for (const ch of SITE_TOKENS_CSS) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
  }
  check('the generated CSS is balanced', depth === 0, `${depth} block(s) left open`);
}

/* -------------------------------------------------------------------------- */

console.log(
  `${passed} checks passed: ${Object.keys(SITE_TOKENS).length} tokens mirrored from ${GLOBAL_CSS}, ` +
    `${themedTokens().length} of them themed`,
);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  process.exitCode = 1;
}
