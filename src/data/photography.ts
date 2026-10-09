// Photography albums.
//
// Empty on purpose. While this list has nothing in it the page shows the
// empty state (the illustration and the "currently developing" note) instead
// of a grid. Add an entry here and the grid comes back on its own — no page
// changes needed.
//
// To add one: drop images into public/photography/<slug>/ and set `cover` to
// the one you want on this page.
export interface Album {
  title: string;
  year: string;
  /** Path to the cover image, e.g. '/photography/ocean-beach/cover.jpg'. */
  cover?: string;
}

export const albums: Album[] = [];
