/**
 * src/cms/app/shell/site-slots.ts
 *
 * WS-D. The slot contract for the record editor.
 *
 * Phase 1's shell did not implement canvas dragging or prose editing: it
 * rendered a host element per band or block, called a render prop inside it,
 * and drew a read-only placeholder when the render prop was absent. That is
 * what made the shell verifiable before WS-4 and WS-5 existed, and it is
 * exactly what this does for WS-E.
 *
 * The site shell owns everything around the record editor — the section
 * sidebar, the entry list, create/duplicate/delete/reorder, the toolbar with
 * Save and Publish, undo and redo, the dirty indicator, the status line, the
 * unsaved-changes guard, and the upload path with the right media directory
 * already filled in. WS-E owns what is inside one record: the fields of
 * `RecordsDef.fields`, the YouTube paste, the embed, the photo grid, the drag
 * to reorder photos, the cover picker.
 *
 * So the slot is handed a store that can already do everything, plus the one
 * record it should draw:
 *
 *     renderRecordEditor={(props) => <FilmEditor {...props} />}
 *
 * WS-E should not need to edit a file in `src/cms/app/shell/`. If it does,
 * that is a missing slot and a bug against WS-D.
 */

import type { ReactNode } from 'react';

import type { RecordEntry, RecordFile } from '../../schema.ts';
import type { RecordField, RecordSectionDef, RecordsDef } from '../../sections.ts';
import type { MediaUploadResult } from '../state/api.ts';
import type { RecordEditOptions, RecordPatch, RecordStore, RecordStoreState } from '../state/record-store.ts';
import type { EditorShellSlots } from './slots.ts';

/* -------------------------------------------------------------------------- */
/* The record editor slot                                                      */
/* -------------------------------------------------------------------------- */

export type RecordEditorSlotProps = {
  /**
   * The whole store, in case the editor wants to do more than change its own
   * record: undo, save, select another entry, read the collection. Also
   * available through `useOpenRecordStore()` from
   * `../state/use-site-store.ts`; it is the same object.
   */
  store: RecordStore;
  /** The store's state at this render, so the editor need not subscribe itself. */
  state: RecordStoreState;

  section: RecordSectionDef;
  /** `section.records`. Passed so nothing has to narrow to reach it. */
  records: RecordsDef;
  /** `records.fields`, in the order the editor should show them. */
  fields: readonly RecordField[];

  /** The record to draw. Narrow it with the schema's `isFilm` / `isAlbum`. */
  entry: RecordEntry;
  /** Its index in the collection's array, which is the site's order. */
  entryIndex: number;
  /** What identifies it in a URL and in the API: a film's id, an album's slug. */
  entryKey: string;
  /** The whole collection, for anything that needs its siblings. */
  file: RecordFile;
  /** The collection differs from the last saved state. */
  dirty: boolean;

  /**
   * Merge fields into this record. Consecutive calls on the same field
   * coalesce into one undo step, so calling it on every keystroke is correct.
   * Deleting an album's cover photo clears `cover` in the same edit; the store
   * does that, so the editor does not have to remember.
   */
  onPatch(patch: RecordPatch, options?: RecordEditOptions): void;
  /** Replace the whole record. For an editor that keeps its own draft object. */
  onReplace(entry: RecordEntry, options?: RecordEditOptions): void;

  /**
   * Upload into this record's own media directory —
   * `public/media/<section>/<this entry's slug>/` (docs/cms-contracts.md 9.3)
   * — and answer with the `src`, `w` and `h` that `newPhoto(src, { w, h })`
   * wants. The slug is already filled in; the editor passes only the file.
   */
  uploadMedia(file: File): Promise<MediaUploadResult>;

  /**
   * Map a stored `src` onto something loadable here. Identity in production;
   * the harness points it at the local `public/` tree so real images draw with
   * no server. Same prop, same meaning, as the canvas slot's.
   */
  resolveMediaSrc(src: string): string;
};

/* -------------------------------------------------------------------------- */
/* The record toolbar slot                                                     */
/* -------------------------------------------------------------------------- */

export type RecordToolbarSlotProps = {
  store: RecordStore;
  state: RecordStoreState;
};

/* -------------------------------------------------------------------------- */
/* The slot bundle                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Everything `<SiteShell>` takes. The phase 1 slots are unchanged and are
 * passed straight through to `<EditorShell>` for the three document sections.
 */
export type SiteShellSlots = EditorShellSlots & {
  /** Mount WS-E's record editor. Omitted: a read-only field table (`record-stub.tsx`). */
  renderRecordEditor?: (props: RecordEditorSlotProps) => ReactNode;
  /** Appended to the record toolbar, left of Save. */
  renderRecordToolbarExtra?: (props: RecordToolbarSlotProps) => ReactNode;
};
