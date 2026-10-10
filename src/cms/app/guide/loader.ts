/**
 * src/cms/app/guide/loader.ts
 *
 * Turn whatever is on disk into guide content, or fall back to the defaults.
 *
 * The guide is the thing you open when you do not know how the tool works.
 * It is the worst possible surface to let fail closed, so there is no path
 * through this file that throws and none that returns nothing. A missing
 * file, an empty file, a half-edited file, a file from a future version:
 * every one of them yields the built-in guide and a flag saying so.
 *
 * It takes raw input rather than reading a file itself, because this module
 * has to run in the browser, in the editor, and at build time, and none of
 * those three agree on what reading a file means.
 */

import { DEFAULT_GUIDE_CONTENT } from './content.ts';
import { validateGuideContent, validateGuideContentJson } from './schema.ts';
import type { GuideContent, GuideIssue } from './schema.ts';

export type LoadedGuide = {
  /** Always usable. The stored content, or the built-in one. */
  content: GuideContent;
  /** True when the stored content could not be used. */
  fellBack: boolean;
  /**
   * Why it fell back. Empty when `fellBack` is false, and empty when there
   * was simply nothing stored, which is not an error.
   */
  issues: GuideIssue[];
};

/**
 * `raw` may be:
 *
 *  - a JSON string, as read from a content file;
 *  - an already-parsed value, as handed over by an API;
 *  - null, undefined or an empty string, meaning nothing is stored yet.
 */
export function loadGuideContent(raw: unknown): LoadedGuide {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return { content: DEFAULT_GUIDE_CONTENT, fellBack: true, issues: [] };
  }

  const result = typeof raw === 'string' ? validateGuideContentJson(raw) : validateGuideContent(raw);
  if (result.ok) return { content: result.data, fellBack: false, issues: [] };
  return { content: DEFAULT_GUIDE_CONTENT, fellBack: true, issues: result.issues };
}

/** A fresh deep copy of the defaults, for the editor's reset. */
export function defaultGuideContent(): GuideContent {
  return structuredClone(DEFAULT_GUIDE_CONTENT);
}
