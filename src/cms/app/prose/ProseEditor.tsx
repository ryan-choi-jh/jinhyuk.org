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

import type { ProseBlock, ProseBlockKind } from '../../schema.ts';
import {
  blockFromDoc,
  canonicalJson,
  convertBlockKind,
  docFromBlock,
  normalizeProseContent,
} from './block.ts';
import { PROSE_KIND_TITLE, proseExtensions } from './extensions.ts';
import { injectProseEditorStyles } from './css.ts';
import { ProseToolbar } from './Toolbar.tsx';

export type ProseEditorProps = {
  /** The block being edited. Its `id` is preserved on every emission. */
  block: ProseBlock;
  /** Called with a complete, normalised ProseBlock on every author edit. */
  onChange: (block: ProseBlock) => void;

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

function ProseEditorInstance({
  block,
  onChange,
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

  useEffect(() => {
    injectProseEditorStyles();
  }, []);

  const editor = useEditor(
    {
      extensions: proseExtensions(kind, { onRequestLink: () => requestLink.current() }),
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
    <div className={classes} data-prose-block={block.id} data-prose-kind={kind}>
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
