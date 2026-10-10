/**
 * src/cms/assets/fingerprint.ts
 *
 * Prints a hash of the whole verification matrix. verify.ts runs this in a
 * second node process and compares: determinism inside one process proves
 * nothing about a module that caches, reads a clock, or seeds itself at import.
 */

import { generateShape } from './shapes.ts';
import { fingerprint, verificationMatrix } from './matrix.ts';

console.log(fingerprint(verificationMatrix().map((spec) => generateShape(spec))));
