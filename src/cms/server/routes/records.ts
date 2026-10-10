/**
 * GET    /api/cms/records/[section]  ->  { ok, published: RecordFile|null, draft: ... }
 * PUT    /api/cms/records/[section]  body: RecordFile    ->  { ok, commit }
 * POST   /api/cms/records/[section]  body: { op, ... }   ->  { ok, commit, data }
 * DELETE /api/cms/records/[section]                      ->  { ok }
 *
 * One file is one commit, so a record collection has no per-entry endpoints
 * (docs/cms-contracts.md 11, note 1): adding, editing, deleting and reordering
 * are all a write of the whole file with a different array.
 *
 * PUT takes that array from the client. POST asks the server to do it —
 * `{ op: 'reorder', keys: [...] }`, `{ op: 'move', key, to }`, `add`, `update`,
 * `delete` — so that the read, the permute and the write happen inside one
 * request and a reorder cannot drop a film another tab just added. Both write
 * the draft; `POST /api/cms/publish/<section>` moves it into the published
 * tree.
 */

import type { APIRoute } from 'astro';
import { deleteRecords, getRecords, postRecordOp, putRecords } from '../handlers.ts';
import { handle } from '../http.ts';

export const prerender = false;

export const GET: APIRoute = ({ cookies, params }) =>
  handle(async () => getRecords(cookies, params));

export const PUT: APIRoute = ({ cookies, params, request }) =>
  handle(async () => putRecords(cookies, request, params));

export const POST: APIRoute = ({ cookies, params, request }) =>
  handle(async () => postRecordOp(cookies, request, params));

export const DELETE: APIRoute = ({ cookies, params, request }) =>
  handle(async () => deleteRecords(cookies, request, params));
