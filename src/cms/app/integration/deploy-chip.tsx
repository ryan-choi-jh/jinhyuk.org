/**
 * src/cms/app/integration/deploy-chip.tsx
 *
 * "Published." used to be the end of the story, and it was the wrong end.
 * Publishing commits to main; the site appears a minute or so later, when
 * GitHub Actions has built it and Pages is serving it. Until this existed the
 * only way to know was the Actions tab in one window and a reload loop in
 * another.
 *
 * So the chip keeps talking after the commit lands: queued, building with a
 * running clock, then live, with a link to the page. It stops talking when
 * there is nothing left to say.
 *
 * ---------------------------------------------------------------------------
 * THE POLLING
 * ---------------------------------------------------------------------------
 *
 * Every poll costs one GitHub read and one fetch of the live site, so the
 * interval widens as the wait goes on: a deploy that is going to take 70
 * seconds should not be asked 70 times. It gives up after GIVE_UP_MS rather
 * than polling a tab someone left open all afternoon, and says it has stopped
 * instead of showing a spinner that means nothing.
 *
 * A failed poll is not a failed deploy. The network blips, the session can
 * expire, GitHub rate-limits an anonymous read; none of that says anything
 * about the build, so a poll that throws is skipped and the next one goes
 * ahead. Only the server saying "failed" is a failure.
 */

import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import type { CmsClient, DeploySnapshot } from '../../server/client.ts';

export type DeployTiming = {
  /** A moment's grace before the first poll: see the call site. */
  firstDelayMs: number;
  /** Poll this often at first, while a deploy is most likely to finish. */
  fastMs: number;
  /** And this often after `slowAfterMs`, when it is clearly taking a while. */
  slowMs: number;
  slowAfterMs: number;
  /** Stop watching. A Pages deploy that has not landed by now is not going to. */
  giveUpMs: number;
};

export const DEPLOY_TIMING: DeployTiming = {
  firstDelayMs: 1500,
  fastMs: 4000,
  slowMs: 10_000,
  slowAfterMs: 90_000,
  giveUpMs: 10 * 60_000,
};

/** Nothing further will change on its own, so stop asking. */
function settled(state: DeploySnapshot['state']): boolean {
  return state === 'live' || state === 'failed' || state === 'built';
}

export type DeployWatch = {
  snapshot: DeploySnapshot | null;
  /** Milliseconds since the publish, for the clock. */
  waitedMs: number;
  /** Polling stopped without reaching a conclusion. */
  gaveUp: boolean;
};

export function useDeployWatch(
  client: CmsClient,
  publish: { commit: string; at: number } | null,
  /** Shortened by the harness; a real deploy takes a minute, a test must not. */
  timing: DeployTiming = DEPLOY_TIMING,
): DeployWatch {
  const [snapshot, setSnapshot] = useState<DeploySnapshot | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Read inside the loop rather than captured, so a poll in flight when the
  // answer arrives does not overwrite it with a staler one.
  const latest = useRef<DeploySnapshot | null>(null);
  latest.current = snapshot;

  const commit = publish?.commit ?? null;
  const startedAt = publish?.at ?? null;

  useEffect(() => {
    setSnapshot(null);
    setGaveUp(false);
    if (commit === null || startedAt === null) return;

    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async (): Promise<void> => {
      if (!alive) return;
      const waited = Date.now() - startedAt;

      if (waited > timing.giveUpMs) {
        setGaveUp(true);
        return;
      }

      try {
        const next = await client.deployStatus(commit);
        if (!alive) return;
        setSnapshot(next);
        if (settled(next.state)) return;
      } catch {
        // Skipped, not fatal. See the header.
        if (!alive) return;
      }

      setNow(Date.now());
      timer = setTimeout(() => void tick(), waited > timing.slowAfterMs ? timing.slowMs : timing.fastMs);
    };

    // A moment's grace: the push has only just happened and GitHub will not
    // have a run for it yet, so the first poll would always come back empty.
    timer = setTimeout(() => void tick(), timing.firstDelayMs);

    // The clock has to move between polls or a ten-second gap looks frozen.
    const clock = setInterval(() => {
      if (alive) setNow(Date.now());
    }, 1000);

    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
      clearInterval(clock);
    };
  }, [client, commit, startedAt, timing]);

  return {
    snapshot,
    waitedMs: startedAt === null ? 0 : Math.max(0, now - startedAt),
    gaveUp,
  };
}

/* -------------------------------------------------------------------------- */
/* The chip                                                                    */
/* -------------------------------------------------------------------------- */

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

type Look = { tone: 'wait' | 'good' | 'bad'; label: string; title: string };

function look(watch: DeployWatch): Look {
  if (watch.gaveUp) {
    return {
      tone: 'bad',
      label: 'Still not live',
      title:
        'Stopped checking after ten minutes. The build may still be going; open the run on GitHub to see.',
    };
  }

  const snapshot = watch.snapshot;
  const waited = clock(watch.waitedMs);

  if (snapshot === null) return { tone: 'wait', label: `Publishing · ${waited}`, title: 'Committed. Waiting for the build to start.' };

  switch (snapshot.state) {
    case 'live':
      return { tone: 'good', label: 'Live', title: 'The site is serving this publish.' };
    case 'built':
      return {
        tone: 'good',
        label: 'Built',
        title: snapshot.note ?? 'The build finished.',
      };
    case 'failed':
      return { tone: 'bad', label: 'Build failed', title: 'The deploy failed. Nothing new is live.' };
    case 'superseded':
      return {
        tone: 'wait',
        label: `Rolled into the next build · ${waited}`,
        title:
          'A newer publish cancelled this build. This page goes live with that one, so it is still on its way.',
      };
    case 'queued':
      return { tone: 'wait', label: `Queued · ${waited}`, title: 'Committed. The build has not started yet.' };
    case 'unknown':
      return { tone: 'wait', label: `Publishing · ${waited}`, title: snapshot.note ?? 'Waiting for the build.' };
    default:
      return { tone: 'wait', label: `Building · ${waited}`, title: 'GitHub is building the site.' };
  }
}

export function DeployChip({
  client,
  publish,
  siteUrl,
  timing,
}: {
  /** Either adapter's underlying client; both expose the same one. */
  client: CmsClient;
  publish: { commit: string; at: number } | null;
  /** The published page, linked once it is actually live. */
  siteUrl: string | null;
  timing?: DeployTiming;
}): JSX.Element | null {
  const watch = useDeployWatch(client, publish, timing);
  if (publish === null) return null;

  const shown = look(watch);
  const runUrl = watch.snapshot?.run?.url ?? '';
  // Live links to the page, because that is what you want next. Anything else
  // links to the run, because that is where the detail is.
  const href = shown.label === 'Live' ? (siteUrl ?? runUrl) : runUrl;

  const body = (
    <>
      <span className="ws8-deploy__dot" />
      {shown.label}
    </>
  );

  return (
    <span className="ws8-deploy" data-tone={shown.tone} title={shown.title} data-testid="deploy-chip">
      {href === '' ? (
        body
      ) : (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {body}
        </a>
      )}
    </span>
  );
}
