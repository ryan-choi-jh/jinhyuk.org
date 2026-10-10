/**
 * src/cms/app/shell/index.ts
 *
 * WS-3. Public surface of the editor shell. WS-8 should import from here and
 * from `../state/index.ts`, and should not need to touch anything else in this
 * directory.
 */

export { EditorShell, defaultPreviewUrl } from './editor-shell.tsx';
export type { EditorShellProps, PreviewContext } from './editor-shell.tsx';

export type {
  CanvasBandSlotProps,
  EditorShellSlots,
  InspectorSlotProps,
  ProseBlockSlotProps,
  ToolbarSlotProps,
} from './slots.ts';

export { PageSurface, groupBands } from './page-surface.tsx';
export type { PageSurfaceProps, Zoom } from './page-surface.tsx';

export { BandOutline } from './band-outline.tsx';
export type { BandOutlineProps } from './band-outline.tsx';

export { Inspector } from './inspector.tsx';
export type { InspectorProps } from './inspector.tsx';

export { Toolbar, ZOOM_CHOICES } from './toolbar.tsx';
export type { ToolbarProps } from './toolbar.tsx';

export { SHELL_CSS, SHELL_STYLE_ID, useShellStyles } from './styles.ts';
export { UNSAVED_MESSAGE, useUnsavedChangesGuard } from './use-unsaved-changes.ts';
export type { UnsavedChangesGuard } from './use-unsaved-changes.ts';
export { useShortcuts } from './use-shortcuts.ts';
export type { ShortcutTarget } from './use-shortcuts.ts';

/* -------------------------------------------------------------------------- */
/* WS-D: the navigation shell                                                  */
/* -------------------------------------------------------------------------- */

export { SiteShell } from './site-shell.tsx';
export type { SiteShellProps } from './site-shell.tsx';

export { SectionSidebar } from './section-sidebar.tsx';
export type { SectionSidebarProps } from './section-sidebar.tsx';

export { EntryList } from './entry-list.tsx';
export type { EntryListProps } from './entry-list.tsx';

export { RecordView, defaultRecordPreviewUrl } from './record-view.tsx';
export type { RecordPreviewContext, RecordViewProps } from './record-view.tsx';

export { RecordStub } from './record-stub.tsx';

export type {
  RecordEditorSlotProps,
  RecordToolbarSlotProps,
  SiteShellSlots,
} from './site-slots.ts';

export { SITE_CSS, SITE_STYLE_ID, useSiteStyles } from './site-styles.ts';
