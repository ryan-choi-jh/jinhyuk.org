/**
 * src/cms/app/records/RecordEditor.tsx
 *
 * WS-E. The one component WS-D and WS-G need: give it a record section and one
 * of its entries, and the right editor appears.
 *
 *   import { RecordEditor } from '../records/index.ts';
 *
 *   <RecordEditor
 *     section={section}          // a RecordSectionDef from src/cms/sections.ts
 *     record={entry}             // Film | Album
 *     onChange={(next) => ...}   // Film | Album, the whole record
 *     uploadMedia={upload}
 *   />
 *
 * The switch is on `section.records.key`, the registry's own discriminant, and
 * it is exhaustive: adding a third record collection to `sections.ts` stops
 * this file compiling rather than silently rendering nothing
 * (docs/cms-contracts.md 9.4).
 */

import { isAlbum, isFilm } from '../../schema.ts';
import type { Album, Film, RecordEntry } from '../../schema.ts';
import type { RecordSectionDef } from '../../sections.ts';

import { AlbumEditor } from './AlbumEditor.tsx';
import { FilmEditor } from './FilmEditor.tsx';
import { useRecordsStyles } from './styles.ts';
import type { RecordEditorProps } from './types.ts';

export type RecordEditorDispatchProps = Omit<RecordEditorProps<RecordEntry>, 'record' | 'onChange'> & {
  section: RecordSectionDef;
  record: RecordEntry;
  onChange: (next: RecordEntry) => void;
};

/** Shown instead of crashing when an entry and its section disagree. */
function Mismatch({ expected, got }: { expected: string; got: string }) {
  return (
    <div className="cms-rec" data-testid="record-mismatch">
      <div className="cms-rec__body">
        <div className="cms-rec__issues">
          This section holds {expected}s, but the entry it was given looks like {got}. Nothing has
          been changed. This is a wiring mistake, not something you did.
        </div>
      </div>
    </div>
  );
}

export function RecordEditor({ section, record, onChange, ...rest }: RecordEditorDispatchProps) {
  useRecordsStyles();
  const fields = rest.fields ?? section.records.fields;

  switch (section.records.key) {
    case 'films':
      if (!isFilm(record)) {
        return <Mismatch expected="film" got={isAlbum(record) ? 'an album' : 'something else'} />;
      }
      return (
        <FilmEditor
          {...rest}
          fields={fields}
          record={record}
          onChange={(next: Film) => onChange(next)}
        />
      );
    case 'albums':
      if (!isAlbum(record)) {
        return <Mismatch expected="album" got={isFilm(record) ? 'a film' : 'something else'} />;
      }
      return (
        <AlbumEditor
          {...rest}
          fields={fields}
          record={record}
          onChange={(next: Album) => onChange(next)}
        />
      );
    default: {
      const unhandled: never = section.records.key;
      throw new TypeError(`RecordEditor: no editor for record collection ${String(unhandled)}`);
    }
  }
}

export default RecordEditor;
