/**
 * src/cms/app/shell/site-harness/harness.tsx
 *
 * WS-D's standalone harness. Boots the navigation shell over WS-A's fixtures
 * with the in-memory `SiteApi`: no server, no network, no other workstream.
 * `./build.mjs` bundles it; `./drive.mjs` drives it in headless Chrome and
 * screenshots every section.
 *
 * The world it boots is the whole site:
 *
 *   home          home.json                        singleton document
 *   projects      dense.json, canvas.json, simple.json
 *   essays        essay.json
 *   filmography   filmography.json                 4 films
 *   photography   photography.json                 2 albums, 7 photos
 *
 * No document-editor slots are passed, so the three document sections mount
 * phase 1's `<EditorShell>` with its own read-only placeholders — this
 * workstream is proving the navigation and the dispatch, not WS-4's canvas.
 * The record slot is switchable at runtime (`__wsd.setRecordSlot`) so the
 * driver can prove both halves of the slot contract: the shell's stub when
 * nothing is mounted, and WS-E's component when something is.
 *
 * `window.__wsd` is the handle `drive.mjs` uses. It is a test seam and nothing
 * in the shell knows about it.
 */

import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { formatIssues, validateDocJson } from '../../../schema.ts';
import type { Doc, RecordFile, SectionId } from '../../../schema.ts';
import { isRecordSection, requireSection } from '../../../sections.ts';
import { createMemoryNavigator } from '../../state/route.ts';
import type { CmsRoute } from '../../state/route.ts';
import { createSiteStore } from '../../state/site-store.ts';
import { createStubSiteApi } from '../../state/site-stub-api.ts';
import { SiteShell } from '../site-shell.tsx';
import type { RecordEditorSlotProps } from '../site-slots.ts';

/** Injected by ./build.mjs: fixture name -> file contents. */
declare const __FIXTURES_JSON__: string;
/** Injected by ./build.mjs: a file:// URL for the repo's `public/` directory. */
declare const __PUBLIC_BASE__: string;

const FIXTURES = JSON.parse(__FIXTURES_JSON__) as Record<string, string>;

function doc(name: string): Doc {
  const text = FIXTURES[name];
  if (text === undefined) throw new Error(`the harness was not given ${name}`);
  const parsed = validateDocJson(text);
  if (!parsed.ok) throw new Error(`${name} does not validate:\n${formatIssues(parsed.issues)}`);
  return parsed.doc;
}

function records(id: SectionId, name: string): RecordFile {
  const section = requireSection(id);
  if (!isRecordSection(section)) throw new Error(`${id} holds documents`);
  const text = FIXTURES[name];
  if (text === undefined) throw new Error(`the harness was not given ${name}`);
  const parsed = section.records.validateFile(JSON.parse(text));
  if (!parsed.ok) throw new Error(`${name} does not validate:\n${formatIssues(parsed.issues)}`);
  return parsed.data;
}

const home = doc('home.json');
const essay = doc('essay.json');
const dense = doc('dense.json');
const canvas = doc('canvas.json');
const simple = doc('simple.json');
const filmography = records('filmography', 'filmography.json');
const photography = records('photography', 'photography.json');

const api = createStubSiteApi({
  docs: {
    home: { [home.meta.slug]: { published: home } },
    projects: {
      [dense.meta.slug]: { published: dense },
      [canvas.meta.slug]: { published: canvas },
      [simple.meta.slug]: { published: simple, draft: simple },
    },
    essays: { [essay.meta.slug]: { published: essay } },
  },
  records: {
    filmography: { published: filmography },
    photography: { published: photography },
  },
});

const navigator_ = createMemoryNavigator();
const store = createSiteStore({ api, navigator: navigator_ });

/** `/projects/...` and `/filmography/...` exist under `public/`, so images draw. */
function resolveMediaSrc(src: string): string {
  if (src.startsWith('/')) return `${__PUBLIC_BASE__}${src}`;
  return src;
}

/* -------------------------------------------------------------------------- */
/* A stand-in for WS-E                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Not a record editor: the smallest thing that proves the slot contract is
 * honoured. It reads every prop the contract promises, writes through
 * `onPatch`, and says which section and which record it was handed. When
 * WS-E's real editor lands it replaces exactly this.
 */
const previews: unknown[] = [];

function SlotProbe(props: RecordEditorSlotProps) {
  const { entry, entryKey, entryIndex, fields, file, records: def, section, dirty } = props;
  return (
    <div data-testid="record-slot-live" data-section={section.id} data-entry={entryKey}>
      <p data-testid="slot-report">
        {def.noun} · {entryKey} · index {entryIndex} · {fields.length} fields ·{' '}
        {def.entries(file).length} in the collection · {dirty ? 'dirty' : 'clean'}
      </p>
      <input
        data-testid="slot-title"
        className="cms-input"
        value={String((entry as unknown as Record<string, unknown>)[def.titleField] ?? '')}
        onChange={(event) => props.onPatch({ [def.titleField]: event.target.value })}
      />
      <button
        type="button"
        className="cms-btn cms-btn--tiny"
        data-testid="slot-upload"
        onClick={() => {
          void props.uploadMedia(new File(['x'], 'From The Slot.png', { type: 'image/png' })).then((result) => {
            previews.push(result);
          });
        }}
      >
        Upload through the slot
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Mount                                                                       */
/* -------------------------------------------------------------------------- */

let setSlotMounted: ((mounted: boolean) => void) | null = null;

function Harness() {
  const [slotMounted, setMounted] = useState(false);
  setSlotMounted = setMounted;
  return (
    <SiteShell
      store={store}
      resolveMediaSrc={resolveMediaSrc}
      onPreview={(context) => previews.push(context)}
      onRecordPreview={(context) => previews.push(context)}
      {...(slotMounted ? { renderRecordEditor: (props: RecordEditorSlotProps) => <SlotProbe {...props} /> } : {})}
    />
  );
}

const container = document.getElementById('root');
if (container === null) throw new Error('no #root in the harness page');

createRoot(container).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);

/* -------------------------------------------------------------------------- */
/* Test seam                                                                   */
/* -------------------------------------------------------------------------- */

const seam = {
  store,
  api,
  previews,
  navigator: navigator_,

  /** Mount or unmount the stand-in record editor in the shell's slot. */
  setRecordSlot(mounted: boolean): boolean {
    if (setSlotMounted === null) return false;
    setSlotMounted(mounted);
    return true;
  },

  route(): CmsRoute {
    return navigator_.current();
  },

  /** One flat object the driver can assert against in a single evaluate. */
  probe() {
    const state = store.getState();
    const editor = state.editor;
    const recordStore = editor !== null && editor.kind === 'records' ? editor.store : null;
    const docState = editor !== null && editor.kind === 'document' ? editor.store.getState() : null;

    const record =
      recordStore === null
        ? null
        : (() => {
            const current = recordStore.getState();
            return {
              openId: current.openId,
              count: current.summaries.length,
              dirty: current.dirty,
              canUndo: current.canUndo,
              canRedo: current.canRedo,
              /** Live, not the last `validate()` run: a fresh film is invalid immediately. */
              validates: recordStore.records.validateFile(current.file).ok,
              issues: current.issues.length,
              notice: current.notice,
              order: current.summaries.map((summary) => summary.key),
            };
          })();
    return {
      view: state.resolved.view,
      section: state.resolved.section?.id ?? null,
      entryKey: state.resolved.entryKey,
      editorKind: editor === null ? null : editor.kind,
      editorSection: editor === null ? null : editor.section.id,
      editorEntry: editor === null ? null : editor.entryKey,
      phase: state.phase,
      notice: state.notice,
      auth: state.auth,
      dirty: store.isDirty(),
      sections: state.sections.map((summary) => ({
        id: summary.id,
        count: summary.count,
        hasDraft: summary.hasDraft,
        storage: summary.storage,
        shape: summary.shape,
      })),
      entries: Object.fromEntries(
        Object.entries(state.entries).map(([id, rows]) => [id, (rows ?? []).map((row) => row.key)]),
      ),
      titles: Object.fromEntries(
        Object.entries(state.entries).map(([id, rows]) => [id, (rows ?? []).map((row) => row.title)]),
      ),
      record,
      document:
        docState === null
          ? null
          : {
              slug: docState.slug,
              title: docState.doc.meta.title,
              bands: docState.doc.bands.length,
              dirty: docState.dirty,
            },
      previews: previews.length,
      calls: api.calls.map((call) => `${call.method}:${call.section ?? ''}`),
      server: api.snapshot(),
    };
  },
};

(window as unknown as { __wsd: typeof seam }).__wsd = seam;
