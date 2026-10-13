/**
 * src/cms/app/prose/harness/main.tsx
 *
 * WS-5's standalone proof, part 2 of 2: the real <ProseEditor> component, in a
 * real browser, driven against src/cms/fixtures/simple.json.
 *
 *   node src/cms/app/prose/harness/run.mjs      # headless, prints the results
 *   node src/cms/app/prose/harness/build.mjs    # then open index.html by hand
 *
 * It mounts one editor per prose block, shows what each one currently emits,
 * and then runs the assertion list below against the live editors and the live
 * toolbar DOM. Clicks are real clicks; key presses are real keydown events;
 * the dark-mode checks read getComputedStyle, so the claim "a palette colour
 * survives dark mode" is measured in a browser rather than asserted on paper.
 *
 * No shell, no API, no renderer, no other workstream.
 */

import { useRef, useState } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { Editor } from '@tiptap/core';

import fixture from '../../../fixtures/simple.json';
import { HIGHLIGHT_INKS, PROSE_NODE_TYPE, isProseBand, validateDoc } from '../../../schema.ts';
import type { ProseBlock } from '../../../schema.ts';
import { ProseEditor } from '../ProseEditor.tsx';
import type { CaretAt, CaretRequest } from '../ProseEditor.tsx';
import {
  blockFromDoc,
  canonicalJson,
  collectProseColors,
  collectProseMarks,
  collectProseText,
  inlineLength,
  joinInlineContent,
} from '../block.ts';
import type { ProseNode } from '../block.ts';
import { SINGLE_LINE_KINDS } from '../extensions.ts';
import { COLOR_TOKEN_CSS, PROSE_PALETTE } from '../palette.ts';

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

type Result = { label: string; ok: boolean; detail: string };

const results: Result[] = [];
let group = '';

function section(title: string): void {
  group = title;
  results.push({ label: `--- ${title}`, ok: true, detail: '' });
}

function check(label: string, ok: boolean, detail: unknown = ''): boolean {
  results.push({ label, ok, detail: detail === '' ? '' : String(detail) });
  if (!ok) console.error(`FAIL [${group}] ${label}`, detail);
  return ok;
}

function render(): void {
  const real = results.filter((result) => !result.label.startsWith('---'));
  const failed = real.filter((result) => !result.ok);
  const verdict =
    failed.length === 0
      ? `PASS ${real.length}/${real.length} assertions`
      : `FAIL ${failed.length} of ${real.length} assertions`;
  const lines = results.map((result) => {
    if (result.label.startsWith('---')) return `\n${result.label.slice(4)}`;
    const mark = result.ok ? '    ok   ' : '    FAIL ';
    return `${mark} ${result.label}${result.detail === '' ? '' : `  (${result.detail})`}`;
  });
  // Tell the runner we are done. Served from file:// (opened by hand) this
  // just fails quietly and the page is read with human eyes instead.
  void fetch('/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verdict, total: real.length, failed: failed.length, lines }),
  }).catch(() => undefined);

  const verdictNode = document.getElementById('verdict');
  const resultsNode = document.getElementById('results');
  const jsonNode = document.getElementById('results-json');
  if (verdictNode !== null) verdictNode.textContent = verdict;
  if (resultsNode !== null) resultsNode.textContent = lines.join('\n').trim();
  if (jsonNode !== null) {
    jsonNode.textContent = JSON.stringify(
      { verdict, total: real.length, failed: failed.length, lines },
      null,
      1,
    );
  }
  document.title = verdict;
}

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

const parsed = validateDoc(fixture);
if (!parsed.ok) {
  check('src/cms/fixtures/simple.json validates', false, canonicalJson(parsed.issues));
  render();
  throw new Error('fixture does not validate');
}

const FIXTURE_BLOCKS: ProseBlock[] = parsed.doc.bands
  .filter(isProseBand)
  .flatMap((band) => band.blocks);

/* -------------------------------------------------------------------------- */
/* The app under test                                                          */
/* -------------------------------------------------------------------------- */

const editors = new Map<string, Editor>();
const changeCounts = new Map<string, number>();
const contentErrors: string[] = [];

type Bridge = {
  get: () => ProseBlock[];
  set: (blocks: ProseBlock[]) => void;
};

const bridge: Bridge = { get: () => [], set: () => undefined };

/**
 * Enter and Backspace cross a block boundary, so proving them needs a host
 * holding a LIST of blocks, not one editor. This is the same wiring the real
 * slot does in src/cms/app/index.tsx (cut the block in two, join it back, hand
 * the caret to whichever block should now have it), with an array standing in
 * for the document store.
 */
let splitCount = 0;
/**
 * How many times the editor asked the host to merge. Backspace is bound for
 * every single-line block but must only reach the host at the very start of
 * one; a counter is the only way to see the difference from outside, because a
 * synthetic keydown cannot drive the browser's own character deletion and so
 * mid-paragraph Backspace looks like "nothing happened" either way.
 */
let mergeCalls = 0;
/* Per block, so a request for one block does not refire another block's. */
const caretRequests = new Map<string, CaretRequest>();
let caretNonce = 0;

function requestCaret(blockId: string, at: CaretAt): void {
  caretNonce += 1;
  caretRequests.set(blockId, { at, nonce: caretNonce });
}

/** A fixture block by id. Index lookups break whenever the fixture grows. */
function fixtureBlock(id: string): ProseBlock {
  const found = FIXTURE_BLOCKS.find((block) => block.id === id);
  if (found === undefined) throw new Error(`no fixture block ${id}`);
  return found;
}

function blockById(id: string): ProseBlock {
  const found = bridge.get().find((block) => block.id === id);
  if (found === undefined) throw new Error(`no block ${id}`);
  return found;
}

function editorFor(id: string): Editor {
  const editor = editors.get(id);
  if (editor === undefined) throw new Error(`no editor for ${id}`);
  return editor;
}

function App(): JSX.Element {
  const [blocks, setBlocks] = useState<ProseBlock[]>(FIXTURE_BLOCKS);
  const latest = useRef(blocks);
  latest.current = blocks;

  bridge.get = () => latest.current;
  bridge.set = setBlocks;

  const handleChange = (next: ProseBlock): void => {
    changeCounts.set(next.id, (changeCounts.get(next.id) ?? 0) + 1);
    setBlocks((previous) =>
      previous.map((block) => (block.id === next.id ? next : block)),
    );
  };

  const handleSplit = (block: ProseBlock, head: ProseNode[], tail: ProseNode[]): void => {
    splitCount += 1;
    // The same rule the real slot applies: no split ever leaves an empty
    // heading, at either end. See src/cms/app/index.tsx.
    const heading = block.kind === 'h2' || block.kind === 'h3';
    const kind = heading && tail.length === 0 ? 'p' : block.kind;
    const headKind = heading && head.length === 0 ? 'p' : block.kind;
    const made: ProseBlock = { id: `split_${splitCount}`, kind, content: tail };
    requestCaret(made.id, 'start');
    setBlocks((previous) =>
      previous.flatMap((candidate) =>
        candidate.id === block.id
          ? [{ ...candidate, kind: headKind, content: head }, made]
          : [candidate],
      ),
    );
  };

  const handleMergeUp = (block: ProseBlock): boolean => {
    mergeCalls += 1;
    const current = latest.current;
    const index = current.findIndex((candidate) => candidate.id === block.id);
    const previous = index > 0 ? current[index - 1] : undefined;
    if (previous === undefined) return false;
    if (!SINGLE_LINE_KINDS.has(previous.kind) || !SINGLE_LINE_KINDS.has(block.kind)) return false;

    requestCaret(previous.id, inlineLength(previous.content));
    const merged = joinInlineContent(previous.content, block.content);
    setBlocks((all) =>
      all
        .filter((candidate) => candidate.id !== block.id)
        .map((candidate) => (candidate.id === previous.id ? { ...candidate, content: merged } : candidate)),
    );
    return true;
  };

  return (
    <div className="hz-grid">
      {blocks.map((block) => (
        <div className="hz-row" key={block.id}>
          <div className="hz-cell">
            <span className="hz-tag">{`${block.id} · ${block.kind}`}</span>
            <ProseEditor
              block={block}
              onChange={handleChange}
              onSplit={(head, tail) => handleSplit(block, head, tail)}
              onMergeUp={() => handleMergeUp(block)}
              caret={caretRequests.get(block.id) ?? null}
              onReady={(editor) => {
                if (editor === null) editors.delete(block.id);
                else editors.set(block.id, editor);
              }}
              onContentError={(message) => contentErrors.push(`${block.id}: ${message}`)}
            />
          </div>
          <div className="hz-cell">
            <span className="hz-tag">emitted ProseBlock</span>
            <pre className="hz-json">{JSON.stringify(block, null, 1)}</pre>
          </div>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Driving                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Let React commit.
 *
 * React's concurrent root schedules its work through MessageChannel, so one
 * `await setTimeout(0)` can return before that work has run and leave the
 * toolbar a render behind. Several turns of the macrotask queue fix that,
 * and nothing below waits a fixed number of turns and hopes: every
 * interaction goes through waitFor(), which polls a predicate.
 *
 * Deliberately NOT requestAnimationFrame. Under headless Chrome's
 * --virtual-time-budget there is no compositor driving frames, so awaiting one
 * can stall the whole run and the budget never expires.
 */
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await macrotask();
}

/** Poll until the page agrees, rather than guessing how long React will take. */
async function waitFor(predicate: () => boolean, tries = 30): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (predicate()) return true;
    await settle(1);
  }
  return predicate();
}

async function reset(): Promise<void> {
  bridge.set(FIXTURE_BLOCKS);
  owner = '';
  await waitFor(() => canonicalJson(bridge.get()) === canonicalJson(FIXTURE_BLOCKS));
  await waitFor(() => toolbarCount() === 0);
}

/**
 * Which block the driver is currently working on. Every toolbar query is
 * scoped to it through `data-prose-toolbar`, because with nine editors on one
 * page "the toolbar" is not a thing: clicking the wrong editor's Bold button
 * is exactly the kind of mistake a harness has to be unable to make.
 */
let owner = '';

/** Everything that decides whether a toolbar is showing, in one string. */
function focusReport(): string {
  const active = document.activeElement;
  const activeLabel =
    active === null
      ? 'none'
      : (active.closest('[data-prose-block]')?.getAttribute('data-prose-block') ??
        active.closest('[data-prose-toolbar]')?.getAttribute('data-prose-toolbar') ??
        active.tagName);
  const focused = FIXTURE_BLOCKS.filter((block) => editors.get(block.id)?.isFocused === true).map(
    (block) => block.id,
  );
  const ranged = FIXTURE_BLOCKS.filter((block) => {
    const editor = editors.get(block.id);
    return editor !== undefined && !editor.state.selection.empty;
  }).map((block) => block.id);
  return `docFocus=${document.hasFocus()} active=${activeLabel} isFocused=[${focused.join(',')}] hasRange=[${ranged.join(',')}] toolbars=[${toolbarOwners()}]`;
}

/**
 * Focus a block, select all of it, and wait until its toolbar is actually on
 * the page. Returns the live editor.
 *
 * The contenteditable is focused directly first, which is what a click does.
 * TipTap's own focus() command defers view.focus() into a requestAnimationFrame,
 * and leaning on that alone makes a test wait on a frame it cannot see.
 */
async function focusBlock(id: string): Promise<Editor> {
  owner = id;
  await waitFor(() => editors.has(id));
  const editor = editorFor(id);
  // Blur whatever holds focus first. A click does this for you; calling
  // focus() on a second contenteditable without it leaves the browser's
  // notion of the focused element behind in some headless configurations.
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== editor.view.dom) active.blur();
  editor.view.dom.focus();
  editor.commands.selectAll();
  editor.commands.focus();
  await waitFor(() => editor.isFocused && !editor.state.selection.empty && toolbar() !== null);
  return editor;
}

function toolbar(): HTMLElement | null {
  if (owner === '') return document.querySelector<HTMLElement>('[data-prose-toolbar]');
  return document.querySelector<HTMLElement>(`[data-prose-toolbar="${owner}"]`);
}

function toolbarCount(): number {
  return document.querySelectorAll('[data-prose-toolbar]').length;
}

function toolbarOwners(): string {
  return [...document.querySelectorAll('[data-prose-toolbar]')]
    .map((node) => node.getAttribute('data-prose-toolbar'))
    .join(',');
}

function toolbarButton(match: (button: HTMLButtonElement) => boolean): HTMLButtonElement | null {
  const root = toolbar();
  if (root === null) return null;
  return [...root.querySelectorAll('button')].find(match) ?? null;
}

function byTitle(prefix: string): HTMLButtonElement | null {
  return toolbarButton((button) => (button.getAttribute('title') ?? '').startsWith(prefix));
}

function byAriaLabel(label: string): HTMLButtonElement | null {
  return toolbarButton((button) => button.getAttribute('aria-label') === label);
}

/** Is there such a thing inside the current block's toolbar? */
function has(selector: string): boolean {
  const root = toolbar();
  return root !== null && root.querySelector(selector) !== null;
}

/**
 * Click a toolbar control. Waits for it, and records a failure rather than
 * silently doing nothing, because a missing button that is quietly skipped is
 * how a harness ends up reporting green on a broken toolbar.
 */
async function clickToolbar(what: string, find: () => HTMLButtonElement | null): Promise<void> {
  const ready = await waitFor(() => find() !== null);
  if (!ready) {
    check(`toolbar control "${what}" exists`, false, `want=${owner} ${focusReport()}`);
    return;
  }
  find()?.click();
  await settle();
}

/**
 * Open a toolbar panel, if it is not already open.
 *
 * The Colour and Link buttons toggle, which is right for a person and wrong
 * for a script: a section that assumes a closed popover will close an open one
 * instead, and then hunt for a swatch that is no longer rendered.
 */
async function openPanel(what: 'Text colour' | 'Link' | 'Highlight', marker: string): Promise<void> {
  if (has(marker)) return;
  await clickToolbar(what, () => byTitle(what));
  const open = await waitFor(() => has(marker));
  if (!open) check(`the ${what} panel opened`, false, `owner=${owner} ${focusReport()}`);
}

const openColour = (): Promise<void> => openPanel('Text colour', '.pe-swatches');
const openLink = (): Promise<void> => openPanel('Link', '.pe-input--href');
const openInks = (): Promise<void> => openPanel('Highlight', '.pe-inks');

/** Type into a controlled input the way a person does: value, then events. */
async function typeInto(selector: string, text: string): Promise<void> {
  const ready = await waitFor(() => has(selector));
  if (!ready) {
    check(`field ${selector} exists`, false, `want=${owner} ${focusReport()}`);
    return;
  }
  const input = toolbar()?.querySelector<HTMLInputElement>(selector);
  if (input === null || input === undefined) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle();
}

/** Flip the site theme and wait for the style recalculation. */
async function setTheme(theme: 'light' | 'dark'): Promise<void> {
  document.documentElement.setAttribute('data-theme', theme);
  await settle();
}

async function press(
  id: string,
  key: string,
  modifiers: { meta?: boolean; shift?: boolean; alt?: boolean } = {},
): Promise<void> {
  owner = id;
  const editor = editorFor(id);
  editor.view.dom.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      metaKey: modifiers.meta ?? false,
      ctrlKey: false,
      shiftKey: modifiers.shift ?? false,
      altKey: modifiers.alt ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
  await settle();
}

function liveRoundTrip(id: string): ProseBlock {
  const block = blockById(id);
  return blockFromDoc(block, editorFor(id).getJSON());
}

function computedColorOf(id: string): string {
  const span = editorFor(id).view.dom.querySelector('span[style*="color"]');
  return span === null ? '' : window.getComputedStyle(span).color;
}

function nodeTypesIn(id: string): string[] {
  const types = new Set<string>();
  editorFor(id).state.doc.descendants((node) => {
    types.add(node.type.name);
    return true;
  });
  return [...types].sort();
}

/* -------------------------------------------------------------------------- */

async function run(): Promise<void> {
  /* ---------------------------------------------------------------- mount */
  section('mount');
  check('all fixture blocks mounted an editor', editors.size === FIXTURE_BLOCKS.length, `${editors.size}/${FIXTURE_BLOCKS.length}`);
  check('no content errors from TipTap', contentErrors.length === 0, contentErrors.join('; '));
  check(
    "every editor's top node is the one docs/cms-contracts.md 2.3 names",
    FIXTURE_BLOCKS.every(
      (block) => editorFor(block.id).state.doc.firstChild?.type.name === PROSE_NODE_TYPE[block.kind],
    ),
    FIXTURE_BLOCKS.map((block) => `${block.kind}:${editorFor(block.id).state.doc.firstChild?.type.name}`).join(' '),
  );
  check(
    'headings carry the level derived from kind, never from content',
    ['h2_heatmap', 'h3_detail'].every((id) => {
      const block = blockById(id);
      const level = editorFor(id).state.doc.firstChild?.attrs.level;
      return level === (block.kind === 'h2' ? 2 : 3);
    }),
  );
  check('onChange has not fired on mount', [...changeCounts.values()].length === 0, canonicalJson([...changeCounts]));

  /* ----------------------------------------------------------- round trip */
  section('round trip: live editor -> ProseBlock');
  for (const block of FIXTURE_BLOCKS) {
    const after = liveRoundTrip(block.id);
    const marks = collectProseMarks(block.content);
    const ok = check(
      `${block.id} (${block.kind}, ${marks.length === 0 ? 'no marks' : marks.map((mark) => mark.type).join('+')}): lossless`,
      canonicalJson(after) === canonicalJson(block),
    );
    if (!ok) {
      check(`${block.id}: before`, false, canonicalJson(block.content));
      check(`${block.id}: after`, false, canonicalJson(after.content));
    }
  }
  check(
    'every mark in the fixture survives with identical attrs',
    FIXTURE_BLOCKS.every(
      (block) =>
        canonicalJson(collectProseMarks(liveRoundTrip(block.id).content)) ===
        canonicalJson(collectProseMarks(block.content)),
    ),
  );
  check(
    "the link stores exactly href/target/rel (no TipTap class or title)",
    canonicalJson(collectProseMarks(liveRoundTrip('p_heatmap').content).find((mark) => mark.type === 'link')) ===
      canonicalJson({
        type: 'link',
        attrs: {
          href: 'https://habit-tracker-xi-gilt.vercel.app/welcome',
          target: '_blank',
          rel: 'noopener noreferrer',
        },
      }),
    canonicalJson(collectProseMarks(liveRoundTrip('p_heatmap').content)),
  );
  check(
    "the fixture's colour comes back byte-identical",
    canonicalJson(collectProseColors(liveRoundTrip('p_cover').content)) === canonicalJson(['#ff5722']),
    canonicalJson(collectProseColors(liveRoundTrip('p_cover').content)),
  );
  check(
    'no node type outside the 3.2 shape exists in any editor',
    FIXTURE_BLOCKS.every((block) =>
      nodeTypesIn(block.id).every((type) =>
        ['text', 'paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem'].includes(type),
      ),
    ),
  );

  /* -------------------------------------------------------------- editing */
  section('editing emits a whole, normalised ProseBlock');
  {
    const editor = editorFor('p_open');
    editor.commands.insertContentAt(1, 'ZZQ');
    // Wait on the rendered state, not on the counter: handleChange bumps the
    // counter before React has committed setBlocks, so the counter is true a
    // beat before blockById() can see the edit.
    const landed = await waitFor(() => collectProseText(blockById('p_open').content).includes('ZZQ'));
    check('typing fires onChange once', changeCounts.get('p_open') === 1, String(changeCounts.get('p_open')));
    check(
      'React state now holds the typed text',
      landed,
      collectProseText(blockById('p_open').content).slice(0, 20),
    );
    check(
      'and it kept the marks around it',
      canonicalJson(collectProseMarks(blockById('p_open').content)) ===
        canonicalJson(collectProseMarks(fixtureBlock('p_open').content)),
    );
    check('the id survived the edit', blockById('p_open').id === 'p_open');
    check('the kind survived the edit', blockById('p_open').kind === 'p');
    editor.commands.undo();
    check(
      'undo restores the fixture block exactly',
      await waitFor(() => canonicalJson(blockById('p_open')) === canonicalJson(fixtureBlock('p_open'))),
    );
  }

  section('an externally changed block is pushed into the editor');
  {
    const replacement: ProseBlock = {
      ...blockById('p_close'),
      content: [{ type: 'text', text: 'Replaced from outside the editor.' }],
    };
    bridge.set(bridge.get().map((block) => (block.id === 'p_close' ? replacement : block)));
    await waitFor(() => editorFor('p_close').getText() === 'Replaced from outside the editor.');
    check(
      'the editor shows the externally set content',
      editorFor('p_close').getText() === 'Replaced from outside the editor.',
      editorFor('p_close').getText(),
    );
    check(
      'and it did not bounce back through onChange',
      (changeCounts.get('p_close') ?? 0) === 0,
      String(changeCounts.get('p_close') ?? 0),
    );
    await reset();
    check(
      'resetting the prop restores the fixture content',
      canonicalJson(blockById('p_close')) === canonicalJson(fixtureBlock('p_close')),
    );
  }

  /* ------------------------------------------------------- floating toolbar */
  section('floating toolbar');
  check('no toolbar with nothing selected', toolbarCount() === 0, toolbarOwners());
  await focusBlock('p_open');
  check('a selection shows the toolbar', toolbar() !== null);
  check('exactly one toolbar exists', toolbarCount() === 1, toolbarOwners());
  check('and it belongs to the focused block', toolbar()?.getAttribute('data-prose-toolbar') === 'p_open', toolbarOwners());
  await focusBlock('p_cover');
  check(
    'moving focus to another editor moves the toolbar with it',
    toolbarCount() === 1 && toolbarOwners() === 'p_cover',
    focusReport(),
  );
  await focusBlock('p_open');
  {
    const box = toolbar()?.getBoundingClientRect();
    check(
      'it is on screen',
      box !== undefined && box.width > 0 && box.top >= 0 && box.left >= 0 && box.bottom <= window.innerHeight,
      box === undefined ? '' : `${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`,
    );
    check('it is portaled to the body, not nested in the editor', toolbar()?.parentElement === document.body);
    check('it offers all six block kinds', ['Paragraph', 'Heading 2', 'Heading 3', 'Quote', 'Bulleted list', 'Numbered list'].every((title) => byTitle(title) !== null));
    check('bold, italic, link and colour are present', ['Bold', 'Italic', 'Link', 'Text colour'].every((title) => byTitle(title) !== null));
  }

  section('bold and italic, by click and by keyboard');
  {
    // p_close carries no marks, so toggling twice has to land back on exactly
    // the fixture. (On p_open it could not: selecting a run that is only
    // partly bold and toggling twice correctly clears the bold that was
    // already there. That is ProseMirror doing the right thing, not a loss.)
    const pristine = fixtureBlock('p_close');
    await focusBlock('p_close');
    await clickToolbar('Bold', () => byTitle('Bold'));
    await waitFor(() => collectProseMarks(blockById('p_close').content).some((mark) => mark.type === 'bold'));
    const marks = collectProseMarks(blockById('p_close').content).map((mark) => mark.type);
    check('clicking B adds bold', marks.includes('bold'), marks.join('+'));
    check(
      'and adds nothing else',
      marks.every((mark) => ['bold', 'italic', 'link', 'textStyle'].includes(mark)),
      marks.join('+'),
    );
    await clickToolbar('Bold', () => byTitle('Bold'));
    await waitFor(() => canonicalJson(blockById('p_close')) === canonicalJson(pristine));
    check(
      'clicking B again returns the block to the fixture, exactly',
      canonicalJson(blockById('p_close')) === canonicalJson(pristine),
      canonicalJson(collectProseMarks(blockById('p_close').content).map((mark) => mark.type)),
    );

    await focusBlock('p_close');
    await press('p_close', 'b', { meta: true });
    check(
      'Mod-B toggles bold',
      await waitFor(() => collectProseMarks(blockById('p_close').content).some((mark) => mark.type === 'bold')),
    );
    await press('p_close', 'b', { meta: true });
    await press('p_close', 'i', { meta: true });
    check(
      'Mod-I toggles italic',
      await waitFor(() => collectProseMarks(blockById('p_close').content).some((mark) => mark.type === 'italic')),
    );
    await press('p_close', 'i', { meta: true });
    check(
      'both shortcuts are reversible with no residue',
      await waitFor(() => canonicalJson(blockById('p_close')) === canonicalJson(pristine)),
      canonicalJson(collectProseMarks(blockById('p_close').content).map((mark) => mark.type)),
    );

    // And on a partly-marked run, undo is what restores it.
    await focusBlock('p_open');
    await clickToolbar('Bold', () => byTitle('Bold'));
    await settle();
    editorFor('p_open').commands.undo();
    check(
      'on a partly bold run, undo restores the fixture exactly',
      await waitFor(() => canonicalJson(blockById('p_open')) === canonicalJson(fixtureBlock('p_open'))),
      canonicalJson(collectProseMarks(blockById('p_open').content).map((mark) => mark.type)),
    );
  }

  /* --------------------------------------------------------------- colour */
  section('text colour: palette swatches');
  {
    await focusBlock('p_close');
    await openColour();
    check('the colour popover opens', has('.pe-swatches'));
    check(
      'it shows the whole site palette',
      toolbar()?.querySelectorAll('.pe-swatch').length === PROSE_PALETTE.length,
      String(toolbar()?.querySelectorAll('.pe-swatch').length),
    );
    check('it offers a real colour picker', has('input[type="color"]'));
    check('it offers a hex field', has('.pe-input--hex'));
    check('it offers Default, to remove the mark', byTitle('Remove the colour mark') !== null);

    await clickToolbar('Accent swatch', () => byAriaLabel('Accent'));
    check(
      'clicking Accent stores a token reference, not a frozen hex',
      await waitFor(
        () =>
          canonicalJson(collectProseColors(blockById('p_close').content)) ===
          canonicalJson(['var(--accent, #ff5722)']),
      ),
      canonicalJson(collectProseColors(blockById('p_close').content)),
    );
    check(
      'and the round trip through the live editor keeps it verbatim',
      canonicalJson(collectProseColors(liveRoundTrip('p_close').content)) ===
        canonicalJson(['var(--accent, #ff5722)']),
    );

    // The hex field mirrors the stored colour, so it now reads #ff5722.
    // Leaving it must not rewrite the token as that flattened hex.
    const hexField = toolbar()?.querySelector<HTMLInputElement>('.pe-input--hex');
    check('the hex field mirrors the token', hexField?.value === '#ff5722', hexField?.value);
    // React's onBlur is the native focusout, which bubbles. A plain
    // non-bubbling 'blur' event would never reach the handler, and the
    // assertion below would pass for the wrong reason.
    hexField?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await settle();
    check(
      'and blurring it leaves the token alone',
      canonicalJson(collectProseColors(blockById('p_close').content)) ===
        canonicalJson(['var(--accent, #ff5722)']),
      canonicalJson(collectProseColors(blockById('p_close').content)),
    );
  }

  section('a palette colour survives dark mode (measured, not asserted)');
  {
    await setTheme('light');
    const light = computedColorOf('p_close');
    await setTheme('dark');
    const dark = computedColorOf('p_close');
    await setTheme('light');
    check('light mode resolves --accent to #ff5722', light === 'rgb(255, 87, 34)', light);
    check('dark mode resolves --accent to #f5a623', dark === 'rgb(245, 166, 35)', dark);
    check('so the same stored value renders two colours', light !== dark, `${light} -> ${dark}`);
  }

  section('a named colour flips too, once COLOR_TOKEN_CSS is loaded');
  {
    await focusBlock('p_close');
    await openColour();
    await clickToolbar('Red swatch', () => byAriaLabel('Red'));
    check(
      'Red stores var(--fc-red, #c0392b)',
      await waitFor(
        () =>
          canonicalJson(collectProseColors(blockById('p_close').content)) ===
          canonicalJson(['var(--fc-red, #c0392b)']),
      ),
      canonicalJson(collectProseColors(blockById('p_close').content)),
    );
    await setTheme('light');
    const light = computedColorOf('p_close');
    await setTheme('dark');
    const dark = computedColorOf('p_close');
    await setTheme('light');
    check('light: #c0392b', light === 'rgb(192, 57, 43)', light);
    check('dark: #e8695a', dark === 'rgb(232, 105, 90)', dark);
  }

  section('an arbitrary colour, and Default');
  {
    await focusBlock('p_close');
    await openColour();
    await typeInto('.pe-input--hex', '#2E7D52');
    check(
      'a typed hex is stored canonically, lowercase',
      await waitFor(
        () => canonicalJson(collectProseColors(blockById('p_close').content)) === canonicalJson(['#2e7d52']),
      ),
      canonicalJson(collectProseColors(blockById('p_close').content)),
    );
    await setTheme('dark');
    const dark = computedColorOf('p_close');
    await setTheme('light');
    check('a frozen hex does not flip, which is the control', dark === 'rgb(46, 125, 82)', dark);

    await focusBlock('p_close');
    await openColour();
    await clickToolbar('Default', () => byTitle('Remove the colour mark'));
    check(
      'Default removes the textStyle mark entirely, rather than storing ink',
      await waitFor(() =>
        collectProseMarks(blockById('p_close').content).every((mark) => mark.type !== 'textStyle'),
      ),
      canonicalJson(collectProseMarks(blockById('p_close').content)),
    );
    await reset();
  }

  /* ----------------------------------------------------------------- link */
  section('link');
  {
    await focusBlock('p_close');
    await press('p_close', 'k', { meta: true });
    check('Mod-K opens the link field', await waitFor(() => has('.pe-input--href')), toolbarOwners());
    await typeInto('.pe-input--href', 'example.com/a');
    await waitFor(() => collectProseMarks(blockById('p_close').content).some((mark) => mark.type === 'link'));
    const link = collectProseMarks(blockById('p_close').content).find((mark) => mark.type === 'link');
    check(
      'a bare host is stored as https, with target and rel',
      canonicalJson(link) ===
        canonicalJson({
          type: 'link',
          attrs: { href: 'https://example.com/a', target: '_blank', rel: 'noopener noreferrer' },
        }),
      canonicalJson(link),
    );
    await focusBlock('p_close');
    await openLink();
    await clickToolbar('Remove link', () => toolbarButton((button) => button.textContent === 'Remove'));
    check(
      'Remove takes the link mark off',
      await waitFor(() =>
        collectProseMarks(blockById('p_close').content).every((mark) => mark.type !== 'link'),
      ),
    );
    await reset();
  }

  /* ------------------------------------------------------------ block kind */
  section('block kind, through the toolbar');
  {
    const original = blockById('p_close');
    const words = collectProseText(original.content);
    await focusBlock('p_close');
    await clickToolbar('Heading 2', () => byTitle('Heading 2'));
    await waitFor(() => blockById('p_close').kind === 'h2');
    await waitFor(() => editors.get('p_close')?.state.doc.firstChild?.type.name === 'heading');
    check('clicking H2 changes the kind', blockById('p_close').kind === 'h2', blockById('p_close').kind);
    check('the words come with it', collectProseText(blockById('p_close').content) === words);
    check('the id is untouched', blockById('p_close').id === 'p_close');
    check(
      'the editor was rebuilt on the heading schema',
      editorFor('p_close').state.doc.firstChild?.type.name === 'heading',
      String(editorFor('p_close').state.doc.firstChild?.type.name),
    );
    check(
      'and the level came from the kind',
      editorFor('p_close').state.doc.firstChild?.attrs.level === 2,
    );

    await focusBlock('p_close');
    await clickToolbar('Bulleted list', () => byTitle('Bulleted list'));
    await waitFor(() => blockById('p_close').kind === 'ul');
    await waitFor(() => editors.get('p_close')?.state.doc.firstChild?.type.name === 'bulletList');
    check('h2 -> ul produces list items wrapping a paragraph', canonicalJson(blockById('p_close').content) === canonicalJson([
      { type: 'listItem', content: [{ type: 'paragraph', content: original.content }] },
    ]), canonicalJson(blockById('p_close').content));

    await focusBlock('p_close');
    await clickToolbar('Paragraph', () => byTitle('Paragraph'));
    await waitFor(() => blockById('p_close').kind === 'p');
    check(
      'and back to a paragraph it is the fixture block again',
      await waitFor(() => canonicalJson(blockById('p_close')) === canonicalJson(original)),
      canonicalJson(blockById('p_close').content),
    );
  }

  /* -------------------------------------------------------------- keyboard */
  section('Enter cuts a paragraph in two');
  {
    await reset();
    const whole = collectProseText(blockById('p_open').content);
    const at = 6;
    const countBefore = bridge.get().length;

    editorFor('p_open').chain().focus().setTextSelection(at + 1).run();
    await press('p_open', 'Enter');
    await waitFor(() => bridge.get().length === countBefore + 1);

    check('the band gains a block', bridge.get().length === countBefore + 1, `${countBefore} -> ${bridge.get().length}`);
    // Still one node per editor: the contract's whole point. The second
    // paragraph is a second BLOCK, never a second node inside this one.
    check('and the original editor still holds exactly one node', editorFor('p_open').state.doc.childCount === 1);
    check(
      'the original keeps its id, and the text before the caret',
      collectProseText(blockById('p_open').content) === whole.slice(0, at),
      JSON.stringify(collectProseText(blockById('p_open').content)),
    );

    const made = bridge.get()[bridge.get().indexOf(blockById('p_open')) + 1];
    check('the new block holds the text after it', collectProseText(made.content) === whole.slice(at), JSON.stringify(collectProseText(made.content)));
    check('the new block is a paragraph too', made.kind === 'p', made.kind);
    check('no character was lost', collectProseText(blockById('p_open').content) + collectProseText(made.content) === whole);

    // The caret has to follow the author into the new block, or the next thing
    // they type goes somewhere they are not looking.
    const landed = await waitFor(() => editors.get(made.id)?.isFocused === true);
    check('the caret moves into the new block', landed, `focused=${editors.get(made.id)?.isFocused}`);
    check(
      'and sits at its start, before the moved text',
      editors.get(made.id)?.state.selection.from === 1,
      String(editors.get(made.id)?.state.selection.from),
    );

    // Backspace there puts it back exactly, with no space at the seam.
    await press(made.id, 'Backspace');
    await waitFor(() => bridge.get().length === countBefore);
    check('Backspace at the start joins the block back onto the one above', bridge.get().length === countBefore, String(bridge.get().length));
    check(
      'and the sentence is character-for-character what it was',
      collectProseText(blockById('p_open').content) === whole,
      JSON.stringify(collectProseText(blockById('p_open').content)),
    );
    check(
      'with the caret on the seam, where the join happened',
      editorFor('p_open').state.selection.from === at + 1,
      `${editorFor('p_open').state.selection.from} (want ${at + 1})`,
    );

    await reset();
  }

  section('a split never leaves an empty heading');
  {
    await reset();
    const before = bridge.get().length;

    // Enter at the START of a heading: how you push a heading down to make a
    // blank row above it. The blank row must be a paragraph; left as a
    // heading, a screen reader announces "heading level 2, blank".
    editorFor('h2_heatmap').chain().focus().setTextSelection(1).run();
    await press('h2_heatmap', 'Enter');
    await waitFor(() => bridge.get().length === before + 1);
    check('the blank row left above is a paragraph, not a heading', blockById('h2_heatmap').kind === 'p', blockById('h2_heatmap').kind);
    check('and it is empty', blockById('h2_heatmap').content.length === 0);
    const moved = bridge.get()[bridge.get().indexOf(blockById('h2_heatmap')) + 1];
    check('the heading itself moved down, still a heading', moved.kind === 'h2', moved.kind);
    check('with all of its words', collectProseText(moved.content) === collectProseText(fixtureBlock('h2_heatmap').content), collectProseText(moved.content));
    await reset();

    // Enter at the END of a heading starts a paragraph, which is the case
    // that already worked and must keep working.
    const h2 = editorFor('h2_heatmap');
    h2.chain().focus().setTextSelection(h2.state.doc.content.size - 1).run();
    await press('h2_heatmap', 'Enter');
    await waitFor(() => bridge.get().length === before + 1);
    const after = bridge.get()[bridge.get().indexOf(blockById('h2_heatmap')) + 1];
    check('Enter at the end of a heading starts a paragraph', after.kind === 'p', after.kind);
    check('and the heading keeps its words', collectProseText(blockById('h2_heatmap').content) === collectProseText(fixtureBlock('h2_heatmap').content));
    await reset();
  }

  section('Shift-Enter breaks the line without breaking the block');
  {
    await reset();
    const countBefore = bridge.get().length;
    const whole = collectProseText(blockById('p_open').content);
    const at = 6;

    editorFor('p_open').chain().focus().setTextSelection(at + 1).run();
    await press('p_open', 'Enter', { shift: true });
    await waitFor(() => nodeTypesIn('p_open').includes('hardBreak'));

    // The difference from Enter, which is the whole reason both keys exist.
    check('it does NOT add a block', bridge.get().length === countBefore, String(bridge.get().length));
    check('it inserts a hardBreak', nodeTypesIn('p_open').includes('hardBreak'), nodeTypesIn('p_open').join(','));
    check('the editor still holds exactly one top node', editorFor('p_open').state.doc.childCount === 1);
    check(
      'no character is lost: the break is the only thing added',
      collectProseText(blockById('p_open').content).replace('\n', '') === whole,
      JSON.stringify(collectProseText(blockById('p_open').content).slice(0, 24)),
    );
    check(
      'and it lands where the caret was',
      collectProseText(blockById('p_open').content).indexOf('\n') === at,
      String(collectProseText(blockById('p_open').content).indexOf('\n')),
    );

    // The stored block has to round trip, or the break is lost on the next
    // save and the author's line quietly re-joins.
    check(
      'the block round trips through the live editor unchanged',
      canonicalJson(liveRoundTrip('p_open').content) === canonicalJson(blockById('p_open').content),
      canonicalJson(liveRoundTrip('p_open').content).slice(0, 80),
    );

    // Enter after a Shift-Enter: the break is one position wide, so the split
    // offsets have to account for it or the cut lands a character out.
    const broken = collectProseText(blockById('p_open').content);
    editorFor('p_open').chain().focus().setTextSelection(at + 6).run();
    await press('p_open', 'Enter');
    await waitFor(() => bridge.get().length === countBefore + 1);
    const tail = bridge.get()[bridge.get().indexOf(blockById('p_open')) + 1];
    check(
      'Enter after a break still cuts exactly at the caret',
      collectProseText(blockById('p_open').content) + collectProseText(tail.content) === broken,
      `${JSON.stringify(collectProseText(blockById('p_open').content))} + ${JSON.stringify(collectProseText(tail.content).slice(0, 16))}`,
    );

    await reset();
  }

  section('the callout box');
  {
    await reset();
    const root = () => document.querySelector('[data-prose-block="callout_guide"]') as HTMLElement | null;

    check('a callout mounts like any other block', editors.has('callout_guide'));
    check(
      'its top node is a paragraph: the content is a paragraph\'s, only the box differs',
      editorFor('callout_guide').state.doc.firstChild?.type.name === 'paragraph',
      editorFor('callout_guide').state.doc.firstChild?.type.name,
    );
    check('the link inside survives the round trip', collectProseMarks(blockById('callout_guide').content).some((m) => m.type === 'link'));

    // The editor has to SHOW the box, or the one thing a callout is for is
    // invisible until the page is published.
    const box = root();
    const styles = box === null ? null : getComputedStyle(box.querySelector('.pe-content') as HTMLElement);
    check('the editor draws the box, not a bare paragraph', styles !== null && styles.backgroundColor !== 'rgba(0, 0, 0, 0)', styles?.backgroundColor);
    check(
      'and in the tone the block stores',
      box?.getAttribute('data-tone') === 'blue',
      box?.getAttribute('data-tone') ?? 'none',
    );

    // The box has to be the size the published page makes it. It was 92px
    // here against 60px there, because the editor puts a real paragraph
    // inside and it arrived with a margin of its own on top of the box's
    // padding. One line of 28px text in 16px of padding is 60px, and nothing
    // inside the box may add to that.
    const content = box?.querySelector('.pe-content') as HTMLElement | null;
    const inner = content?.querySelector('p') ?? null;
    check(
      'the box is the height the page makes it, not taller',
      content !== null && Math.round(content.getBoundingClientRect().height) === 60,
      `${Math.round(content?.getBoundingClientRect().height ?? 0)}px`,
    );
    check(
      'because nothing inside it adds a margin of its own',
      inner !== null && getComputedStyle(inner).marginTop === '0px' && getComputedStyle(inner).marginBottom === '0px',
      inner === null ? 'no paragraph' : `${getComputedStyle(inner).marginTop} / ${getComputedStyle(inner).marginBottom}`,
    );

    // Converting away and back is how the kind buttons work, and a callout
    // must not lose its words on the way.
    const words = collectProseText(blockById('callout_guide').content);
    bridge.set(bridge.get().map((b) => (b.id === 'callout_guide' ? { ...b, kind: 'p' as const } : b)));
    await waitFor(() => blockById('callout_guide').kind === 'p');
    check('converting a callout to a paragraph keeps its words', collectProseText(blockById('callout_guide').content) === words);
    await reset();
  }

  section('the highlighter');
  {
    await reset();
    await focusBlock('p_close');
    await openInks();

    check('the highlighter popover opens', has('.pe-inks'));
    check(
      'it offers one button per pen and no colour picker',
      toolbar()?.querySelectorAll('.pe-ink').length === HIGHLIGHT_INKS.length &&
        !has('input[type="color"]'),
      String(toolbar()?.querySelectorAll('.pe-ink').length),
    );

    const inks = () => [...(toolbar()?.querySelectorAll<HTMLButtonElement>('.pe-ink') ?? [])];
    inks()[1]?.click();
    await waitFor(() => collectProseMarks(blockById('p_close').content).some((m) => m.type === 'highlight'));

    const stored = collectProseMarks(blockById('p_close').content).find((m) => m.type === 'highlight');
    check('clicking a pen stores a highlight mark', stored !== undefined, canonicalJson(stored));
    check(
      'carrying an ink NAME, not a colour: the stroke is a class in the stylesheet',
      canonicalJson(stored?.attrs) === canonicalJson({ ink: HIGHLIGHT_INKS[1] }),
      canonicalJson(stored?.attrs),
    );
    check(
      'and the editor draws the same classes the published page will',
      editorFor('p_close').view.dom.querySelector(`mark.doc-hl.doc-hl--${HIGHLIGHT_INKS[1]}`) !== null,
      editorFor('p_close').view.dom.innerHTML.slice(0, 90),
    );
    // The brush is a background image, so the text itself is untouched: that
    // is the whole reason it is drawn behind the words rather than over them.
    const markEl = editorFor('p_close').view.dom.querySelector('mark.doc-hl');
    const painted = markEl === null ? '' : getComputedStyle(markEl).backgroundImage;
    check('the pen paints a brush stroke, not a flat colour', painted.startsWith('url('), painted.slice(0, 40));
    check(
      'and it is a background, so the glyphs keep their own colour',
      markEl !== null && getComputedStyle(markEl).backgroundColor === 'rgba(0, 0, 0, 0)',
      markEl === null ? 'no mark' : getComputedStyle(markEl).backgroundColor,
    );

    check(
      'the block still round trips through the live editor',
      canonicalJson(liveRoundTrip('p_close').content) === canonicalJson(blockById('p_close').content),
    );

    // Same pen again turns it off; that is what makes the button a toggle.
    await openInks();
    inks()[1]?.click();
    await waitFor(() => !collectProseMarks(blockById('p_close').content).some((m) => m.type === 'highlight'));
    check(
      'clicking the same pen again removes it',
      !collectProseMarks(blockById('p_close').content).some((m) => m.type === 'highlight'),
      canonicalJson(collectProseMarks(blockById('p_close').content)),
    );
    await reset();
  }

  section('Shift-Enter works in the other kinds too');
  {
    await reset();
    await press('h2_heatmap', 'Enter', { shift: true });
    check('a heading takes a line break', nodeTypesIn('h2_heatmap').includes('hardBreak'), nodeTypesIn('h2_heatmap').join(','));
    const items = blockById('ul_habits').content.length;
    editorFor('ul_habits').chain().focus().setTextSelection(3).run();
    await press('ul_habits', 'Enter', { shift: true });
    await waitFor(() => nodeTypesIn('ul_habits').includes('hardBreak'));
    check('a list item takes one without becoming a new item', nodeTypesIn('ul_habits').includes('hardBreak') && blockById('ul_habits').content.length === items, `${items} items`);
    await reset();
  }

  section('Backspace only merges where it should');
  {
    await reset();
    const countBefore = bridge.get().length;

    // Mid-paragraph, Backspace is ProseMirror's (really the browser's) own
    // deletion and must never reach the host. Measured by whether the host was
    // asked at all: a synthetic keydown cannot drive the browser's native
    // character deletion, so the text alone would not tell the two apart.
    const callsBefore = mergeCalls;
    editorFor('p_open').chain().focus().setTextSelection(6).run();
    await press('p_open', 'Backspace');
    check('Backspace mid-paragraph never asks to merge', mergeCalls === callsBefore, `${callsBefore} -> ${mergeCalls}`);
    check('and no block is removed', bridge.get().length === countBefore, String(bridge.get().length));

    // At the very start it does ask. But this is the FIRST block, so there is
    // nothing above to merge into and the host declines.
    editorFor('p_open').chain().focus().setTextSelection(1).run();
    await press('p_open', 'Backspace');
    check('Backspace at the start does ask', mergeCalls === callsBefore + 1, `${callsBefore} -> ${mergeCalls}`);
    check('but the first block has nothing above it, so nothing happens', bridge.get().length === countBefore, String(bridge.get().length));
    check(
      'and its text is untouched',
      canonicalJson(blockById('p_open')) === canonicalJson(fixtureBlock('p_open')),
      collectProseText(blockById('p_open').content).slice(0, 20),
    );

    // A list is a block container: Enter already works inside it, and merging
    // a paragraph into it would have to guess which item the text joins.
    const listCalls = mergeCalls;
    editorFor('ul_habits').chain().focus().setTextSelection(1).run();
    await press('ul_habits', 'Backspace');
    check('Backspace in a list never asks to merge either', mergeCalls === listCalls, `${listCalls} -> ${mergeCalls}`);

    await reset();
  }

  section('keys that must work');
  {
    const editor = editorFor('ul_habits');
    const itemsBefore = blockById('ul_habits').content.length;
    editor.chain().focus().setTextSelection(editor.state.doc.content.size - 2).run();
    await press('ul_habits', 'Enter');
    await waitFor(() => blockById('ul_habits').content.length === itemsBefore + 1);
    check(
      'Enter in a list adds one item',
      blockById('ul_habits').content.length === itemsBefore + 1,
      `${itemsBefore} -> ${blockById('ul_habits').content.length}`,
    );
    check(
      'and the new item is a listItem wrapping a paragraph',
      canonicalJson(blockById('ul_habits').content[blockById('ul_habits').content.length - 1]) ===
        canonicalJson({ type: 'listItem', content: [{ type: 'paragraph' }] }),
      canonicalJson(blockById('ul_habits').content[blockById('ul_habits').content.length - 1]),
    );
    await press('ul_habits', 'Tab');
    check(
      'Tab cannot nest a list inside a list',
      blockById('ul_habits').content.every(
        (item) => canonicalJson(item).indexOf('bulletList') === -1,
      ),
      canonicalJson(blockById('ul_habits').content),
    );
    await reset();
  }

  /* ----------------------------------------------------------------- final */
  section('final state');
  check(
    'after every test above, all nine blocks equal the fixture again',
    canonicalJson(bridge.get()) === canonicalJson(FIXTURE_BLOCKS),
  );
  check('still no content errors', contentErrors.length === 0, contentErrors.join('; '));
  check(
    'and the editors still round trip losslessly',
    FIXTURE_BLOCKS.every((block) => canonicalJson(liveRoundTrip(block.id)) === canonicalJson(block)),
  );

  render();
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

// The --fc-* tokens the five named colours reference. WS-1 will put these in
// doc.css; the harness injects them so the dark-mode measurement is real.
const tokenStyle = document.createElement('style');
tokenStyle.textContent = COLOR_TOKEN_CSS;
document.head.appendChild(tokenStyle);

const container = document.getElementById('root');
if (container === null) throw new Error('no #root');
createRoot(container).render(<App />);

void (async () => {
  await settle();
  try {
    await run();
  } catch (error) {
    check('the harness ran to completion', false, (error as Error).stack ?? String(error));
    render();
  }
})();
