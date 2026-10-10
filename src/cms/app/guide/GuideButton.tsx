/**
 * src/cms/app/guide/GuideButton.tsx
 *
 * The top-bar trigger. Always there, whatever is on screen.
 *
 * It is drawn as the editor's own `.cms-btn`, re-declared in this directory's
 * stylesheet against the same `--cms-*` tokens rather than imported from the
 * shell, so it is pixel-identical in the toolbar and still correct alone in
 * the harness. See the note at the top of `styles.ts`.
 */

import { useGuideStyles } from './styles.ts';

export type GuideButtonProps = {
  onClick: () => void;
  /**
   * Show a word next to the mark. Leave it out for the 24px square ? that
   * matches the undo and redo buttons.
   */
  label?: string;
  /** The panel is open, so the button reads as pressed. */
  active?: boolean;
  title?: string;
  className?: string;
};

export function GuideButton({
  onClick,
  label,
  active = false,
  title = 'How this works',
  className,
}: GuideButtonProps) {
  useGuideStyles();

  const classes = ['cms-guide-btn'];
  if (label === undefined) classes.push('cms-guide-btn--icon');
  if (active) classes.push('cms-guide-btn--on');
  if (className !== undefined) classes.push(className);

  return (
    <button
      type="button"
      className={classes.join(' ')}
      title={title}
      aria-label={title}
      aria-expanded={active}
      aria-haspopup="dialog"
      data-testid="guide-button"
      onClick={onClick}
    >
      <span aria-hidden="true">?</span>
      {label !== undefined && <span>{label}</span>}
    </button>
  );
}
