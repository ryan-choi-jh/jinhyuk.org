/**
 * src/cms/app/shell/verify-typography.mjs
 *
 * Does the editor set prose the way the published page does?
 *
 *   node src/cms/app/shell/verify-typography.mjs
 *
 * The editor draws the page in the middle of the screen, and the whole point
 * of that is that it looks like the page. But the two typographies live in
 * different files — doc.css for the page, SHELL_CSS for the editor — and they
 * have drifted twice:
 *
 *   - every heading was 56/4 in the editor against the page's 48/8, because
 *     the numbers were taken from global.css's article rules rather than the
 *     doc ones;
 *   - every quote was drawn the project way, 26px behind an accent rule, so a
 *     TL;DR at the top of an essay came out half as large again as the page
 *     shows it. That is the one that got noticed, because it is the first
 *     thing on the page.
 *
 * So: the same document, rendered twice in one browser — once as the page
 * with doc.css, once inside the editor's surface with SHELL_CSS — and the
 * COMPUTED styles compared. Computed, not declared: a regex over two
 * stylesheets was tried first and could not tell a rule inside a media query
 * from one outside it, which is exactly the kind of wrong answer a test must
 * not give.
 *
 * Both sections, because they are set differently and the bug was that the
 * editor did not know the difference.
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';

const REPO = new URL('../../../../', import.meta.url).pathname;

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((path) => existsSync(path));

const PLAYWRIGHT = `${process.env.HOME}/.claude/skills/gstack/node_modules/playwright/index.mjs`;
if (!existsSync(PLAYWRIGHT)) {
  console.error('This check needs Playwright, which is not installed here.');
  console.error(`Looked for: ${PLAYWRIGHT}`);
  process.exit(2);
}
const { chromium } = await import(PLAYWRIGHT);

const render = await import(`${REPO}src/cms/render/index.ts`);
const { SHELL_CSS } = await import(`${REPO}src/cms/app/shell/styles.ts`);
const globalCss = readFileSync(`${REPO}src/styles/global.css`, 'utf8');
const docCss = readFileSync(`${REPO}src/cms/styles/doc.css`, 'utf8');

/**
 * Every block kind, in one document, so nothing is checked only by accident
 * of what a real page happens to contain. Rendered once per section, because
 * the two are set differently and the bug was that the editor did not know
 * the difference.
 */
function everyKind(section) {
  const text = (value) => [{ type: 'text', text: value }];
  const para = (value) => [{ type: 'paragraph', content: text(value) }];
  const item = (value) => ({ type: 'listItem', content: para(value) });
  return {
    version: 1,
    meta: { title: 'Every kind', slug: 'every-kind', date: '2026-01-01', section },
    bands: [
      {
        id: 'b1',
        type: 'prose',
        blocks: [
          { id: 'k1', kind: 'p', content: text('A paragraph, which is most of any page.') },
          { id: 'k2', kind: 'h2', content: text('A heading') },
          { id: 'k3', kind: 'h3', content: text('A subheading') },
          { id: 'k4', kind: 'quote', content: para('A quote, which an essay sets quite differently from a project.') },
          { id: 'k5', kind: 'callout', content: text('A callout box.') },
          { id: 'k6', kind: 'ul', content: [item('One'), item('Two')] },
          { id: 'k7', kind: 'ol', content: [item('First'), item('Second')] },
        ],
      },
    ],
  };
}

const SUBJECTS = [
  ['essays', everyKind('essays')],
  ['projects', everyKind('projects')],
];

/** What a reader would notice if it differed. */
const PROPERTIES = [
  'fontSize',
  'lineHeight',
  'fontWeight',
  'color',
  'letterSpacing',
  'marginTop',
  'marginBottom',
  'borderLeftWidth',
  'borderLeftColor',
  'paddingLeft',
];

const BLOCKS = [
  ['paragraph', 'p.doc-p'],
  ['h2', 'h2'],
  ['h3', 'h3'],
  ['quote', 'blockquote'],
  ['list', 'ul, ol'],
  ['callout', 'aside.doc-callout'],
];

let failures = 0;
let checks = 0;
function check(label, okay, detail = '') {
  checks += 1;
  if (okay) {
    console.log(`    ok    ${label}`);
    return;
  }
  failures += 1;
  console.log(`    FAIL  ${label}${detail === '' ? '' : `\n          ${detail}`}`);
}

const browser = await chromium.launch(CHROME === undefined ? {} : { executablePath: CHROME });

for (const [section, doc] of SUBJECTS) {
  console.log(`\n${section}`);
  const body = render.renderDoc(doc);

  const html = `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8">
<style>${globalCss}\n${docCss}\n${SHELL_CSS}</style>
<style>
  .rig { display: flex; gap: 40px; align-items: flex-start; }
  .rig > div { width: 760px; }
  /* The surface is absolutely positioned and scaled in the real shell; here
     it only has to be a box its own rules apply inside. */
  .cms-surface { position: static !important; transform: none !important; width: 760px !important; }
</style></head><body><div class="rig">
  <div id="page">${body}</div>
  <div class="cms-surface cms-surface--${section}" id="editor">${body}</div>
</div></body></html>`;

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const page = await browser.newPage({ viewport: { width: 1700, height: 900 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  const compared = await page.evaluate(
    ({ blocks, properties }) => {
      const read = (root, selector) => {
        // Every part of the list has to be scoped, or `#editor ul, ol` means
        // "a ul inside #editor, OR any ol anywhere" and the measurement walks
        // straight out of the container it was meant to stay in.
        const scoped = selector
          .split(',')
          .map((part) => `#${root} ${part.trim()}`)
          .join(', ');
        const el = document.querySelector(scoped);
        if (el === null) return null;
        const style = getComputedStyle(el);
        return Object.fromEntries(properties.map((key) => [key, style[key]]));
      };
      return blocks.map(([name, selector]) => ({
        name,
        page: read('page', selector),
        editor: read('editor', selector),
      }));
    },
    { blocks: BLOCKS, properties: PROPERTIES },
  );

  for (const { name, page: onPage, editor } of compared) {
    if (onPage === null) {
      console.log(`    --    ${name}: not in this document`);
      continue;
    }
    if (editor === null) {
      check(`${name} is drawn in the editor at all`, false, 'the editor rendered nothing for it');
      continue;
    }
    const differ = Object.keys(onPage).filter((key) => onPage[key] !== editor[key]);
    check(
      `${name} is set the same in the editor as on the page`,
      differ.length === 0,
      differ.map((key) => `${key}: page ${onPage[key]} vs editor ${editor[key]}`).join('\n          '),
    );
  }

  await page.close();
  server.close();
}

await browser.close();

console.log('');
if (failures === 0) {
  console.log(`PASS  ${checks} checks, 0 failures`);
  process.exit(0);
}
console.log(`FAIL  ${failures} of ${checks} checks failed`);
process.exit(1);
