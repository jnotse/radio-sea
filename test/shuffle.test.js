import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawRandomTrack, pickRandomExcluding, shufflePick } from '../src/shuffle.js';

const pool = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}` }));
const readAtOffset = (offset) => pool[offset] ?? null;

test('pickRandomExcluding skips recent ids when alternatives exist', () => {
  const picked = pickRandomExcluding(pool, ['t0', 't1', 't2', 't3'], () => 0.99);
  assert.equal(picked.id, 't4');
});

test('pickRandomExcluding falls back to the whole pool when everything is excluded', () => {
  const picked = pickRandomExcluding(pool, ['t0', 't1', 't2', 't3', 't4'], () => 0);
  assert.ok(picked !== null);
});

test('pickRandomExcluding returns null for an empty pool', () => {
  assert.equal(pickRandomExcluding([], [], () => 0), null);
});

test('drawRandomTrack retries up to 3 draws and avoids recent ids', () => {
  // rand() sequence picks offsets 0, 1, 2 -> t0 excluded, t1 excluded, t2 ok.
  const rands = [0.01, 0.21, 0.41];
  let i = 0;
  const rand = () => rands[i++];
  const picked = drawRandomTrack({
    totalTracks: 5,
    readAtOffset,
    excludeIds: ['t0', 't1'],
    rand,
  });
  assert.equal(picked.id, 't2');
});

test('drawRandomTrack keeps the first draw as fallback when all draws are recent', () => {
  const rands = [0.01, 0.21, 0.41];
  let i = 0;
  const rand = () => rands[i++];
  const picked = drawRandomTrack({
    totalTracks: 5,
    readAtOffset,
    excludeIds: ['t0', 't1', 't2', 't3', 't4'],
    rand,
  });
  assert.equal(picked.id, 't0'); // fallback: first draw
});

test('shufflePick skips the remote draw when the pool covers the playlist', () => {
  let reads = 0;
  const picked = shufflePick({
    pool,
    totalTracks: 5,
    readAtOffset: (offset) => {
      reads += 1;
      return pool[offset] ?? null;
    },
    recentIds: ['t0', 't1', 't2', 't3'],
    rand: () => 0.99,
  });
  assert.equal(reads, 0, 'no remote reads expected when the pool is complete');
  assert.equal(picked.id, 't4');
});

test('shufflePick draws remotely when the pool is only a slice', () => {
  const slice = pool.slice(0, 2);
  const picked = shufflePick({
    pool: slice,
    totalTracks: 5,
    readAtOffset,
    recentIds: ['t0'],
    rand: () => 0.41, // offset 2 -> t2, not recent
  });
  assert.equal(picked.id, 't2');
});

test('shufflePick returns null for an empty pool and zero total', () => {
  assert.equal(shufflePick({ pool: [], totalTracks: 0, readAtOffset: () => null }), null);
});
