/**
 * src/cms/app/records/uploads.ts
 *
 * WS-E. The upload queue, as data and pure functions. The side effects live in
 * `./use-uploads.ts`; everything here can be stepped through under bare node,
 * which is how `./verify.ts` proves that six files dropped at once end up in
 * the album in the order they were chosen even when they finish out of order
 * and one of them fails.
 *
 * The brief that matters (docs/cms-sections.md 5, WS-E): "Six photos should
 * take one drag and a few seconds, not six round trips." So:
 *
 *  - selecting many files makes many tasks at once, with no dialog per file;
 *  - `CONCURRENCY` of them are in flight together;
 *  - a task that fails does not stop the others, and can be retried on its own;
 *  - a finished task is inserted at the position its file had in the
 *    selection, not at the position it happened to finish in.
 */

import { IMAGE_EXTENSIONS, extensionOf } from '../integration/media.ts';

/* -------------------------------------------------------------------------- */
/* What can be uploaded                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Albums and posters hold pictures, so video is refused here even though the
 * media endpoint would take it. The extension list comes from WS-8's module,
 * which mirrors `ALLOWED_MEDIA` in `src/cms/server/config.ts`: one allow-list,
 * not three.
 */
export function isPhotoFile(file: { name: string; type?: string }): boolean {
  const extension = extensionOf(file.name);
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(extension)) return true;
  return false;
}

export function rejectedFileMessage(name: string): string {
  const extension = extensionOf(name);
  const shown = extension === '' ? 'no extension' : `.${extension}`;
  return `${name} (${shown}) is not an image. Pictures only: ${IMAGE_EXTENSIONS.join(', ')}.`;
}

/* -------------------------------------------------------------------------- */
/* Tasks                                                                       */
/* -------------------------------------------------------------------------- */

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'failed';

export type UploadTask = {
  /** Stable local key. Not a photo id: a task may never become a photo. */
  key: string;
  name: string;
  size: number;
  /**
   * Position in the selection. Monotonic across the editor's lifetime, so two
   * overlapping batches still each keep their own order.
   */
  order: number;
  /**
   * Where this task's batch started: `album.photos.length` when the files were
   * chosen. A completed upload lands at `anchor` plus however many earlier
   * files in the batch have already landed.
   */
  anchor: number;
  status: UploadStatus;
  /** 0..1 when the upload reports progress, else -1 for "no idea yet". */
  progress: number;
  error?: string;
};

/** How many uploads are in flight at once. Six photos in two waves of three. */
export const CONCURRENCY = 3;

export const UNKNOWN_PROGRESS = -1;

export function isSettled(task: UploadTask): boolean {
  return task.status === 'done' || task.status === 'failed';
}

export function inFlight(tasks: readonly UploadTask[]): number {
  return tasks.filter((task) => task.status === 'uploading').length;
}

export function isIdle(tasks: readonly UploadTask[]): boolean {
  return !tasks.some((task) => task.status === 'queued' || task.status === 'uploading');
}

/** Tasks the grid draws. A finished one is replaced by its real photo tile. */
export function visibleTasks(tasks: readonly UploadTask[]): UploadTask[] {
  return tasks.filter((task) => task.status !== 'done');
}

export function failedTasks(tasks: readonly UploadTask[]): UploadTask[] {
  return tasks.filter((task) => task.status === 'failed');
}

/**
 * One new task per file, in the order the files were given. `nextOrder` is the
 * editor's running counter; `anchor` is where this batch lands in the album.
 */
export function makeTasks(
  files: readonly { name: string; size?: number }[],
  options: { nextOrder: number; anchor: number; keyPrefix?: string },
): UploadTask[] {
  const prefix = options.keyPrefix ?? 'up';
  return files.map((file, index) => ({
    key: `${prefix}-${options.nextOrder + index}`,
    name: file.name,
    size: file.size ?? 0,
    order: options.nextOrder + index,
    anchor: options.anchor,
    status: 'queued' as const,
    progress: UNKNOWN_PROGRESS,
  }));
}

/** The queued tasks that may start now, oldest first, up to the concurrency limit. */
export function startable(tasks: readonly UploadTask[], limit = CONCURRENCY): UploadTask[] {
  const room = Math.max(0, limit - inFlight(tasks));
  if (room === 0) return [];
  return tasks
    .filter((task) => task.status === 'queued')
    .sort((a, b) => a.order - b.order)
    .slice(0, room);
}

/** Replace one task. Returns the same array identity when nothing matched. */
export function patchTask(
  tasks: readonly UploadTask[],
  key: string,
  patch: Partial<UploadTask>,
): UploadTask[] {
  let hit = false;
  const next = tasks.map((task) => {
    if (task.key !== key) return task;
    hit = true;
    const merged = { ...task, ...patch };
    if (patch.error === undefined && 'error' in patch) delete merged.error;
    return merged;
  });
  return hit ? next : [...tasks];
}

export function removeTask(tasks: readonly UploadTask[], key: string): UploadTask[] {
  return tasks.filter((task) => task.key !== key);
}

/**
 * Where a finished upload goes: the batch's anchor, plus one place for every
 * earlier file in the same batch that has already landed. That is what keeps
 * the album in selection order while three uploads race.
 *
 * Two batches that overlap in time can interleave with each other — each keeps
 * its own order, which is what a person dropping files twice expects.
 */
export function insertIndexFor(tasks: readonly UploadTask[], task: UploadTask): number {
  const landedBefore = tasks.filter(
    (other) => other.anchor === task.anchor && other.status === 'done' && other.order < task.order,
  ).length;
  return task.anchor + landedBefore;
}

/**
 * Drop the finished tasks once nothing is in flight. Failures stay until they
 * are retried or dismissed, because a failure the editor forgets is a photo
 * the owner thinks they uploaded.
 */
export function pruneSettled(tasks: readonly UploadTask[]): UploadTask[] {
  if (!isIdle(tasks)) return [...tasks];
  return tasks.filter((task) => task.status === 'failed');
}

/* -------------------------------------------------------------------------- */
/* Progress summary                                                            */
/* -------------------------------------------------------------------------- */

export type UploadSummary = {
  total: number;
  done: number;
  failed: number;
  active: number;
  queued: number;
  /** 0..1 across the whole batch, counting an unknown-progress upload as half. */
  fraction: number;
  busy: boolean;
};

export function summarise(tasks: readonly UploadTask[]): UploadSummary {
  const total = tasks.length;
  const done = tasks.filter((task) => task.status === 'done').length;
  const failed = tasks.filter((task) => task.status === 'failed').length;
  const active = inFlight(tasks);
  const queued = tasks.filter((task) => task.status === 'queued').length;
  const progressed = tasks.reduce((sum, task) => {
    if (task.status === 'done') return sum + 1;
    if (task.status === 'failed') return sum + 1;
    if (task.status === 'uploading') {
      return sum + (task.progress === UNKNOWN_PROGRESS ? 0.5 : task.progress);
    }
    return sum;
  }, 0);
  return {
    total,
    done,
    failed,
    active,
    queued,
    fraction: total === 0 ? 0 : progressed / total,
    busy: active + queued > 0,
  };
}

/** The sentence under the grid while a batch is going out. */
export function uploadStatusLine(summary: UploadSummary): string | null {
  if (summary.total === 0) return null;
  if (summary.busy) {
    const place = Math.min(summary.done + summary.active + summary.failed, summary.total);
    return `Uploading ${place} of ${summary.total}…`;
  }
  if (summary.failed > 0) {
    return `${summary.failed} of ${summary.total} did not upload.`;
  }
  return null;
}
