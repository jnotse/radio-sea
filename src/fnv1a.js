// FNV-1a 32-bit hash.
// Used wherever we need a stable, seedable hash (layout jitter, ids, PRNG seeds).
export const FNV_OFFSET_BASIS = 2166136261;
export const FNV_PRIME = 16777619;

export function fnv1aHash(text, seed = FNV_OFFSET_BASIS) {
  let hash = seed;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), FNV_PRIME);
  }
  return hash >>> 0;
}

export function fnv1aHashHex(text) {
  return fnv1aHash(text).toString(16).padStart(8, '0');
}
