/**
 * src/cms/app/shell/slots.ts
 *
 * WS-3. The slot contract.
 *
 * The shell does not implement canvas dragging or prose editing. WS-4 ships
 * `<CanvasEditor items onChange />` and WS-5 ships `<ProseEditor block onChange />`,
 * and WS-8 mounts them here. The shell renders a host element per band or
 * block and calls the matching render prop inside it; when a render prop is
 * absent it draws a read-only placeholder instead, which is what makes the
 * shell verifiable on its own.
 *
 * WS-8 should not need to edit a file in `src/cms/app/shell/`. If it does,
 * that is a missing slot and a bug against WS-3.
 */

import type { ReactNode } from 'react';

import type { CanvasBand, CanvasItem, ProseBand, ProseBlock } from '../../schema.ts';
import type { DocStore, DocStoreState } from '../state/store.ts';
import type { ResolvedSelection, Selection } from '../state/selection.ts';

/* -------------------------------------------------------------------------- */
/* Prose                                                                       */
/* -------------------------------------------------------------------------- */

export type ProseBlockSlotProps = {
  /** The store, in case the slot wants to do more than change its own block. */
  store: DocStore;
  band: ProseBand;
  bandIndex: number;
  block: ProseBlock;
  blockIndex: number;
  /** This block is the current selection. */
  selected: boolean;
  /**
   * Write new TipTap content for this block. Exactly `ProseBlock.content`:
   * the `content` array of the single top-level node named by
   * `PROSE_NODE_TYPE[block.kind]` (docs/cms-contracts.md 2.3). Consecutive
   * calls coalesce into one undo step, so calling it on every keystroke is
   * correct.
   */
  onChange(content: unknown[]): void;
  /** Make this block the selection, e.g. on focus. */
  onSelect(): void;
};

/* -------------------------------------------------------------------------- */
/* Canvas                                                                      */
/* -------------------------------------------------------------------------- */

export type CanvasBandSlotProps = {
  store: DocStore;
  band: CanvasBand;
  bandIndex: number;
  /** `band.items`, passed separately because that is WS-4's actual prop. */
  items: CanvasItem[];
  /** Items the shell currently has selected inside this band. Possibly empty. */
  selectedItemIds: readonly string[];
  /**
   * The host element the slot renders into is exactly `stageWidth` x
   * `stageHeight` CSS px, and those CSS px ARE reference px: an item at
   * `x: 672` sits at 672px inside it, with no conversion.
   */
  stageWidth: number;
  stageHeight: number;
  /** Always `REFERENCE_WIDTH` (1344). Passed so nothing has to import it. */
  referenceWidth: number;
  /**
   * An ancestor of the host applies `transform: scale(scale)`, so the stage is
   * drawn at `stageWidth * scale` real pixels. A pointer delta measured in
   * client coordinates must be divided by `scale` to become a delta in stage
   * coordinates. `getBoundingClientRect()` on the host returns the SCALED box.
   */
  scale: number;
  /**
   * Replace the band's items. Consecutive calls coalesce into one undo step,
   * so calling it on every pointer move during a drag is correct.
   */
  onChange(items: CanvasItem[]): void;
  /** Report a selection change up to the shell. Empty array selects the band. */
  onSelectItems(itemIds: string[]): void;
  /**
   * Map a document `src` to something loadable in the current environment.
   * Identity in production; the harness points it at the local `public/` tree.
   */
  resolveMediaSrc(src: string): string;
};

/* -------------------------------------------------------------------------- */
/* Inspector and toolbar                                                       */
/* -------------------------------------------------------------------------- */

export type InspectorSlotProps = {
  store: DocStore;
  state: DocStoreState;
  /** Raw selection, and the same selection already looked up in the document. */
  selection: Selection;
  resolved: ResolvedSelection;
};

export type ToolbarSlotProps = {
  store: DocStore;
  state: DocStoreState;
};

/* -------------------------------------------------------------------------- */
/* The slot bundle                                                             */
/* -------------------------------------------------------------------------- */

export type EditorShellSlots = {
  /** Mount WS-5's `<ProseEditor>`. Omitted: read-only plain text. */
  renderProseBlock?: (props: ProseBlockSlotProps) => ReactNode;
  /** Mount WS-4's `<CanvasEditor>`. Omitted: read-only positioned boxes. */
  renderCanvasBand?: (props: CanvasBandSlotProps) => ReactNode;
  /** Appended to the inspector, below the shell's own panels. For WS-6's picker. */
  renderInspectorExtra?: (props: InspectorSlotProps) => ReactNode;
  /** Appended to the toolbar, left of Save. For sign-in state, page switcher. */
  renderToolbarExtra?: (props: ToolbarSlotProps) => ReactNode;
};
