/**
 * src/cms/app/prose/harness/keys.tsx
 *
 * A BAND of real ProseEditors, wired exactly as src/cms/app/index.tsx wires
 * them, for the keys that only mean anything when a block has neighbours.
 *
 * The harness next door (main.tsx) drives one editor and proves the component.
 * This one exists because five of the keys people press most are not about
 * the component at all: they are about what happens at the EDGE of a block,
 * which needs a host holding a list of blocks and moving the caret between
 * them. All five were dead until 2026-10-13, each for the same underlying
 * reason — one ProseBlock is one ProseMirror document, so there is nothing
 * inside a block for the caret to cross into — and each needed its own fix:
 *
 *   Enter on an empty bullet      breaks the list open there
 *   Delete at the end of a block  pulls the next one up
 *   ArrowDown / ArrowUp           cross into the neighbouring block
 *   ArrowRight / ArrowLeft        the same, from the very ends
 *
 * Driven by ./keys.mjs. The host logic here is a copy of ProseSlot's, which
 * is the one thing about this file that could drift; if you change the real
 * one, change this one, and the assertions will tell you if you did it wrong.
 */

import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { ProseEditor } from '../ProseEditor.tsx';
import {
  SINGLE_LINE_KINDS,
  inlineLength,
  joinInlineContent,
} from '../index.ts';
import type { ProseNode } from '../index.ts';
import { newId } from '../../../schema.ts';
import type { ProseBlock, ProseBlockKind } from '../../../schema.ts';
import { SHELL_CSS } from '../../shell/styles.ts';

const text = (t: string) => [{ type: 'text', text: t }];
const li = (t: string) => ({ type: 'listItem', content: [{ type: 'paragraph', content: text(t) }] });

const START: ProseBlock[] = [
  { id: 'p1', kind: 'p', content: text('A first paragraph.') },
  { id: 'gap', kind: 'p', content: [] },
  { id: 'p2', kind: 'p', content: text('A second paragraph.') },
  { id: 'list', kind: 'ul', content: [li('One'), li('Two')] },
  { id: 'p3', kind: 'p', content: text('After the list.') },
];

/** Where a caret request is left for a block that may not be mounted yet. */
const carets = new Map<string, 'start' | 'end' | number>();
const listeners = new Set<() => void>();
function requestCaret(id: string, at: 'start' | 'end' | number) {
  carets.set(id, at);
  for (const l of [...listeners]) l();
}

/** The same shape as useCaretRequest in src/cms/app/index.tsx. */
function useCaret(id: string) {
  const [caret, setCaret] = useState<{ at: 'start' | 'end' | number; nonce: number } | null>(null);
  useEffect(() => {
    const collect = (): void => {
      const at = carets.get(id);
      if (at === undefined) return;
      carets.delete(id);
      setCaret((p) => ({ at, nonce: (p?.nonce ?? 0) + 1 }));
    };
    listeners.add(collect);
    collect();
    return () => {
      listeners.delete(collect);
    };
  }, [id]);
  return caret;
}

function Slot({
  block,
  blocks,
  setBlocks,
}: {
  block: ProseBlock;
  blocks: ProseBlock[];
  setBlocks: (f: (all: ProseBlock[]) => ProseBlock[]) => void;
}) {
  const onChange = useCallback(
    (next: ProseBlock) => setBlocks((all) => all.map((b) => (b.id === next.id ? next : b))),
    [setBlocks],
  );

  const onSplit = (head: ProseNode[], tail: ProseNode[]) => {
    const heading = block.kind === 'h2' || block.kind === 'h3';
    const tailKind: ProseBlockKind = heading && tail.length === 0 ? 'p' : block.kind;
    const headKind: ProseBlockKind = heading && head.length === 0 ? 'p' : block.kind;
    const fresh: ProseBlock = { id: newId('p'), kind: tailKind, content: tail };
    setBlocks((all) => {
      const i = all.findIndex((b) => b.id === block.id);
      if (i < 0) return all;
      const copy = [...all];
      copy.splice(i, 1, { ...all[i]!, kind: headKind, content: head }, fresh);
      return copy;
    });
    requestCaret(fresh.id, 'start');
  };

  const onMergeUp = (): boolean => {
    const i = blocks.findIndex((b) => b.id === block.id);
    if (i < 1) return false;
    const prev = blocks[i - 1]!;
    if (!SINGLE_LINE_KINDS.has(prev.kind) || !SINGLE_LINE_KINDS.has(block.kind)) return false;
    const seam = inlineLength(prev.content);
    setBlocks((all) => {
      const copy = [...all];
      copy.splice(i, 1);
      copy[i - 1] = { ...prev, content: joinInlineContent(prev.content, block.content) };
      return copy;
    });
    requestCaret(prev.id, seam);
    return true;
  };

  const onMergeDown = (): boolean => {
    const i = blocks.findIndex((b) => b.id === block.id);
    const next = i >= 0 ? blocks[i + 1] : undefined;
    if (next === undefined) return false;
    if (!SINGLE_LINE_KINDS.has(next.kind) || !SINGLE_LINE_KINDS.has(block.kind)) return false;
    const seam = inlineLength(block.content);
    setBlocks((all) => {
      const copy = [...all];
      copy.splice(i + 1, 1);
      copy[i] = { ...block, content: joinInlineContent(block.content, next.content) };
      return copy;
    });
    requestCaret(block.id, seam);
    return true;
  };

  const onSplitList = (before: ProseNode[], after: ProseNode[]): boolean => {
    const paragraph: ProseBlock = { id: newId('p'), kind: 'p', content: [] };
    setBlocks((all) => {
      const i = all.findIndex((b) => b.id === block.id);
      if (i < 0) return all;
      const replacement: ProseBlock[] = [];
      if (before.length > 0) replacement.push({ ...all[i]!, content: before });
      replacement.push(paragraph);
      if (after.length > 0) replacement.push({ id: newId('p'), kind: block.kind, content: after });
      const copy = [...all];
      copy.splice(i, 1, ...replacement);
      return copy;
    });
    requestCaret(paragraph.id, 'start');
    return true;
  };

  const onLeaveEdge = (direction: 'up' | 'down' | 'left' | 'right'): boolean => {
    const back = direction === 'up' || direction === 'left';
    const i = blocks.findIndex((b) => b.id === block.id);
    if (i < 0) return false;
    const neighbour = blocks[back ? i - 1 : i + 1];
    if (neighbour === undefined) return false;
    requestCaret(neighbour.id, back ? 'end' : 'start');
    return true;
  };

  const caret = useCaret(block.id);

  return (
    <div className="cms-slot" data-block={block.id}>
      <ProseEditor
        block={block}
        onChange={onChange}
        onSplit={onSplit}
        onMergeUp={onMergeUp}
        onMergeDown={onMergeDown}
        onSplitList={onSplitList}
        onLeaveEdge={onLeaveEdge}
        caret={caret}
        showKindControls
      />
    </div>
  );
}

function Band() {
  const [blocks, setBlocks] = useState<ProseBlock[]>(START);
  (window as unknown as { blocks: () => ProseBlock[] }).blocks = () => blocks;
  return (
    <div className="cms-surface cms-surface--essays" id="surface">
      {blocks.map((block) => (
        <Slot key={block.id} block={block} blocks={blocks} setBlocks={setBlocks} />
      ))}
    </div>
  );
}

const style = document.createElement('style');
style.textContent = SHELL_CSS;
document.head.append(style);
createRoot(document.getElementById('root')!).render(<Band />);
