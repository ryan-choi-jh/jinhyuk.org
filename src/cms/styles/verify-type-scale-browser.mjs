/**
 * src/cms/styles/verify-type-scale-browser.mjs
 *
 * The body size, measured, in both places.
 *
 *   node src/cms/styles/verify-type-scale-browser.mjs
 *
 * ./verify-type-scale.ts checks the arithmetic and the selectors offline. It
 * cannot check the one thing that actually matters, which is whether the
 * generated rules land: a selector can be correct, specific enough and still
 * reach nothing, and CSS fails silently when it does. The first version of
 * the generator emitted `body[data-section='essays'] body`, which is valid,
 * well-specified and matches no element in any document.
 *
 * So this puts the real rendered markup in a real browser twice — once with
 * the page's stylesheets and the page's scoping, once with the editor's —
 * and reads the computed font-size off the elements. Two assertions per
 * measurement:
 *
 *   1. the page is at the size that was asked for
 *   2. the editor is at the SAME size as the page
 *
 * The second is the one that keeps the middle pane honest. The two dialects
 * compute from one function, so their numbers cannot disagree; what can
 * disagree is whether each one's rules reach the element, and that is exactly
 * what a browser can answer and a reading of the CSS cannot.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const REPO = new URL('../../../', import.meta.url).pathname;

const PLAYWRIGHT = `${process.env.HOME}/.claude/skills/gstack/node_modules/playwright/index.mjs`;
if (!existsSync(PLAYWRIGHT)) {
  console.error('This check needs Playwright, which is not installed here.');
  process.exit(2);
}
const { chromium } = await import(PLAYWRIGHT);

const render = await import(`${REPO}src/cms/render/index.ts`);
const { SHELL_CSS } = await import(`${REPO}src/cms/app/shell/styles.ts`);
const { CALLOUT_CSS } = await import(`${REPO}src/cms/styles/callout.ts`);
const { SITE_TOKENS_CSS } = await import(`${REPO}src/cms/styles/tokens.ts`);
const scale = await import(`${REPO}src/cms/styles/type-scale.ts`);

const globalCss = readFileSync(`${REPO}src/styles/global.css`, 'utf8');
const docCss = readFileSync(`${REPO}src/cms/styles/doc.css`, 'utf8');

let checks = 0;
let failures = 0;
function check(label, ok, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`    ok    ${label}${detail === '' ? '' : ` (${detail})`}`);
    return;
  }
  failures += 1;
  console.log(`    FAIL  ${label}${detail === '' ? '' : `\n          ${detail}`}`);
}

/* -------------------------------------------------------------------------- */
/* One document with every kind of running text in it                          */
/* -------------------------------------------------------------------------- */

const text = (value) => [{ type: 'text', text: value }];
const para = (value) => [{ type: 'paragraph', content: text(value) }];

function fixture(section) {
  return {
    meta: { slug: 'scale', title: 'Scale', section },
    bands: [
      {
        id: 'b1',
        type: 'prose',
        blocks: [
          { id: 'p1', kind: 'p', content: text('A paragraph of ordinary running text.') },
          { id: 'q1', kind: 'quote', content: para('A quotation.') },
          { id: 'c1', kind: 'callout', content: text('An aside in a box.') },
          {
            id: 'l1',
            kind: 'ul',
            content: [
              { type: 'listItem', content: para('First item') },
              { type: 'listItem', content: para('Second item') },
            ],
          },
        ],
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* The two documents                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The page, as Base.astro builds it: the real stylesheets, the section on
 * `<body>`, and the override stylesheet last.
 */
function pageHtml(section, size) {
  const css = scale.typeScaleCss({ size: 17.5, sections: { [section]: size } }, [section], scale.SITE_DIALECT);
  return `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8">
<style>${globalCss}\n${docCss}</style>
<style>${css}</style>
</head><body data-section="${section}">${render.renderDoc(fixture(section))}</body></html>`;
}

/**
 * The editor's middle pane: SHELL_CSS and the injected stylesheets, the
 * section on the surface, and the override last — the order
 * app/shell/use-type-scale.ts puts them in.
 */
function editorHtml(section, size) {
  const css = scale.typeScaleCss({ size: 17.5, sections: { [section]: size } }, [section], scale.EDITOR_DIALECT);
  return `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8">
<style>${SITE_TOKENS_CSS}</style>
<style>${SHELL_CSS}</style>
<style>${CALLOUT_CSS}</style>
<style>${css}</style>
<style>
  /* The surface is absolutely positioned and scaled in the real shell; here
     it only has to be a box its own rules apply inside. */
  .cms-surface { position: static !important; transform: none !important; width: 900px !important; }
</style>
</head><body><div class="cms-surface cms-surface--${section}"><div class="cms-surface__inner">${render.renderDoc(fixture(section))}</div></div></body></html>`;
}

/* -------------------------------------------------------------------------- */

const WHAT = [
  ['a paragraph', '.doc-p'],
  ['a list item', '.doc-list li'],
  ['a quote', '.doc-quote'],
  ['a callout', '.doc-callout'],
];

/** What each of those should measure, given the section and the body size. */
function expected(section, size) {
  const quoteRole = section === 'essays' ? 'quote-essays' : 'quote';
  return {
    '.doc-p': scale.scaleRole('body', size, 'wide'),
    '.doc-list li': scale.scaleRole('body', size, 'wide'),
    '.doc-quote': scale.scaleRole(quoteRole, size, 'wide'),
    '.doc-callout': scale.scaleRole('callout', size, 'wide'),
  };
}

const browser = await chromium.launch();

async function measure(html) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  const out = await page.evaluate((selectors) => {
    const read = (selector) => {
      const el = document.querySelector(selector);
      if (el === null) return null;
      const style = getComputedStyle(el);
      return { size: parseFloat(style.fontSize), leading: parseFloat(style.lineHeight) };
    };
    return Object.fromEntries(selectors.map((selector) => [selector, read(selector)]));
  }, WHAT.map(([, selector]) => selector));
  await page.close();
  server.close();
  return out;
}

for (const section of ['essays', 'projects']) {
  for (const size of [17.5, 16, 14]) {
    console.log(`\n${section} at ${size}px`);
    const onPage = await measure(pageHtml(section, size));
    const inEditor = await measure(editorHtml(section, size));
    const want = expected(section, size);

    for (const [name, selector] of WHAT) {
      const p = onPage[selector];
      const e = inEditor[selector];
      if (p === null || e === null) {
        check(`${name} is drawn in both`, false, `page ${p === null ? 'missing' : 'ok'}, editor ${e === null ? 'missing' : 'ok'}`);
        continue;
      }
      check(
        `${name} on the page is ${want[selector].size}/${want[selector].leading}`,
        p.size === want[selector].size && p.leading === want[selector].leading,
        `measured ${p.size}/${p.leading}`,
      );
      check(
        `${name} in the editor matches the page`,
        e.size === p.size && e.leading === p.leading,
        `editor ${e.size}/${e.leading} vs page ${p.size}/${p.leading}`,
      );
    }
  }
}

/* The property the whole design rests on: untouched means untouched. */
console.log('\nan unscaled section');
{
  const onPage = await measure(pageHtml('essays', 17.5));
  const base = expected('essays', 17.5);
  for (const [name, selector] of WHAT) {
    check(
      `${name} is still ${base[selector].size}/${base[selector].leading}`,
      onPage[selector].size === base[selector].size && onPage[selector].leading === base[selector].leading,
      `${onPage[selector].size}/${onPage[selector].leading}`,
    );
  }
  check(
    'and nothing was generated for it',
    scale.typeScaleCss({ size: 17.5, sections: {} }, ['essays'], scale.SITE_DIALECT) === '',
  );
}

await browser.close();

console.log('');
if (failures === 0) {
  console.log(`PASS  ${checks} checks, 0 failures`);
  process.exit(0);
}
console.log(`FAIL  ${failures} of ${checks} checks failed`);
process.exit(1);
