import { fnv1aHash } from './fnv1a.js';

// Deterministic PRNG (mulberry32). Every "random" decision in the engine takes
// a rand() function so tests can pin behaviour by seeding.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededRand(seedText) {
  return mulberry32(fnv1aHash(String(seedText)));
}
