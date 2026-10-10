/**
 * src/cms/app/records/FilmEditor.tsx
 *
 * WS-E. One film: paste a YouTube URL, see the right video, give it a title, a
 * kind, a year and a note, and choose a poster frame.
 *
 *   <FilmEditor record={film} onChange={setFilm} uploadMedia={upload} />
 *
 * Pure editing. The only thing that leaves this component is `onChange` with a
 * whole new `Film`, and the only thing that reaches the outside world is the
 * injected `uploadMedia` (see `./types.ts`).
 *
 * Two deliberate choices:
 *
 *  - **The stage is click-to-play,** exactly like the live filmography page
 *    (`src/pages/filmography/index.astro`): the poster frame with a play
 *    button, and the `youtube-nocookie` iframe only after a click. So the
 *    editor shows what the site will show, nothing is fetched from YouTube
 *    until someone asks, and the editor is drivable with no network at all.
 *  - **`youtubeId` is only ever written from `youtubeIdFromInput`.** A
 *    half-typed URL stays in this component's text state and never reaches the
 *    record, which is why a film cannot be saved with a broken video id.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { youtubeEmbedUrl, youtubeThumbUrl, validateFilm } from '../../schema.ts';
import type { Film, YouTubeThumbQuality } from '../../schema.ts';
import type { RecordField } from '../../sections.ts';

import {
  applyYouTubeInput,
  clearFilmPoster,
  filmFieldProblem,
  optionalText,
  pinYouTubePoster,
  posterOrigin,
  readYouTubeInput,
  setFilmPoster,
  patchFilm,
  youTubeInputValue,
} from './film-edits.ts';
import {
  FilePick,
  Group,
  TextLine,
  TextualField,
  findField,
  recordFieldsFor,
  splitFields,
} from './fields.tsx';
import { useRecordsStyles } from './styles.ts';
import type { RecordEditorProps } from './types.ts';
import { useUploadQueue } from './use-uploads.ts';

/** The registry's film fields, so WS-G passes nothing (docs/cms-contracts.md 9.5). */
export function filmFields(): readonly RecordField[] {
  return recordFieldsFor('filmography');
}

const identity = (src: string): string => src;

export type FilmEditorProps = RecordEditorProps<Film>;

export function FilmEditor({
  record,
  onChange,
  uploadMedia,
  fields = filmFields(),
  resolveMediaSrc = identity,
  disabled = false,
  onNotice,
  headerExtra,
}: FilmEditorProps) {
  useRecordsStyles();

  /**
   * The record as it is right now, updated the instant an edit is emitted, so
   * two edits in one tick compose instead of the second overwriting the first.
   */
  const recordRef = useRef(record);
  recordRef.current = record;

  const emit = useCallback(
    (next: Film) => {
      recordRef.current = next;
      onChange(next);
    },
    [onChange],
  );

  /* ---------------------------------------------------------------------- */
  /* The YouTube field                                                      */
  /* ---------------------------------------------------------------------- */

  const [raw, setRaw] = useState(() => youTubeInputValue(record));
  const seenRef = useRef({ id: record.id, youtubeId: record.youtubeId });

  // Follow the record when it changes from outside: a different film opened, or
  // an undo. Typing is never interrupted, because the parsed id of what is in
  // the box already equals what is in the record while someone types a URL.
  useEffect(() => {
    const seen = seenRef.current;
    const switched = seen.id !== record.id;
    const externally = seen.youtubeId !== record.youtubeId;
    seenRef.current = { id: record.id, youtubeId: record.youtubeId };
    if (!switched && !externally) return;
    if (!switched && readYouTubeInput(raw).id === record.youtubeId) return;
    setRaw(youTubeInputValue(record));
  }, [record.id, record.youtubeId, raw]);

  const reading = useMemo(() => readYouTubeInput(raw), [raw]);

  const onYouTubeInput = useCallback(
    (next: string) => {
      setRaw(next);
      const applied = applyYouTubeInput(recordRef.current, next);
      if (applied.changed) emit(applied.film);
    },
    [emit],
  );

  /* ---------------------------------------------------------------------- */
  /* The stage                                                              */
  /* ---------------------------------------------------------------------- */

  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    setPlaying(false);
  }, [record.id, record.youtubeId]);

  /**
   * `maxresdefault.jpg` does not exist for every video — older uploads only
   * have `hqdefault` — so a failed load steps down one quality rather than
   * leaving a broken image where the poster should be.
   */
  const [thumbQuality, setThumbQuality] = useState<YouTubeThumbQuality>('maxresdefault');
  const [posterBroken, setPosterBroken] = useState(false);
  useEffect(() => {
    setThumbQuality('maxresdefault');
    setPosterBroken(false);
  }, [record.youtubeId, record.poster]);

  const origin = posterOrigin(record);
  const uploaded = optionalText(record.poster);
  const posterHref =
    origin === 'uploaded' && uploaded !== undefined
      ? uploaded
      : origin === 'youtube'
        ? youtubeThumbUrl(record.youtubeId, thumbQuality)
        : null;
  const posterDisplay = posterHref === null ? null : resolveMediaSrc(posterHref);

  const onPosterError = useCallback(() => {
    if (origin === 'youtube' && thumbQuality === 'maxresdefault') {
      setThumbQuality('hqdefault');
      return;
    }
    if (origin === 'youtube' && thumbQuality === 'hqdefault') {
      setThumbQuality('mqdefault');
      return;
    }
    setPosterBroken(true);
  }, [origin, thumbQuality]);

  /* ---------------------------------------------------------------------- */
  /* Poster upload                                                          */
  /* ---------------------------------------------------------------------- */

  const queue = useUploadQueue({
    uploadMedia,
    concurrency: 1,
    onUploaded: (upload) => {
      emit(setFilmPoster(recordRef.current, upload.src));
      onNotice?.('info', 'Poster replaced.');
    },
    onFailed: (_task, message) => onNotice?.('error', `The poster did not upload: ${message}`),
  });

  const posterTask = queue.tasks.find((task) => task.status !== 'done');

  const onPosterFiles = useCallback(
    (files: File[]) => {
      const first = files.slice(0, 1);
      const result = queue.add(first, 0);
      for (const message of result.rejected) onNotice?.('error', message);
    },
    [onNotice, queue],
  );

  /* ---------------------------------------------------------------------- */
  /* Fields                                                                 */
  /* ---------------------------------------------------------------------- */

  const split = useMemo(() => splitFields(fields), [fields]);
  const youtubeField = findField(fields, 'youtubeId');
  const posterField = findField(fields, 'poster');

  const textValue = (field: RecordField): string => {
    const value = (record as unknown as Record<string, unknown>)[field.name];
    return typeof value === 'string' ? value : '';
  };

  const problemFor = (field: RecordField): string | null => filmFieldProblem(record, field.name);

  const outstanding = fields
    .map((field) => ({ field, problem: problemFor(field) }))
    .filter((entry) => entry.problem !== null);
  const valid = validateFilm(record).ok;

  const youtubeProblem =
    reading.status === 'bad'
      ? 'That is not a YouTube link. Paste a watch, youtu.be, embed or shorts URL.'
      : youtubeField === undefined
        ? null
        : filmFieldProblem(record, 'youtubeId');

  return (
    <div className="cms-rec cms-rec--film" data-testid="film-editor" data-valid={String(valid)}>
      <header className="cms-rec__head">
        <span className="cms-rec__kicker">Film</span>
        <span className="cms-rec__title" data-testid="film-heading">
          {record.title.trim() === '' ? 'Untitled' : record.title}
        </span>
        <span className="cms-rec__spacer" />
        {headerExtra}
      </header>

      <div className="cms-rec__body">
        <div className="cms-rec__cols">
          <div className="cms-rec__col">
            <Group title="The video" testId="group-video">
              {youtubeField === undefined ? null : (
                <TextLine
                  field={youtubeField}
                  value={raw}
                  onChange={onYouTubeInput}
                  problem={youtubeProblem}
                  disabled={disabled}
                  testId="field-youtube"
                  below={
                    record.youtubeId === '' ? null : (
                      <div className="cms-rec__row">
                        <span className="cms-rec__ok" data-testid="youtube-id">
                          id {record.youtubeId}
                        </span>
                      </div>
                    )
                  }
                />
              )}

              <div style={{ marginTop: 10 }}>
                {record.youtubeId === '' ? (
                  <div
                    className="cms-rec__stage cms-rec__stage--empty"
                    data-testid="film-stage-empty"
                  >
                    Paste a YouTube link and the film appears here.
                  </div>
                ) : (
                  <div className="cms-rec__stage" data-testid="film-stage">
                    {playing ? (
                      <iframe
                        data-testid="film-embed"
                        src={youtubeEmbedUrl(record.youtubeId, { autoplay: true })}
                        title={record.title === '' ? 'Film' : record.title}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        allowFullScreen
                      />
                    ) : (
                      <>
                        {posterDisplay === null || posterBroken ? null : (
                          <img
                            src={posterDisplay}
                            alt=""
                            data-testid="film-poster-img"
                            onError={onPosterError}
                          />
                        )}
                        <button
                          type="button"
                          className="cms-rec__play"
                          data-testid="film-play"
                          onClick={() => setPlaying(true)}
                          aria-label={`Play ${record.title}`}
                        >
                          <span className="cms-rec__play-dot">▶</span>
                        </button>
                        <span
                          className={
                            origin === 'uploaded'
                              ? 'cms-rec__badge cms-rec__badge--own'
                              : 'cms-rec__badge'
                          }
                          data-testid="poster-origin"
                        >
                          {origin === 'uploaded' ? 'Your poster' : `YouTube · ${thumbQuality}`}
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>

              {playing ? (
                <div className="cms-rec__row" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="cms-rec__btn cms-rec__btn--tiny cms-rec__btn--quiet"
                    data-testid="film-stop"
                    onClick={() => setPlaying(false)}
                  >
                    Back to the poster
                  </button>
                  <span className="cms-rec__help">
                    The site plays it the same way: poster first, player on click.
                  </span>
                </div>
              ) : null}
            </Group>

            {posterField === undefined ? null : (
              <Group title="Poster frame" testId="group-poster">
                <div className="cms-rec__poster">
                  <div className="cms-rec__poster-thumb">
                    {posterDisplay === null || posterBroken ? null : (
                      <img src={posterDisplay} alt="" onError={onPosterError} />
                    )}
                  </div>
                  <div className="cms-rec__poster-side">
                    <div className="cms-rec__row">
                      <FilePick
                        id="film-poster-pick"
                        label={origin === 'uploaded' ? 'Replace…' : 'Upload a poster…'}
                        disabled={disabled || posterTask !== undefined}
                        onFiles={onPosterFiles}
                        testId="poster-upload"
                      />
                      {origin === 'uploaded' ? (
                        <button
                          type="button"
                          className="cms-rec__btn cms-rec__btn--tiny"
                          data-testid="poster-clear"
                          disabled={disabled}
                          onClick={() => {
                            emit(clearFilmPoster(recordRef.current));
                            onNotice?.('info', "Back to YouTube's own frame.");
                          }}
                        >
                          Use YouTube&apos;s frame
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="cms-rec__btn cms-rec__btn--tiny"
                          data-testid="poster-pin"
                          disabled={disabled || record.youtubeId === ''}
                          title="Write YouTube's current frame into the record, so it survives a new video id"
                          onClick={() => emit(pinYouTubePoster(recordRef.current, thumbQuality))}
                        >
                          Keep this frame
                        </button>
                      )}
                    </div>
                    {posterTask === undefined ? (
                      <div className="cms-rec__help" data-testid="poster-help">
                        {origin === 'uploaded'
                          ? 'An uploaded frame. Clearing it falls back to YouTube.'
                          : posterField.help ?? "YouTube's own thumbnail is the fallback."}
                      </div>
                    ) : (
                      <div data-testid="poster-progress">
                        <div
                          className={
                            posterTask.progress < 0 ? 'cms-rec__bar cms-rec__bar--waiting' : 'cms-rec__bar'
                          }
                        >
                          <div
                            className="cms-rec__bar-fill"
                            style={{
                              width: `${Math.round((posterTask.progress < 0 ? 0.08 : posterTask.progress) * 100)}%`,
                            }}
                          />
                        </div>
                        <div className="cms-rec__task-state">
                          {posterTask.status === 'failed'
                            ? (posterTask.error ?? 'upload failed')
                            : `uploading ${posterTask.name}`}
                        </div>
                        {posterTask.status === 'failed' ? (
                          <div className="cms-rec__row">
                            <button
                              type="button"
                              className="cms-rec__btn cms-rec__btn--tiny"
                              data-testid="poster-retry"
                              onClick={() => queue.retry(posterTask.key)}
                            >
                              Try again
                            </button>
                            <button
                              type="button"
                              className="cms-rec__btn cms-rec__btn--tiny cms-rec__btn--quiet"
                              data-testid="poster-dismiss"
                              onClick={() => queue.dismiss(posterTask.key)}
                            >
                              Dismiss
                            </button>
                          </div>
                        ) : null}
                      </div>
                    )}
                    {posterBroken ? (
                      <div className="cms-rec__problem" data-testid="poster-broken">
                        That image did not load.
                      </div>
                    ) : null}
                  </div>
                </div>
              </Group>
            )}
          </div>

          <div className="cms-rec__col">
            <Group title="Details" testId="group-details">
              {split.text.map((field) => (
                <TextualField
                  key={field.name}
                  field={field}
                  value={textValue(field)}
                  onChange={(next) =>
                    emit(patchFilm(recordRef.current, { [field.name]: next } as Partial<Film>))
                  }
                  problem={problemFor(field)}
                  disabled={disabled}
                />
              ))}
            </Group>

            {outstanding.length === 0 ? null : (
              <div className="cms-rec__issues" data-testid="film-outstanding">
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
      </div>
    </div>
  );
}

export default FilmEditor;
