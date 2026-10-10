/**
 * GET /api/cms/sections  ->  { ok, sections: SectionSummary[] }
 *
 * The sidebar (docs/cms-contracts.md 11). Five rows, in the registry's own
 * order, each with how many entries it holds and whether anything in it is
 * drafted. Injected by astro.config.mjs; see routes/pages.ts for why no file
 * in this directory lives under src/pages/.
 */

import type { APIRoute } from 'astro';
import { getSections } from '../handlers.ts';
import { handle } from '../http.ts';

export const prerender = false;

export const GET: APIRoute = ({ cookies }) => handle(async () => getSections(cookies));
