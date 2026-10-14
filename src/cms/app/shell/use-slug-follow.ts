/**
 * src/cms/app/shell/use-slug-follow.ts
 *
 * Keeping a new page's address in step with its title.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A MOVE AND NOT AN EDIT
 * ---------------------------------------------------------------------------
 *
 * A document's slug is its file name — `src/content/pages/essays/<slug>.json`
 * — and the server refuses a document whose `meta.slug` is not the slug in
 * its path. So changing a slug is not a field edit, it is a file move, and a
 * file move is a commit. That is the whole reason the slug cannot simply
 * mirror the title as you type: it would be a commit per keystroke.
 *
 * So the move happens when a commit is being made anyway — on save — and
 * only while it is free:
 *
 *   never published   there is no address yet, so nothing can break
 *   slugFromTitle     the author has not taken the address over
 *
 * `slugToFollow` in schema.ts is that rule, and it is pure. This file is the
 * wiring: save first, then move.
 *
 * ---------------------------------------------------------------------------
 * SAVE FIRST, ALWAYS
 * ---------------------------------------------------------------------------
 *
 * Renaming reloads the entry from the repository, so anything not yet
 * written is gone. Moving before saving would lose exactly the edit that
 * prompted the move. The order is not negotiable and the check asserts it.
 *
 * A FAILED MOVE MUST NOT FAIL THE SAVE. The slug may be taken by another
 * page, the branch may have moved, the API may not support renaming at all.
 * None of that is a reason to tell someone their writing was not saved: it
 * was, under the name it had, and that is reported as a note rather than an
 * error.
 */

import { useCallback } from 'react';

import { slugToFollow } from '../../schema.ts';
import type { DocumentSectionId } from '../../schema.ts';
import type { DocStore } from '../state/store.ts';
import { useOptionalSiteStore } from '../state/use-site-store.ts';

export type SaveWithFollow = () => Promise<boolean>;

/**
 * Save, and then move the page to match its title if it should.
 *
 * Returns what the SAVE returned. The move is a refinement of a save that
 * has already succeeded; a caller deciding whether to publish next cares
 * about the save.
 */
export function useSaveWithSlugFollow(store: DocStore): SaveWithFollow {
  const siteStore = useOptionalSiteStore();

  return useCallback(async (): Promise<boolean> => {
    const saved = await store.save();
    if (!saved || siteStore === null) return saved;

    const state = store.getState();
    const wanted = slugToFollow(state.doc, state.published);
    if (wanted === null) return saved;

    const section = state.doc.meta.section;
    if (section === undefined || section === 'home') return saved;
    if (!siteStore.can(section).rename) return saved;

    const moved = await siteStore.renameEntry(section as DocumentSectionId, state.doc.meta.slug, wanted);
    if (!moved) {
      // `renameEntry` has already said why in the site store's notice. This
      // says the thing that notice cannot: the writing is safe.
      store.notify(
        'info',
        `Saved. The address is still /${section}/${state.doc.meta.slug}/ — it could not be moved to match the title, and you can set it yourself in the inspector.`,
      );
    }
    return saved;
  }, [store, siteStore]);
}
