/**
 * src/cms/app/guide/harness/harness.tsx
 *
 * The guide, with no editor around it: a stand-in top bar, the live
 * `<GuideOverlay>` behind its button, and `<GuideEditor>` filling the rest
 * of the page so a change in the form can be watched landing in both the
 * editor's own preview and the real overlay.
 *
 * A strip of fake chrome stands in for the real top bar, so the button can
 * be judged against neighbours of the right size. Nothing from `../../shell/`
 * is imported; the strip below is a few lines of local CSS.
 *
 * `window.__guide` and `window.__guideApi` are what `run.mjs` drives.
 */

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  GuideButton,
  GuideEditor,
  GuideOverlay,
  Hint,
  loadGuideContent,
  useGuide,
  validateGuideContent,
} from '../index.ts';
import type { GuideContent } from '../index.ts';
import { DEFAULT_GUIDE_CONTENT } from '../content.ts';
import { GUIDE_SEEN_KEY, readFlag } from '../storage.ts';

declare global {
  interface Window {
    __guide?: {
      open: boolean;
      remembered: boolean;
      flag: string;
      content: GuideContent;
      json: string;
    };
    __guideApi?: {
      /** Replace the edited content outright. */
      set(content: GuideContent): void;
      /** Put the shipped guide back. */
      reset(): void;
      /** Does this content survive JSON and the schema unchanged? */
      roundTrip(): { ok: boolean; issues: string[]; same: boolean; diff: string };
      /** What the loader makes of some raw input. Must never throw. */
      probe(raw: unknown): { fellBack: boolean; issues: number; title: string; threw: boolean };
    };
  }
}

const HARNESS_CSS = `
  html, body { margin: 0; height: 100%; }
  body {
    background: #15171a;
    color: #e7eaed;
    font: 12px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .hz-root {
    --cms-bg: #15171a; --cms-panel: #1b1e22; --cms-panel-2: #22262b;
    --cms-line: #2d3238; --cms-line-strong: #3b424a;
    --cms-text: #e7eaed; --cms-muted: #8d969f;
    --cms-accent: #4c8dff; --cms-accent-dim: #1f3a66; --cms-danger: #e5534b;
    display: flex; flex-direction: column; height: 100vh;
  }
  .hz-bar {
    display: flex; align-items: center; gap: 8px;
    height: 40px; padding: 0 10px; flex: 0 0 auto;
    border-bottom: 1px solid var(--cms-line); background: var(--cms-panel);
  }
  .hz-bar__name { font-weight: 600; font-size: 13px; }
  .hz-bar__slug { color: var(--cms-muted); font-size: 11px; }
  .hz-bar__spacer { flex: 1 1 auto; }
  .hz-bar__sep { width: 1px; height: 20px; background: var(--cms-line); }
  .hz-btn {
    display: inline-flex; align-items: center; justify-content: center;
    height: 24px; padding: 0 9px; border: 1px solid var(--cms-line-strong);
    border-radius: 5px; background: var(--cms-panel-2); color: var(--cms-text);
    font: inherit; cursor: pointer;
  }
  .hz-btn--icon { width: 24px; padding: 0; }
  .hz-btn--primary { background: var(--cms-accent); border-color: var(--cms-accent); color: #fff; }
  .hz-main { flex: 1 1 auto; min-height: 0; }
  .hz-state {
    position: fixed; right: 10px; bottom: 10px; z-index: 400;
    padding: 4px 8px; border-radius: 5px; background: #0b0d0f;
    border: 1px solid #2d3238; color: #8d969f;
    font: 11px/1.4 ui-monospace, Menlo, monospace;
  }
`;

/** The harness owns its own flag, so running it never touches the real one. */
const HARNESS_KEY = `${GUIDE_SEEN_KEY}.harness`;

function Harness() {
  const guide = useGuide({ storageKey: HARNESS_KEY });
  const [content, setContent] = useState<GuideContent>(() => structuredClone(DEFAULT_GUIDE_CONTENT));

  useEffect(() => {
    window.__guide = {
      open: guide.open,
      remembered: guide.remembered,
      flag: readFlag(HARNESS_KEY),
      content,
      json: JSON.stringify(content),
    };
    window.__guideApi = {
      set: (next) => setContent(next),
      reset: () => setContent(structuredClone(DEFAULT_GUIDE_CONTENT)),
      roundTrip: () => {
        const text = JSON.stringify(content);
        const result = validateGuideContent(JSON.parse(text));
        const back = result.ok ? JSON.stringify(result.data) : '';
        let where = -1;
        if (result.ok && back !== text) {
          where = 0;
          while (where < text.length && text[where] === back[where]) where += 1;
        }
        return {
          ok: result.ok,
          issues: result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`),
          same: result.ok && back === text,
          diff: where < 0 ? '' : `…${text.slice(Math.max(0, where - 60), where + 40)}\n  vs …${back.slice(Math.max(0, where - 60), where + 40)}`,
        };
      },
      probe: (raw) => {
        try {
          const loaded = loadGuideContent(raw);
          return {
            fellBack: loaded.fellBack,
            issues: loaded.issues.length,
            title: loaded.content.title,
            threw: false,
          };
        } catch {
          return { fellBack: false, issues: 0, title: '', threw: true };
        }
      },
    };
  });

  return (
    <div className="hz-root">
      <div className="hz-bar">
        <span className="hz-bar__name">Tide pools at Pillar Point</span>
        <span className="hz-bar__slug">/projects/pillar-point</span>
        <span className="hz-bar__spacer" />
        <button type="button" className="hz-btn hz-btn--icon" aria-label="Undo">
          ↺
        </button>
        <button type="button" className="hz-btn hz-btn--icon" aria-label="Redo">
          ↻
        </button>
        <span className="hz-bar__sep" />
        <Hint text="Opens the guide. Esc closes it.">
          <GuideButton onClick={guide.toggle} active={guide.open} />
        </Hint>
        <span className="hz-bar__sep" />
        <button type="button" className="hz-btn">
          Preview
        </button>
        <button type="button" className="hz-btn">
          Save
        </button>
        <button type="button" className="hz-btn hz-btn--primary">
          Publish
        </button>
      </div>

      <div className="hz-main">
        <GuideEditor content={content} onChange={setContent} />
      </div>

      <div className="hz-state" data-testid="state">
        open={String(guide.open)} remembered={String(guide.remembered)} flag={readFlag(HARNESS_KEY)}{' '}
        cards={content.cards.length}
      </div>

      <GuideOverlay open={guide.open} onClose={guide.hide} content={content} />
    </div>
  );
}

const style = document.createElement('style');
style.textContent = HARNESS_CSS;
document.head.append(style);

const host = document.getElementById('root');
if (host !== null) {
  createRoot(host).render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
}
