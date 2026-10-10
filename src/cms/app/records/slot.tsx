/**
 * src/cms/app/records/slot.tsx
 *
 * WS-E. The adapter between WS-D's record-editor slot and these editors.
 *
 * WS-D's shell (`src/cms/app/shell/site-slots.ts`) hands its slot a bundle:
 * the store, the section, the fields, the entry, its index, the whole
 * collection, an `onPatch`, an `onReplace`, an upload bound to this record's
 * own media directory, and a `resolveMediaSrc`. WS-E's brief says the editors
 * take a record and an `onChange`. Both are right — one is a host, the other
 * is a control — so the join is this function and WS-G writes no glue:
 *
 *     import { recordEditorSlot } from '../records/index.ts';
 *     <SiteShell slots={{ ...slots, renderRecordEditor: recordEditorSlot }} />
 *
 * The props are typed structurally, not imported from
 * `src/cms/app/shell/site-slots.ts`. This directory does not depend on a file
 * another workstream owns, and WS-D's richer `RecordEditorSlotProps` satisfies
 * `RecordSlotLike` by having more than it needs.
 */

import type { ReactNode } from 'react';

import type { RecordEntry } from '../../schema.ts';
import type { RecordField, RecordSectionDef } from '../../sections.ts';

import { RecordEditor } from './RecordEditor.tsx';
import type { UploadedMedia, UploadOptions } from './types.ts';

/** As much of a host's slot props as a record editor actually uses. */
export type RecordSlotLike = {
  section: RecordSectionDef;
  entry: RecordEntry;
  fields?: readonly RecordField[];
  /** Replace the whole record. Every edit these editors make is a whole record. */
  onReplace: (entry: RecordEntry) => void;
  /** Already bound to this record's own media directory by the host. */
  uploadMedia: (file: File, options?: UploadOptions) => Promise<UploadedMedia>;
  resolveMediaSrc?: (src: string) => string;
  disabled?: boolean;
  onNotice?: (level: 'info' | 'error', message: string) => void;
};

export function recordEditorSlot(props: RecordSlotLike): ReactNode {
  return (
    <RecordEditor
      section={props.section}
      record={props.entry}
      onChange={props.onReplace}
      uploadMedia={props.uploadMedia}
      {...(props.fields === undefined ? {} : { fields: props.fields })}
      {...(props.resolveMediaSrc === undefined
        ? {}
        : { resolveMediaSrc: props.resolveMediaSrc })}
      {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
      {...(props.onNotice === undefined ? {} : { onNotice: props.onNotice })}
    />
  );
}

export default recordEditorSlot;
