/**
 * src/cms/app/shell/use-shortcuts.ts
 *
 * WS-3. Keyboard shortcuts: undo, redo, save.
 *
 * The important part is what it does NOT do. TipTap has its own undo stack for
 * the block being typed in, and stealing ⌘Z from a focused editor would undo a
 * band reorder while someone is mid-sentence. So every shortcut is skipped
 * when focus is inside an input, a textarea, a select or a contenteditable.
 */

import { useEffect } from 'react';

/**
 * Everything a shortcut needs. Widened by WS-D from `DocStore` to this, so the
 * record editor gets the same three keys from the same code: `DocStore` and
 * `RecordStore` both satisfy it, and nothing that passed before stops passing.
 */
export type ShortcutTarget = {
  undo(): boolean;
  redo(): boolean;
  save(): Promise<boolean>;
};

export function useShortcuts(store: ShortcutTarget, enabled = true): void {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.defaultPrevented) return;
      if (isTextEntry(event.target)) return;

      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (key === 'y') {
        event.preventDefault();
        store.redo();
        return;
      }
      if (key === 's') {
        event.preventDefault();
        void store.save();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [store, enabled]);
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
