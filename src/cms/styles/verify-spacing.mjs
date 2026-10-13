/**
 * src/cms/styles/verify-spacing.mjs
 *
 * Does "space above a block" do what the inspector says it does?
 *
 *   node src/cms/styles/verify-spacing.mjs
 *
 * The control replaces the empty row, which was never a spacer: measured, an
 * empty paragraph is 35px tall in the CMS and 0px on the page, changes the
 * page in 6 of 36 block pairings, and three of them do what one does. So the
 * thing that replaces it had better be exact, and this is where that is
 * checked rather than asserted.
 *
 * Four claims, all of them things the inspector tells the author:
 *
 *   A  each size makes the gap it names, whatever the blocks either side are
 *   B  it is a FLOOR, not an addition
 *   C  it steps down below the breakpoint
 *   D  the document's first block is untouched by it
 *
 * B is the one worth the browser. The rule is a `margin-top`, it adjoins the
 * previous block's `margin-bottom`, and adjoining margins collapse to the
 * larger of the two, so "small" after a heading and "small" after a
 * paragraph must come out the same despite the heading leaving 8px and the
 * paragraph 27. Getting that wrong is how people start stacking them.
 *
 * It also caught the thing that made the first version useless: the rules it
 * has to beat are two classes (`.doc--essays .doc-p`), so a one-class
 * selector worked on a heading and a callout and did nothing whatever to a
 * paragraph, a quote or a list.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PLAYWRIGHT = `${process.env.HOME}/.claude/skills/gstack/node_modules/playwright/index.mjs`;
if (!existsSync(PLAYWRIGHT)) {
  console.error('This check needs Playwright, which is not installed here.');
  console.error(`Looked for: ${PLAYWRIGHT}`);
  process.exit(2);
}
const { chromium } = await import(PLAYWRIGHT);

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const render = await import(`${REPO}src/cms/render/index.ts`);
const { SPACE_SCALE } = await import(`${REPO}src/cms/styles/spacing.ts`);
const { SPACING_CSS } = await import(`${REPO}src/cms/styles/spacing.ts`);
const { SHELL_CSS } = await import(`${REPO}src/cms/app/shell/styles.ts`);
const globalCss = readFileSync(`${REPO}src/styles/global.css`, 'utf8');
const docCss = readFileSync(`${REPO}src/cms/styles/doc.css`, 'utf8');

const text = (t) => [{ type: 'text', text: t }];
const para = (t) => [{ type: 'paragraph', content: text(t) }];
const item = (t) => ({ type: 'listItem', content: para(t) });
const blockOf = (kind, id, space) => {
  const b =
    kind === 'quote'
      ? { id, kind, content: para(id) }
      : kind === 'ul'
        ? { id, kind, content: [item(id)] }
        : { id, kind, content: text(id) };
  if (space !== undefined) b.space = space;
  return b;
};

const pages = new Map();
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(pages.get(req.url) ?? '<!doctype html><html><body></body></html>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

function html(body) {
  return `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8">
<style>${globalCss}\n${docCss}</style>
<style>body{margin:0}.wrap{max-width:1440px;padding:0 48px}</style>
</head><body><div class="wrap">${body}</div></body></html>`;
}

async function gap(firstKind, secondKind, space, width = 1440) {
  // A lead block first, so the pair under test is never the document's first.
  const blocks = [blockOf('p', 'lead'), blockOf(firstKind, 'first'), blockOf(secondKind, 'second', space)];
  const doc = {
    version: 1,
    meta: { title: 'T', slug: 'x', date: '2026-01-01', section: 'essays' },
    bands: [{ id: 'b1', type: 'prose', blocks }],
  };
  const url = `/${firstKind}-${secondKind}-${space ?? 'none'}-${width}`;
  pages.set(url, html(render.renderDoc(doc)));
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(origin + url, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => {
    const a = document.querySelector('[data-block-id="first"]').getBoundingClientRect();
    const b = document.querySelector('[data-block-id="second"]').getBoundingClientRect();
    return Math.round((b.top - a.bottom) * 10) / 10;
  });
}

let bad = 0;
const check = (label, okay, detail) => {
  console.log(`  ${okay ? 'ok  ' : 'FAIL'}  ${label}  ${detail}`);
  if (!okay) bad += 1;
};

console.log('\nA. the gap each size makes, at 1440');
for (const [first, second] of [['p', 'p'], ['h2', 'p'], ['p', 'h2'], ['p', 'callout'], ['ul', 'quote']]) {
  const row = [];
  for (const space of [undefined, 'small', 'medium', 'large']) row.push(await gap(first, second, space));
  console.log(`  ${first.padEnd(8)}-> ${second.padEnd(9)} default ${String(row[0]).padStart(5)}   small ${String(row[1]).padStart(5)}   medium ${String(row[2]).padStart(5)}   large ${String(row[3]).padStart(5)}`);
}

console.log('\nB. it is a FLOOR, not an addition');
{
  const plain = await gap('p', 'p', 'small');
  const afterHeading = await gap('h2', 'p', 'small');
  check(
    'small gives the same gap after a paragraph as after a heading',
    plain === afterHeading && plain === SPACE_SCALE.small.wide,
    `${plain} and ${afterHeading}, wanted ${SPACE_SCALE.small.wide}`,
  );
  // p -> h2 already leaves 48, which is exactly `small`, so asking for small
  // must change nothing rather than adding to it.
  const bigAlready = await gap('p', 'h2', undefined);
  const asked = await gap('p', 'h2', 'small');
  check(
    'asking for less than what is already there changes nothing',
    bigAlready === asked,
    `${bigAlready} -> ${asked}`,
  );
  const more = await gap('p', 'h2', 'large');
  check('asking for more does raise it', more === SPACE_SCALE.large.wide, `${more}`);
}

console.log('\nC. it steps down on a phone');
for (const space of ['small', 'medium', 'large']) {
  const got = await gap('p', 'p', space, 390);
  check(`${space} at 390`, got === SPACE_SCALE[space].narrow, `${got}, wanted ${SPACE_SCALE[space].narrow}`);
}

console.log('\nD. the first block of the document is untouched');
{
  const doc = {
    version: 1,
    meta: { title: 'T', slug: 'f', date: '2026-01-01', section: 'essays' },
    bands: [{ id: 'b1', type: 'prose', blocks: [blockOf('p', 'lead', 'large'), blockOf('p', 'next')] }],
  };
  pages.set('/first', html(render.renderDoc(doc)));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + '/first', { waitUntil: 'load' });
  const top = await page.evaluate(() => {
    const el = document.querySelector('[data-block-id="lead"]');
    return { marginTop: getComputedStyle(el).marginTop, cls: el.className };
  });
  check('no space class and no top margin', top.marginTop === '0px' && !top.cls.includes('doc-space'), JSON.stringify(top));
}

console.log('\nE. the editor shows the same gap as the page');
{
  /*
   * On the page the class is on the block; in the editor it is on the div
   * the surface wraps that block in, because the block there is a live
   * ProseMirror instance the surface does not own the markup of. So the two
   * are the same CLASS in different positions, and the only way to know the
   * gap survives that is to lay both out.
   *
   * The editor side is the surface's own shape, from
   * src/cms/app/shell/page-surface.tsx: a `.cms-block-slot` wrapper carrying
   * the class, with a `.cms-slot-host` and the rendered block inside it. If
   * that wrapper changes, change it here; the numbers below will say so.
   */
  const one = (id, kind, space) =>
    render.renderProseBlock(blockOf(kind, id, space));
  const slot = (id, kind, space) =>
    `<div class="cms-block-slot${space === undefined ? '' : ` doc-space--${space}`}" data-block-id="${id}">` +
    `<div class="cms-slot-host">${render.renderProseBlock(blockOf(kind, id))}</div></div>`;

  for (const space of ['small', 'medium', 'large']) {
    const body = `${one('first', 'p')}${one('second', 'p', space)}`;
    const editor = `${slot('first', 'p')}${slot('second', 'p', space)}`;
    const url = `/editor-${space}`;
    pages.set(
      url,
      `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8">
<style>${globalCss}\n${docCss}\n${SHELL_CSS}\n${SPACING_CSS}</style>
<style>
  body { margin: 0; }
  .rig { display: flex; gap: 40px; align-items: flex-start; }
  .rig > div { width: 760px; }
  .cms-surface { position: static !important; transform: none !important; width: 760px !important; }
</style></head><body><div class="rig">
  <div id="page" class="doc doc--essays">${body}</div>
  <div class="cms-surface cms-surface--essays" id="editor">${editor}</div>
</div></body></html>`,
    );
    await page.setViewportSize({ width: 1700, height: 900 });
    await page.goto(origin + url, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const both = await page.evaluate(() => {
      const gapIn = (root) => {
        const a = document.querySelector(`#${root} [data-block-id="first"]`).getBoundingClientRect();
        const b = document.querySelector(`#${root} [data-block-id="second"]`).getBoundingClientRect();
        return Math.round((b.top - a.bottom) * 10) / 10;
      };
      return { page: gapIn('page'), editor: gapIn('editor') };
    });
    check(
      `${space}: the editor's gap equals the page's`,
      both.page === both.editor && both.page === SPACE_SCALE[space].wide,
      `page ${both.page}, editor ${both.editor}, wanted ${SPACE_SCALE[space].wide}`,
    );
  }
}

await page.close();
await browser.close();
server.close();
console.log(bad === 0 ? '\nPASS' : `\nFAIL ${bad}`);
process.exit(bad === 0 ? 0 : 1);
