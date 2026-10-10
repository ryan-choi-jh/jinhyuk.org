/**
 * src/cms/app/shell/record-stub.tsx
 *
 * WS-D. What the record editor slot draws when nothing has been mounted in it:
 * every field of `RecordsDef.fields`, with its label, whether it is required,
 * its input type and its current value, read only.
 *
 * This is the same device phase 1's shell used for the canvas and prose slots
 * — a read-only placeholder in place of the real editor — and it is here for
 * the same two reasons. It makes the navigation shell verifiable on its own,
 * before WS-E's editors exist, which is the only way this workstream can prove
 * anything today. And it is the picture of the contract: if a field in here
 * shows a value the real editor cannot edit, the two have diverged.
 *
 * It takes exactly `RecordEditorSlotProps`, so it is a drop-in for whatever
 * WS-E ships.
 */

import { isAlbum, isFilm, youtubeEmbedUrl } from '../../schema.ts';
import type { Photo } from '../../schema.ts';
import type { RecordField } from '../../sections.ts';
import type { RecordEditorSlotProps } from './site-slots.ts';

/** A field's current value off the record, as whatever it is. */
function valueOf(entry: unknown, name: string): unknown {
  return (entry as Record<string, unknown>)[name];
}

function Empty({ what }: { what: string }) {
  return <span className="cms-rec__value cms-rec__value--empty">{what}</span>;
}

function FieldValue({
  field,
  props,
}: {
  field: RecordField;
  props: RecordEditorSlotProps;
}) {
  const { entry, resolveMediaSrc } = props;
  const raw = valueOf(entry, field.name);

  switch (field.type) {
    case 'youtube': {
      const id = typeof raw === 'string' ? raw : '';
      if (id === '') return <Empty what="no video yet — a film cannot be saved without one" />;
      return (
        <span className="cms-rec__value">
          {id}
          <br />
          <span style={{ color: 'var(--cms-muted)' }}>{youtubeEmbedUrl(id)}</span>
        </span>
      );
    }

    case 'image': {
      if (typeof raw !== 'string' || raw === '') {
        const fallback =
          isFilm(entry) && entry.youtubeId !== '' ? "YouTube's own thumbnail" : 'nothing';
        return <Empty what={`not set — the site falls back to ${fallback}`} />;
      }
      return (
        <span className="cms-rec__value">
          <img className="cms-rec__thumb" src={resolveMediaSrc(raw)} alt="" />
          <br />
          {raw}
        </span>
      );
    }

    case 'photos': {
      const photos = Array.isArray(raw) ? (raw as Photo[]) : [];
      if (photos.length === 0) return <Empty what="no photos uploaded yet" />;
      return (
        <span className="cms-rec__value">
          <span className="cms-rec__thumbs">
            {photos.map((photo) => (
              <img
                key={photo.id}
                className="cms-rec__thumb"
                src={resolveMediaSrc(photo.src)}
                alt={photo.alt ?? ''}
                title={`${photo.id}${photo.w === undefined ? '' : ` · ${photo.w}×${photo.h}`}`}
              />
            ))}
          </span>
          {photos.length} photo{photos.length === 1 ? '' : 's'}, in this order
        </span>
      );
    }

    case 'cover': {
      if (!isAlbum(entry)) return <Empty what="not an album" />;
      if (typeof raw !== 'string' || raw === '') {
        const first = entry.photos[0];
        return <Empty what={first === undefined ? 'no photos to choose from' : `not chosen — the first photo (${first.id})`} />;
      }
      const chosen = entry.photos.find((photo) => photo.id === raw);
      return (
        <span className="cms-rec__value">
          {chosen === undefined ? (
            raw
          ) : (
            <>
              <img className="cms-rec__thumb" src={resolveMediaSrc(chosen.src)} alt="" />
              <br />
              {raw}
            </>
          )}
        </span>
      );
    }

    default: {
      if (typeof raw !== 'string' || raw === '') return <Empty what="empty" />;
      return <span className="cms-rec__value">{raw}</span>;
    }
  }
}

export function RecordStub(props: RecordEditorSlotProps) {
  const { section, fields, entry, entryKey, entryIndex, records } = props;

  return (
    <div className="cms-rec__stub" data-testid="record-stub" data-section={section.id} data-entry={entryKey}>
      <div className="cms-rec__note">
        <strong>No {records.noun} editor is mounted.</strong> This is the shell&rsquo;s read-only
        placeholder, showing the {fields.length} fields {section.label} stores. WS-E&rsquo;s editor
        mounts here through <code>renderRecordEditor</code>; everything around it — the list, create,
        duplicate, delete, reorder, undo, Save and Publish — is already working.
      </div>

      <div className="cms-rec__fields">
        {fields.map((field) => (
          <div className="cms-rec__field" key={field.name} data-testid={`record-field-${field.name}`}>
            <span className="cms-rec__label">
              {field.label}
              {field.required && (
                <span className="cms-rec__req" title="Required">
                  {' '}
                  *
                </span>
              )}
              <span className="cms-rec__meta">
                {field.name} · {field.type}
              </span>
            </span>
            <FieldValue field={field} props={props} />
          </div>
        ))}
      </div>

      <p style={{ color: 'var(--cms-muted)', margin: 0 }}>
        Record {entryIndex + 1} of this collection · id <code>{entry.id}</code> · URL key{' '}
        <code>{entryKey}</code>
        {section.entryUrl === null
          ? ' · no page of its own on the site'
          : ` · ${section.entryUrl.replace(':slug', entryKey)}`}
      </p>
    </div>
  );
}
