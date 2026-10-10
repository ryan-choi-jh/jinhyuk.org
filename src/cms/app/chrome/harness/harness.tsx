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
import { SiteChromeProvider } from '../context.tsx';
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

function memoryApi(): { api: SiteChromeApi; log: Log[]; state: () => unknown } {
  const log: Log[] = [];
  let publishedChrome: SiteChrome | null = published;
  let draftChrome: SiteChrome | null = null;
  let draftSha: string | null = null;
  let publishedSha: string | null = 'sha-published-0';
  let counter = 0;

  const note = (call: string): void => {
    log.push({ call, at: Date.now() });
  };

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
  };
}

/* -------------------------------------------------------------------------- */
/* The page                                                                    */
/* -------------------------------------------------------------------------- */

const wire = memoryApi();

function Harness() {
  const [{ store }] = useState(() => ({
    store: createDocStore({ api: createStubApi(), doc: homeDoc, published: homeDoc }),
  }));

  return (
    <SiteChromeProvider api={wire.api} fallback={published}>
      <EditorShell
        store={store}
        checkAuthOnMount={false}
        guardUnsavedChanges={false}
        renderInspectorExtra={() => <SiteChromePanel />}
      />
    </SiteChromeProvider>
  );
}

const host = document.getElementById('root');
if (host === null) throw new Error('no #root');
createRoot(host).render(<Harness />);

/** What a driver reads. */
(window as unknown as { __chr: unknown }).__chr = {
  log: wire.log,
  server: wire.state,
};
