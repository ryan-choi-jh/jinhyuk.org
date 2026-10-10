/**
 * src/cms/app/records/fields.tsx
 *
 * WS-E. The form primitives both record editors are built from. Which control
 * a field gets is decided in `./field-plan.ts`, which has no JSX in it so the
 * node-only proof can import it.
 *
 * These are deliberately NOT `../shell/fields.tsx`. Those belong to the
 * document editor's inspector (and to WS-D this phase); these carry a per-field
 * problem line, a datalist from `RecordField.suggestions`, and a slug input
 * that shows the URL it is about to make.
 */

import { useRef } from 'react';
import type { ChangeEvent, ReactNode } from 'react';

import {
  assertNever,
  fieldGroup,
  findField,
  isMediaField,
  isTextField,
  recordFieldsFor,
  requireRecordSection,
  splitFields,
} from './field-plan.ts';
import type { FieldGroup } from './field-plan.ts';
import type { RecordField } from '../../sections.ts';

/** Re-exported so a component file is the only import a caller needs. */
export {
  fieldGroup,
  findField,
  isMediaField,
  isTextField,
  recordFieldsFor,
  requireRecordSection,
  splitFields,
};
export type { FieldGroup };

/* -------------------------------------------------------------------------- */
/* Shells                                                                     */
/* -------------------------------------------------------------------------- */

export function Group({
  title,
  aside,
  children,
  testId,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="cms-rec__group" data-testid={testId}>
      <div className="cms-rec__group-head">
        <span>{title}</span>
        <span className="cms-rec__spacer" />
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * Label, control, then at most one line underneath: the problem if there is
 * one, otherwise the help text. Never both, because two lines of grey under
 * every field is how a form stops being readable.
 */
export function FieldShell({
  field,
  problem,
  advisory = false,
  below,
  children,
}: {
  field: RecordField;
  problem?: string | null;
  advisory?: boolean;
  below?: ReactNode;
  children: ReactNode;
}) {
  const showProblem = problem !== null && problem !== undefined && problem !== '';
  return (
    <div className="cms-rec__field" data-field={field.name}>
      <div className="cms-rec__label">
        <span>{field.label}</span>
        {field.required ? (
          <span className="cms-rec__req" title="Required">
            ·
          </span>
        ) : null}
      </div>
      {children}
      {showProblem ? (
        <div
          className={advisory ? 'cms-rec__help' : 'cms-rec__problem'}
          data-testid={`problem-${field.name}`}
        >
          {problem}
        </div>
      ) : field.help === undefined ? null : (
        <div className="cms-rec__help">{field.help}</div>
      )}
      {below}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

type InputProps = {
  field: RecordField;
  value: string;
  onChange: (next: string) => void;
  problem?: string | null;
  advisory?: boolean;
  disabled?: boolean;
  /** Overrides the default `field-<name>`. */
  testId?: string;
  below?: ReactNode;
  placeholder?: string;
};

const listId = (field: RecordField): string | undefined =>
  field.suggestions === undefined ? undefined : `cms-rec-list-${field.name}`;

function Suggestions({ field }: { field: RecordField }) {
  const id = listId(field);
  if (id === undefined || field.suggestions === undefined) return null;
  return (
    <datalist id={id}>
      {field.suggestions.map((suggestion) => (
        <option key={suggestion} value={suggestion} />
      ))}
    </datalist>
  );
}

/**
 * One line. Used for `text`, and for `year` and `slug` with a tighter
 * placeholder — the validation difference between them is in the problem line,
 * which the editor computes, not in the input element.
 */
export function TextLine({
  field,
  value,
  onChange,
  problem,
  advisory,
  disabled,
  testId,
  below,
  placeholder,
  mono = false,
}: InputProps & { mono?: boolean }) {
  const bad = problem !== null && problem !== undefined && problem !== '' && advisory !== true;
  const classes = ['cms-rec__input'];
  if (mono) classes.push('cms-rec__input--mono');
  if (bad) classes.push('cms-rec__input--bad');
  return (
    <FieldShell field={field} problem={problem} advisory={advisory} below={below}>
      <input
        className={classes.join(' ')}
        data-testid={testId ?? `field-${field.name}`}
        type="text"
        value={value}
        placeholder={placeholder}
        list={listId(field)}
        disabled={disabled}
        spellCheck={field.type === 'slug' ? false : undefined}
        autoComplete="off"
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      />
      <Suggestions field={field} />
    </FieldShell>
  );
}

export function TextBlock({
  field,
  value,
  onChange,
  problem,
  advisory,
  disabled,
  testId,
  below,
  placeholder,
  rows = 3,
}: InputProps & { rows?: number }) {
  const bad = problem !== null && problem !== undefined && problem !== '' && advisory !== true;
  return (
    <FieldShell field={field} problem={problem} advisory={advisory} below={below}>
      <textarea
        className={bad ? 'cms-rec__textarea cms-rec__textarea--bad' : 'cms-rec__textarea'}
        data-testid={testId ?? `field-${field.name}`}
        value={value}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
      />
    </FieldShell>
  );
}

/**
 * The generic renderer for the four textual field types. `media` types never
 * reach it: both editors route those to their own controls, and `splitFields`
 * is how they do it.
 */
export function TextualField(
  props: InputProps & { urlPreview?: string | null; fix?: { label: string; onClick: () => void } },
) {
  const { field, urlPreview, fix, ...rest } = props;
  const below =
    urlPreview === undefined || urlPreview === null ? (
      props.below
    ) : (
      <div className="cms-rec__row">
        <span className="cms-rec__url" data-testid={`url-${field.name}`}>
          {urlPreview}
        </span>
        {fix === undefined ? null : (
          <button
            type="button"
            className="cms-rec__btn cms-rec__btn--tiny cms-rec__btn--quiet"
            data-testid={`fix-${field.name}`}
            onClick={fix.onClick}
            disabled={rest.disabled}
          >
            {fix.label}
          </button>
        )}
      </div>
    );

  switch (field.type) {
    case 'text':
      return <TextLine {...rest} field={field} below={below} />;
    case 'textarea':
      return <TextBlock {...rest} field={field} below={below} />;
    case 'slug':
      return (
        <TextLine {...rest} field={field} below={below} mono placeholder="lowercase-with-hyphens" />
      );
    case 'year':
      return <TextLine {...rest} field={field} below={below} placeholder="2026" />;
    case 'youtube':
    case 'image':
    case 'photos':
    case 'cover':
      // Routed to a media control by the editor. Rendering a bare text input
      // for a list of photos would be worse than rendering nothing.
      return null;
    default:
      return assertNever(field.type, 'TextualField');
  }
}

/* -------------------------------------------------------------------------- */
/* A file button that behaves                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A styled `<input type="file">`. The input stays in the DOM — hidden, but not
 * `display: none`, so a driver can still set files on it — and a button opens
 * it through a ref rather than through `label[for]`, so two editors mounted at
 * once cannot steal each other's file dialog.
 */
export function FilePick({
  id,
  label,
  multiple = false,
  disabled = false,
  accept = 'image/*',
  onFiles,
  primary = false,
  testId,
}: {
  /** Stable handle for tests: the input is `<id>-input`. Not used for wiring. */
  id: string;
  label: string;
  multiple?: boolean;
  disabled?: boolean;
  accept?: string;
  onFiles: (files: File[]) => void;
  primary?: boolean;
  testId?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const classes = ['cms-rec__btn'];
  if (primary) classes.push('cms-rec__btn--primary');
  return (
    <>
      <button
        type="button"
        className={classes.join(' ')}
        data-testid={testId ?? id}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {label}
      </button>
      <input
        ref={inputRef}
        id={id}
        data-testid={`${id}-input`}
        type="file"
        multiple={multiple}
        accept={accept}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          opacity: 0,
          overflow: 'hidden',
          pointerEvents: 'none',
        }}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const files = Array.from(event.target.files ?? []);
          // Reset, so choosing the same file twice in a row still fires.
          event.target.value = '';
          if (files.length > 0) onFiles(files);
        }}
      />
    </>
  );
}
