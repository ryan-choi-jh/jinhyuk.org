/**
 * GET    /api/cms/entry/[section]/[slug]  ->  { ok, published, draft, ... }
 * DELETE /api/cms/entry/[section]/[slug]  ->  { ok, commit, slug, url }
 *
 * The collection form, and the unambiguous one: a project whose slug happens
 * to be a section id is only reachable here.
 */

import type { APIRoute } from 'astro';
import { deleteEntryPage, getEntry, sectionTarget } from '../handlers.ts';
import { handle } from '../http.ts';

export const prerender = false;

export const GET: APIRoute = ({ cookies, params }) =>
  handle(async () => getEntry(cookies, sectionTarget(params)));

/**
 * DELETE removes the page: the published file and its draft, in one commit.
 * On the ENTRY route rather than a path of its own, because unlike a rename
 * it really is an operation on this entry, and DELETE is what it means.
 */
export const DELETE: APIRoute = ({ cookies, params }) =>
  handle(async () => deleteEntryPage(cookies, params));
