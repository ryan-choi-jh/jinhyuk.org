/**
 * src/cms/app/shell/publish-queue.ts
 *
 * Everything that is saved but not live, and a way to put chosen ones live.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * Publishing used to be three unrelated buttons. The toolbar's Publish moved
 * the OPEN DOCUMENT's draft; the nav-and-footer panel had its own, which
 * moved `site.json`; a record collection had a third. Each was correct on
 * its own and the set of them was not, because the question people actually
 * have is not "publish this page" — it is "what is about to go live, and
 * which of it do I want".
 *
 * The failure that prompted this: a body-size change was saved into
 * `site.json` and an unfinished essay was saved as a page draft, and
 * pressing the big blue Publish answered
 *
 *   There is no draft of "home" to publish.
 *
 * which is true, unhelpful, and says nothing about either of the two things
 * that really were waiting. There was no way to publish one of them without
 * knowing which of three buttons owned it.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE
 * ---------------------------------------------------------------------------
 *
 * A queue is a LIST of pending things, each carrying its own `publish`. The
 * three kinds publish through three different endpoints and the panel should
 * not know that; it ticks boxes and calls what the item hands it.
 *
 * `list()` is async and is called when the panel opens, not held in state.
 * A draft saved in another tab five minutes ago is pending too, and a cached
 * answer would be a list of what was true when the editor booted.
 *
 * NOTHING HERE PUBLISHES ANYTHING BY ITSELF. The panel decides, one item at
 * a time, and a failure stops the rest: publishing is a commit per item, and
 * carrying on after one has failed would leave a half-done release that
 * nobody asked for and nothing describes.
 */

import { createContext, useContext } from 'react';

import type { SectionId } from '../../schema.ts';

/** One thing that is saved and not live. */
export type PendingItem = {
  /** Stable across a `list()` refresh, so a tick survives one. */
  id: string;
  /** What it is: 'Essays', 'Filmography', 'Site settings'. */
  group: string;
  /** Which one: a page title, or what the setting is. */
  label: string;
  /**
   * What publishing it would do, in a few words — "new page, not on the
   * site yet", "replaces the live version". The distinction matters: one of
   * these adds an address to the site and the other changes a page people
   * may already have open.
   */
  detail: string;
  /** True for the entry the editor is currently showing. */
  current: boolean;
  section: SectionId | null;
  /** Move this one draft into the published tree. */
  publish: () => Promise<void>;
};

export type PublishQueue = {
  /** Everything pending, right now. Ordered: the open entry first. */
  list: () => Promise<PendingItem[]>;
};

const PublishQueueContext = createContext<PublishQueue | null>(null);

export const PublishQueueProvider = PublishQueueContext.Provider;

/**
 * The queue, or null.
 *
 * Optional on purpose. The standalone document editor and every harness
 * mount a toolbar with no site API behind it, and the right behaviour there
 * is the old one — Publish publishes the open document — rather than a
 * crash or an empty list that implies nothing is waiting.
 */
export function usePublishQueue(): PublishQueue | null {
  return useContext(PublishQueueContext);
}

/**
 * Publish each of these, in order, stopping at the first failure.
 *
 * Returns what went live and what stopped it. Sequential rather than
 * parallel because each one is a commit on the same branch, and several at
 * once would race for the branch head and lose to each other's conflict
 * detection.
 */
export async function publishEach(
  items: readonly PendingItem[],
): Promise<{ done: PendingItem[]; failed: { item: PendingItem; message: string } | null }> {
  const done: PendingItem[] = [];
  for (const item of items) {
    try {
      await item.publish();
      done.push(item);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { done, failed: { item, message } };
    }
  }
  return { done, failed: null };
}

/** "3 things" / "1 thing", for a button that says what it will do. */
export function countLabel(n: number): string {
  return `${n} thing${n === 1 ? '' : 's'}`;
}
