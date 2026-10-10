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
 *  hardBreak                            would put a `hardBreak` node inside
 *                                       stored content. 3.2's shapes are text
 *                                       nodes only, so WS-1 would meet a node
 *                                       it has never been told about.
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
 */

import { Extension, Node, getSchema } from '@tiptap/core';
import type { Extensions } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { Color } from '@tiptap/extension-color';
import { ListItem } from '@tiptap/extension-list';
import { TextStyle } from '@tiptap/extension-text-style';
import { StarterKit } from '@tiptap/starter-kit';

import { PROSE_NODE_TYPE } from '../../schema.ts';
import type { ProseBlockKind } from '../../schema.ts';

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
  'Shift-Enter',
] as const;

/** Kinds whose top node holds inline content only: Enter has nowhere to go. */
const SINGLE_LINE_KINDS: ReadonlySet<ProseBlockKind> = new Set<ProseBlockKind>(['p', 'h2', 'h3']);

export type ProseExtensionOptions = {
  /** Mod-K. The floating toolbar's link field opens from here. */
  onRequestLink?: () => void;
};

function ProseKeymap(kind: ProseBlockKind, options: ProseExtensionOptions): Extension {
  const onRequestLink = options.onRequestLink;
  return Extension.create({
    name: 'proseBlockKeymap',
    // Above every StarterKit extension, so these bindings win.
    priority: 1000,
    addKeyboardShortcuts() {
      const swallow = (): boolean => true;
      const shortcuts: Record<string, () => boolean> = {};
      for (const key of SWALLOWED_KEYS) shortcuts[key] = swallow;
      if (SINGLE_LINE_KINDS.has(kind)) shortcuts.Enter = swallow;
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
      hardBreak: false,
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
export const PROSE_KINDS: readonly ProseBlockKind[] = ['p', 'h2', 'h3', 'quote', 'ul', 'ol'];

/** Toolbar labels for the kind buttons. Short, because the toolbar is small. */
export const PROSE_KIND_LABEL: Readonly<Record<ProseBlockKind, string>> = {
  p: 'P',
  h2: 'H2',
  h3: 'H3',
  quote: '“”',
  ul: '•',
  ol: '1.',
};

export const PROSE_KIND_TITLE: Readonly<Record<ProseBlockKind, string>> = {
  p: 'Paragraph',
  h2: 'Heading 2',
  h3: 'Heading 3',
  quote: 'Quote',
  ul: 'Bulleted list',
  ol: 'Numbered list',
};
