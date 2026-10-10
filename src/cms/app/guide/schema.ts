/**
 * src/cms/app/guide/schema.ts
 *
 * The content model for the guide itself, so the guide is editable from
 * inside the CMS rather than compiled into the bundle.
 *
 * It lives here and not in `src/cms/schema.ts` because that file is owned by
 * another workstream. It deliberately imports NOTHING from it, not even
 * types: this directory has to keep building while that file is being
 * rewritten. The conventions are copied rather than shared, and they are the
 * same two rules:
 *
 *  1. Every object schema is `.strict()`. An unknown key is a validation
 *     error, not something silently dropped.
 *  2. Validation returns a discriminated result and never throws, so callers
 *     switch on `ok` instead of wrapping in try/catch.
 *
 * If the guide content model ever belongs in the main schema, the three
 * schemas below move across unchanged; nothing else in this directory refers
 * to zod.
 */

import { z } from 'zod';

/** Content format version. Bumping this is a migration, not a patch. */
export const GUIDE_CONTENT_VERSION = 1;

/** Same shape as the main schema's ids, so the two can never disagree. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const GuideIdSchema = z
  .string()
  .regex(ID_RE, 'id must be 1-64 characters from A-Z a-z 0-9 _ -');

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One labelled line inside a card: the thing, and what it is.
 *
 * `key` renders the term as a key cap, monospace in a bordered box, which is
 * what the canvas gestures and the preview widths want. It is optional and
 * three-valued on purpose: left out, the card's own `keys` flag decides. Use
 * `rowIsKeyCap()` rather than reading either field directly.
 *
 * `id` is optional because the guide shipped without row ids and that content
 * must keep validating. The editor gives every row it creates one.
 */
export const GuideRowSchema = z
  .object({
    id: GuideIdSchema.optional(),
    term: z.string().min(1, 'a row needs a term').max(80, 'a term is at most 80 characters'),
    text: z.string().min(1, 'a row needs a description').max(600, 'a description is at most 600 characters'),
    key: z.boolean().optional(),
  })
  .strict();

export type GuideRow = z.infer<typeof GuideRowSchema>;

/* -------------------------------------------------------------------------- */
/* Cards                                                                       */
/* -------------------------------------------------------------------------- */

export const GuideCardSchema = z
  .object({
    id: GuideIdSchema,
    /** The heading. */
    title: z.string().min(1, 'a card needs a heading').max(120, 'a heading is at most 120 characters'),
    /** The blurb above the rows. */
    lead: z.string().max(600, 'a blurb is at most 600 characters').optional(),
    rows: z.array(GuideRowSchema).max(40, 'a card holds at most 40 rows'),
    /** The footnote below the rows. */
    note: z.string().max(600, 'a footnote is at most 600 characters').optional(),
    /** Default for this card's rows when a row does not say. */
    keys: z.boolean().optional(),
  })
  .strict()
  .superRefine((card, ctx) => {
    const seen = new Set<string>();
    card.rows.forEach((row, index) => {
      if (row.id === undefined) return;
      if (seen.has(row.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rows', index, 'id'],
          message: `duplicate row id "${row.id}"`,
        });
      }
      seen.add(row.id);
    });
  });

export type GuideCard = z.infer<typeof GuideCardSchema>;

/* -------------------------------------------------------------------------- */
/* The document                                                                */
/* -------------------------------------------------------------------------- */

export const GuideContentSchema = z
  .object({
    version: z.literal(GUIDE_CONTENT_VERSION),
    /** The panel's heading. */
    title: z.string().min(1, 'the guide needs a title').max(120, 'the title is at most 120 characters'),
    /** The sentence under the heading. May be empty, and then it is not drawn. */
    lead: z.string().max(400, 'the lead is at most 400 characters'),
    cards: z
      .array(GuideCardSchema)
      .min(1, 'a guide with no cards is an empty panel')
      .max(24, 'a guide holds at most 24 cards'),
  })
  .strict()
  .superRefine((content, ctx) => {
    const seen = new Set<string>();
    content.cards.forEach((card, index) => {
      if (seen.has(card.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cards', index, 'id'],
          message: `duplicate card id "${card.id}"`,
        });
      }
      seen.add(card.id);
    });
  });

export type GuideContent = z.infer<typeof GuideContentSchema>;

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export type GuideIssue = {
  /** Dotted path into the content, e.g. `cards.2.rows.0.term`. `(root)` for the whole thing. */
  path: string;
  message: string;
};

export type GuideValidateResult =
  | { ok: true; data: GuideContent }
  | { ok: false; issues: GuideIssue[] };

function toIssues(error: z.ZodError): GuideIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}

export function validateGuideContent(value: unknown): GuideValidateResult {
  const parsed = GuideContentSchema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, issues: toIssues(parsed.error) };
}

/** Same contract, starting from the raw file contents. Bad JSON is an issue, not a throw. */
export function validateGuideContentJson(text: string): GuideValidateResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: '(root)', message: `invalid JSON: ${(error as Error).message}` }],
    };
  }
  return validateGuideContent(value);
}

/** One line per issue, for a status bar or a CLI. */
export function formatGuideIssues(issues: GuideIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Fresh id, valid against `GuideIdSchema`. Same approach as the main schema's
 * `newId`, reimplemented here rather than imported for the reason in the
 * header. Conventional prefixes: `gc` card, `gr` row.
 */
export function newGuideId(prefix = 'g'): string {
  const safePrefix = prefix.replace(/[^A-Za-z0-9_-]/g, '') || 'g';
  const webcrypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  let body: string;
  if (webcrypto !== undefined && typeof webcrypto.getRandomValues === 'function') {
    const bytes = webcrypto.getRandomValues(new Uint8Array(5));
    body = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  } else {
    body = Math.random().toString(16).slice(2, 12).padEnd(10, '0');
  }
  return `${safePrefix}_${body}`;
}

/**
 * Does this row draw as a key cap? The row decides if it says; otherwise the
 * card's default does; otherwise no. Nobody reads `row.key` or `card.keys`
 * directly, so the two-level default exists in exactly one place.
 */
export function rowIsKeyCap(card: Pick<GuideCard, 'keys'>, row: Pick<GuideRow, 'key'>): boolean {
  return row.key ?? card.keys ?? false;
}

export function newGuideRow(overrides: Partial<GuideRow> = {}): GuideRow {
  return { id: newGuideId('gr'), term: 'Term', text: 'What it is.', ...overrides };
}

export function newGuideCard(overrides: Partial<GuideCard> = {}): GuideCard {
  return {
    id: newGuideId('gc'),
    title: 'New card',
    rows: [newGuideRow()],
    ...overrides,
  };
}
