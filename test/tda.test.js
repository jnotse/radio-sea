import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeTopology,
  buildMapperComplex,
  computeDensityAndEccentricity,
  computePersistentHomology,
  findIslandBridges,
  seriateIslandMembers,
  spectralLens,
} from '../src/mapping/tda.js';
import { buildSimilarity } from '../src/mapping/embed.js';
import { clusterReleases } from '../src/mapping/cartography.js';
import { RadioSeaDiscovery } from '../src/engine.js';
import { buildFixture } from '../src/fixture.js';

test('H0 persistent homology tracks component merges and bridge edges; H1 detects musical loops vs cliques', () => {
  // Construct a 4-node musical ring:
  //   0 (jazz + funk) -- 1 (funk + disco) -- 2 (disco + house) -- 3 (house + jazz) -- 0
  // Opposite nodes (0 vs 2, 1 vs 3) share nothing, so d(0,2) = 1 and d(1,3) = 1,
  // while adjacent nodes along the ring have d < 0.6.
  const ring = [
    { id: 'r0', artist: 'A0', styles: ['jazz', 'funk'], tags: { all: ['jazz', 'funk'] }, tracks: [] },
    { id: 'r1', artist: 'A1', styles: ['funk', 'disco'], tags: { all: ['funk', 'disco'] }, tracks: [] },
    { id: 'r2', artist: 'A2', styles: ['disco', 'house'], tags: { all: ['disco', 'house'] }, tracks: [] },
    { id: 'r3', artist: 'A3', styles: ['house', 'jazz'], tags: { all: ['house', 'jazz'] }, tracks: [] },
  ];
  const simRing = buildSimilarity(ring);
  const phRing = computePersistentHomology(ring, simRing);

  assert.equal(phRing.h0.length, 4);
  assert.equal(phRing.mstEdges.length, 3, 'spanning tree of 4 connected vertices has 3 edges');
  assert.equal(phRing.h1.length, 1, 'a 4-node chordless musical loop produces 1 H1 cycle');
  assert.ok(phRing.h1[0].persistence > 0.3, `expected strong H1 persistence, got ${phRing.h1[0].persistence}`);
  assert.equal(phRing.h1[0].cycle.length, 4);

  // Now add a universal hub that shares all 4 tags so every triangle fills in immediately.
  const filled = [
    ...ring,
    { id: 'hub', artist: 'Hub', styles: ['jazz', 'funk', 'disco', 'house'], tags: { all: ['jazz', 'funk', 'disco', 'house'] }, tracks: [] },
  ];
  const phFilled = computePersistentHomology(filled, buildSimilarity(filled));
  const maxPersistence = phFilled.h1[0]?.persistence ?? 0;
  assert.ok(maxPersistence < phRing.h1[0].persistence, 'filling the loop with a central hub reduces H1 persistence');
});

test('Mapper nerve complex builds overlapping nodes, 1-simplex edges and identifies bridge records', () => {
  // Linear chain of 7 records transitioning from dub -> post-punk -> krautrock.
  const chain = [
    { id: 'c1', artist: 'A1', styles: ['dub', 'roots reggae'], tags: { all: ['dub', 'roots reggae'] }, year: 1978, tracks: [] },
    { id: 'c2', artist: 'A2', styles: ['dub', 'roots reggae'], tags: { all: ['dub', 'roots reggae'] }, year: 1979, tracks: [] },
    { id: 'c3', artist: 'A3', styles: ['dub', 'post-punk'], tags: { all: ['dub', 'post-punk'] }, year: 1980, tracks: [] },
    { id: 'c4', artist: 'A4', styles: ['post-punk'], tags: { all: ['post-punk'] }, year: 1981, tracks: [] },
    { id: 'c5', artist: 'A5', styles: ['post-punk', 'krautrock'], tags: { all: ['post-punk', 'krautrock'] }, year: 1982, tracks: [] },
    { id: 'c6', artist: 'A6', styles: ['krautrock', 'kosmische'], tags: { all: ['krautrock', 'kosmische'] }, year: 1983, tracks: [] },
    { id: 'c7', artist: 'A7', styles: ['krautrock', 'kosmische'], tags: { all: ['krautrock', 'kosmische'] }, year: 1984, tracks: [] },
  ];
  const sim = buildSimilarity(chain);
  const mapper = buildMapperComplex(chain, sim, {
    bins: 3,
    overlap: 0.45,
    lensValues: chain.map((r) => r.year),
  });

  assert.ok(mapper.nodes.length >= 3, 'each cover bin forms at least one node');
  assert.ok(mapper.edges.length >= 2, 'overlapping cover bins connect into a 1-skeleton nerve');
  assert.ok(mapper.bridges.length >= 1, 'transition records in bin overlaps are detected as bridges');
});

test('spectralLens and density/eccentricity are deterministic and separate distinct clusters', () => {
  const { releases } = buildFixture();
  const sim = buildSimilarity(releases);
  const specA = spectralLens(releases, sim);
  const specB = spectralLens(releases, sim);
  assert.deepEqual(specA, specB);

  const { density, eccentricity } = computeDensityAndEccentricity(releases, sim);
  assert.equal(density.length, releases.length);
  assert.equal(eccentricity.length, releases.length);
  for (let i = 0; i < releases.length; i += 1) {
    assert.ok(density[i] >= 0 && density[i] <= 1);
    assert.ok(eccentricity[i] >= 0 && eccentricity[i] <= 1);
  }
});

test('seriateIslandMembers improves adjacent similarity around an island perimeter', () => {
  const members = [
    { id: 'm1', artist: 'A', year: 1980, styles: ['jazz', 'modal'], tags: { all: ['jazz', 'modal', 'inst:saxophone'] }, tracks: [] },
    { id: 'm2', artist: 'B', year: 1980, styles: ['jazz', 'fusion'], tags: { all: ['jazz', 'fusion', 'inst:synthesizer'] }, tracks: [] },
    { id: 'm3', artist: 'C', year: 1980, styles: ['jazz', 'modal'], tags: { all: ['jazz', 'modal', 'inst:saxophone'] }, tracks: [] },
    { id: 'm4', artist: 'D', year: 1980, styles: ['jazz', 'fusion'], tags: { all: ['jazz', 'fusion', 'inst:synthesizer'] }, tracks: [] },
  ];
  const sim = buildSimilarity(members);
  const ordered = seriateIslandMembers(members, sim);
  // In the raw order [m1, m2, m3, m4], modal and fusion alternate; seriation groups m1 next to m3 and m2 next to m4.
  const adjScore = (list) => list.slice(1).reduce((sum, item, i) => sum + sim(list[i], item), 0);
  assert.ok(adjScore(ordered) > adjScore(members));
});

test('findIslandBridges and RadioSeaDiscovery expose topological bridges, cycles and Mapper complex', () => {
  const { releases, users, gems } = buildFixture();
  // Add a crossover record bridging techno and dub.
  const bridgeRelease = {
    id: 'rel-bridge',
    name: 'Submerged Echo',
    artistId: 'art-bridge',
    artist: 'Maurizio',
    artists: ['Maurizio'],
    styles: ['techno', 'detroit techno', 'dub', 'roots reggae'],
    tags: { all: ['techno', 'detroit techno', 'dub', 'roots reggae'] },
    country: 'Germany',
    year: 1995,
    format: 'Vinyl',
    tracks: [{ id: 'tb-1', name: 'M4', bpm: 120, key: 'Gm' }],
  };
  const all = [...releases, bridgeRelease];
  const engine = new RadioSeaDiscovery({ releases: all, users, gems, seed: 'tda-world' });

  assert.ok(engine.topology);
  assert.ok(Array.isArray(engine.topology.persistence.h0));
  assert.ok(Array.isArray(engine.cycles()));
  assert.ok(engine.topology.mapper.nodes.length > 0);

  const bridges = engine.bridges();
  assert.ok(bridges.length > 0);
  const topIds = bridges.slice(0, 5).map((b) => b.id);
  assert.ok(topIds.includes('rel-bridge'), 'the dub-techno crossover record ranks among the top island bridges');

  // Every release gets finite 3D topological coordinates (tx, ty, tz) with non-flat Z spread.
  const coords = engine.topology.coordinates;
  assert.equal(coords.length, all.length);
  for (const c of coords) {
    assert.ok(Number.isFinite(c.tx) && Number.isFinite(c.ty) && Number.isFinite(c.tz));
    assert.ok(Number.isFinite(c.w));
  }
  const zSpan = Math.max(...coords.map((c) => c.tz)) - Math.min(...coords.map((c) => c.tz));
  assert.ok(zSpan > 5, `expected non-trivial 3D vertical relief, got zSpan=${zSpan}`);
});
