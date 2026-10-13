/**
 * src/cms/app/prose/extensions.ts
 *
 * WS-5. The TipTap extension set, built per block kind.
 *
 * No React, no DOM: this file runs under bare `node`, which is how
 * src/cms/app/prose/verify.ts can assert things about the real schema without
 * a browser.
 *
 * ---------------------------------------------------------------------------
 * WHY PER KIND
 * ---------------------------------------------------------------------------
 *
 * A ProseBlock holds the content of exactly ONE top-level node
 * (docs/cms-contracts.md 2.3), so the editor's document is pinned to one node
 * of that type, and every node type the kind does not need is switched off.
 * A paragraph block's schema literally has no heading, no blockquote and no
 * lists in it, so there is nothing a paste or a stray shortcut can smuggle in.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SWITCHED OFF, AND WHY
 * ---------------------------------------------------------------------------
 *
 * StarterKit 3.31.4 brings more than this contract allows
 * (docs/cms-contracts.md 2.3). Every one of these is a real trap:
 *
 *  code, codeBlock, strike, underline   marks/nodes PROSE_MARKS forbids; left
 *                                       on, a paste writes them into stored
 *                                       content that the contract says cannot
 *                                       exist.
 *  horizontalRule                       a node 3.2 has no place for.
 *  trailingNode                         appends an empty paragraph after the
 *                                       document's last node. In a one-block
 *                                       editor that is a second, phantom
 *                                       paragraph the author can type into.
 *  document                             replaced with a pinned top node.
 *  listItem                             replaced with one whose content is a
 *                                       single paragraph, so Tab cannot nest.
 *  link (reconfigured, not removed)     StarterKit already includes Link.
 *                                       Adding @tiptap/extension-link beside
 *                                       it duplicates the extension.
 *
 * TextStyle and Color are added individually, never TextStyleKit, so the
 * stored textStyle mark carries `{ color }` and not five mostly-null keys.
 *
 * ---------------------------------------------------------------------------
 * hardBreak IS IN THE SCHEMA, AND IS THE ONE NON-TEXT INLINE NODE
 * ---------------------------------------------------------------------------
 *
 * Shift-Enter puts a `hardBreak` in the run: a line that starts lower down
 * while staying the same paragraph, which is a different thing from Enter
 * cutting the block in two and the reason both keys exist.
 *
 * It was switched off here originally, on the grounds that 3.2's inline shapes
 * are text nodes only. That was over-cautious: WS-1's serialiser already
 * renders `hardBreak` as `<br />` (render/prose.ts) and always has, with a
 * case in render/selftest.ts covering it, and ProseBlock.content is
 * `z.array(z.unknown())`, so nothing in the stored shape had to change. What
 * DID have to change is block.ts, which treated every non-text node as the end
 * of a paragraph and would have turned a line break into a block split on the
 * next normalisation.
 *
 * Being the one inline node that is not text, it is also the one place where a
 * character offset and a ProseMirror position can drift apart: it is one
 * position wide and carries no text. splitInlineContent counts it as one, so
 * Enter after a Shift-Enter still cuts where the caret is.
 */

import { Extension, Mark, Node, getSchema, mergeAttributes } from '@tiptap/core';
import type { Extensions } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { Color } from '@tiptap/extension-color';
import { ListItem } from '@tiptap/extension-list';
import { TextStyle } from '@tiptap/extension-text-style';
import { StarterKit } from '@tiptap/starter-kit';

import { DEFAULT_HIGHLIGHT_INK, PROSE_NODE_TYPE, isHighlightInk } from '../../schema.ts';
import type { HighlightInk, ProseBlockKind } from '../../schema.ts';

/* -------------------------------------------------------------------------- */
/* The pinned top node                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `doc`, holding exactly one node of the block's type. This is what stops
 * Enter from creating a second paragraph, Backspace from deleting the block,
 * and a paste of three paragraphs from becoming three blocks inside one
 * ProseBlock.
 */
function ProseBlockDocument(kind: ProseBlockKind): Node {
  return Node.create({
    name: 'doc',
    topNode: true,
    content: PROSE_NODE_TYPE[kind],
  });
}

/**
 * A list item that holds one paragraph and nothing else. ListItem's default
 * content is `paragraph block*`, which is what lets Tab nest a list inside a
 * list; 3.2's shape is "list items, each wrapping a paragraph", with no
 * nesting. Pinning the content makes sinkListItem fail rather than produce
 * content WS-1 cannot render, and leaves Tab free to move focus.
 */
const ProseListItem = ListItem.extend({ content: 'paragraph' });

/* -------------------------------------------------------------------------- */
/* Highlight                                                                   */
/* -------------------------------------------------------------------------- */

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    proseHighlight: {
      setHighlight: (ink: HighlightInk) => ReturnType;
      toggleHighlight: (ink: HighlightInk) => ReturnType;
      unsetHighlight: () => ReturnType;
    };
  }
}

/**
 * The highlighter: a brush stroke behind the words, carrying one of four inks
 * (HIGHLIGHT_INKS).
 *
 * Written here rather than pulled from @tiptap/extension-highlight, which is
 * not a dependency and whose stored shape is a free `color` attribute. A
 * closed set of inks is the point: the stroke is a background image on the
 * `<mark>`, so its colour has to be baked into the SVG and lives as a class in
 * doc.css, and an arbitrary colour would have nothing to resolve to.
 *
 * `priority` is explicit so the mark's rank in the ProseMirror schema is
 * fixed, which is what keeps MARK_ORDER in block.ts true. prose/verify.ts
 * asserts the two agree, so a reshuffle fails loudly rather than quietly
 * reordering the marks in every stored document.
 */
const ProseHighlight = Mark.create({
  name: 'highlight',
  priority: 99,

  addAttributes() {
    return {
      ink: {
        default: DEFAULT_HIGHLIGHT_INK,
        parseHTML: (element: HTMLElement) => {
          const value = element.getAttribute('data-ink');
          if (isHighlightInk(value)) return value;
          // Pasted from the published page, which carries the ink as a class
          // and no data attribute. Without this every paste would come back
          // yellow.
          const fromClass = [...element.classList]
            .map((name) => name.replace(/^doc-hl--/, ''))
            .find((name) => isHighlightInk(name));
          return isHighlightInk(fromClass) ? fromClass : DEFAULT_HIGHLIGHT_INK;
        },
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-ink': isHighlightInk(attributes.ink) ? attributes.ink : DEFAULT_HIGHLIGHT_INK,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'mark' }];
  },

  renderHTML({ HTMLAttributes }) {
    // The SAME classes WS-1 puts on the published page, so one rule set
    // (styles/highlight.ts) draws both and the editor cannot look different
    // from the page it is editing.
    const ink = isHighlightInk(HTMLAttributes['data-ink'])
      ? HTMLAttributes['data-ink']
      : DEFAULT_HIGHLIGHT_INK;
    return ['mark', mergeAttributes(HTMLAttributes, { class: `doc-hl doc-hl--${ink}` }), 0];
  },

  addCommands() {
    return {
      setHighlight:
        (ink: HighlightInk) =>
        ({ commands }) =>
          commands.setMark(this.name, { ink }),
      toggleHighlight:
        (ink: HighlightInk) =>
        ({ commands, editor }) =>
          // Same pen again turns it off; a different pen recolours in place
          // rather than making the author unhighlight first.
          editor.isActive(this.name, { ink })
            ? commands.unsetMark(this.name)
            : commands.setMark(this.name, { ink }),
      unsetHighlight:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

/* -------------------------------------------------------------------------- */
/* Keyboard                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Shortcuts that would change the block's kind or add a forbidden mark, all
 * swallowed. The kind lives on the ProseBlock, not inside the editor, so a
 * shortcut that changed the top node would either be rejected by the pinned
 * document or silently dropped on save. Either way the author would watch
 * their formatting disappear, so the key never does anything in the first
 * place. Kind changes go through the toolbar, which emits a new block.
 *
 * Mod-U, Mod-E and Mod-Shift-X are swallowed even though underline, code and
 * strike are not in the schema: in a contenteditable the browser itself
 * applies those on Cmd-B/I/U, and a DOM mutation ProseMirror did not author is
 * worth never provoking.
 */
const SWALLOWED_KEYS = [
  'Mod-Alt-0',
  'Mod-Alt-1',
  'Mod-Alt-2',
  'Mod-Alt-3',
  'Mod-Alt-4',
  'Mod-Alt-5',
  'Mod-Alt-6',
  'Mod-Shift-7',
  'Mod-Shift-8',
  'Mod-Shift-B',
  'Mod-Shift-X',
  'Mod-Alt-C',
  'Mod-E',
  'Mod-U',
] as const;

/**
 * Kinds whose top node holds inline content only, so there is no second
 * paragraph for Enter to make INSIDE the editor. In these, Enter and Backspace
 * work on the block boundary instead: see onSplit and onMergeUp below.
 *
 * quote, ul and ol are block containers, so Enter already has somewhere to go
 * (a new paragraph in the quote, a new item in the list) and is left alone.
 */
export const SINGLE_LINE_KINDS: ReadonlySet<ProseBlockKind> = new Set<ProseBlockKind>([
  'p',
  'h2',
  'h3',
  'callout',
]);

export type ProseExtensionOptions = {
  /** Mod-K. The floating toolbar's link field opens from here. */
  onRequestLink?: () => void;
  /**
   * Enter in a single-line kind. The host cuts the block in two at the caret.
   * Return false to leave the key doing nothing, which is what happens when no
   * host has wired it.
   */
  onSplit?: () => boolean;
  /**
   * Backspace with the caret at the very start of a single-line block, nothing
   * selected: the host joins this block onto the one above. Return false and
   * the key falls through to ProseMirror, which will find nothing to delete
   * and leave the document alone.
   */
  onMergeUp?: () => boolean;
  /**
   * Delete with the caret at the very END of a single-line block, nothing
   * selected: the host joins the block BELOW onto this one. The mirror of
   * `onMergeUp`, and it was simply missing — Backspace joined backwards and
   * Delete did nothing at all, which is an asymmetry no other editor has.
   */
  onMergeDown?: () => boolean;
  /**
   * Enter on an EMPTY item of a ul or ol: the author is trying to stop making
   * bullets. The host drops that item and breaks the list open there, in one
   * edit. Return false and the key does nothing, which is what it did before
   * this existed.
   */
  onSplitList?: () => boolean;
  /**
   * The caret has tried to leave the block vertically: Down from the last
   * line, Up from the first. The host moves it into the neighbouring block.
   *
   * Every block is its own editor, so there is nothing inside this one for
   * the caret to move into and the key does nothing without a host. `at` is
   * where the caret should land in the block it arrives in.
   */
  onLeaveVertically?: (direction: 'up' | 'down') => boolean;
  /**
   * The caret has tried to leave the block sideways: Left from the very
   * start, Right from the very end. Same story as the vertical pair.
   */
  onLeaveHorizontally?: (direction: 'left' | 'right') => boolean;
};

/**
 * Is the caret sitting at the very end of the document, with nothing
 * selected? `doc.content.size - 1` is the last position inside the single top
 * node, the mirror of position 1 at the other end.
 */
function atDocumentEnd(editor: { state: { selection: { empty: boolean; from: number } ; doc: { content: { size: number } } } }): boolean {
  const { selection, doc } = editor.state;
  return selection.empty && selection.from >= doc.content.size - 1;
}

/**
 * Is the caret on the first (or last) VISUAL line of the editor?
 *
 * Not the same question as "is it at the first position". A paragraph wraps,
 * and pressing Down in the middle of a three-line paragraph should move to
 * the next line, not jump out of the block. So this measures: it compares the
 * caret's own rectangle against the editor's, which is the only way to know
 * where the lines actually fell.
 *
 * Returns true when it cannot tell, which errs towards handing the key to the
 * host. A caret with no rectangle is a caret in an empty block, and an empty
 * block is both its first line and its last.
 */
function onEdgeLine(view: EditorView, edge: 'first' | 'last'): boolean {
  const { selection } = view.state;
  if (!selection.empty) return false;
  let caret: { top: number; bottom: number };
  try {
    caret = view.coordsAtPos(selection.from);
  } catch {
    return true;
  }
  const box = view.dom.getBoundingClientRect();
  // Half a line of tolerance, so a caret sitting on the first line is still
  // "on the first line" when the line box is a little taller than the glyphs.
  const slack = Math.max(4, (caret.bottom - caret.top) / 2);
  return edge === 'first'
    ? caret.top - box.top <= slack
    : box.bottom - caret.bottom <= slack;
}

function ProseKeymap(kind: ProseBlockKind, options: ProseExtensionOptions): Extension {
  const onRequestLink = options.onRequestLink;
  const onSplit = options.onSplit;
  const onMergeUp = options.onMergeUp;
  const onMergeDown = options.onMergeDown;
  const onSplitList = options.onSplitList;
  const onLeaveVertically = options.onLeaveVertically;
  const onLeaveHorizontally = options.onLeaveHorizontally;
  const singleLine = SINGLE_LINE_KINDS.has(kind);

  return Extension.create({
    name: 'proseBlockKeymap',
    // Above every StarterKit extension, so these bindings win.
    priority: 1000,
    addKeyboardShortcuts() {
      const swallow = (): boolean => true;
      const shortcuts: Record<string, () => boolean> = {};
      for (const key of SWALLOWED_KEYS) shortcuts[key] = swallow;

      /* Shift-Enter is a line break inside the paragraph, in every kind.
         StarterKit's own binding does this already; it is spelled out here
         because this keymap runs at priority 1000 and would otherwise have to
         leave a hole for it, and because the pairing with Enter is the point:
         Enter starts a new block, Shift-Enter starts a new line in this one. */
      shortcuts['Shift-Enter'] = () => this.editor.commands.setHardBreak();

      if (singleLine) {
        // Enter cuts the block in two, because the contract pins this editor
        // to a single top-level node and a second paragraph has nowhere to go.
        shortcuts.Enter = () => (onSplit === undefined ? true : onSplit());

        shortcuts.Backspace = () => {
          if (onMergeUp === undefined) return false;
          const { selection } = this.editor.state;
          // Only an empty caret sitting at the first position. Position 1 is
          // the start of the single top node's content; anything else is a
          // deletion ProseMirror should handle itself.
          if (!selection.empty || selection.from !== 1) return false;
          return onMergeUp();
        };

        // The mirror of the above. Delete at the end of a block pulls the
        // next one up onto it, exactly as Backspace at the start pushes this
        // one onto the previous.
        shortcuts.Delete = () => {
          if (onMergeDown === undefined) return false;
          if (!atDocumentEnd(this.editor)) return false;
          return onMergeDown();
        };
      } else if (flagsFor(kind).lists) {
        /* Enter on an EMPTY list item breaks the list open there.

           In every other editor that is how you stop making bullets. Here it
           could not be: the block's document is pinned to a single
           `bulletList`, so `liftListItem` has nowhere to lift to and the key
           did nothing at all. Measured on the shipped component, twice: on
           the last item the list stayed at three with the third empty and no
           paragraph appeared, and on an item in the MIDDLE the key was just
           as dead, which only showed up once there was a test for it.

           So it is any empty item, not only the last: before it stays a
           list, after it stays a list, and a paragraph opens between them.
           At the end that degenerates to "end the list", which is the common
           case and the one people mean.

           This only RECOGNISES the moment. It does not touch the document,
           because the fix is up to three blocks where there was one and only
           the host can do that atomically. It is deliberately not `onSplit`,
           which builds inline content: handing a list's content to that
           would flatten the bullets into a paragraph. */
        shortcuts.Enter = () => {
          if (onSplitList === undefined) return false;
          const { selection } = this.editor.state;
          if (!selection.empty) return false;
          const item = selection.$from.node(-1);
          const list = selection.$from.node(-2);
          if (item === undefined || item.type.name !== 'listItem') return false;
          if (item.textContent !== '') return false;
          // One item and it is empty: the list is empty, and taking the item
          // out would leave a node with no legal content. Leave it alone; the
          // way out of an empty list is the toolbar, or Backspace.
          if (list === undefined || list.childCount <= 1) return false;
          return onSplitList();
        };
      }

      /* Arrow keys cross block boundaries.

         Every block is a separate editor, so there is nothing inside this one
         for the caret to move into and these keys simply stopped at the edge:
         measured, ArrowDown from the end of a paragraph left focus exactly
         where it was. On a long page that means clicking into every block.

         The host moves the caret, through the same `caretRequests` machinery
         that split and merge already use. Returning false where there is no
         host, or where the caret is not on the edge line, leaves ProseMirror
         to do its ordinary within-block thing. */
      shortcuts.ArrowDown = () =>
        onLeaveVertically !== undefined &&
        onEdgeLine(this.editor.view, 'last') &&
        onLeaveVertically('down');

      shortcuts.ArrowUp = () =>
        onLeaveVertically !== undefined &&
        onEdgeLine(this.editor.view, 'first') &&
        onLeaveVertically('up');

      shortcuts.ArrowRight = () => {
        if (onLeaveHorizontally === undefined) return false;
        if (!atDocumentEnd(this.editor)) return false;
        return onLeaveHorizontally('right');
      };

      shortcuts.ArrowLeft = () => {
        if (onLeaveHorizontally === undefined) return false;
        const { selection } = this.editor.state;
        if (!selection.empty || selection.from > 1) return false;
        return onLeaveHorizontally('left');
      };

      shortcuts['Mod-k'] = () => {
        if (onRequestLink === undefined) return false;
        onRequestLink();
        return true;
      };
      return shortcuts;
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Link                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Configured through StarterKit's `link` option, not added separately.
 *
 *  - openOnClick false: clicking a link in the editor puts the caret in it.
 *  - autolink false: typing a URL does not silently add a mark the author did
 *    not ask for. Links are made from the toolbar or by pasting onto a
 *    selection.
 *  - target and rel default from HTMLAttributes (that is where TipTap's Link
 *    reads its attribute defaults from), so a new link stores exactly the
 *    `{ href, target: '_blank', rel: 'noopener noreferrer' }` the fixtures use.
 */
function linkOptions(): NonNullable<Parameters<typeof StarterKit.configure>[0]>['link'] {
  return {
    openOnClick: false,
    autolink: false,
    linkOnPaste: true,
    defaultProtocol: 'https',
    protocols: ['http', 'https', 'mailto', 'tel'],
    HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
  };
}

/* -------------------------------------------------------------------------- */
/* The extension set                                                           */
/* -------------------------------------------------------------------------- */

type KindFlags = {
  heading: false | { levels: (2 | 3)[] };
  blockquote: boolean;
  bulletList: boolean;
  orderedList: boolean;
  lists: boolean;
};

function flagsFor(kind: ProseBlockKind): KindFlags {
  switch (kind) {
    case 'h2':
    case 'h3':
      return {
        heading: { levels: [2, 3] },
        blockquote: false,
        bulletList: false,
        orderedList: false,
        lists: false,
      };
    case 'quote':
      return {
        heading: false,
        blockquote: true,
        bulletList: false,
        orderedList: false,
        lists: false,
      };
    case 'ul':
      return {
        heading: false,
        blockquote: false,
        bulletList: true,
        orderedList: false,
        lists: true,
      };
    case 'ol':
      return {
        heading: false,
        blockquote: false,
        bulletList: false,
        orderedList: true,
        lists: true,
      };
    default:
      return {
        heading: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        lists: false,
      };
  }
}

/**
 * The extensions one ProseEditor instance runs on. Build a new set when the
 * block's kind changes; the schema is different, so the editor is too.
 */
export function proseExtensions(
  kind: ProseBlockKind,
  options: ProseExtensionOptions = {},
): Extensions {
  const flags = flagsFor(kind);
  const extensions: Extensions = [
    ProseBlockDocument(kind),
    StarterKit.configure({
      document: false,
      // Forbidden by PROSE_MARKS / 3.2.
      code: false,
      codeBlock: false,
      strike: false,
      underline: false,
      horizontalRule: false,
      // A phantom second paragraph in a one-block editor.
      trailingNode: false,
      // Replaced below, with its content pinned to a single paragraph.
      listItem: false,
      // Only the nodes this kind needs.
      heading: flags.heading,
      blockquote: flags.blockquote ? {} : false,
      bulletList: flags.bulletList ? {} : false,
      orderedList: flags.orderedList ? {} : false,
      listKeymap: flags.lists ? {} : false,
      link: linkOptions(),
    }),
    TextStyle,
    Color,
    ProseHighlight,
    ProseKeymap(kind, options),
  ];
  if (flags.lists) extensions.push(ProseListItem);
  return extensions;
}

/** The real ProseMirror schema for a kind. Used by the verification harness. */
export function getProseSchema(kind: ProseBlockKind): Schema {
  return getSchema(proseExtensions(kind)) as Schema;
}

/** Every kind, for exhaustive tests and for the toolbar. */
export const PROSE_KINDS: readonly ProseBlockKind[] = ['p', 'h2', 'h3', 'quote', 'callout', 'ul', 'ol'];

/** Toolbar labels for the kind buttons. Short, because the toolbar is small. */
export const PROSE_KIND_LABEL: Readonly<Record<ProseBlockKind, string>> = {
  p: 'P',
  h2: 'H2',
  h3: 'H3',
  quote: '“”',
  callout: '▣',
  ul: '•',
  ol: '1.',
};

export const PROSE_KIND_TITLE: Readonly<Record<ProseBlockKind, string>> = {
  p: 'Paragraph',
  h2: 'Heading 2',
  h3: 'Heading 3',
  quote: 'Quote',
  callout: 'Callout box',
  ul: 'Bulleted list',
  ol: 'Numbered list',
};
