/**
 * src/cms/app/prose/harness/keys.mjs
 *
 * The block-boundary keys, driven against the real editor in a real browser.
 *
 *   node src/cms/app/prose/harness/keys.mjs
 *
 * ./keys.tsx is the page: a band of real ProseEditors wired the way the
 * application wires them. This presses the keys and checks the document that
 * comes out. Exit code 0 means every assertion below holds.
 *
 * TWO THINGS THAT COST TIME HERE, both written down so they do not again:
 *
 *  1. Home and End are handled by the BROWSER. ProseMirror learns about the
 *     new selection from a selectionchange event a tick later, so pressing
 *     the consequential key immediately afterwards runs the keymap against a
 *     stale caret and it decides it is not at the edge. Hence `caretTo`.
 *  2. React commits a keystroke's edit on its own schedule. A fixed sleep
 *     reported a merge that HAD happened as one that had not. Hence
 *     `settleAt`, which waits for the condition instead of guessing.
 */

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const PLAYWRIGHT = `${process.env.HOME}/.claude/skills/gstack/node_modules/playwright/index.mjs`;
if (!existsSync(PLAYWRIGHT)) {
  console.error('This check needs Playwright, which is not installed here.');
  console.error(`Looked for: ${PLAYWRIGHT}`);
  process.exit(2);
}
const { chromium } = await import(PLAYWRIGHT);

const HERE = fileURLToPath(new URL('.', import.meta.url));
// src/cms/app/prose/harness -> the project root
const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));

mkdirSync(`${HERE}.out`, { recursive: true });

await esbuild.build({
  entryPoints: [`${HERE}keys.tsx`],
  outfile: `${HERE}.out/keys.js`,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  absWorkingDir: REPO,
  nodePaths: [`${REPO}node_modules`],
  loader: { '.ts': 'ts', '.tsx': 'tsx' },
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'warning',
});

const bundle = readFileSync(`${HERE}.out/keys.js`, 'utf8');
const globalCss = readFileSync(`${REPO}src/styles/global.css`, 'utf8');

const html = `<!doctype html><html lang=en data-theme=light><head><meta charset=utf-8>
<style>${globalCss}</style>
<style>body{margin:0;padding:24px;} .cms-surface{position:static!important;transform:none!important;width:760px!important;}</style>
</head><body><div id=root></div><script>${bundle.replace(/<\/script>/g, '<\\/script>')}</script></body></html>`;

const server = createServer((_q, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

let failures = 0;
let checks = 0;
const check = (label, okay, detail = '') => {
  checks += 1;
  if (okay) { console.log(`    ok    ${label}${detail === '' ? '' : `  (${detail})`}`); return; }
  failures += 1;
  console.log(`    FAIL  ${label}${detail === '' ? '' : `  (${detail})`}`);
};

/**
 * Move the caret with a key, then let ProseMirror notice.
 *
 * Home and End are handled by the browser; ProseMirror learns about the new
 * selection from a selectionchange event, which is a tick later. Pressing the
 * consequential key immediately afterwards means it is handled against a
 * stale selection, and the keymap decides it is not at the edge after all.
 * This cost an hour once already and is written down in cms/AGENTS.md.
 */
const caretTo = async (key) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(120);
};

const reset = async () => {
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.waitForSelector('[data-block="p1"] .ProseMirror');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(120);
};

const state = () => page.evaluate(() => window.blocks().map((b) => ({ id: b.id, kind: b.kind, text: JSON.stringify(b.content) })));
const count = async () => (await state()).length;

/**
 * Wait for the band to reach a block count, rather than sleeping and hoping.
 * React commits a keystroke's edit on its own schedule, and a fixed delay
 * reported a merge that had in fact happened as one that had not. Resolves
 * either way; the check that follows is what judges it.
 */
const settleAt = async (wanted, ms = 2000) => {
  try {
    await page.waitForFunction((n) => window.blocks().length === n, wanted, { timeout: ms });
  } catch {
    /* the check below reports it */
  }
};
/** Which block holds the caret, read from the real selection. */
const caretIn = () =>
  page.evaluate(() => {
    const node = document.getSelection()?.anchorNode ?? null;
    const el = node === null ? null : (node.nodeType === 1 ? node : node.parentElement);
    return el?.closest('[data-block]')?.getAttribute('data-block') ?? 'none';
  });

/* ------------------------------------------------------------------ 1 */
console.log('\n1. Enter on an EMPTY last list item ends the list');
{
  await reset();
  const before = await count();
  await page.click('[data-block="list"] li:last-child p');
  await caretTo('End');
  await page.keyboard.press('Enter');          // a third, empty item
  await page.waitForTimeout(100);
  const mid = await state();
  const items = JSON.parse(mid.find((b) => b.id === 'list').text).length;
  check('one Enter adds an item', items === 3, `${items} items`);

  await page.keyboard.press('Enter');          // and now: out
  await settleAt(before + 1);
  const after = await state();
  const left = JSON.parse(after.find((b) => b.id === 'list').text).length;
  check('the second Enter drops the empty item', left === 2, `${left} items`);
  check('…and adds a block', after.length === before + 1, `${before} -> ${after.length}`);
  const fresh = after[after.findIndex((b) => b.id === 'list') + 1];
  check('…which is an empty paragraph', fresh?.kind === 'p' && fresh.text === '[]', `${fresh?.kind} ${fresh?.text}`);
  check('…and the caret is in it', (await caretIn()) === fresh?.id, await caretIn());
}

/* ------------------------------------------------------------------ 2 */
console.log('\n2. Enter on an empty item in the MIDDLE splits the list in two');
{
  await reset();
  const before = await count();
  await page.click('[data-block="list"] li:first-child p');
  await caretTo('End');
  await page.keyboard.press('Enter');          // One / (empty) / Two
  await page.waitForTimeout(150);
  const items = JSON.parse((await state()).find((b) => b.id === 'list').text).length;
  check('one Enter adds an item', items === 3, `${items} items`);

  await page.keyboard.press('Enter');          // break it open here
  await settleAt(before + 2);
  const after = await state();
  check('one block becomes three', after.length === before + 2, `${before} -> ${after.length}`);
  const at = after.findIndex((b) => b.id === 'list');
  check('the first keeps the items above', JSON.parse(after[at].text).length === 1, after[at].text);
  check('a paragraph opens between', after[at + 1]?.kind === 'p' && after[at + 1].text === '[]');
  check('and the items below stay a list', after[at + 2]?.kind === 'ul' && JSON.parse(after[at + 2].text).length === 1, after[at + 2]?.text);
  check('the caret is in the paragraph', (await caretIn()) === after[at + 1]?.id, await caretIn());
}

/* ------------------------------------------------------------------ 2b */
console.log('\n2b. Enter on the only item of a one-item list does nothing');
{
  await reset();
  const before = await count();
  await page.click('[data-block="list"] li:last-child p');
  await caretTo('End');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);
  await page.keyboard.press('Enter');          // now 2 real + 1 empty -> escapes
  await settleAt(before + 1);
  // and from the fresh paragraph, a list that is only an empty bullet is left alone
  check('a list with real items still escapes', (await count()) === before + 1, `${await count()}`);
}

/* ------------------------------------------------------------------ 3 */
console.log('\n3. Delete at the END of a block pulls the next one up');
{
  await reset();
  const before = await count();
  // p1 -> gap, two paragraphs. Delete at the end of the first should swallow
  // the empty one after it, which is also the tidiest way to remove a blank
  // row by hand.
  await page.click('[data-block="p1"] p');
  await caretTo('End');
  await page.keyboard.press('Delete');
  await settleAt(before - 1);
  const after = await state();
  check('a block is removed', after.length === before - 1, `${before} -> ${after.length}`);
  check('the gone one is the block below', !after.some((b) => b.id === 'gap'));
  const joined = after.find((b) => b.id === 'p1');
  check(
    'the text is joined with nothing inserted',
    joined !== undefined && joined.text === '[{"type":"text","text":"A first paragraph."}]',
    joined?.text ?? 'gone',
  );
}

/* ------------------------------------------------------------------ 3b */
console.log('\n3b. …but it refuses to merge a list or a quote into a paragraph');
{
  await reset();
  const before = await count();
  // p2's neighbour below is the list. Joining a list into a paragraph would
  // have to decide which item the text lands in, and guessing there is worse
  // than doing nothing. Same rule as Backspace.
  await page.click('[data-block="p2"] p');
  await caretTo('End');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(150);
  const after = await state();
  check('nothing is removed', after.length === before, `${before} -> ${after.length}`);
  check('the list is still a list', after.some((b) => b.id === 'list' && b.kind === 'ul'));
}

/* ------------------------------------------------------------------ 4 */
console.log('\n4. Delete mid-block still deletes one character');
{
  await reset();
  const before = await count();
  await page.click('[data-block="p1"] p');
  await caretTo('Home');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(120);
  const after = await state();
  check('no block is removed', after.length === before, `${before} -> ${after.length}`);
  check(
    'one character goes',
    after.find((b) => b.id === 'p1').text.includes(' first paragraph.'),
    after.find((b) => b.id === 'p1').text,
  );
}

/* ------------------------------------------------------------------ 5 */
console.log('\n5. Delete at the end of the LAST block does nothing');
{
  await reset();
  const before = await count();
  await page.click('[data-block="p3"] p');
  await caretTo('End');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(120);
  check('nothing happens at the end of the document', (await count()) === before, `${before}`);
}

/* ------------------------------------------------------------------ 6 */
console.log('\n6. Arrow keys cross block boundaries');
{
  await reset();
  await page.click('[data-block="p1"] p');
  await caretTo('End');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  check('ArrowDown from the last line moves on', (await caretIn()) === 'gap', await caretIn());

  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(150);
  check('ArrowUp comes back', (await caretIn()) === 'p1', await caretIn());

  await caretTo('End');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  check('ArrowRight off the end moves on', (await caretIn()) === 'gap', await caretIn());

  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(150);
  check('ArrowLeft off the start comes back', (await caretIn()) === 'p1', await caretIn());
}

/* ------------------------------------------------------------------ 7 */
console.log('\n7. A wrapped paragraph moves line by line before it leaves');
{
  await reset();
  const long = 'This paragraph is deliberately long enough that it has to wrap onto at least three separate lines inside its own block, which is the case the edge detection has to get right. ';
  await page.click('[data-block="p1"] p');
  await caretTo('Home');
  await page.evaluate((t) => {
    const el = document.querySelector('[data-block="p1"] .ProseMirror');
    el.focus();
    document.execCommand('insertText', false, t + t);
  }, long);
  await page.waitForTimeout(200);
  const lines = await page.evaluate(() => {
    const el = document.querySelector('[data-block="p1"] .ProseMirror p');
    return Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
  });
  await page.evaluate(() => {
    const el = document.querySelector('[data-block="p1"] .ProseMirror');
    const range = document.createRange();
    range.setStart(el.firstChild.firstChild, 0);
    range.collapse(true);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.focus();
  });
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  check(
    `ArrowDown inside a ${lines}-line paragraph stays in it`,
    (await caretIn()) === 'p1',
    await caretIn(),
  );
}

console.log('\n8. Pasting a whole essay in');
{
  /*
   * One ProseBlock is one top-level node, so a paste of twenty paragraphs
   * had nowhere to go: ProseMirror kept what fitted and dropped the rest,
   * and moving an essay across from Notion meant pasting it a paragraph at
   * a time. src/cms/app/prose/paste.ts reads the clipboard before the editor
   * does and hands the band whole blocks.
   *
   * The mapping is tested offline in ../verify.ts. This is the half that
   * needs a browser: a real DataTransfer, the browser's own HTML parser and
   * ProseMirror's handlePaste seam, against a real band of real editors.
   *
   * The HTML is shaped like what an editor actually puts on a clipboard —
   * a wrapper div, spans carrying styles, a figure, blank paragraphs — and
   * not the tidy markup a parser would obviously cope with.
   */
  const CLIPBOARD = [
    "<meta charset='utf-8'>",
    '<div data-pm-slice="0 0 []">',
    '<h1>The title of the piece</h1>',
    '<p><span style="color:inherit">First, with <strong>bold</strong> in it.</span></p>',
    '<p></p>',
    '<h2>A section heading</h2>',
    '<p>Second, with <a href="https://example.com/x">a link</a>.</p>',
    '<ul><li>One</li><li>Two</li></ul>',
    '<ol><li>Step</li></ol>',
    '<blockquote>Something quoted.</blockquote>',
    '<figure><img src="https://example.com/a.png" alt="dropped"></figure>',
    '<h4>A deeper heading</h4>',
    '<p>   </p>',
    '<p>Last paragraph.</p>',
    '</div>',
  ].join('');

  const paste = async (selector, html) =>
    page.evaluate(
      ({ selector, html }) => {
        const editable = document.querySelector(selector + ' .ProseMirror');
        if (editable === null) return 'no editor';
        editable.focus();
        const data = new DataTransfer();
        data.setData('text/html', html);
        data.setData('text/plain', 'the html wins');
        editable.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
        return 'sent';
      },
      { selector, html },
    );

  /* Into the EMPTY block: it is replaced, which is the case this is for. */
  await reset();
  await page.click('[data-block="gap"] p');
  await page.waitForTimeout(120);
  const sent = await paste('[data-block="gap"]', CLIPBOARD);
  check('the paste reached a mounted editor', sent === 'sent', sent);
  await settleAt(13);
  const after = await state();
  const kinds = after.map((b) => b.kind).join(' ');
  // Was: p1, gap(empty), p2, list, p3. The empty one becomes the nine
  // blocks the clipboard came to; the other four are untouched.
  check('a multi-block paste becomes multiple blocks', after.length === 13, `${after.length} blocks`);
  check(
    'in the clipboard order, with the clipboard kinds',
    kinds === 'p h2 p h2 p ul ol quote h3 p p ul p',
    kinds,
  );
  check('an empty block is replaced, not pushed down', after[0].id === 'p1' && after[1].kind === 'h2');
  check('every pasted block has its own id', new Set(after.map((b) => b.id)).size === after.length);

  const json = after.map((b) => b.text).join('');
  check('the bold survives', json.includes('"bold"'));
  check('the link survives', json.includes('example.com/x'));
  check('the list keeps both items', json.includes('One') && json.includes('Two'));
  check('blank paragraphs do not arrive as blank blocks', !/"content":\[\]/.test(json), json.slice(0, 120));

  const dropped = await page.evaluate(() => window.lastPaste?.dropped ?? null);
  check('and what the model cannot hold is counted', dropped === 1, String(dropped));

  /* Into a block WITH text: its text stays, the paste follows it. */
  await reset();
  await page.click('[data-block="p1"] p');
  await page.waitForTimeout(120);
  await paste('[data-block="p1"]', '<p>Alpha</p><p>Beta</p>');
  await settleAt(7);
  const mixed = await state();
  check('a block with text in it keeps its text', mixed[0].id === 'p1' && mixed[0].text.includes('A first paragraph.'));
  check('and the paste lands after it', mixed[1].text.includes('Alpha') && mixed[2].text.includes('Beta'), mixed.map((b) => b.id).join(' '));

  /* ONE block is left entirely to ProseMirror. */
  await reset();
  await page.click('[data-block="gap"] p');
  await page.waitForTimeout(120);
  await paste('[data-block="gap"]', '<p>Just the one.</p>');
  await page.waitForTimeout(250);
  const single = await state();
  check('a single-block paste does not become a block operation', single.length === 5, `${single.length} blocks`);
  check('it goes into the block, as it always did', single[1].text.includes('Just the one.'), single[1].text);

  /* Plain text, when there is no HTML to read. */
  await reset();
  await page.click('[data-block="gap"] p');
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    const editable = document.querySelector('[data-block="gap"] .ProseMirror');
    editable.focus();
    const data = new DataTransfer();
    data.setData('text/plain', 'One\nTwo\nThree');
    editable.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await settleAt(7);
  const plain = await state();
  check('plain text is one paragraph per line', plain.length === 7, `${plain.length} blocks`);
  check(
    'and they are in order',
    plain.slice(1, 4).map((b) => JSON.parse(b.text)[0]?.text).join('|') === 'One|Two|Three',
    plain.map((b) => b.text).join(' '),
  );
}

/* ------------------------------------------------------------------ 9 */
console.log('\n9. Nothing threw');
check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await page.close();
await browser.close();
server.close();

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${checks - failures}/${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
