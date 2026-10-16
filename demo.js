// Demo: prints the sea, then runs a sample play path.
// Run with: npm run demo

import { RadioSea, buildMusicMapFilterQuery, EMPTY_FILTER_STATE } from './src/engine.js';
import { buildFixture } from './src/fixture.js';
import { seededRand } from './src/rng.js';

const { releases, users, gems } = buildFixture();
const engine = new RadioSea({ releases, users, gems, seed: 'demo' });

// --- 1. the sea -----------------------------------------------------------

console.log('The sea (style initial per release at its x~y cell):\n');
const positions = releases.map((r) => ({ r, pos: engine.mapPlacement(r.id) }));
const xs = positions.map((p) => p.pos.x);
const ys = positions.map((p) => p.pos.y);
const minX = Math.min(...xs);
const maxX = Math.max(...xs);
const minY = Math.min(...ys);
const maxY = Math.max(...ys);

const STYLE_LETTERS = { techno: 'T', ambient: 'A', disco: 'S', jazz: 'J', dub: 'U', folk: 'F' };

const grid = Array.from({ length: maxY - minY + 1 }, () => Array(maxX - minX + 1).fill('·'));
for (const { r, pos } of positions) {
  grid[pos.y - minY][pos.x - minX] = STYLE_LETTERS[r.styles[0]] ?? '?';
}
for (const row of grid) console.log('  ' + row.join(' '));
console.log('\n  legend: T=techno A=ambient S=disco J=jazz U=dub F=folk');
console.log(`  rows = y ${minY}..${maxY}, cols = x ${minX}..${maxX}\n`);

console.log(`islands (${engine.islands.length}):`);
for (const island of engine.islands) {
  console.log(`  [${island.name}] ${island.memberIds.length} releases at ${island.centre.x}~${island.centre.y}`);
}

const deepest = [...engine.depths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
console.log('\ndeepest cuts (depth 0..1):');
for (const [id, depth] of deepest) {
  const release = engine.releases.find((r) => r.id === id);
  console.log(`  ${depth}  ${release.name} (${release.styles[0]}, ${release.year})`);
}

// --- 2. a play path -------------------------------------------------------

const rand = seededRand('demo-play');

// UI filter state -> filter query
const filter = buildMusicMapFilterQuery({
  ...EMPTY_FILTER_STATE,
  genres: ['disco'],
  bpmRange: [105, 125],
});
console.log('filter query:', filter);

const first = engine.withTopConditions(engine.getBanger({ filter }, { rand }));
console.log(`\nbanger pick -> ${first.name} (${first.styles[0]}, ${first.year}, ${first.country})`);
console.log(`  at ${engine.coordinatesString(first.id)}, top_conditions:`, first.top_conditions);

const second = engine.postSimilar({ current_release_id: first.id, filter }, { rand, excludeIds: [first.id] });
console.log(`similar next -> ${second.name} (${second.styles[0]}, ${second.year})`);

engine.postNavigationSuggestion({
  from_release_id: first.id,
  to_release_id: second.id,
  to_track_id: second.tracks[0].id,
});
const suggestions = engine.getNavigationSuggestions({ from_release_id: first.id });
console.log(`\nnavigation suggestions from ${first.name}:`);
for (const s of suggestions) {
  console.log(`  -> ${s.release_track.name} (track ${s.release_track.chosen_track_id})`);
}

console.log('\nauto trade routes (cross-island navigation candidates):');
for (const route of engine.tradeRoutes({ minScore: 0.15 }).slice(0, 3)) {
  const from = engine.releases.find((r) => r.id === route.from);
  const to = engine.releases.find((r) => r.id === route.to);
  console.log(`  ${route.score}  ${from.name}  ~>  ${to.name}`);
  console.log(`      why: ${engine.explain(route.from, route.to).reasons.join('; ')}`);
}

console.log('\ncommunity gems (top 5):');
for (const row of engine.getCommunityTracks({ limit: 5 })) {
  console.log(`  ${row.likes} gems  ${row.release_track.name}`);
}

console.log('\nartist radio pick:', engine.getEntityRadio(
  { resource: 'artists', id: releases[0].artistId },
  { rand },
)?.name);
