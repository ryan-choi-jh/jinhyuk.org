/**
 * src/cms/app/chrome/index.ts
 *
 * The nav bar and the footer, as the rest of the editor sees them.
 *
 *   <SiteChromeProvider>   holds the one copy, and loads/saves/publishes it
 *   <SiteChromePanel>      edits it (mounted in the Home editor's inspector)
 *   <SiteChromeView>       draws it, inert, around the page in the middle pane
 *
 * `./edits.ts` is the pure half and is importable on its own.
 */

export { SiteChromeProvider, siteChromeApiFrom, useSiteChrome, useSiteChromeOptional } from './context.tsx';
export type {
  SiteChromeApi,
  SiteChromeNotice,
  SiteChromePhase,
  SiteChromeProviderProps,
  SiteChromeState,
  SiteChromeStore,
} from './context.tsx';
export { SiteChromePanel } from './SiteChromePanel.tsx';
export { SiteChromeView } from './chrome-view.tsx';
export type { SiteChromeViewProps } from './chrome-view.tsx';
