/**
 * src/cms/app/prose/Toolbar.tsx
 *
 * WS-5. The floating toolbar: appears over the selection, follows it, and
 * carries everything the brief asks for (block kind, bold, italic, link, text
 * colour).
 *
 * Positioned from posToDOMRect, which is ProseMirror's own measurement of the
 * selection, so it tracks a selection that spans lines and one that is inside
 * a scrolled container. Rendered into a portal on document.body by default:
 * position:fixed inside a transformed ancestor is measured against that
 * ancestor, and the editor shell may well put a transform somewhere above us.
 *
 * Two details that make it usable rather than merely present:
 *
 *  - Every button calls preventDefault on mousedown, so clicking it does not
 *    blur the editor and does not collapse the selection. The commands then
 *    apply to the run the author actually highlighted.
 *  - The toolbar stays open while focus is inside it, which is what lets the
 *    link field and the hex field exist at all.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { createPortal } from 'react-dom';
import { posToDOMRect } from '@tiptap/core';
import type { Editor } from '@tiptap/core';

import { PROSE_KINDS, PROSE_KIND_LABEL, PROSE_KIND_TITLE } from './extensions.ts';
import type { ProseBlockKind } from '../../schema.ts';
import { ColorControl, useColorTheme } from './ColorControl.tsx';
import { LinkControl } from './LinkControl.tsx';
import { colorLabel, resolveColorToHex } from './palette.ts';

const GAP = 8;

/**
 * Re-render on anything that can change what the toolbar shows.
 *
 * The document-level focusin is not redundant with the editor's own blur
 * event. With several editors on a page, focus moving from one to another must
 * re-evaluate EVERY toolbar's visibility in the same beat, or the editor that
 * just lost focus leaves its toolbar on screen. One listener per editor, for a
 * handful of editors, for one person.
 */
export function useEditorTick(editor: Editor | null): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (editor === null) return undefined;
    const bump = (): void => setTick((value) => value + 1);
    editor.on('transaction', bump);
    editor.on('focus', bump);
    editor.on('blur', bump);
    if (typeof document !== 'undefined') document.addEventListener('focusin', bump, true);
    return () => {
      editor.off('transaction', bump);
      editor.off('focus', bump);
      editor.off('blur', bump);
      if (typeof document !== 'undefined') document.removeEventListener('focusin', bump, true);
    };
  }, [editor]);
}

type Panel = 'none' | 'link' | 'color';

export type ProseToolbarProps = {
  editor: Editor;
  /**
   * The block this toolbar belongs to. Written to `data-prose-toolbar` so a
   * host (or a test) can tell two editors' toolbars apart, and so a stray
   * second toolbar is visible rather than mysterious.
   */
  blockId: string;
  kind: ProseBlockKind;
  onKindChange: (kind: ProseBlockKind) => void;
  showKindControls: boolean;
  /** Portal target. Defaults to document.body. */
  container: HTMLElement | null;
  /** Bumped by Mod-K. Opens the link field. */
  linkRequest: number;
};

const HOLD_FOCUS = (event: { preventDefault: () => void }): void => event.preventDefault();

export function ProseToolbar({
  editor,
  blockId,
  kind,
  onKindChange,
  showKindControls,
  container,
  linkRequest,
}: ProseToolbarProps): JSX.Element | null {
  useEditorTick(editor);
  const theme = useColorTheme();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [panel, setPanel] = useState<Panel>('none');
  const [interacting, setInteracting] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [viewportTick, setViewportTick] = useState(0);

  // Mod-K.
  useEffect(() => {
    if (linkRequest === 0) return;
    setPanel('link');
  }, [linkRequest]);

  // Scrolling and resizing move the selection without changing the document,
  // so neither fires an editor transaction.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const bump = (): void => setViewportTick((value) => value + 1);
    window.addEventListener('scroll', bump, true);
    window.addEventListener('resize', bump);
    return () => {
      window.removeEventListener('scroll', bump, true);
      window.removeEventListener('resize', bump);
    };
  }, []);

  const destroyed = editor.isDestroyed;
  const selection = destroyed ? null : editor.state.selection;
  const hasRange = selection !== null && !selection.empty;
  // An empty block has nothing to select, and still needs its kind changeable.
  const visible =
    !destroyed && (hasRange || editor.isEmpty) && (editor.isFocused || interacting);

  useEffect(() => {
    if (!visible && panel !== 'none') setPanel('none');
  }, [visible, panel]);

  useLayoutEffect(() => {
    if (!visible || selection === null) {
      if (pos !== null) setPos(null);
      return;
    }
    const element = rootRef.current;
    if (element === null || typeof window === 'undefined') return;
    const rect = posToDOMRect(editor.view, selection.from, selection.to);
    const box = element.getBoundingClientRect();
    let top = rect.top - box.height - GAP;
    if (top < GAP) top = rect.bottom + GAP;
    top = Math.max(GAP, Math.min(top, window.innerHeight - box.height - GAP));
    let left = rect.left + rect.width / 2 - box.width / 2;
    left = Math.max(GAP, Math.min(left, window.innerWidth - box.width - GAP));
    if (pos === null || Math.abs(pos.top - top) > 0.5 || Math.abs(pos.left - left) > 0.5) {
      setPos({ top, left });
    }
    // viewportTick and panel are read so the position is recomputed when the
    // page scrolls or the toolbar changes height.
  }, [visible, selection, editor, pos, panel, viewportTick]);

  if (!visible) return null;

  const target =
    container ?? (typeof document === 'undefined' ? null : document.body);
  if (target === null) return null;

  const color = (editor.getAttributes('textStyle').color as string | undefined) ?? null;
  const href = (editor.getAttributes('link').href as string | undefined) ?? null;

  const toolbar = (
    <div
      ref={rootRef}
      className="pe-toolbar"
      role="toolbar"
      aria-label="Formatting"
      data-prose-toolbar={blockId}
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos === null ? 'hidden' : 'visible',
      }}
      onFocus={() => setInteracting(true)}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next !== null && rootRef.current?.contains(next) === true) return;
        setInteracting(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && panel !== 'none') {
          event.preventDefault();
          setPanel('none');
          editor.commands.focus();
        }
      }}
    >
      <div className="pe-row">
        {showKindControls
          ? PROSE_KINDS.map((candidate) => (
              <button
                key={candidate}
                type="button"
                className="pe-btn"
                aria-pressed={candidate === kind}
                title={PROSE_KIND_TITLE[candidate]}
                onMouseDown={HOLD_FOCUS}
                onClick={() => onKindChange(candidate)}
              >
                {PROSE_KIND_LABEL[candidate]}
              </button>
            ))
          : null}
        {showKindControls ? <div className="pe-sep" /> : null}

        <button
          type="button"
          className="pe-btn pe-btn--bold"
          aria-pressed={editor.isActive('bold')}
          title="Bold (Cmd-B)"
          onMouseDown={HOLD_FOCUS}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          B
        </button>
        <button
          type="button"
          className="pe-btn pe-btn--italic"
          aria-pressed={editor.isActive('italic')}
          title="Italic (Cmd-I)"
          onMouseDown={HOLD_FOCUS}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          I
        </button>
        <button
          type="button"
          className="pe-btn"
          aria-pressed={editor.isActive('link')}
          title="Link (Cmd-K)"
          onMouseDown={HOLD_FOCUS}
          onClick={() => setPanel(panel === 'link' ? 'none' : 'link')}
        >
          Link
        </button>

        <div className="pe-sep" />

        <button
          type="button"
          className="pe-btn"
          aria-pressed={panel === 'color'}
          title={`Text colour: ${colorLabel(color)}`}
          onMouseDown={HOLD_FOCUS}
          onClick={() => setPanel(panel === 'color' ? 'none' : 'color')}
        >
          <span
            className="pe-dot"
            style={{ background: color === null ? 'transparent' : resolveColorToHex(color, theme) }}
          />
          Colour
        </button>
      </div>

      {panel === 'link' ? (
        <LinkControl editor={editor} current={href} onClose={() => setPanel('none')} />
      ) : null}
      {panel === 'color' ? <ColorControl editor={editor} current={color} /> : null}
    </div>
  );

  return createPortal(toolbar, target);
}
