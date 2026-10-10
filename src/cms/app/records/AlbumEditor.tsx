/**
 * src/cms/app/records/AlbumEditor.tsx
 *
 * WS-E. One album: a title, an address, a year, a summary, and the photographs
 * — dropped in by the handful, dragged into order, one of them the cover, each
 * with its own alt text and caption.
 *
 *   <AlbumEditor record={album} onChange={setAlbum} uploadMedia={upload} />
 *
 * This is the editor the brief says has to feel good, so the things it refuses
 * to do are worth naming:
 *
 *  - It does not ask about files one at a time. One drag or one file dialog
 *    queues every file, three go out at once, and a failure is one tile with a
 *    "Try again" on it rather than a dead batch (`./uploads.ts`).
 *  - It does not reorder by asking for a number. Tiles are dragged, with
 *    arrow buttons as the keyboard path (`./PhotoGrid.tsx`).
 *  - It does not open a dialog to write alt text. Both text fields are on the
 *    tile.
 *  - It does not lose a photo to a mis-click: a deletion is undoable, and
 *    deleting the cover photo clears `cover` in the same edit so the record
 *    stays valid (docs/cms-contracts.md 10.2 rule 3).
 *
 * Pure editing, like the film editor: `onChange` out, injected `uploadMedia`
 * for the one thing that cannot be local.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';

import { IdSchema, validateAlbum } from '../../schema.ts';
import type { Album } from '../../schema.ts';
import { siteUrlFor } from '../../sections.ts';
import type { RecordField } from '../../sections.ts';

import {
  albumFieldProblem,
  effectiveCoverId,
  hasPinnedCover,
  indexOfPhoto,
  insertPhotosAt,
  clearCover,
  missingAltCount,
  movePhoto,
  movePhotoBy,
  patchAlbum,
  photoFromUpload,
  photosProblemIsAdvisory,
  removePhoto,
  restorePhoto,
  setAlbumTitle,
  setPhotoAlt,
  setPhotoCaption,
  suggestSlug,
  toggleCover,
} from './album-edits.ts';
import type { PhotoRemoval } from './album-edits.ts';
import {
  FilePick,
  Group,
  TextualField,
  recordFieldsFor,
  requireRecordSection,
  splitFields,
} from './fields.tsx';
import { PhotoGrid } from './PhotoGrid.tsx';
import { useRecordsStyles } from './styles.ts';
import type { RecordEditorProps } from './types.ts';
import { uploadStatusLine } from './uploads.ts';
import { useUploadQueue } from './use-uploads.ts';

/** The registry's album fields, so WS-G passes nothing (docs/cms-contracts.md 9.5). */
export function albumFields(): readonly RecordField[] {
  return recordFieldsFor('photography');
}

/** How long the undo bar stays up after a deletion. */
const UNDO_MS = 12_000;

const identity = (src: string): string => src;

/**
 * `/photography/<slug>/`, or null while the slug is not yet something that can
 * go in a path. `fillSlug` throws on a bad slug by design — it is the
 * traversal guard — so the check happens here, where a half-typed slug is
 * normal rather than a bug.
 */
function albumUrl(slug: string): string | null {
  if (!IdSchema.safeParse(slug).success) return null;
  try {
    return siteUrlFor(requireRecordSection('photography'), slug);
  } catch {
    return null;
  }
}

export type AlbumEditorProps = RecordEditorProps<Album>;

export function AlbumEditor({
  record,
  onChange,
  uploadMedia,
  fields = albumFields(),
  resolveMediaSrc = identity,
  disabled = false,
  onNotice,
  headerExtra,
}: AlbumEditorProps) {
  useRecordsStyles();

  /**
   * The album as it is right now. Updated the instant an edit goes out, so
   * three uploads finishing in the same tick each build on the previous one
   * instead of the last writer winning.
   */
  const recordRef = useRef(record);
  recordRef.current = record;

  const emit = useCallback(
    (next: Album) => {
      recordRef.current = next;
      onChange(next);
    },
    [onChange],
  );

  /* ---------------------------------------------------------------------- */
  /* Uploads                                                                */
  /* ---------------------------------------------------------------------- */

  const queue = useUploadQueue({
    uploadMedia,
    onUploaded: (upload, _task, insertAt) => {
      const photo = photoFromUpload(upload);
      emit(insertPhotosAt(recordRef.current, [photo], insertAt));
    },
    onFailed: (task, message) => onNotice?.('error', `${task.name} did not upload: ${message}`),
  });

  const addFiles = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      const result = queue.add(files, recordRef.current.photos.length);
      for (const message of result.rejected) onNotice?.('error', message);
      if (result.accepted > 0) {
        onNotice?.(
          'info',
          result.accepted === 1 ? 'Uploading 1 photo…' : `Uploading ${result.accepted} photos…`,
        );
      }
    },
    [onNotice, queue],
  );

  /* ---------------------------------------------------------------------- */
  /* Drop                                                                   */
  /* ---------------------------------------------------------------------- */

  const [dropping, setDropping] = useState(false);
  const dropDepth = useRef(0);

  const onDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.preventDefault();
    dropDepth.current += 1;
    setDropping(true);
  };
  const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dropDepth.current = Math.max(0, dropDepth.current - 1);
    if (dropDepth.current === 0) setDropping(false);
  };
  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dropDepth.current = 0;
    setDropping(false);
    if (disabled) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    addFiles(files);
  };

  /* ---------------------------------------------------------------------- */
  /* Delete and undo                                                        */
  /* ---------------------------------------------------------------------- */

  const [removal, setRemoval] = useState<PhotoRemoval | null>(null);

  useEffect(() => {
    if (removal === null) return;
    const timer = setTimeout(() => setRemoval(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [removal]);

  // A different album opened: an undo for a photo that is not in this record
  // would put somebody else's picture in it.
  useEffect(() => {
    setRemoval(null);
  }, [record.id]);

  const onRemove = useCallback(
    (photoId: string) => {
      const index = indexOfPhoto(recordRef.current, photoId) + 1;
      const result = removePhoto(recordRef.current, photoId);
      if (result.removal === null) return;
      emit(result.album);
      setRemoval(result.removal);
      onNotice?.('info', `Photo ${index} deleted.`);
    },
    [emit, onNotice],
  );

  const onUndo = useCallback(() => {
    if (removal === null) return;
    emit(restorePhoto(recordRef.current, removal));
    setRemoval(null);
    onNotice?.('info', 'Photo restored.');
  }, [emit, onNotice, removal]);

  /* ---------------------------------------------------------------------- */
  /* Fields                                                                 */
  /* ---------------------------------------------------------------------- */

  const split = useMemo(() => splitFields(fields), [fields]);
  const coverField = fields.find((field) => field.name === 'cover');
  const photosField = fields.find((field) => field.name === 'photos');

  const textValue = (field: RecordField): string => {
    const value = (record as unknown as Record<string, unknown>)[field.name];
    return typeof value === 'string' ? value : '';
  };

  const onTextChange = (field: RecordField, next: string): void => {
    if (field.name === 'title') {
      emit(setAlbumTitle(recordRef.current, next));
      return;
    }
    emit(patchAlbum(recordRef.current, { [field.name]: next } as Partial<Album>));
  };

  const coverId = effectiveCoverId(record);
  const pinned = hasPinnedCover(record);
  const coverPhoto = record.photos.find((photo) => photo.id === coverId) ?? null;
  const url = albumUrl(record.slug);
  const suggested = suggestSlug(record.title, record.id);
  const valid = validateAlbum(record).ok;
  const missingAlt = missingAltCount(record);
  const statusLine = uploadStatusLine(queue.summary);

  const outstanding = fields
    .map((field) => ({ field, problem: albumFieldProblem(record, field.name) }))
    .filter((entry) => entry.problem !== null && !photosProblemIsAdvisory(entry.field.name));

  return (
    <div
      className="cms-rec cms-rec--album"
      data-testid="album-editor"
      data-valid={String(valid)}
      data-photos={record.photos.length}
      data-cover={coverId ?? ''}
    >
      <header className="cms-rec__head">
        <span className="cms-rec__kicker">Album</span>
        <span className="cms-rec__title" data-testid="album-heading">
          {record.title.trim() === '' ? 'Untitled album' : record.title}
        </span>
        <span className="cms-rec__kicker" data-testid="album-count">
          {record.photos.length} photo{record.photos.length === 1 ? '' : 's'}
        </span>
        <span className="cms-rec__spacer" />
        {headerExtra}
      </header>

      <div className="cms-rec__body">
        <div className="cms-rec__cols">
          <div className="cms-rec__col">
            <Group title="The album" testId="group-album">
              {split.text.map((field) => (
                <TextualField
                  key={field.name}
                  field={field}
                  value={textValue(field)}
                  onChange={(next) => onTextChange(field, next)}
                  problem={albumFieldProblem(record, field.name)}
                  disabled={disabled}
                  urlPreview={field.type === 'slug' ? (url ?? 'not a usable address yet') : undefined}
                  {...(field.type === 'slug' && record.slug !== suggested
                    ? {
                        fix: {
                          label: `use "${suggested}"`,
                          onClick: () => emit(patchAlbum(recordRef.current, { slug: suggested })),
                        },
                      }
                    : {})}
                />
              ))}
            </Group>
          </div>

          <div className="cms-rec__col">
            {coverField === undefined ? null : (
              <Group title="Cover" testId="group-cover">
                <div className="cms-rec__poster">
                  <div className="cms-rec__poster-thumb" data-testid="cover-thumb">
                    {coverPhoto === null ? null : (
                      <img src={resolveMediaSrc(coverPhoto.src)} alt="" />
                    )}
                  </div>
                  <div className="cms-rec__poster-side">
                    {coverPhoto === null ? (
                      <div className="cms-rec__help" data-testid="cover-state">
                        No photos yet, so there is nothing to put on the tile.
                      </div>
                    ) : (
                      <>
                        <div data-testid="cover-state">
                          {pinned ? 'Chosen' : 'The first photo'}
                          <span className="cms-rec__help">
                            {' '}
                            · photo {indexOfPhoto(record, coverPhoto.id) + 1}
                          </span>
                        </div>
                        <div className="cms-rec__help">
                          {pinned
                            ? 'Reordering the album will not move it.'
                            : coverField.help ?? 'Star a tile to choose a different one.'}
                        </div>
                        {pinned ? (
                          <div className="cms-rec__row">
                            <button
                              type="button"
                              className="cms-rec__btn cms-rec__btn--tiny"
                              data-testid="cover-clear"
                              disabled={disabled}
                              onClick={() => emit(clearCover(recordRef.current))}
                            >
                              Follow the first photo
                            </button>
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              </Group>
            )}
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <Group
            title={photosField?.label ?? 'Photos'}
            testId="group-photos"
            aside={
              <>
                {missingAlt > 0 ? (
                  <span className="cms-rec__help" data-testid="alt-nudge">
                    {missingAlt} without alt text
                  </span>
                ) : null}
                <FilePick
                  id="album-photo-pick"
                  label="Add photos…"
                  multiple
                  primary
                  disabled={disabled}
                  onFiles={addFiles}
                  testId="add-photos"
                />
              </>
            }
          >
            <div
              className="cms-rec__drop"
              data-testid="photo-drop"
              data-dropping={String(dropping)}
              onDragEnter={onDragEnter}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            >
              {record.photos.length === 0 && queue.tasks.length === 0 ? (
                <div className="cms-rec__drop-hint" data-testid="photo-empty">
                  Drop photographs here, or choose them. Several at once is the point.
                </div>
              ) : (
                <PhotoGrid
                  photos={record.photos}
                  coverId={coverId}
                  pinnedCover={pinned}
                  tasks={queue.tasks}
                  disabled={disabled}
                  resolveMediaSrc={resolveMediaSrc}
                  onReorder={(from, to) => emit(movePhoto(recordRef.current, from, to))}
                  onMoveBy={(photoId, delta) => emit(movePhotoBy(recordRef.current, photoId, delta))}
                  onToggleCover={(photoId) => emit(toggleCover(recordRef.current, photoId))}
                  onRemove={onRemove}
                  onAlt={(photoId, value) => emit(setPhotoAlt(recordRef.current, photoId, value))}
                  onCaption={(photoId, value) =>
                    emit(setPhotoCaption(recordRef.current, photoId, value))
                  }
                  onRetry={queue.retry}
                  onDismiss={queue.dismiss}
                />
              )}
            </div>

            {statusLine === null ? null : (
              <div className="cms-rec__row" style={{ marginTop: 8 }}>
                <span className="cms-rec__help" data-testid="upload-status">
                  {statusLine}
                </span>
                {queue.summary.failed > 0 && !queue.summary.busy ? (
                  <button
                    type="button"
                    className="cms-rec__btn cms-rec__btn--tiny cms-rec__btn--quiet"
                    data-testid="dismiss-failed"
                    onClick={queue.dismissFailed}
                  >
                    Dismiss {queue.summary.failed}
                  </button>
                ) : null}
              </div>
            )}

            {removal === null ? null : (
              <div className="cms-rec__undo" data-testid="undo-bar">
                <span className="cms-rec__undo-text">
                  Deleted photo {removal.index + 1}
                  {removal.coverWas === removal.photo.id ? ', which was the cover' : ''}.
                </span>
                <button
                  type="button"
                  className="cms-rec__btn cms-rec__btn--tiny"
                  data-testid="undo-remove"
                  onClick={onUndo}
                >
                  Undo
                </button>
                <button
                  type="button"
                  className="cms-rec__btn cms-rec__btn--tiny cms-rec__btn--quiet"
                  data-testid="undo-dismiss"
                  onClick={() => setRemoval(null)}
                >
                  Dismiss
                </button>
              </div>
            )}
          </Group>
        </div>

        {outstanding.length === 0 ? null : (
          <div className="cms-rec__issues" data-testid="album-outstanding">
            Not ready to save:
            <ul>
              {outstanding.map((entry) => (
                <li key={entry.field.name}>
                  <strong>{entry.field.label}</strong> — {entry.problem}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

export default AlbumEditor;
