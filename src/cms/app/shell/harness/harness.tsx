/**
 * src/cms/app/shell/harness/harness.tsx
 *
 * WS-3's standalone harness. Boots the editor shell from
 * `src/cms/fixtures/dense.json` with the in-memory stub API: no server, no
 * network, no other workstream. `./build.mjs` bundles it; `./drive.mjs` drives
 * it in headless Chrome and screenshots it.
 *
 * The fixture is injected at build time as a string (`__FIXTURE_JSON__`)
 * rather than fetched, because a `file://` page cannot fetch anything. It
 * still goes through `validateDocJson`, so the harness fails loudly if the
 * fixture and the schema ever disagree.
 *
 * `window.__ws3` is the handle `drive.mjs` uses. It is a test seam and nothing
 * in the shell knows about it.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { formatIssues, validateDoc, validateDocJson } from '../../../schema.ts';
import type { Doc } from '../../../schema.ts';
import { docsEqual } from '../../state/doc-ops.ts';
import { createDocStore } from '../../state/store.ts';
import { createStubApi } from '../../state/stub-api.ts';
import { EditorShell } from '../editor-shell.tsx';
import type { PreviewContext } from '../editor-shell.tsx';

/** Injected by ./build.mjs. */
declare const __FIXTURE_JSON__: string;
/** Injected by ./build.mjs: a file:// URL for the repo's `public/` directory. */
declare const __PUBLIC_BASE__: string;

const parsed = validateDocJson(__FIXTURE_JSON__);
if (!parsed.ok) {
  throw new Error(`the fixture does not validate:\n${formatIssues(parsed.issues)}`);
}
const fixture: Doc = parsed.doc;

const api = createStubApi({
  pages: { [fixture.meta.slug]: { published: fixture, draft: null } },
});

const store = createDocStore({
  api,
  doc: fixture,
  published: fixture,
  hasDraft: false,
});

/** Preview is a navigation; in the harness it is recorded instead. */
const previews: PreviewContext[] = [];

/** `/projects/...` exists under `public/`, so the harness draws real images. */
function resolveMediaSrc(src: string): string {
  if (src.startsWith('/')) return `${__PUBLIC_BASE__}${src}`;
  return src;
}

const container = document.getElementById('root');
if (container === null) throw new Error('no #root in the harness page');

createRoot(container).render(
  <StrictMode>
    <EditorShell
      store={store}
      resolveMediaSrc={resolveMediaSrc}
      onPreview={(context) => previews.push(context)}
    />
  </StrictMode>,
);

/* -------------------------------------------------------------------------- */
/* Test seam                                                                   */
/* -------------------------------------------------------------------------- */

const original = JSON.parse(JSON.stringify(fixture)) as Doc;

const seam = {
  store,
  api,
  previews,
  original,
  docsEqual,
  validateDoc,
  /** One flat object the driver can assert against in a single evaluate. */
  probe() {
    const state = store.getState();
    const snapshot = api.snapshot()[state.slug];
    return {
      slug: state.slug,
      title: state.doc.meta.title,
      bandIds: state.doc.bands.map((band) => band.id),
      bandCount: state.doc.bands.length,
      overlayBandIds: state.doc.bands
        .filter((band) => band.type === 'canvas' && band.overlay === true)
        .map((band) => band.id),
      dirty: state.dirty,
      canUndo: state.canUndo,
      canRedo: state.canRedo,
      undoLabel: state.undoLabel,
      redoLabel: state.redoLabel,
      selection: state.selection,
      phase: state.phase,
      notice: state.notice,
      issues: state.issues,
      hasDraft: state.hasDraft,
      lastCommit: state.lastCommit,
      matchesOriginal: docsEqual(state.doc, original),
      valid: validateDoc(state.doc).ok,
      previewCount: previews.length,
      server: {
        hasDraft: snapshot?.draft !== null && snapshot?.draft !== undefined,
        draftTitle: snapshot?.draft?.meta.title ?? null,
        publishedTitle: snapshot?.published?.meta.title ?? null,
        publishedBandCount: snapshot?.published?.bands.length ?? null,
      },
      calls: api.calls.map((call) => call.method),
    };
  },
  /** JSON of the current document, for exact before/after comparison. */
  docJson(): string {
    return JSON.stringify(store.getState().doc);
  },
};

(window as unknown as { __ws3: typeof seam }).__ws3 = seam;
