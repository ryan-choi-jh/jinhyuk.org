/**
 * src/cms/site-icons.ts
 *
 * Every drawing in the site's chrome: the footer's social icons, and the sun
 * and moon in the theme toggle.
 *
 * `src/content/data/site.json` stores an icon as a KEY — `github`, `x`,
 * `email` — and never as path data, so that editing the footer is choosing from
 * a list rather than pasting a bezier. This file is the other half of that
 * bargain: the one place the artwork lives, keyed by exactly the five names
 * `SOCIAL_ICONS` in `./schema.ts` names. The theme toggle is the same bargain
 * with one fewer choice: `site.json` says whether it is shown, this file says
 * what it looks like.
 *
 * It is imported by both ends on purpose:
 *
 *   src/components/SocialLinks.astro       the published footer
 *   src/layouts/Base.astro                 the published theme toggle
 *   src/cms/app/chrome/chrome-view.tsx     the editor's own scenery
 *
 * so the icons in the editor are the icons on the site, and adding a sixth one
 * is one entry here plus one name in `SOCIAL_ICONS`.
 *
 * Deliberately plain: types and data, no React, no zod, no DOM. It is pulled
 * into the static site build, where anything heavier would be dead weight.
 *
 * Every path is drawn to fill its own `viewBox` and is filled with
 * `currentColor`, so the colour comes from the page and the size from CSS.
 */

import type { SocialIcon } from './schema.ts';

export type SocialIconArt = {
  /** The icon's own coordinate system. Not all five are 24x24. */
  viewBox: string;
  /** A single `<path d="...">`. One path per icon, so one `<path>` draws it. */
  path: string;
};

/**
 * The five icons, exactly as they were drawn in the hardcoded footer this
 * replaced (the former `links` array in `src/components/SocialLinks.astro`).
 * Nothing here is new artwork.
 */
export const SOCIAL_ICON_ART: Readonly<Record<SocialIcon, SocialIconArt>> = {
  github: {
    viewBox: '0 0 24 24',
    path: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  },
  linkedin: {
    viewBox: '0 0 24 24',
    path: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z',
  },
  x: {
    viewBox: '0 0 24 24',
    path: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z',
  },
  youtube: {
    viewBox: '0 0 24 24',
    path: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
  },
  email: {
    viewBox: '0 0 16 16',
    path: 'M.05 3.555A2 2 0 0 1 2 2h12a2 2 0 0 1 1.95 1.555L8 8.414zM0 4.697v7.104l5.803-3.558zM6.761 8.83l-6.57 4.027A2 2 0 0 0 2 14h12a2 2 0 0 0 1.808-1.144l-6.57-4.027L8 9.586zm3.436-.586L16 11.801V4.697z',
  },
};

/**
 * What to call each icon in a picker, and the name a new link gets when it is
 * chosen. Not part of the stored shape: `SocialLink.name` is editable, because
 * it is the accessible label and may want to be "Ryan on X" rather than "X".
 */
export const SOCIAL_ICON_LABELS: Readonly<Record<SocialIcon, string>> = {
  github: 'GitHub',
  linkedin: 'LinkedIn',
  x: 'X',
  youtube: 'YouTube',
  email: 'Email',
};

/** The artwork for a key. Total over `SocialIcon`, so there is no fallback. */
export function socialIconArt(icon: SocialIcon): SocialIconArt {
  return SOCIAL_ICON_ART[icon];
}

/* -------------------------------------------------------------------------- */
/* The theme toggle                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The sun and the moon in the top-right control.
 *
 * Here for the same reason the social icons are: `site.json` says whether the
 * toggle is SHOWN, never what it looks like, so the drawing has to live
 * somewhere that both the published page and the editor's scenery can reach.
 * Before this, the two SVGs were written out longhand in
 * `src/layouts/Base.astro` and the editor drew a grey pill in their place.
 *
 * These are STROKED outlines, not filled silhouettes, so unlike a social icon
 * they are not one `<path d>`: the sun is a circle plus a path of eight rays,
 * and the two shapes do not take the same attributes. Hence `parts`, a
 * discriminated union carrying exactly the attributes each element is drawn
 * with — so a renderer emits the same element the hardcoded toggle did, rather
 * than a lossy approximation of it.
 */
export type ThemeIconPart =
  | { shape: 'circle'; cx: string; cy: string; r: string }
  | { shape: 'path'; d: string; linecap?: 'round'; linejoin?: 'round' };

/** The two halves of the control. Not a theme name: `system` has no icon. */
export const THEME_ICONS = ['light', 'dark'] as const;

export type ThemeIconKey = (typeof THEME_ICONS)[number];

export type ThemeIconArt = {
  viewBox: string;
  /** The button's accessible name. One copy, so the two ends cannot differ. */
  label: string;
  /**
   * Every part carries `fill="none" stroke="currentColor" stroke-width="2"`;
   * a renderer applies those to all of them rather than repeating them here.
   */
  parts: readonly ThemeIconPart[];
};

export const THEME_ICON_ART: Readonly<Record<ThemeIconKey, ThemeIconArt>> = {
  light: {
    viewBox: '0 0 24 24',
    label: 'Light theme',
    parts: [
      { shape: 'circle', cx: '12', cy: '12', r: '4.5' },
      {
        shape: 'path',
        d: 'M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
        linecap: 'round',
      },
    ],
  },
  dark: {
    viewBox: '0 0 24 24',
    label: 'Dark theme',
    parts: [
      {
        shape: 'path',
        d: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
        linecap: 'round',
        linejoin: 'round',
      },
    ],
  },
};

/** The artwork for a half. Total over `ThemeIconKey`, so there is no fallback. */
export function themeIconArt(key: ThemeIconKey): ThemeIconArt {
  return THEME_ICON_ART[key];
}
