/**
 * src/cms/app/records/types.ts
 *
 * WS-E RECORD EDITORS. The props both editors take, and the one seam they
 * have on the outside world.
 *
 * Rule for this whole directory (docs/cms-sections.md 5, WS-E): the editors
 * are PURE EDITING. They never fetch, never touch `/api/cms/...`, never read
 * a file. A record comes in, a changed record goes out through `onChange`, and
 * the only thing that reaches the network is the `uploadMedia` function the
 * caller injects — which is why both editors can be driven in a headless
 * browser with no server (`./harness/drive.mjs`).
 *
 * `uploadMedia` is shaped so that WS-G can hand over WS-C's endpoint with no
 * adapter:
 *
 *   <AlbumEditor
 *     record={album}
 *     onChange={setAlbum}
 *     uploadMedia={(file) => api.uploadMediaDetailed(section.id, album.slug, file, file.name)}
 *   />
 *
 * `MediaUpload` from `src/cms/server/client.ts` has `src`, `w` and `h` plus
 * extra keys, so a function returning one already satisfies `UploadMedia`.
 */

import type { ReactNode } from 'react';

import type { RecordField } from '../../sections.ts';

/* -------------------------------------------------------------------------- */
/* Upload                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What `POST /api/cms/media/:section[/:slug]` answers with, as much of it as a
 * record editor needs (docs/cms-contracts.md 11): the site-absolute `src` and
 * the intrinsic pixel size.
 *
 * `w`/`h` are tolerated as absent or null because the schema is strict about
 * them travelling together (10.2 rule 1): the editor writes both or neither,
 * and never half a pair.
 */
export type UploadedMedia = {
  /** Site-absolute (`/media/photography/<album>/<file>`) or `http(s)`. */
  src: string;
  w?: number | null;
  h?: number | null;
};

/** Per-file progress and cancellation, both optional for the implementor. */
export type UploadOptions = {
  /** Called with 0..1 as the bytes go out. An implementation may never call it. */
  onProgress?: (fraction: number) => void;
  /** Aborted when the editor unmounts mid-upload. */
  signal?: AbortSignal;
};

/**
 * The injected upload. One file in, one `{ src, w, h }` out, rejecting with an
 * `Error` whose `message` is safe to show (the API client's convention).
 *
 * The section and the slug are bound by the CALLER, not passed per file: a
 * record editor edits one record and does not know which section it is in.
 */
export type UploadMedia = (file: File, options?: UploadOptions) => Promise<UploadedMedia>;

/* -------------------------------------------------------------------------- */
/* Editor props                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Common to `FilmEditor` and `AlbumEditor`. `T` is `Film` or `Album`.
 *
 * `onChange` is called with a whole, new record on every committed edit — one
 * keystroke in a text field is one call, same as the document editor's store.
 * The editors hold no copy of the record: what is on screen is `record`.
 */
export type RecordEditorProps<T> = {
  record: T;
  onChange: (next: T) => void;

  /** Required for the fields that upload: a film's poster, an album's photos. */
  uploadMedia: UploadMedia;

  /**
   * The fields to render, in order. Defaults to this record's own
   * `section.records.fields` from `src/cms/sections.ts`, so WS-G passes
   * nothing and a field added to the registry appears here with no change to
   * this directory.
   */
  fields?: readonly RecordField[];

  /**
   * Map a stored `src` to something this document can load. The real editor
   * passes nothing (a site-absolute `src` resolves against the origin); the
   * offline harness points `/media/...` at `file://.../public/...`.
   */
  resolveMediaSrc?: (src: string) => string;

  /** Everything read-only, for a record being saved. */
  disabled?: boolean;

  /**
   * Surface a transient message (an upload that failed, a photo deleted with
   * its undo). The editor shows its own inline affordances regardless; this is
   * for the shell's notice line.
   */
  onNotice?: (level: 'info' | 'error', message: string) => void;

  /** Extra controls for the editor's header, e.g. WS-D's save button. */
  headerExtra?: ReactNode;
};

/** A field the generic renderer could not place, so the editor can be loud about it. */
export type UnknownField = { field: RecordField; reason: string };
