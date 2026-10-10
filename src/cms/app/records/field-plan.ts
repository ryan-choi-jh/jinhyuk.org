/**
 * src/cms/app/records/field-plan.ts
 *
 * WS-E. Which control a `RecordField` gets, and where the field list comes
 * from. No JSX, no React: `./verify.ts` runs under bare node, and node's type
 * stripping does not understand a `.tsx` file.
 *
 * The exhaustive switch lives here. `src/cms/sections.ts` says the field-type
 * union is closed "so WS-E's record editor can switch exhaustively and the
 * compiler tells it when a field type is added" — `assertNever` at the bottom
 * of `fieldGroup` is that promise being kept. Add a type to the union and this
 * file stops compiling until it is handled, rather than a field silently
 * vanishing from the editor.
 */

import { isRecordSection, requireSection } from '../../sections.ts';
import type { RecordField, RecordFieldType, RecordSectionDef } from '../../sections.ts';
import type { RecordSectionId } from '../../schema.ts';

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A record section from the registry, already narrowed. `requireSection` hands
 * back a `SectionDef` whose `records` is `null` for the three document
 * sections, and both editors want the `RecordsDef` without writing the narrow
 * themselves.
 */
export function requireRecordSection(id: RecordSectionId): RecordSectionDef {
  const section = requireSection(id);
  if (!isRecordSection(section)) {
    throw new TypeError(`section "${id}" stores documents, not records`);
  }
  return section;
}

/** The fields the registry declares for a record section, in editor order. */
export function recordFieldsFor(id: RecordSectionId): readonly RecordField[] {
  return requireRecordSection(id).records.fields;
}

/* -------------------------------------------------------------------------- */
/* Which half of the editor a field belongs to                                 */
/* -------------------------------------------------------------------------- */

/**
 *   text   a plain input the generic renderer can draw
 *   media  a picture, a video or a list of them, drawn by its own control
 */
export type FieldGroup = 'text' | 'media';

/** The compile-time guarantee that a new field type cannot be ignored. */
export function assertNever(value: never, what: string): never {
  throw new TypeError(`${what}: unhandled ${JSON.stringify(value)}`);
}

export function fieldGroup(type: RecordFieldType): FieldGroup {
  switch (type) {
    case 'text':
    case 'textarea':
    case 'slug':
    case 'year':
      return 'text';
    case 'youtube':
    case 'image':
    case 'photos':
    case 'cover':
      return 'media';
    default:
      return assertNever(type, 'fieldGroup');
  }
}

export function isTextField(field: RecordField): boolean {
  return fieldGroup(field.type) === 'text';
}

export function isMediaField(field: RecordField): boolean {
  return fieldGroup(field.type) === 'media';
}

/** Split a section's fields the way both editors lay them out. */
export function splitFields(fields: readonly RecordField[]): {
  text: RecordField[];
  media: RecordField[];
} {
  return {
    text: fields.filter(isTextField),
    media: fields.filter(isMediaField),
  };
}

export function findField(
  fields: readonly RecordField[],
  name: string,
): RecordField | undefined {
  return fields.find((field) => field.name === name);
}
