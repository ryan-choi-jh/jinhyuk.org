/**
 * src/cms/app/guide/index.ts
 *
 * Everything the rest of the CMS should import from this directory.
 *
 * The whole module is self-contained: it imports React and zod and nothing
 * else from the app, takes no store, fetches nothing, and reads no document.
 *
 * Showing the guide:
 *
 *   const guide = useGuide();
 *   const { content } = loadGuideContent(storedJsonOrNull);
 *   <GuideButton onClick={guide.toggle} active={guide.open} />
 *   <GuideOverlay open={guide.open} onClose={guide.hide} content={content} />
 *
 * Editing it:
 *
 *   <GuideEditor content={draft} onChange={setDraft} />
 */

export { GuideOverlay } from './GuideOverlay.tsx';
export type { GuideOverlayProps } from './GuideOverlay.tsx';

export { GuidePanel } from './GuidePanel.tsx';
export type { GuidePanelProps } from './GuidePanel.tsx';

export { GuideButton } from './GuideButton.tsx';
export type { GuideButtonProps } from './GuideButton.tsx';

export { GuideEditor } from './GuideEditor.tsx';
export type { GuideEditorProps } from './GuideEditor.tsx';

export { useGuide } from './use-guide.ts';
export type { Guide, UseGuideOptions } from './use-guide.ts';

export { Hint } from './Hint.tsx';
export type { HintProps } from './Hint.tsx';

/* Content model */
export {
  GUIDE_CONTENT_VERSION,
  GuideCardSchema,
  GuideContentSchema,
  GuideIdSchema,
  GuideRowSchema,
  formatGuideIssues,
  newGuideCard,
  newGuideId,
  newGuideRow,
  rowIsKeyCap,
  validateGuideContent,
  validateGuideContentJson,
} from './schema.ts';
export type {
  GuideCard,
  GuideContent,
  GuideIssue,
  GuideRow,
  GuideValidateResult,
} from './schema.ts';

export { defaultGuideContent, loadGuideContent } from './loader.ts';
export type { LoadedGuide } from './loader.ts';

export { DEFAULT_GUIDE_CONTENT, GUIDE_CARDS, GUIDE_LEAD, GUIDE_TITLE } from './content.ts';

export * as guideEdits from './edits.ts';

export { GUIDE_CSS, GUIDE_STYLE_ID, useGuideStyles } from './styles.ts';
export { GUIDE_SEEN_KEY, clearFlag, readFlag, writeFlag } from './storage.ts';
export type { FlagState } from './storage.ts';
