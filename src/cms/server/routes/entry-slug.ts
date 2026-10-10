/**
 * GET /api/cms/entry/[section]/[slug]  ->  { ok, published, draft, ... }
 *
 * The collection form, and the unambiguous one: a project whose slug happens
 * to be a section id is only reachable here.
 */

import type { APIRoute } from 'astro';
import { getEntry, sectionTarget } from '../handlers.ts';
import { handle } from '../http.ts';

export const prerender = false;

export const GET: APIRoute = ({ cookies, params }) =>
  handle(async () => getEntry(cookies, sectionTarget(params)));
