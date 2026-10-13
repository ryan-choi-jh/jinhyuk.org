/**
 * src/cms/app/prose/ProseEditor.tsx
 *
 * WS-5. `<ProseEditor block onChange />`.
 *
 * One editor per ProseBlock. The block is the state; the editor is a view of
 * it. Everything the component emits is a whole ProseBlock in the exact
 * docs/cms-rebuild.md 3.2 shape, with its `id` carried through untouched and
 * its `kind` set by the toolbar, never guessed from the editor.
 *
 * ---------------------------------------------------------------------------
 * CONTROLLED, WITHOUT THE LOOP
 * ---------------------------------------------------------------------------
 *
 * A TipTap editor owns a ProseMirror document, so the naive controlled pattern
 * (prop in, setContent on every render) destroys the selection on every
 * keystroke. Instead:
 *
 *   - the editor is created once, from `block`;
 *   - edits emit onChange, and the canonical JSON of what was emitted is
 *     remembered;
 *   - an incoming `block.content` is pushed into the editor ONLY when its
 *     canonical JSON differs from what was last emitted or synced.
 *
 * So a parent that echoes the block straight back (the normal case) causes no
 * setContent at all, and a parent that changes it from elsewhere (undo, a
 * reload, a different draft) does. Comparison is canonical, not by reference,
 * because the shell has no reason to preserve array identity.
 *
 * ---------------------------------------------------------------------------
 * A KIND CHANGE IS A NEW EDITOR
 * ---------------------------------------------------------------------------
 *
 * The schema is built per kind (see extensions.ts), so changing kind changes
 * the schema. The outer component keys the instance on `block.kind`, which
 * rebuilds it; the content is converted first, by convertBlockKind, so the
 * words survive.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';

import { DEFAULT_CALLOUT_TONE } from '../../schema.ts';
import type { ProseBlock, ProseBlockKind } from '../../schema.ts';
import {
  blockFromDoc,
  canonicalJson,
  convertBlockKind,
  docFromBlock,
  normalizeProseContent,
  splitInlineRange,
} from './block.ts';
import type { ProseNode } from './block.ts';
import { PROSE_KIND_TITLE, SINGLE_LINE_KINDS, proseExtensions } from './extensions.ts';
import { injectProseEditorStyles } from './css.ts';
import { injectHighlightStyles } from '../../styles/highlight.ts';
import { injectCalloutStyles } from '../../styles/callout.ts';
import { ProseToolbar } from './Toolbar.tsx';

/** Where to put the caret: an end of the block, or a character offset into it. */
export type CaretAt = 'start' | 'end' | number;

/**
 * A caret placement, from the host. `nonce` is what makes it fire: the same
 * request passed twice is the same request, and placing the caret on every
 * render would fight the author for the selection.
 */
export type CaretRequest = { at: CaretAt; nonce: number };

export type ProseEditorProps = {
  /** The block being edited. Its `id` is preserved on every emission. */
  block: ProseBlock;
  /** Called with a complete, normalised ProseBlock on every author edit. */
  onChange: (block: ProseBlock) => void;

  /**
   * Enter (or Shift-Enter) in a p/h2/h3 block, which the contract pins to one
   * top-level node: the content either side of the caret, for the host to put
   * into two blocks. Anything selected is already dropped. Without this the key
   * does nothing, exactly as before.
   */
  onSplit?: (head: ProseNode[], tail: ProseNode[]) => void;
  /**
   * Backspace at the very start of a p/h2/h3 block. Return true if the host
   * joined this block onto the one above; false and the key does nothing.
   */
  onMergeUp?: () => boolean;
  /** Move the caret and take focus. Bump `nonce` to fire it again. */
  caret?: CaretRequest | null;

  /** Default false. */
  readOnly?: boolean;
  /** Put the caret at the end on mount. Default false. */
  autoFocus?: boolean;
  /** Added to the wrapper, next to `pe-root`. */
  className?: string;
  /**
   * Show the six block-kind buttons in the toolbar. Default true. Set false if
   * the host owns block kind (WS-3's band outline, for instance).
   */
  showKindControls?: boolean;
  /** Portal target for the floating toolbar. Default document.body. */
  toolbarContainer?: HTMLElement | null;
  onFocusChange?: (focused: boolean) => void;
  /**
   * The live editor, for hosts that need it (and for the verification
   * harness). Called with the instance on create and with null on destroy.
   */
  onReady?: (editor: Editor | null) => void;
  /**
   * TipTap could not place the given content in the schema. Should never fire:
   * content is normalised before it is handed over. Defaults to console.error.
   */
  onContentError?: (message: string) => void;
};

/**
 * The schema depends on the block kind, so a kind change is a different
 * editor. Keying the instance is the whole implementation.
 *
 * The id is in the key too: a host that reuses one slot for a different block
 * (WS-3's band outline will) gets a clean instance rather than an editor
 * holding the previous block's history.
 */
export function ProseEditor(props: ProseEditorProps): JSX.Element {
  return <ProseEditorInstance key={`${props.block.id}:${props.block.kind}`} {...props} />;
}

/**
 * A caret offset as a ProseMirror position in a single-line block. Content
 * starts at 1, and `doc.content.size - 1` is the last place inside the top
 * node, so a stale offset lands at the end rather than throwing.
 */
function caretPosition(editor: Editor, at: CaretAt): number | 'start' | 'end' {
  if (at === 'start' || at === 'end') return at;
  const last = Math.max(1, editor.state.doc.content.size - 1);
  return Math.min(Math.max(1, Math.round(at) + 1), last);
}

function ProseEditorInstance({
  block,
  onChange,
  onSplit,
  onMergeUp,
  caret = null,
  readOnly = false,
  autoFocus = false,
  className,
  showKindControls = true,
  toolbarContainer = null,
  onFocusChange,
  onReady,
  onContentError,
}: ProseEditorProps): JSX.Element {
  const kind: ProseBlockKind = block.kind;

  // Live refs, because TipTap captures its handlers when the editor is built.
  const blockRef = useRef(block);
  blockRef.current = block;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSplitRef = useRef(onSplit);
  onSplitRef.current = onSplit;
  const onMergeUpRef = useRef(onMergeUp);
  onMergeUpRef.current = onMergeUp;
  const onFocusChangeRef = useRef(onFocusChange);
  onFocusChangeRef.current = onFocusChange;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onContentErrorRef = useRef(onContentError);
  onContentErrorRef.current = onContentError;

  /** Canonical JSON of the content the editor and the parent agree on. */
  const agreed = useRef(canonicalJson(normalizeProseContent(kind, block.content)));

  const [linkRequest, setLinkRequest] = useState(0);
  const requestLink = useRef(() => setLinkRequest((value) => value + 1));

  /**
   * The live instance, for the keymap. The extensions are built before
   * `useEditor` returns, so a handler that needs the editor cannot close over
   * it; `onCreate` fills this in before any key can be pressed.
   */
  const editorRef = useRef<Editor | null>(null);

  /**
   * Enter in a single-line block. The selection is read from the editor rather
   * than from `block`, which the parent may not have echoed back yet, and the
   * content from the editor's own JSON for the same reason. Normalisation never
   * changes the character sequence, only how it is split into text nodes, so
   * ProseMirror's positions still line up with the normalised runs.
   */
  const handleSplit = useRef((): boolean => {
    const instance = editorRef.current;
    const split = onSplitRef.current;
    // Still swallowed when no host is listening: a bare editor with no band
    // around it has nowhere to put a second block.
    if (instance === null || split === undefined) return true;
    const { from, to } = instance.state.selection;
    const content = blockFromDoc(blockRef.current, instance.getJSON()).content;
    const [head, tail] = splitInlineRange(content, from - 1, to - 1);
    split(head, tail);
    return true;
  });

  const handleMergeUp = useRef((): boolean => onMergeUpRef.current?.() ?? false);

  useEffect(() => {
    injectProseEditorStyles();
    // The highlighter's own rules. Separate stylesheet, shared with the
    // published page; see styles/highlight.ts.
    injectHighlightStyles();
    // The callout's box, same arrangement: shared with the published page.
    injectCalloutStyles();
  }, []);

  const editor = useEditor(
    {
      extensions: proseExtensions(kind, {
        onRequestLink: () => requestLink.current(),
        onSplit: () => handleSplit.current(),
        onMergeUp: () => handleMergeUp.current(),
      }),
      content: docFromBlock(block),
      editable: !readOnly,
      enableContentCheck: true,
      editorProps: {
        attributes: {
          class: 'pe-content',
          'aria-label': PROSE_KIND_TITLE[kind],
          'data-prose-kind': kind,
        },
      },
      onCreate: ({ editor: instance }) => {
        editorRef.current = instance as Editor;
      },
      onDestroy: () => {
        editorRef.current = null;
      },
      onContentError: ({ error }) => {
        const report = onContentErrorRef.current;
        if (report === undefined) console.error('[ProseEditor] content error', error);
        else report(error.message);
      },
      onUpdate: ({ editor: instance }) => {
        const next = blockFromDoc(blockRef.current, instance.getJSON());
        const canonical = canonicalJson(next.content);
        if (canonical === agreed.current) return;
        agreed.current = canonical;
        onChangeRef.current(next);
      },
      onFocus: () => onFocusChangeRef.current?.(true),
      onBlur: () => onFocusChangeRef.current?.(false),
    },
    // Created once. A kind change remounts the whole instance via the key.
    [],
  );

  // Push an externally changed block into the editor, and only then.
  useEffect(() => {
    if (editor === null || editor.isDestroyed) return;
    const incoming = canonicalJson(normalizeProseContent(kind, block.content));
    if (incoming === agreed.current) return;
    agreed.current = incoming;
    try {
      editor.commands.setContent(docFromBlock(blockRef.current), { emitUpdate: false });
    } catch (error) {
      // enableContentCheck makes setContent throw on content the schema
      // cannot hold. Normalisation should make that impossible; if it ever
      // happens, the host hears about it instead of the editor going blank
      // without a word.
      const message = error instanceof Error ? error.message : String(error);
      const report = onContentErrorRef.current;
      if (report === undefined) console.error('[ProseEditor] could not set content', error);
      else report(message);
    }
  }, [editor, block.content, kind]);

  useEffect(() => {
    if (editor === null || editor.isDestroyed) return;
    editor.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  useEffect(() => {
    if (editor === null || !autoFocus) return;
    editor.commands.focus('end');
  }, [editor, autoFocus]);

  /*
   * A caret placement from the host. `editor` is in the deps on purpose: a
   * block created by a split asks for the caret before its editor exists, and
   * useEditor returns null on that first render, so the request has to be
   * applied again when the instance arrives.
   */
  const caretNonce = caret?.nonce ?? null;
  const caretAt = caret?.at;
  useEffect(() => {
    if (editor === null || editor.isDestroyed || caretNonce === null || caretAt === undefined) {
      return;
    }
    editor.commands.focus(caretPosition(editor, caretAt));
    // caretAt is read through the nonce: the same nonce is the same request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, caretNonce]);

  useEffect(() => {
    onReadyRef.current?.(editor);
    return () => onReadyRef.current?.(null);
  }, [editor]);

  const handleKindChange = useCallback((next: ProseBlockKind) => {
    const converted = convertBlockKind(blockRef.current, next);
    agreed.current = canonicalJson(converted.content);
    onChangeRef.current(converted);
  }, []);

  const classes = className === undefined ? 'pe-root' : `pe-root ${className}`;

  return (
    <div
      className={classes}
      data-prose-block={block.id}
      data-prose-kind={kind}
      // Only a callout has one, and callout.ts keys its colours off it. The
      // tone lives on the ProseBlock rather than inside the editor document,
      // so it has to reach the DOM from here.
      data-tone={kind === 'callout' ? (block.tone ?? DEFAULT_CALLOUT_TONE) : undefined}
    >
      <div className="pe-surface">
        <EditorContent editor={editor} />
      </div>
      {editor !== null && !readOnly ? (
        <ProseToolbar
          editor={editor}
          blockId={block.id}
          kind={kind}
          onKindChange={handleKindChange}
          showKindControls={showKindControls}
          container={toolbarContainer}
          linkRequest={linkRequest}
        />
      ) : null}
    </div>
  );
}
