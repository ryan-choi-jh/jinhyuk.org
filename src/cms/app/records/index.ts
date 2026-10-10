/**
 * src/cms/app/records/index.ts
 *
 * WS-E's public surface (docs/cms-sections.md 5: "Owns src/cms/app/records/**").
 * WS-D and WS-G import from here and from nowhere else inside this directory.
 *
 *   import { RecordEditor } from '../records/index.ts';
 *   import type { UploadMedia } from '../records/index.ts';
 *
 *   <RecordEditor
 *     section={section}                                   // RecordSectionDef
 *     record={entry}                                      // Film | Album
 *     onChange={(next) => store.setRecord(next)}
 *     uploadMedia={(file) => api.uploadMedia(section.id, key, file)}
 *   />
 *
 * `RecordEditor` dispatches on `section.records.key`; `FilmEditor` and
 * `AlbumEditor` are there for a caller that already knows which one it wants.
 * Mounting inside WS-D's shell needs no glue at all:
 *
 *   import { recordEditorSlot } from '../records/index.ts';
 *   <SiteShell slots={{ ...slots, renderRecordEditor: recordEditorSlot }} />
 *
 * Everything here is pure editing: no fetch, no API client, no knowledge of a
 * URL. The single seam on the outside world is the `uploadMedia` prop.
 */

export { RecordEditor, default } from './RecordEditor.tsx';
export type { RecordEditorDispatchProps } from './RecordEditor.tsx';

export { recordEditorSlot } from './slot.tsx';
export type { RecordSlotLike } from './slot.tsx';

export { FilmEditor, filmFields } from './FilmEditor.tsx';
export type { FilmEditorProps } from './FilmEditor.tsx';

export { AlbumEditor, albumFields } from './AlbumEditor.tsx';
export type { AlbumEditorProps } from './AlbumEditor.tsx';

export { PhotoGrid } from './PhotoGrid.tsx';
export type { PhotoGridProps } from './PhotoGrid.tsx';

export type {
  RecordEditorProps,
  UnknownField,
  UploadMedia,
  UploadOptions,
  UploadedMedia,
} from './types.ts';

export { RECORDS_CSS, RECORDS_STYLE_ID, useRecordsStyles } from './styles.ts';

/* The pure edit functions, for WS-D's list actions and anyone writing a test. */
export {
  applyYouTubeInput,
  blankFilm,
  canonicalFilm,
  clearFilmPoster,
  filmFieldProblem,
  isFilmComplete,
  optionalText,
  patchFilm,
  pinYouTubePoster,
  posterOrigin,
  posterSrc,
  readYouTubeInput,
  setFilmPoster,
  yearProblem,
  youTubeInputValue,
} from './film-edits.ts';
export type { PosterOrigin, YouTubeReading } from './film-edits.ts';

export {
  albumFieldProblem,
  appendPhotos,
  blankAlbum,
  canonicalAlbum,
  canonicalPhoto,
  clearCover,
  effectiveCoverId,
  hasPinnedCover,
  indexOfPhoto,
  insertPhotosAt,
  isAlbumComplete,
  isCover,
  missingAltCount,
  movePhoto,
  movePhotoBy,
  patchAlbum,
  photoFromUpload,
  removePhoto,
  reorderPhotos,
  restorePhoto,
  setAlbumTitle,
  setCover,
  setPhotoAlt,
  setPhotoCaption,
  slugFollowsTitle,
  suggestSlug,
  toggleCover,
} from './album-edits.ts';
export type { PhotoRemoval } from './album-edits.ts';

export {
  CONCURRENCY,
  UNKNOWN_PROGRESS,
  failedTasks,
  inFlight,
  insertIndexFor,
  isIdle,
  isPhotoFile,
  isSettled,
  makeTasks,
  patchTask,
  pruneSettled,
  rejectedFileMessage,
  removeTask,
  startable,
  summarise,
  uploadStatusLine,
  visibleTasks,
} from './uploads.ts';
export type { UploadStatus, UploadSummary, UploadTask } from './uploads.ts';

export { useUploadQueue } from './use-uploads.ts';
export type { AddResult, UploadQueue, UseUploadQueueOptions } from './use-uploads.ts';

export { FieldShell, FilePick, Group, TextBlock, TextLine, TextualField } from './fields.tsx';

export {
  assertNever,
  fieldGroup,
  findField,
  isMediaField,
  isTextField,
  recordFieldsFor,
  requireRecordSection,
  splitFields,
} from './field-plan.ts';
export type { FieldGroup } from './field-plan.ts';
