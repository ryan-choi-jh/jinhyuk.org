/**
 * src/cms/assets/matrix.ts
 *
 * The specs verify.ts checks and fingerprint.ts hashes. One list, imported by
 * both, so the two can never drift apart and quietly stop comparing the same
 * thing.
 *
 * The sizes are chosen to be awkward: a 2px high rule, a 1100x70 banner, a
 * taller-than-wide box, a 36px thumbnail, and one deliberately fractional box
 * because a canvas editor resizing by drag does not produce round numbers.
 */

import { seedFromId } from '../schema.ts';
import type { ShapeSpec } from '../schema.ts';
import { SHAPE_KINDS } from './shapes.ts';

export const SIZES: readonly [number, number][] = [
  [420, 2],
  [120, 48],
  [300, 160],
  [900, 220],
  [80, 300],
  [40, 40],
  [1100, 70],
  [36, 36],
  [600, 30],
  [240, 240],
  [317.4567, 164.5],
];

export const STROKES: readonly number[] = [0.5, 1, 2, 3, 5, 8];

export const SEEDS: readonly number[] = ['i_a', 'i_b', 'i_c', 'i_d', 'i_e'].map(seedFromId);

export function verificationMatrix(): ShapeSpec[] {
  const specs: ShapeSpec[] = [];
  for (const shape of SHAPE_KINDS) {
    for (const [width, height] of SIZES) {
      for (const strokeWidth of STROKES) {
        for (const seed of SEEDS) {
          specs.push({ shape, width, height, color: '#111111', strokeWidth, seed });
          if (shape === 'rect') {
            specs.push({
              shape,
              width,
              height,
              color: '#111111',
              strokeWidth,
              seed,
              radius: 14,
              fill: '#6aa3e022',
            });
          }
          if (shape === 'ellipse') {
            specs.push({
              shape,
              width,
              height,
              color: '#111111',
              strokeWidth,
              seed,
              fill: '#5cb98a22',
            });
          }
        }
      }
    }
  }
  return specs;
}

/** FNV-1a over a list of drawings. Short, stable, and enough to compare processes. */
export function fingerprint(drawings: readonly string[]): string {
  let value = 0x811c9dc5;
  const joined = drawings.join('');
  for (let index = 0; index < joined.length; index += 1) {
    value ^= joined.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(16);
}
