/**
 * src/cms/app/records/use-uploads.ts
 *
 * WS-E. The side-effecting half of the upload queue: it turns the pure task
 * machine in `./uploads.ts` into promises against the injected `uploadMedia`.
 *
 * It is the ONLY file in this directory that starts anything asynchronous, and
 * even here the asynchrony is somebody else's function. There is no `fetch`,
 * no URL and no knowledge of `/api/cms/...` anywhere in `src/cms/app/records`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  CONCURRENCY,
  UNKNOWN_PROGRESS,
  insertIndexFor,
  isPhotoFile,
  makeTasks,
  patchTask,
  pruneSettled,
  rejectedFileMessage,
  removeTask,
  startable,
  summarise,
} from './uploads.ts';
import type { UploadSummary, UploadTask } from './uploads.ts';
import type { UploadMedia, UploadedMedia } from './types.ts';

export type AddResult = {
  /** How many files were queued. */
  accepted: number;
  /** One message per file that was not an image, ready to show. */
  rejected: string[];
};

export type UploadQueue = {
  tasks: UploadTask[];
  summary: UploadSummary;
  /**
   * Queue files. `anchor` is where this batch should land in the list the
   * caller is building — `album.photos.length` for an album.
   */
  add: (files: readonly File[], anchor: number) => AddResult;
  retry: (key: string) => void;
  dismiss: (key: string) => void;
  dismissFailed: () => void;
};

export type UseUploadQueueOptions = {
  uploadMedia: UploadMedia;
  /**
   * Called once per successful upload, with the index the new item should take
   * so that a batch keeps its selection order however the uploads race.
   */
  onUploaded: (upload: UploadedMedia, task: UploadTask, insertAt: number) => void;
  onFailed?: (task: UploadTask, message: string) => void;
  concurrency?: number;
};

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The queue. Tasks live in state because they are drawn; the `File` objects
 * live in a ref because they are not, and a 20MB JPEG has no business in a
 * React render.
 */
export function useUploadQueue(options: UseUploadQueueOptions): UploadQueue {
  const { uploadMedia, onUploaded, onFailed, concurrency = CONCURRENCY } = options;

  const [tasks, setTasks] = useState<UploadTask[]>([]);

  const filesRef = useRef(new Map<string, File>());
  const abortsRef = useRef(new Map<string, AbortController>());
  /** Keys already handed to `uploadMedia`, so StrictMode's double effect cannot double-send. */
  const startedRef = useRef(new Set<string>());
  const orderRef = useRef(0);
  const liveRef = useRef(true);
  /** Latest tasks, for the completion handlers, which must not close over stale state. */
  const tasksRef = useRef<UploadTask[]>(tasks);
  tasksRef.current = tasks;

  /** Callbacks through refs: a caller re-creating its closures must not restart uploads. */
  const uploadRef = useRef(uploadMedia);
  uploadRef.current = uploadMedia;
  const uploadedRef = useRef(onUploaded);
  uploadedRef.current = onUploaded;
  const failedRef = useRef(onFailed);
  failedRef.current = onFailed;

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      for (const controller of abortsRef.current.values()) controller.abort();
      abortsRef.current.clear();
    };
  }, []);

  const add = useCallback((files: readonly File[], anchor: number): AddResult => {
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const file of files) {
      if (isPhotoFile(file)) accepted.push(file);
      else rejected.push(rejectedFileMessage(file.name));
    }
    if (accepted.length > 0) {
      const fresh = makeTasks(accepted, { nextOrder: orderRef.current, anchor });
      orderRef.current += accepted.length;
      accepted.forEach((file, index) => {
        const task = fresh[index];
        if (task !== undefined) filesRef.current.set(task.key, file);
      });
      setTasks((current) => [...current, ...fresh]);
    }
    return { accepted: accepted.length, rejected };
  }, []);

  const retry = useCallback((key: string) => {
    startedRef.current.delete(key);
    setTasks((current) =>
      patchTask(current, key, { status: 'queued', progress: UNKNOWN_PROGRESS, error: undefined }),
    );
  }, []);

  const dismiss = useCallback((key: string) => {
    abortsRef.current.get(key)?.abort();
    abortsRef.current.delete(key);
    filesRef.current.delete(key);
    startedRef.current.delete(key);
    setTasks((current) => removeTask(current, key));
  }, []);

  const dismissFailed = useCallback(() => {
    setTasks((current) => {
      for (const task of current) {
        if (task.status === 'failed') {
          filesRef.current.delete(task.key);
          startedRef.current.delete(task.key);
        }
      }
      return current.filter((task) => task.status !== 'failed');
    });
  }, []);

  /* ---------------------------------------------------------------------- */
  /* The pump                                                               */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const next = startable(tasks, concurrency).filter((task) => !startedRef.current.has(task.key));
    if (next.length === 0) return;

    for (const task of next) {
      const file = filesRef.current.get(task.key);
      if (file === undefined) {
        setTasks((current) =>
          patchTask(current, task.key, { status: 'failed', error: 'the file went away' }),
        );
        continue;
      }
      startedRef.current.add(task.key);
      const controller = new AbortController();
      abortsRef.current.set(task.key, controller);
      setTasks((current) =>
        patchTask(current, task.key, { status: 'uploading', progress: UNKNOWN_PROGRESS }),
      );

      const started = uploadRef.current(file, {
        signal: controller.signal,
        onProgress: (fraction: number) => {
          if (!liveRef.current) return;
          const clamped = Math.min(Math.max(fraction, 0), 1);
          setTasks((current) => patchTask(current, task.key, { progress: clamped }));
        },
      });

      void started
        .then((upload) => {
          if (!liveRef.current) return;
          abortsRef.current.delete(task.key);
          filesRef.current.delete(task.key);
          // The index comes off the ref, which is updated synchronously below,
          // so three uploads finishing in the same tick and out of order still
          // land in selection order.
          const live = tasksRef.current.find((candidate) => candidate.key === task.key) ?? task;
          const insertAt = insertIndexFor(tasksRef.current, live);
          const settle = { status: 'done' as const, progress: 1 };
          tasksRef.current = patchTask(tasksRef.current, task.key, settle);
          setTasks((current) => patchTask(current, task.key, settle));
          uploadedRef.current(upload, live, insertAt);
        })
        .catch((error: unknown) => {
          if (!liveRef.current) return;
          abortsRef.current.delete(task.key);
          const message = messageOf(error);
          tasksRef.current = patchTask(tasksRef.current, task.key, {
            status: 'failed',
            error: message,
          });
          setTasks((current) => patchTask(current, task.key, { status: 'failed', error: message }));
          failedRef.current?.(task, message);
        });
    }
  }, [tasks, concurrency]);

  /** Finished tasks disappear once the batch is over; failures wait to be dealt with. */
  useEffect(() => {
    if (tasks.length === 0) return;
    const pruned = pruneSettled(tasks);
    if (pruned.length === tasks.length) return;
    const timer = setTimeout(() => {
      if (!liveRef.current) return;
      setTasks((current) => pruneSettled(current));
    }, 400);
    return () => clearTimeout(timer);
  }, [tasks]);

  const summary = useMemo(() => summarise(tasks), [tasks]);

  return { tasks, summary, add, retry, dismiss, dismissFailed };
}
