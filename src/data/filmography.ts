// Short films, newest first.
//
// `id` is the YouTube video ID. The poster frame lives at
// public/filmography/<id>.jpg so the page can show the film without loading a
// YouTube player until someone actually clicks.
export interface Film {
  id: string;
  title: string;
  note?: string;
  kind: string;
  year: string;
}

export const films: Film[] = [
  {
    id: 'EudrajWcwwg',
    title: 'Untitled',
    note: 'Incomplete film. Written, directed and edited. Shot in Royal Leamington Spa.',
    kind: 'SHORT FILM',
    year: '2019',
  },
  {
    id: '6SUlwRLFuCc',
    title: 'The Space Race',
    note: 'Role: Perseus. Featured on UCL Film Festival, directed by Dominic Blondel.',
    kind: 'SHORT FILM',
    year: '2019',
  },
  {
    id: '2jiXj6uOuDs',
    title: 'The Space Race (Trailer)',
    kind: 'TRAILER',
    year: '2019',
  },
  {
    id: 'i98vcdfRUqE',
    title: 'The Getaway',
    note: 'Role: Tom. Best Film at the BFTen Short Film Competition, directed by Patrick Brine.',
    kind: 'SHORT FILM',
    year: '2018',
  },
];
