// Photography albums.
//
// PLACEHOLDERS. These are stand-ins so the page has shape — none of them have
// real photographs behind them yet. To make one real, drop images into
// public/photography/<slug>/ and set `cover` to the one you want on this page.
export interface Album {
  title: string;
  year: string;
  /** Path to the cover image, e.g. '/photography/ocean-beach/cover.jpg'. */
  cover?: string;
}

export const albums: Album[] = [
  { title: 'Ocean Beach', year: '2026' },
  { title: 'Seoul & Busan', year: '2025' },
  { title: 'Marin Headlands', year: '2026' },
  { title: 'Jeju', year: '2025' },
  { title: 'Daejeon', year: '2024' },
  { title: 'Leamington Spa', year: '2019' },
];
