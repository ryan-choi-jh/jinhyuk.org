/**
 * GET /api/cms/entries/[section]  ->  { ok, entries: EntrySummary[] }
 *
 * One section's list: every entry it holds, published or only drafted. A
 * section id that is not one of the five is a 404, which is what
 * `getSection(id) === null` is for.
 */

import type { APIRoute } from 'astro';
import { getEntries } from '../handlers.ts';
import { handle } from '../http.ts';

export const prerender = false;

export const GET: APIRoute = ({ cookies, params }) =>
  handle(async () => getEntries(cookies, params));
