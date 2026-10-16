import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutSea, similarity } from '../src/layout.js';
import { buildFixture } from '../src/fixture.js';

const { releases } = buildFixture();

test('layout is deterministic for a given seed', () => {
  const a = layoutSea(releases, { seed: 'seed-1' });
  const b = layoutSea(releases, { seed: 'seed-1' });
  assert.deepEqual([...a.placements.entries()], [...b.placements.entries()]);

  const other = layoutSea(releases, { seed: 'seed-2' });
  assert.notDeepEqual([...a.placements.entries()], [...other.placements.entries()]);
});

test('placements are integer grid cells without collisions', () => {
  const { placements } = layoutSea(releases, { seed: 'seed-1' });
  const seen = new Set();
  for (const [id, pos] of placements) {
    assert.ok(Number.isInteger(pos.x) && Number.isInteger(pos.y), `${id} not integer`);
    const cell = `${pos.x}~${pos.y}`;
    assert.ok(!seen.has(cell), `collision at ${cell}`);
    seen.add(cell);
  }
  assert.equal(placements.size, releases.length);
});

test('spatial neighbours are more similar than random pairs', () => {
  const { placements, similarity: sim } = layoutSea(releases, { seed: 'seed-1' });
  const rows = releases.map((r) => ({ r, pos: placements.get(r.id) }));

  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  let neighbourSum = 0;
  for (const row of rows) {
    const nearest = rows
      .filter((other) => other.r.id !== row.r.id)
      .sort((a, b) => distance(a.pos, row.pos) - distance(b.pos, row.pos))
      .slice(0, 3);
    for (const other of nearest) neighbourSum += sim(row.r, other.r);
  }
  const neighbourAvg = neighbourSum / (rows.length * 3);

  // Deterministic sample of 300 pseudo-random pairs.
  let randomSum = 0;
  for (let i = 0; i < 300; i += 1) {
    const a = rows[(i * 7 + 3) % rows.length];
    const b = rows[(i * 13 + 11) % rows.length];
    if (a.r.id === b.r.id) continue;
    randomSum += sim(a.r, b.r);
  }
  const randomAvg = randomSum / 300;

  assert.ok(
    neighbourAvg > randomAvg + 0.1,
    `neighbourAvg=${neighbourAvg.toFixed(3)} should exceed randomAvg=${randomAvg.toFixed(3)} by 0.1`,
  );
});

test('similarity is symmetric and bounded', () => {
  const [a, b, c] = releases;
  assert.equal(similarity(a, b), similarity(b, a));
  assert.ok(similarity(a, a) > 0.9);
  for (const x of releases) for (const y of releases) {
    const s = similarity(x, y);
    assert.ok(s >= 0 && s <= 1);
  }
  assert.notEqual(similarity(a, b), similarity(a, c));
});
