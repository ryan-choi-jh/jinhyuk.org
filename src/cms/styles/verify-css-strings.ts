/**
 * src/cms/styles/verify-css-strings.ts
 *
 * The backtick trap, caught where it happens instead of where it explodes.
 *
 *   node src/cms/styles/verify-css-strings.ts
 *
 * Several modules ship CSS as a TypeScript template literal. Inside one, a
 * backtick ENDS the string, and the natural way to write a CSS comment is
 * to quote a token in backticks:
 *
 *   `/* the `--rule` token *\/`
 *
 * This has now happened SEVEN times in this codebase, twice in one sitting,
 * including immediately after the rule against it was written down in
 * cms/AGENTS.md. Writing it down is evidently not a control.
 *
 * The build does catch it, which is not the problem. The problem is the
 * error: esbuild reports `Expected ";" but found "flex"` at a line far from
 * the cause, inside what it now thinks is code, and the comment that broke
 * it looks completely innocent. Ten minutes go on reading the wrong file.
 *
 * So this says it plainly, with the line, and runs in the offline group
 * where it costs nothing.
 *
 * It reads the files as TEXT rather than importing them, which is the whole
 * point: when this trap is sprung the module does not parse, so anything
 * that imports it fails the same unintelligible way.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROJECT = fileURLToPath(new URL('../../../', import.meta.url));

/** Every module that exports CSS as a template literal. */
const FILES = [
  'src/cms/styles/highlight.ts',
  'src/cms/styles/callout.ts',
  'src/cms/styles/spacing.ts',
  'src/cms/app/shell/styles.ts',
  'src/cms/app/shell/site-styles.ts',
  'src/cms/app/prose/css.ts',
  'src/cms/app/records/styles.ts',
  'src/cms/app/library/styles.ts',
  'src/cms/app/guide/styles.ts',
  'src/cms/app/chrome/styles.ts',
  'src/cms/app/integration/styles.ts',
  'src/cms/app/prose/palette.ts',
];

let passed = 0;
const failures: string[] = [];

/**
 * Unbalanced braces inside a CSS template literal, with the line.
 *
 * Only the part between the first backtick and the last is considered, so
 * the module's own TypeScript braces are not counted. Rough, and rough is
 * enough: the failure being guarded against is one brace too many or too
 * few, which moves the count off zero.
 */
function braceTrouble(text: string): string | null {
  const first = text.indexOf('= `');
  if (first < 0) return null;
  // The FIRST close after the open, not the last in the file. These
  // modules often have ordinary template literals further down — palette.ts
  // builds hex strings with them — and reaching to the last one slices in
  // a few hundred lines of TypeScript whose braces are nothing to do with
  // the CSS. That reported a perfectly balanced file as broken.
  const last = text.indexOf('`;', first + 3);
  if (last <= first) return null;
  const css = text.slice(first + 3, last);
  let depth = 0;
  let line = text.slice(0, first).split('\n').length;
  for (const ch of css) {
    if (ch === '\n') line += 1;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth < 0) {
        return `line ${line}: a closing brace with nothing open. Everything after it is dropped by the CSS parser.`;
      }
    }
  }
  if (depth !== 0) {
    return `${depth} block(s) left open in the CSS. Everything after the unclosed one is swallowed by it.`;
  }
  return null;
}

/**
 * A line that is part of a CSS comment.
 *
 * Inside a CSS string the comments are the ones written `/* … *\/`, and the
 * continuation lines of a block comment start with text rather than `*`,
 * so both shapes are checked. A TypeScript line comment (`//`) or a JSDoc
 * line (` * `) ABOVE the template is not in the string and is allowed to
 * contain backticks — which is why this tracks whether it is inside one.
 */
function offendingLines(text: string): { line: number; content: string }[] {
  const lines = text.split('\n');
  const out: { line: number; content: string }[] = [];

  let inTemplate = false;
  let inCssComment = false;

  lines.forEach((line, index) => {
    // Count the backticks that open or close a template literal. A line
    // with one flips the state; this is a heuristic and it only has to be
    // right about the CSS modules, where a template spans many lines.
    const ticks = (line.match(/`/g) ?? []).length;

    if (inTemplate) {
      const opens = line.includes('/*');
      const closes = line.includes('*/');
      const commentHere = inCssComment || opens;
      if (commentHere && ticks > 0) {
        out.push({ line: index + 1, content: line.trim() });
      }
      if (opens && !closes) inCssComment = true;
      if (closes) inCssComment = false;
    }

    if (ticks % 2 === 1) {
      inTemplate = !inTemplate;
      if (!inTemplate) inCssComment = false;
    }
  });

  return out;
}

/**
 * Does this module build its CSS as a template literal at all?
 *
 * Several build theirs from an array of single-quoted strings joined with
 * newlines, which cannot spring this trap: a backtick inside '...' is just
 * a backtick. Counting those as "clean" would overstate what this proves,
 * so they are counted separately.
 */
function hasTemplate(text: string): boolean {
  return /=\s*`/.test(text);
}

let immune = 0;

for (const file of FILES) {
  let text: string;
  try {
    text = readFileSync(`${PROJECT}${file}`, 'utf8');
  } catch {
    failures.push(`${file}: listed here but not on disk. Remove it or fix the path.`);
    continue;
  }
  if (!hasTemplate(text)) {
    immune += 1;
    continue;
  }
  // Braces, before anything else. A stray or missing one is silent: the
  // string still builds, the editor still boots, and every rule after the
  // bad brace is dropped. That happened while writing this file's sibling
  // and the symptoms were three panes at full width and a "desktop only"
  // notice on a 1600px screen, which looks like anything except a brace.
  const unbalanced = braceTrouble(text);
  if (unbalanced !== null) {
    failures.push(`${file}: ${unbalanced}`);
    continue;
  }

  const found = offendingLines(text);
  if (found.length === 0) {
    passed += 1;
    continue;
  }
  for (const { line, content } of found) {
    failures.push(
      `${file}:${line}\n` +
        `      A backtick inside a CSS comment ENDS the template literal.\n` +
        `      ${content}\n` +
        `      Drop the backticks; the build error for this points somewhere else entirely.`,
    );
  }
}

console.log(
  `${passed} CSS template literals are clean; ` +
    `${immune} build their CSS from an array and cannot spring this trap`,
);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  process.exitCode = 1;
}
