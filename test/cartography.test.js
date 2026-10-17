import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RadioSeaDiscovery } from '../src/engine.js';
import { buildSimilarity } from '../src/mapping/embed.js';
import { clusterReleases, mapCatalogue } from '../src/mapping/cartography.js';
import { tradeRoutes } from '../src/mapping/routes.js';
import { explainSimilarity } from '../src/explain.js';
import { buildFixture } from '../src/fixture.js';

const { releases, users, gems } = buildFixture();
const similarity = buildSimilarity(releases);

test('islands emerge from the data: one per sound, not per label or era', () => {
  const islands = clusterReleases(releases, similarity);
  assert.ok(islands.length >= 4 && islands.length <= releases.length / 2);

  for (const island of islands) {
    const dominant = island.members[0].styles[0];
    const sameSound = island.members.filter((m) => m.styles[0] === dominant);
    assert.ok(
      sameSound.length / island.members.length >= 0.8,
      `island ${island.name} mixes unrelated sounds`,
    );
  }
});

test('mapCatalogue is deterministic per seed and places everything uniquely', () => {
  const a = mapCatalogue(releases, similarity, { seed: 'world-1' });
  const b = mapCatalogue(releases, similarity, { seed: 'world-1' });
  assert.deepEqual([...a.placements.entries()], [...b.placements.entries()]);

  const cells = new Set();
  for (const [id, pos] of a.placements) {
    assert.ok(Number.isInteger(pos.x) && Number.isInteger(pos.y), `${id} not integer`);
    cells.add(`${pos.x}~${pos.y}`);
  }
  assert.equal(cells.size, releases.length, 'no two releases may share a cell');
});

test('dense 2D groves keep markers apart and keep unrelated groves separate', () => {
  const dense = Array.from({ length: 72 }, (_, i) => ({
    id: `dense-${i}`, artist: `Artist ${i}`, styles: [i < 48 ? 'jazz' : 'punk'], year: 1970 + i % 30,
  }));
  const sim = (a, b) => a.styles[0] === b.styles[0] ? 1 : 0;
  const { placements, islands } = mapCatalogue(dense, sim);
  assert.equal(islands.length, 2);
  for (const a of dense) {
    const pa = placements.get(a.id);
    const others = dense.filter((b) => b.id !== a.id).map((b) => ({
      b, distance: Math.hypot(pa.x - placements.get(b.id).x, pa.y - placements.get(b.id).y),
    })).sort((a, b) => a.distance - b.distance);
    assert.ok(others[0].distance >= 3, `${a.id}: markers must have breathing room`);
    assert.equal(others[0].b.styles[0], a.styles[0], 'nearest song stays in the same grove');
  }
});

test('rich TDA descriptors change 3D analysis without rearranging the 2D map or trails', () => {
  const base = new RadioSeaDiscovery({ releases, seed: 'independent-map' });
  const enriched = releases.map((r, i) => ({
    ...r,
    tags: { all: [...(r.tags?.all ?? r.styles), `inst:instrument-${i % 3}`, `credit:producer-${i % 2}`,
      'format:12"', 'channel:Shared curator', 'city:London'] },
    radioPlays: [{ station: 'radio', show: 'Shared set', sourceUrl: 'https://radio.example/set', position: i }],
    tracks: r.tracks.map((t) => ({ ...t, brightness: i % 2, pulseClarity: i % 3 / 2 })),
  }));
  const rich = new RadioSeaDiscovery({ releases: enriched, seed: 'independent-map' });
  assert.deepEqual(rich.islands, base.islands);
  assert.deepEqual(rich.placements, base.placements);
  assert.deepEqual(rich.depths, base.depths);
  assert.deepEqual(rich.tradeRoutes(), base.tradeRoutes());
  assert.notDeepEqual(rich.topology.coordinates, base.topology.coordinates, 'rich signals still inform 3D');
});

test('the sea preserves meaning: neighbours are more similar than random pairs', () => {
  const { placements } = mapCatalogue(releases, similarity, { seed: 'world-1' });
  const rows = releases.map((r) => ({ r, pos: placements.get(r.id) }));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  let neighbourSum = 0;
  for (const row of rows) {
    const nearest = rows
      .filter((other) => other.r.id !== row.r.id)
      .sort((x, y) => dist(x.pos, row.pos) - dist(y.pos, row.pos))
      .slice(0, 3);
    for (const other of nearest) neighbourSum += similarity(row.r, other.r);
  }
  const neighbourAvg = neighbourSum / (rows.length * 3);

  let randomSum = 0;
  let count = 0;
  for (let i = 0; i < 300; i += 1) {
    const a = rows[(i * 7 + 3) % rows.length];
    const b = rows[(i * 13 + 11) % rows.length];
    if (a.r.id === b.r.id) continue;
    randomSum += similarity(a.r, b.r);
    count += 1;
  }
  const randomAvg = randomSum / count;

  assert.ok(
    neighbourAvg > randomAvg + 0.1,
    `neighbourAvg=${neighbourAvg.toFixed(3)} vs randomAvg=${randomAvg.toFixed(3)}`,
  );
});

test('depth marks deep cuts: isolated releases score higher', () => {
  const { depths } = mapCatalogue(releases, similarity, { seed: 'world-1' });
  for (const [, depth] of depths) assert.ok(depth >= 0 && depth <= 1);

  // The fixture's jazz cluster spans unusual keys/eras; compare each release's
  // depth against its mean similarity to everything else.
  const rows = releases.map((r) => {
    const meanSim =
      releases.reduce((sum, other) => (other.id === r.id ? sum : sum + similarity(r, other)), 0) /
      (releases.length - 1);
    return { id: r.id, meanSim, depth: depths.get(r.id) };
  });
  rows.sort((a, b) => a.meanSim - b.meanSim);
  assert.ok(rows[0].depth > rows[rows.length - 1].depth, 'most isolated release must be deepest');
});

test('trade routes cross islands and are ranked', () => {
  const { islands } = mapCatalogue(releases, similarity, { seed: 'world-1' });
  const routes = tradeRoutes(releases, similarity, { islands, minScore: 0.25 });
  assert.ok(routes.length > 0);

  for (const route of routes) {
    assert.notEqual(route.fromIsland, route.toIsland, 'routes must cross open sea');
  }
  for (let i = 1; i < routes.length; i += 1) {
    assert.ok(routes[i - 1].score >= routes[i].score, 'routes must be sorted by score');
  }
  const keys = new Set(routes.map((r) => [r.from, r.to].sort().join('>')));
  assert.equal(keys.size, routes.length, 'no duplicate routes');
});

test('explanations name the actual shared signals', () => {
  const a = releases.find((r) => r.styles[0] === 'techno');
  const b = releases.find((r) => r.id !== a.id && r.styles.includes('techno'));
  const c = releases.find((r) => r.styles[0] === 'folk');

  const ab = explainSimilarity(a, b, similarity);
  assert.ok(ab.reasons.some((reason) => reason.startsWith('shared tags')));
  assert.ok(ab.score > 0.5);

  const ac = explainSimilarity(a, c, similarity);
  assert.ok(ac.score < ab.score, 'cross-genre pairs must explain worse');
});

test('engine exposes the whole pipeline together', () => {
  const engine = new RadioSeaDiscovery({ releases, users, gems, seed: 'world-1' });
  assert.ok(engine.islands.length >= 4);
  assert.ok(engine.islandOf(releases[0].id) !== null);
  assert.ok(engine.depthOf(releases[0].id) >= 0);
  assert.ok(engine.explain(releases[0].id, releases[1].id).reasons.length > 0);
  assert.ok(engine.tradeRoutes({ minScore: 0.25 }).length > 0);
});
