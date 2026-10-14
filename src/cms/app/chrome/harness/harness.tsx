/**
 * src/cms/app/chrome/harness/harness.tsx
 *
 * The nav-and-footer panel, in the place it actually lives, with no server.
 *
 * It mounts the REAL document editor (`../../shell/editor-shell.tsx`) over the
 * real homepage fixture, with the real panel in its inspector slot and the real
 * scenery around the page — so what this shows is what the owner sees at
 * /cms/home, minus the network. The API behind the panel is an in-memory one
 * with the same four calls and the same draft-then-publish behaviour, and its
 * call log is on `window.__chr` so a driver can assert what was asked of it.
 *
 *   node src/cms/app/chrome/harness/build.mjs   # writes .out/harness.html
 *   node src/cms/app/chrome/harness/run.mjs     # drives it, writes .out/shots
 */

import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { validateSiteChrome } from '../../../schema.ts';
import type { SiteChrome } from '../../../schema.ts';
import { createDocStore, createStubApi } from '../../state/index.ts';
import { EditorShell } from '../../shell/index.ts';
import { SiteChromePanel } from '../SiteChromePanel.tsx';
import { SiteChromeProvider, useSiteChrome } from '../context.tsx';
import type { SiteChromeApi } from '../context.tsx';

declare const __HOME_JSON__: string;
declare const __SITE_JSON__: string;

/* -------------------------------------------------------------------------- */
/* The fixture                                                                 */
/* -------------------------------------------------------------------------- */

const homeDoc = JSON.parse(__HOME_JSON__) as Parameters<typeof createDocStore>[0]['doc'];

const published = ((): SiteChrome => {
  const result = validateSiteChrome(JSON.parse(__SITE_JSON__));
  if (!result.ok) throw new Error('the harness fixture does not validate');
  return result.data;
})();

/* -------------------------------------------------------------------------- */
/* An in-memory API with real draft semantics                                  */
/* -------------------------------------------------------------------------- */

type Log = { call: string; at: number };

function memoryApi(): { api: SiteChromeApi; log: Log[]; state: () => unknown; forget: () => void } {
  const log: Log[] = [];
  let publishedChrome: SiteChrome | null = published;
  let draftChrome: SiteChrome | null = null;
  let draftSha: string | null = null;
  let publishedSha: string | null = 'sha-published-0';
  let counter = 0;

  const note = (call: string): void => {
    log.push({ call, at: Date.now() });
  };

  /**
   * A round trip takes time, and that is the whole point of one of the
   * checks below.
   *
   * With an API that resolves immediately, two clicks on Save are not
   * concurrent: React commits the first one's result before the second
   * fires, so the second quotes the sha the first returned and everything
   * works. Over a real network it does not — the second click lands while
   * the first request is still in the air, both quote the same stale
   * expectation, and the loser is refused. The driver turns this on to
   * reproduce that.
   */
  const latency = (): Promise<void> =>
    new Promise((resolve) => {
      const ms = (window as unknown as { __chrLatency?: number }).__chrLatency ?? 0;
      if (ms === 0) resolve();
      else setTimeout(resolve, ms);
    });

  const api: SiteChromeApi = {
    async read() {
      note('read');
      return {
        published: publishedChrome,
        draft: draftChrome,
        publishedSha,
        draftSha,
        path: 'src/content/data/site.json',
        draftPath: 'src/content/drafts/data/site.json',
      };
    },
    async save(chrome, expect) {
      note(`save(expect=${String(expect)})`);
      await latency();
      if (expect === null && draftSha !== null) {
        // The real server's words, because the point is to reproduce the
        // real dead end and not a paraphrase of it.
        throw new Error(
          'src/content/drafts/data/site.json already exists. It was expected to be a new file; refusing to overwrite it.',
        );
      }
      if (expect !== undefined && expect !== draftSha) {
        throw new Error('The draft changed since you loaded it.');
      }
      draftChrome = chrome;
      counter += 1;
      draftSha = `sha-draft-${counter}`;
      return { commit: `commit-${counter}`, sha: draftSha, data: chrome };
    },
    async publish(expect) {
      note(`publish(expect=${String(expect)})`);
      if (draftChrome === null) throw new Error('There is no draft to publish.');
      if (expect !== undefined && expect !== publishedSha) {
        throw new Error('Someone else published while you were editing.');
      }
      publishedChrome = draftChrome;
      draftChrome = null;
      draftSha = null;
      counter += 1;
      publishedSha = `sha-published-${counter}`;
      return { commit: `commit-${counter}`, sha: publishedSha, data: publishedChrome };
    },
    async discard() {
      note('discard');
      if (draftChrome === null) throw new Error('There is no draft to discard.');
      draftChrome = null;
      draftSha = null;
      counter += 1;
      return { commit: `commit-${counter}` };
    },
  };

  return {
    api,
    log,
    state: () => ({ published: publishedChrome, draft: draftChrome, draftSha, publishedSha }),
    /**
     * Put a draft on the server without the client hearing about it.
     *
     * This is "somebody else saved a draft" — another tab, an earlier
     * session, a save whose response was lost on the way back. The client
     * still believes there is none, so its next save will tell the server
     * to refuse if there is, and the server will. That is the dead end,
     * and there is no way to reach it through the UI, which is why the
     * driver needs a door.
     */
    forget: () => {
      draftChrome = publishedChrome;
      counter += 1;
      draftSha = `sha-elsewhere-${counter}`;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The page                                                                    */
/* -------------------------------------------------------------------------- */

const wire = memoryApi();

/**
 * The working copy, on the seam.
 *
 * `window.__chr.server()` is what the in-memory API holds, which is what has
 * been SAVED. The body-size checks need what the panel is holding right now,
 * before any save, because "applied but not saved" is a state the feature
 * depends on. Rendered inside the provider and nowhere near the UI.
 */
function Expose() {
  const store = useSiteChrome();
  (window as unknown as { __chr: { chrome?: () => unknown } }).__chr.chrome = () => store.chrome;
  return null;
}

/**
 * Make the panel forget that a draft exists, without telling the server.
 *
 * That is the state the owner's editor was in when it dead-ended: a draft
 * on disk, and a client that believed there was none and therefore told the
 * server to refuse if there was. Reachable in real life by a lost response,
 * a second tab, or the race above before it was fixed. There is no way to
 * produce it through the UI, which is exactly why the driver needs a door.
 */
(window as unknown as { __chrForget: () => void }).__chrForget = () => wire.forget();

function Harness() {
  const [{ store }] = useState(() => ({
    store: createDocStore({ api: createStubApi(), doc: homeDoc, published: homeDoc }),
  }));

  return (
    <SiteChromeProvider api={wire.api} fallback={published}>
      <Expose />
      <EditorShell
        store={store}
        checkAuthOnMount={false}
        guardUnsavedChanges={false}
        renderInspectorExtra={() => <SiteChromePanel />}
      />
    </SiteChromeProvider>
  );
}

/** What a driver reads. Defined BEFORE the render, because <Expose> adds to it. */
(window as unknown as { __chr: unknown }).__chr = {
  log: wire.log,
  server: wire.state,
};

const host = document.getElementById('root');
if (host === null) throw new Error('no #root');
createRoot(host).render(<Harness />);
