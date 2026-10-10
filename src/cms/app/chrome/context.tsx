/**
 * src/cms/app/chrome/context.tsx
 *
 * One copy of the nav and the footer, for the whole editor.
 *
 * Two places need it and they must not disagree: the panel under Home that
 * edits it, and the scenery drawn around every page in the middle pane
 * (`../shell/page-surface.tsx`). So it is held once, here, and both read the
 * same object — which is also what makes renaming a nav link show up in the
 * surface as it is typed.
 *
 * It is NOT a section, so it is deliberately not in the site store: that store
 * is a map of sections, entries and the editor bound to one of them, and a file
 * that belongs to all of them at once would be a special case in every one of
 * its reducers. A context with four calls behind it is the whole requirement.
 *
 * Draft semantics are the API's, unchanged: `save` writes
 * `src/content/drafts/data/site.json`, `publish` moves it over
 * `src/content/data/site.json` in one commit, `discard` throws the draft away.
 * The blob shas read on load are quoted back on every write, so a save from
 * another tab is a 409 and not a silent overwrite.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { createCmsClient } from '../../server/client.ts';
import type { CmsClient, ShaExpectation, SiteChromeSnapshot } from '../../server/client.ts';
import type { SiteChrome } from '../../schema.ts';
import { chromeProblem, sameChrome } from './edits.ts';

/* -------------------------------------------------------------------------- */
/* The transport                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The four calls, as an interface, so a harness can drive the panel with no
 * server and the provider does not have to know about `fetch`.
 */
export type SiteChromeApi = {
  read(): Promise<SiteChromeSnapshot>;
  save(chrome: SiteChrome, expect: ShaExpectation): Promise<{ commit: string; sha: string; data: SiteChrome }>;
  publish(expect: ShaExpectation): Promise<{ commit: string; sha: string; data: SiteChrome }>;
  discard(expect: ShaExpectation): Promise<{ commit: string }>;
};

export function siteChromeApiFrom(client: CmsClient): SiteChromeApi {
  return {
    read: () => client.readSiteChrome(),
    save: (chrome, expect) => client.saveSiteChrome(chrome, expect),
    publish: (expect) => client.publishSiteChrome(expect),
    discard: (expect) => client.discardSiteChrome(expect),
  };
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

export type SiteChromePhase = 'idle' | 'loading' | 'saving' | 'publishing' | 'discarding';

export type SiteChromeNotice = { kind: 'info' | 'ok' | 'error'; message: string };

export type SiteChromeState = {
  /** The working copy: the draft if there is one, else the published file. */
  chrome: SiteChrome | null;
  /** What was last read or written, so `dirty` is a comparison and not a flag. */
  base: SiteChrome | null;
  published: SiteChrome | null;
  hasDraft: boolean;
  /** False until the first read has answered. */
  loaded: boolean;
  phase: SiteChromePhase;
  notice: SiteChromeNotice | null;
  /** Where the file lives, for the panel's footnote. */
  path: string;
};

export type SiteChromeStore = SiteChromeState & {
  dirty: boolean;
  /** Null when the working copy would save; else every reason it would not. */
  problem: string | null;
  /** Edit locally. Nothing is written until `save`. */
  edit: (next: SiteChrome) => void;
  save: () => Promise<boolean>;
  publish: () => Promise<boolean>;
  discard: () => Promise<boolean>;
  reload: () => Promise<void>;
  dismiss: () => void;
};

const SiteChromeContext = createContext<SiteChromeStore | null>(null);

/** The store, or null where no provider is mounted (a harness, a stub host). */
export function useSiteChromeOptional(): SiteChromeStore | null {
  return useContext(SiteChromeContext);
}

export function useSiteChrome(): SiteChromeStore {
  const value = useContext(SiteChromeContext);
  if (value === null) throw new Error('useSiteChrome outside <SiteChromeProvider>');
  return value;
}

/* -------------------------------------------------------------------------- */
/* The provider                                                                */
/* -------------------------------------------------------------------------- */

export type SiteChromeProviderProps = {
  children: ReactNode;
  /** Inject the transport (harness). Otherwise one is built from baseUrl/fetch. */
  api?: SiteChromeApi;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * What the editor deployment was built with, from
   * `src/content/data/site.json`. Used for two things, both of them about not
   * showing a page with no nav around it:
   *
   *  - it is what the scenery draws on the first paint, before the read answers
   *  - it is the starting point if the repository has no `site.json` at all,
   *    which is the state of a branch that predates this file
   *
   * Once the read answers, whatever is in the repository wins.
   */
  fallback?: SiteChrome | null;
  /** Skip the read on mount (harness). */
  loadOnMount?: boolean;
};

const DEFAULT_PATH = 'src/content/data/site.json';

export function SiteChromeProvider({
  children,
  api: injected,
  baseUrl,
  fetchImpl,
  fallback = null,
  loadOnMount = true,
}: SiteChromeProviderProps) {
  const [api] = useState<SiteChromeApi>(
    () =>
      injected ??
      siteChromeApiFrom(
        createCmsClient({
          ...(baseUrl === undefined ? {} : { baseUrl }),
          ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
        }),
      ),
  );

  const [state, setState] = useState<SiteChromeState>({
    chrome: fallback,
    base: null,
    published: null,
    hasDraft: false,
    loaded: false,
    phase: 'idle',
    notice: null,
    path: DEFAULT_PATH,
  });

  /**
   * The shas, outside React state on purpose: a write reads the latest one in a
   * callback that may have been created several renders ago, and a stale
   * expectation is a spurious 409. `undefined` means "never read", which is what
   * tells the server to quote whatever it finds instead of our guess.
   */
  const shas = useRef<{ draft: ShaExpectation; published: ShaExpectation }>({
    draft: undefined,
    published: undefined,
  });

  const absorb = useCallback(
    (snapshot: SiteChromeSnapshot, seed: SiteChrome | null) => {
      shas.current = { draft: snapshot.draftSha, published: snapshot.publishedSha };
      const broken = snapshot.draftError ?? snapshot.publishedError;
      const working = snapshot.draft ?? snapshot.published ?? seed;
      setState((prev) => ({
        ...prev,
        chrome: working,
        base: snapshot.draft ?? snapshot.published,
        published: snapshot.published,
        hasDraft: snapshot.draftSha !== null,
        loaded: true,
        phase: 'idle',
        path: snapshot.path ?? prev.path,
        notice:
          broken !== undefined
            ? { kind: 'error', message: broken }
            : snapshot.draft === null && snapshot.published === null
              ? {
                  kind: 'info',
                  message:
                    `${snapshot.path ?? DEFAULT_PATH} is not in the repository yet. ` +
                    'This is what the site is built with; Save puts it in as a draft and Publish commits it.',
                }
              : prev.notice,
      }));
    },
    [],
  );

  const failed = useCallback((error: unknown) => {
    setState((prev) => ({
      ...prev,
      phase: 'idle',
      notice: { kind: 'error', message: messageOf(error) },
    }));
  }, []);

  const reload = useCallback(async () => {
    setState((prev) => ({ ...prev, phase: 'loading' }));
    try {
      const snapshot = await api.read();
      absorb(snapshot, fallback);
    } catch (error) {
      failed(error);
    }
  }, [api, absorb, failed, fallback]);

  const started = useRef(false);
  useEffect(() => {
    if (!loadOnMount || started.current) return;
    started.current = true;
    void reload();
  }, [loadOnMount, reload]);

  const edit = useCallback((next: SiteChrome) => {
    setState((prev) => ({ ...prev, chrome: next, notice: null }));
  }, []);

  const save = useCallback(async () => {
    const working = state.chrome;
    if (working === null) return false;
    const problem = chromeProblem(working);
    if (problem !== null) {
      setState((prev) => ({ ...prev, notice: { kind: 'error', message: problem } }));
      return false;
    }
    setState((prev) => ({ ...prev, phase: 'saving', notice: null }));
    try {
      const ack = await api.save(working, shas.current.draft);
      shas.current = { ...shas.current, draft: ack.sha };
      setState((prev) => ({
        ...prev,
        chrome: ack.data,
        base: ack.data,
        hasDraft: true,
        loaded: true,
        phase: 'idle',
        notice: {
          kind: 'ok',
          message: 'Saved as a draft. Publish puts it on the site.',
        },
      }));
      return true;
    } catch (error) {
      failed(error);
      return false;
    }
  }, [api, failed, state.chrome]);

  const publish = useCallback(async () => {
    setState((prev) => ({ ...prev, phase: 'publishing', notice: null }));
    try {
      const ack = await api.publish(shas.current.published);
      shas.current = { draft: null, published: ack.sha };
      setState((prev) => ({
        ...prev,
        chrome: ack.data,
        base: ack.data,
        published: ack.data,
        hasDraft: false,
        loaded: true,
        phase: 'idle',
        notice: {
          kind: 'ok',
          message: 'Published. Every page of the site gets it on the next deploy.',
        },
      }));
      return true;
    } catch (error) {
      failed(error);
      return false;
    }
  }, [api, failed]);

  const discard = useCallback(async () => {
    setState((prev) => ({ ...prev, phase: 'discarding', notice: null }));
    try {
      await api.discard(shas.current.draft);
      shas.current = { ...shas.current, draft: null };
      const snapshot = await api.read();
      absorb(snapshot, fallback);
      setState((prev) => ({
        ...prev,
        notice: { kind: 'info', message: 'Draft thrown away. This is what is on the site.' },
      }));
      return true;
    } catch (error) {
      failed(error);
      return false;
    }
  }, [api, absorb, failed, fallback]);

  const dismiss = useCallback(() => {
    setState((prev) => ({ ...prev, notice: null }));
  }, []);

  const store = useMemo<SiteChromeStore>(
    () => ({
      ...state,
      dirty: state.chrome !== null && !sameChrome(state.chrome, state.base),
      problem: state.chrome === null ? null : chromeProblem(state.chrome),
      edit,
      save,
      publish,
      discard,
      reload,
      dismiss,
    }),
    [state, edit, save, publish, discard, reload, dismiss],
  );

  return <SiteChromeContext.Provider value={store}>{children}</SiteChromeContext.Provider>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
