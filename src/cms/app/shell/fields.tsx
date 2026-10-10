/**
 * src/cms/app/shell/fields.tsx
 *
 * WS-3. The handful of form primitives the inspector is built from. Dumb,
 * controlled, no state of their own except the number field's in-progress text.
 */

import type { ChangeEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="cms-section">
      <div className="cms-section__head">{title}</div>
      {children}
    </div>
  );
}

export function Field({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={wide ? 'cms-field cms-field--wide' : 'cms-field'}>
      <label>{label}</label>
      {children}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  wide = false,
  type = 'text',
  testId,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  wide?: boolean;
  type?: 'text' | 'date' | 'url' | 'color';
  testId?: string;
}) {
  return (
    <Field label={label} wide={wide}>
      <input
        className={type === 'color' ? 'cms-input cms-input--color' : 'cms-input'}
        data-testid={testId}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      />
    </Field>
  );
}

/**
 * Numbers are edited as text so a half-typed value ("-", "1.") does not get
 * parsed into nonsense and written to the document. The committed value only
 * goes out when the text parses; the text resets to the document's value
 * whenever that changes from elsewhere (undo, a drag on the canvas).
 */
export function NumberField({
  label,
  value,
  onChange,
  step = 1,
  allowEmpty = false,
  testId,
  emptyLabel = 'auto',
}: {
  label: string;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  step?: number;
  allowEmpty?: boolean;
  testId?: string;
  emptyLabel?: string;
}) {
  const external = value === undefined ? '' : String(round(value));
  const [text, setText] = useState(external);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setText(external);
  }, [external, editing]);

  const commit = (next: string): void => {
    setText(next);
    if (next.trim() === '') {
      if (allowEmpty) onChange(undefined);
      return;
    }
    const parsed = Number(next);
    if (Number.isFinite(parsed)) onChange(parsed);
  };

  return (
    <Field label={label}>
      <input
        className="cms-input cms-input--num"
        data-testid={testId}
        type="number"
        step={step}
        value={text}
        placeholder={allowEmpty ? emptyLabel : undefined}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          setEditing(false);
          setText(external);
        }}
        onChange={(event: ChangeEvent<HTMLInputElement>) => commit(event.target.value)}
      />
    </Field>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: readonly T[] | readonly { value: T; label: string }[];
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  const normalised = options.map((option) =>
    typeof option === 'string' ? { value: option, label: option } : option,
  );
  return (
    <Field label={label}>
      <select
        className="cms-select"
        value={value}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value as T)}
      >
        {normalised.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function CheckField({
  label,
  checked,
  onChange,
  disabled = false,
  hint,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  hint?: string;
  testId?: string;
}) {
  return (
    <div>
      <label className="cms-check">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          data-testid={testId}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)}
        />
        {label}
      </label>
      {hint !== undefined && <div className="cms-hint">{hint}</div>}
    </div>
  );
}

function round(value: number): number {
  return Math.abs(value % 1) < 1e-9 ? value : Math.round(value * 100) / 100;
}
