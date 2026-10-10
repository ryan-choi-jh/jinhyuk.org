/**
 * src/cms/server/site-chrome.ts
 *
 * The nav bar and the footer, server side.
 *
 * One file — `src/content/data/site.json` — holding one object, so this is the
 * simplest shape the CMS stores: there is no collection to permute and no slug
 * to fill, which is why there is no `applyOp` here as there is in
 * `./records.ts`. Read it, write the draft, publish the draft.
 *
 * Everything that makes a save safe is inherited rather than restated:
 * `./drafts.ts` owns draft semantics (the editor writes the draft mirror;
 * publish copies the draft's own bytes over the published file and deletes the
 * draft in ONE commit; the site builds from the published tree only) and blob-
 * sha conflict detection. A `Slot` is all it needs from this file, so the chrome
 * gets the same guarantees as a document and a record collection, from the same
 * code, by construction.
 *
 * The paths come from the registry (`SITE_CHROME_PATH`,
 * `SITE_CHROME_DRAFT_PATH`), not from a string here, for the same reason every
 * other path does.
 */

import { badRequest } from './errors.ts';
import {
  discardSlotDraft,
  publishSlot,
  readSlot,
  writeSlotDraft,
} from './drafts.ts';
import type { Ctx, ShaExpectation, Slot, SlotRead, WriteResult } from './drafts.ts';
import { SITE_CHROME_DRAFT_PATH, SITE_CHROME_PATH } from '../sections.ts';
import { formatIssues, validateSiteChrome, validateSiteChromeJson } from '../schema.ts';
import type { SiteChrome } from '../schema.ts';

/**
 * What a commit message and a human-readable error call this file. "site",
 * because the commits read `CMS: save draft site` and `CMS: publish site`, and
 * what is being saved is the site's own frame.
 */
export const SITE_CHROME_LABEL = 'site';

/* -------------------------------------------------------------------------- */
/* Serialisation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The on-disk form: two-space indented JSON with a trailing newline, exactly as
 * a document (`serialiseDoc`) and a record collection (`serialiseRecordFile`),
 * and written from what zod returned rather than from what the client sent — so
 * the file's key order is the schema's key order and a diff of a reordered nav
 * is a reordered nav, not a reshuffled file.
 */
export function serialiseSiteChrome(chrome: SiteChrome): string {
  return `${JSON.stringify(chrome, null, 2)}\n`;
}

/* -------------------------------------------------------------------------- */
/* The slot                                                                    */
/* -------------------------------------------------------------------------- */

export function siteChromeSlot(): Slot<SiteChrome> {
  return {
    label: SITE_CHROME_LABEL,
    contentPath: SITE_CHROME_PATH,
    draftPath: SITE_CHROME_DRAFT_PATH,
    parse: (text) => validateSiteChromeJson(text),
  };
}

/* -------------------------------------------------------------------------- */
/* Reading and writing                                                         */
/* -------------------------------------------------------------------------- */

export type SiteChromeRead = SlotRead<SiteChrome>;

export async function readSiteChrome(ctx: Ctx): Promise<SiteChromeRead> {
  return readSlot(ctx, siteChromeSlot());
}

/**
 * Save the nav and the footer as the draft. Validated here so the refusal names
 * the field, rather than at the `Slot` boundary where it would only say the file
 * does not parse.
 */
export async function writeSiteChromeDraft(
  ctx: Ctx,
  body: unknown,
  expected: ShaExpectation = undefined,
): Promise<WriteResult & { data: SiteChrome }> {
  const chrome = requireChrome(body);
  const write = await writeSlotDraft(
    ctx,
    siteChromeSlot(),
    serialiseSiteChrome(chrome),
    expected,
  );
  return { ...write, data: chrome };
}

export async function discardSiteChromeDraft(
  ctx: Ctx,
  expected: ShaExpectation = undefined,
): Promise<{ commit: string }> {
  return discardSlotDraft(ctx, siteChromeSlot(), expected);
}

export async function publishSiteChrome(
  ctx: Ctx,
  expected: ShaExpectation = undefined,
): Promise<WriteResult & { data: SiteChrome }> {
  const published = await publishSlot(ctx, siteChromeSlot(), expected);
  return { commit: published.commit, sha: published.sha, data: published.value };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A request body as a `SiteChrome`, or the 400 that says what is wrong with it.
 * The returned value is zod's, not the caller's, so what gets serialised has
 * the schema's key order and nothing the schema does not name.
 */
function requireChrome(body: unknown): SiteChrome {
  const result = validateSiteChrome(body);
  if (!result.ok) {
    throw badRequest(
      `That nav and footer do not validate:\n${formatIssues(result.issues)}`,
      'invalid_site_chrome',
    );
  }
  return result.data;
}
