/**
 * src/cms/app/state/index.ts
 *
 * WS-3. Public surface of the state layer. WS-8 should import from here.
 *
 * Extended by WS-D with the phase 2 layer above the document store: the
 * section-aware API (`SiteApi`), where in the site we are (`CmsRoute`), the
 * record collection store, and the navigation store that owns both. Everything
 * phase 1 exported is unchanged and still exported from the same place.
 */

export type {
  AuthStatus,
  CmsApi,
  CommitResult,
  MediaUploadResult,
  OkResult,
  PageDocs,
  PageSummary,
} from './api.ts';
export { CmsApiError, apiErrorMessage } from './api.ts';

export { createStubApi } from './stub-api.ts';
export type { StubApi, StubApiOptions, StubCall, StubPage } from './stub-api.ts';

export {
  NO_SELECTION,
  describeSelection,
  isBandSelected,
  isBlockSelected,
  isItemSelected,
  primaryItemId,
  pruneSelection,
  resolveSelection,
  sameSelection,
  selectBand,
  selectBlock,
  selectItems,
  selectedItemIds,
  selectionBandId,
} from './selection.ts';
export type { ResolvedSelection, Selection } from './selection.ts';

export * as docOps from './doc-ops.ts';
export {
  NEW_CANVAS_HEIGHT,
  bandChildCount,
  bandIndexOf,
  bandReservedHeight,
  blockPlainText,
  cloneDoc,
  convertProseContent,
  createCanvasBand,
  createProseBand,
  createProseBlock,
  deepEqual,
  docsEqual,
  dropIndexToTargetIndex,
  findBand,
  normalizeDoc,
  sanitizeShapeKeys,
} from './doc-ops.ts';

export { COALESCE_MS, HISTORY_LIMIT } from './history.ts';
export type { CommitOptions, History } from './history.ts';

export { createDocStore } from './store.ts';
export type { DocStore, DocStoreOptions, DocStoreState, EditOptions, Notice, StorePhase } from './store.ts';

export {
  DocStoreProvider,
  useDocStore,
  useDocStoreSelector,
  useOptionalStore,
  useStore,
} from './use-doc-store.ts';

/* -------------------------------------------------------------------------- */
/* WS-D: the whole site                                                        */
/* -------------------------------------------------------------------------- */

export { canDeleteEntry, documentApiFor, mediaSlugFor } from './site-api.ts';
export type { EntrySummary, RecordDocs, SectionSummary, SiteApi } from './site-api.ts';

export { createStubSiteApi } from './site-stub-api.ts';
export type { StubEntry, StubSiteApi, StubSiteApiOptions, StubSiteCall } from './site-stub-api.ts';

export {
  CMS_ROOT,
  OVERVIEW,
  cmsRouteHref,
  createBrowserNavigator,
  createMemoryNavigator,
  entryRoute,
  parseCmsRoute,
  resolveRoute,
  sameRoute,
} from './route.ts';
export type { CmsRoute, Navigator, ResolvedRoute, RouteView } from './route.ts';

export { copyTitle, createDocFor, duplicateDoc, todayIso, uniqueSlug } from './entries.ts';

export { copyEntry, createRecordStore, freshEntry, normalizeEntry, recordEntryKey } from './record-store.ts';
export type {
  RecordEditOptions,
  RecordPatch,
  RecordStore,
  RecordStoreOptions,
  RecordStoreState,
} from './record-store.ts';

export { createSiteStore, currentRecordFile, registrySectionSummaries } from './site-store.ts';
export type {
  EditorBinding,
  EntryCapabilities,
  SiteStore,
  SiteStoreOptions,
  SiteStorePhase,
  SiteStoreState,
} from './site-store.ts';

export {
  RecordStoreProvider,
  SiteStoreProvider,
  useOpenRecordStore,
  useOptionalRecordStore,
  useOptionalSiteStore,
  useRecordStore,
  useRecordStoreSelector,
  useSiteStore,
  useSiteStoreSelector,
  useSiteStoreState,
} from './use-site-store.ts';
