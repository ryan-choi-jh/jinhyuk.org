/**
 * src/cms/server/verify-moves.ts
 *
 * The redirect bookkeeping behind a rename, with no network.
 *
 *   node src/cms/server/verify-moves.ts
 *
 * `renameEntry` itself talks to GitHub and is exercised by the end-to-end
 * harnesses. `withRedirect` is the part that is pure, easy to get wrong, and
 * invisible when it is: nobody notices a broken redirect until someone
 * follows an old link, and by then it is a 404 with no clue attached.
 *
 * The case it exists for is the chain. Rename A to B, then B to C, and the
 * naive list leaves `/A -> /B` pointing at a page that no longer exists.
 */

import { withRedirect } from './moves.ts';

let passed = 0;
const failures: string[] = [];
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1;
  else failures.push(`${name}${detail === '' ? '' : `\n      ${detail}`}`);
}
const show = (list: readonly { from: string; to: string }[]): string =>
  list.map((r) => `${r.from}>${r.to}`).join(' ');

{
  const one = withRedirect([], '/essays/old/', '/essays/new/');
  ok('a rename records the old address', show(one) === '/essays/old/>/essays/new/', show(one));
}

{
  // A to B, then B to C. /A must end up pointing at /C, not at /B.
  const a = withRedirect([], '/essays/a/', '/essays/b/');
  const b = withRedirect(a, '/essays/b/', '/essays/c/');
  ok(
    'a second rename repoints the first, rather than chaining',
    show(b) === '/essays/a/>/essays/c/ /essays/b/>/essays/c/',
    show(b),
  );
  ok('…and every target is the page that exists', b.every((r) => r.to === '/essays/c/'), show(b));
}

{
  // Renaming back to a name that used to exist must not leave a redirect
  // from the live page to itself, which would be a loop.
  const a = withRedirect([], '/essays/a/', '/essays/b/');
  const back = withRedirect(a, '/essays/b/', '/essays/a/');
  ok('renaming back drops the redirect that would loop', !back.some((r) => r.from === '/essays/a/'), show(back));
  ok('…and leaves the other way round', show(back) === '/essays/b/>/essays/a/', show(back));
}

{
  const same = withRedirect([], '/essays/a/', '/essays/a/');
  ok('a rename to the same name records nothing', same.length === 0, show(same));
}

{
  const existing = [{ from: '/essays/x/', to: '/essays/y/' }];
  const added = withRedirect(existing, '/projects/p/', '/projects/q/');
  ok('an unrelated entry is left alone', added.length === 2 && added[0]?.to === '/essays/y/', show(added));
  ok('the input is not mutated', existing.length === 1);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  process.exitCode = 1;
}
