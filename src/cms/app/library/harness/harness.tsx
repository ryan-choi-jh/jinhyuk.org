/**
 * src/cms/app/library/harness/harness.tsx
 *
 * The library on its own, with no editor around it.
 *
 * Nothing from `../../shell/`, `../../records/` or `../../canvas/` is imported.
 * The only thing wrapped around `<LibraryBrowser>` is a strip along the bottom
 * showing the `CanvasItem`s it has emitted, each checked against WS-0's real
 * `CanvasItemSchema`, so a screenshot of this page is evidence that insertion
 * produces something a document would accept.
 *
 * `window.__lib` is the hook ./run.mjs drives:
 *
 *   window.__lib.inserted   CanvasItem[], newest last
 *   window.__lib.errors     string[][], schema complaints per inserted item
 *   window.__lib.entries    how many entries the catalogue loaded
 *   window.__lib.problems   catalogue problems, which should be []
 *   window.__libReset()     clear the log
 */

import { StrictMode, useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { LibraryBrowser } from '../LibraryBrowser.tsx';
import { loadCatalogue } from '../catalogue.ts';
import seedCatalogue from '../catalogue.seed.json';
import { checkCanvasItem } from '../shape-adapter.ts';
import type { CanvasItem } from '../shape-adapter.ts';

declare global {
  interface Window {
    __lib: {
      inserted: CanvasItem[];
      errors: string[][];
      entries: number;
      problems: string[];
    };
    __libReset: () => void;
  }
}

function App() {
  const [inserted, setInserted] = useState<CanvasItem[]>([]);
  const loaded = useMemo(() => loadCatalogue(seedCatalogue), []);

  const onInsert = useCallback((item: CanvasItem) => {
    setInserted((current) => [...current, item]);
  }, []);

  window.__lib = {
    inserted,
    errors: inserted.map((item) => checkCanvasItem(item)),
    entries: loaded.entries.length,
    problems: loaded.problems,
  };
  window.__libReset = () => setInserted([]);

  const badCount = inserted.filter((item) => checkCanvasItem(item).length > 0).length;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: 'minmax(0, 1fr) auto',
        height: '100%',
        background: '#15171a',
        color: '#e7eaed',
        font: '12px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif',
      }}
    >
      <LibraryBrowser onInsert={onInsert} title="Library" />

      <div
        data-lib-log={inserted.length}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          minHeight: 46,
          maxHeight: 118,
          overflow: 'auto',
          padding: '8px 14px',
          borderTop: '1px solid #2d3238',
          background: '#111316',
        }}
      >
        <strong
          style={{
            flex: '0 0 auto',
            padding: '2px 7px',
            borderRadius: 4,
            background: badCount === 0 ? '#16391f' : '#4a1d1a',
            color: badCount === 0 ? '#5ad17c' : '#ff8a80',
            fontSize: 11,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}
        >
          {inserted.length === 0
            ? 'nothing inserted yet'
            : `${inserted.length} inserted · ${badCount === 0 ? 'all schema-valid' : `${badCount} INVALID`}`}
        </strong>
        <div style={{ minWidth: 0, flex: '1 1 auto' }}>
          {inserted
            .slice()
            .reverse()
            .map((item, index) => {
              const errors = checkCanvasItem(item);
              return (
                <pre
                  key={`${item.id}-${index}`}
                  style={{
                    margin: '0 0 3px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 10.5,
                    color: errors.length === 0 ? '#9aa4ad' : '#ff8a80',
                  }}
                >
                  {JSON.stringify(item)}
                  {errors.length === 0 ? '' : `  <- ${errors.join('; ')}`}
                </pre>
              );
            })}
        </div>
      </div>
    </div>
  );
}

const mount = document.getElementById('root');
if (mount === null) throw new Error('no #root');
createRoot(mount).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
