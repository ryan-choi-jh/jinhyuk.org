/**
 * src/cms/server/deploy.ts
 *
 * "Has my publish actually gone live?"
 *
 * Publishing commits to main. GitHub Actions then builds the site and pushes
 * it to Pages, which takes a minute or so, and until this existed the only way
 * to know it had landed was to watch the Actions tab and reload the site.
 *
 * ---------------------------------------------------------------------------
 * TWO SIGNALS, AND WHY THE SECOND ONE IS THE ANSWER
 * ---------------------------------------------------------------------------
 *
 * The workflow run says what the BUILD is doing: queued, in progress, failed.
 * That is the progress bar, and it is the only thing that can report a
 * failure, so it is worth having.
 *
 * It is not proof. A green run means Pages accepted the artefact, not that the
 * CDN is handing it to you yet. So the live site is asked directly: every page
 * carries `<meta name="build-rev">` holding the commit it was built from
 * (src/layouts/Base.astro), and a publish is live when the page being served
 * was built from the publish commit or from something after it.
 *
 * "or from something after it" matters. Publishing twice in quick succession
 * cancels the first run (the workflow is `concurrency: cancel-in-progress`),
 * so the first publish never gets a run of its own that finishes. Its content
 * still goes live, carried by the second build. Comparing commits rather than
 * demanding an exact match is what stops that reading as a failure.
 *
 * ---------------------------------------------------------------------------
 * COST
 * ---------------------------------------------------------------------------
 *
 * One Actions query, one page fetch, and at most one commit comparison per
 * poll. The page fetch carries a nonce so it is a cache miss at the Pages CDN
 * (`cache-control: max-age=600` otherwise, which is long enough to report a
 * live deploy as still building for ten minutes).
 */

import { REPO } from './config.ts';
import { ghPublic } from './github.ts';

/** Where the published site lives. Not the editor's own origin. */
export const SITE_ORIGIN = 'https://jinhyuk.org';

export type DeployState =
  /** No run yet, or one that has not started. */
  | 'queued'
  /** A run is going. */
  | 'building'
  /** The live site is serving this commit, or something after it. */
  | 'live'
  /**
   * The build succeeded, but the live site carries no build marker, so
   * whether the CDN is serving it cannot be confirmed. Only reachable until
   * the first deploy that includes the marker; after that, never again.
   */
  | 'built'
  /** The run failed. Nothing new will appear until it is fixed. */
  | 'failed'
  /** A newer publish cancelled this one's run; its content rides along. */
  | 'superseded'
  /** Cannot tell: no run visible and the live site carries no marker. */
  | 'unknown';

export type DeployStatus = {
  state: DeployState;
  /** The commit asked about. */
  commit: string;
  /** What the live site is currently built from, if it says. */
  liveRev: string | null;
  run: {
    name: string;
    status: string;
    conclusion: string | null;
    url: string;
    startedAt: string | null;
  } | null;
  /** Milliseconds since the run was created, for an elapsed readout. */
  elapsedMs: number | null;
  /** Set when something could not be checked, rather than failing the call. */
  note?: string;
};

type RunJson = {
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  created_at?: string;
  run_started_at?: string;
};

/* -------------------------------------------------------------------------- */
/* The live site                                                               */
/* -------------------------------------------------------------------------- */

const REV_META = /<meta\s+name=["']build-rev["']\s+content=["']([0-9a-f]{7,40})["']/i;

/**
 * What the live site is serving, by commit.
 *
 * The homepage is used rather than the published page itself: every page in a
 * Pages deploy comes from the same build, so the homepage answers for all of
 * them, and it is the one URL guaranteed to exist whatever was published.
 *
 * Returns null when the page cannot be read or carries no marker, which is
 * also what a site built before this existed looks like. Null is "cannot
 * tell", never "not yet".
 */
export async function liveRevision(nonce: string): Promise<string | null> {
  try {
    const response = await fetch(`${SITE_ORIGIN}/?cms-deploy-probe=${encodeURIComponent(nonce)}`, {
      headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'jinhyuk.org-cms' },
      redirect: 'follow',
    });
    if (!response.ok) return null;
    // The marker is in <head>, so there is no need to read a 60 kB page to
    // the end. 4 kB is comfortably past it.
    const head = (await response.text()).slice(0, 4096);
    return REV_META.exec(head)?.[1] ?? null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* GitHub                                                                      */
/* -------------------------------------------------------------------------- */

/** The newest workflow run for a commit, or null if none has appeared yet. */
export async function runFor(commit: string): Promise<RunJson | null> {
  const body = await ghPublic<{ workflow_runs?: RunJson[] }>(
    `/repos/${REPO}/actions/runs?head_sha=${encodeURIComponent(commit)}&per_page=5`,
  );
  const runs = body?.workflow_runs ?? [];
  if (runs.length === 0) return null;
  // Newest first is what the API returns; take the first that is a deploy, or
  // simply the first, so a repo that grows a second workflow does not report
  // the wrong one.
  return runs.find((run) => (run.name ?? '').toLowerCase().includes('pages')) ?? runs[0];
}

/**
 * Is `later` the same commit as `earlier`, or a descendant of it?
 *
 * GitHub's compare endpoint answers this directly: from `earlier` to `later`,
 * "identical" or "ahead" both mean `earlier` is contained in `later`.
 */
export async function contains(earlier: string, later: string): Promise<boolean> {
  if (earlier === later) return true;
  // A short sha from the page meta still compares fine; GitHub resolves it.
  const body = await ghPublic<{ status?: string }>(
    `/repos/${REPO}/compare/${encodeURIComponent(earlier)}...${encodeURIComponent(later)}`,
  );
  const status = body?.status;
  return status === 'identical' || status === 'ahead';
}

/* -------------------------------------------------------------------------- */
/* The answer                                                                  */
/* -------------------------------------------------------------------------- */

export async function deployStatus(commit: string, nonce: string): Promise<DeployStatus> {
  const [run, liveRev] = await Promise.all([
    runFor(commit).catch(() => null),
    liveRevision(nonce),
  ]);

  const startedAt = run?.run_started_at ?? run?.created_at ?? null;
  const elapsedMs = startedAt === null ? null : Math.max(0, Date.now() - Date.parse(startedAt));

  const base: DeployStatus = {
    state: 'unknown',
    commit,
    liveRev,
    run:
      run === null
        ? null
        : {
            name: run.name ?? 'Deploy',
            status: run.status ?? 'unknown',
            conclusion: run.conclusion ?? null,
            url: run.html_url ?? '',
            startedAt,
          },
    elapsedMs,
  };

  // The live site first: it is the only signal that proves anything, and a
  // green run with a stale CDN is exactly the case this feature exists for.
  if (liveRev !== null) {
    const landed = await contains(commit, liveRev).catch(() => false);
    if (landed) return { ...base, state: 'live' };
  }

  if (run === null) {
    // No run yet. Immediately after a push that is normal for a few seconds.
    // If the site has no marker either, say so rather than spinning forever.
    return liveRev === null
      ? {
          ...base,
          state: 'unknown',
          note: 'The live site carries no build marker yet, so this can only be confirmed once it has been deployed once with one.',
        }
      : { ...base, state: 'queued' };
  }

  if (run.status !== 'completed') return { ...base, state: 'building' };

  switch (run.conclusion) {
    case 'success':
      // The build is done. Whether it is being SERVED is a different
      // question, and which answer is honest depends on whether the live site
      // can be asked at all.
      return liveRev === null
        ? {
            ...base,
            state: 'built',
            note: 'The build finished. The live site carries no build marker, so this cannot be confirmed from here until it has deployed once with one.',
          }
        : // The marker is there and is older, so Pages has the artefact but
          // the CDN has not handed it over yet. Still building, from the only
          // point of view that matters.
          { ...base, state: 'building' };
    case 'cancelled':
      // Not a failure, and not the end: a newer publish cancelled this run,
      // and its build carries this content too. The live check above is what
      // will eventually turn this into 'live', so the caller keeps polling.
      return { ...base, state: 'superseded' };
    default:
      return { ...base, state: 'failed' };
  }
}
