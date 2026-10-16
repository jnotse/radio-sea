import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZigZagDiscovery, DEFAULT_CONDITIONS } from '../src/engine.js';
import { seededRand } from '../src/rng.js';
import { buildFixture } from '../src/fixture.js';

function makeEngine() {
  const { releases, users, gems } = buildFixture();
  return new ZigZagDiscovery({ releases, users, gems, seed: 'seed-1' });
}

test('coordinates round trip through the map', () => {
  const engine = makeEngine();
  const release = engine.releases[7];
  const coords = engine.coordinatesString(release.id);
  assert.match(coords, /^-?\d+~-?\d+$/);

  const [x, y] = coords.split('~').map(Number);
  assert.equal(engine.getReleaseByCoordinates({ x, y }).id, release.id);
  assert.equal(engine.getReleaseByCoordinates({ x: x + 500, y: y + 500 }), null);
});

test('reactions: toggling votes and top_conditions ordering', () => {
  const engine = makeEngine();
  const release = engine.releases[3];
  const trackId = release.tracks[0].id;

  for (const user of ['u1', 'u2', 'u3']) {
    engine.toggleReaction({ userId: user, releaseId: release.id, trackId, condition: 'banger' });
  }
  engine.toggleReaction({ userId: 'u1', releaseId: release.id, trackId, condition: 'crab' });
  engine.toggleReaction({ userId: 'u1', releaseId: release.id, trackId, condition: 'banger' }); // un-vote

  const top = engine.topConditions(release.id, trackId);
  assert.deepEqual(top.map((t) => t.condition), ['banger', 'crab']);
  assert.equal(top.find((t) => t.condition === 'banger').votes, 2);
  assert.equal(top.find((t) => t.condition === 'crab').votes, 1);

  const played = engine.withTopConditions(release);
  assert.equal(played.top_conditions.length, top.length);
  assert.ok(DEFAULT_CONDITIONS.includes('banger'));
});

test('navigation suggestions flow end to end', () => {
  const engine = makeEngine();
  const [from, to] = [engine.releases[0], engine.releases[20]];

  const id = engine.postNavigationSuggestion({
    from_release_id: from.id,
    to_release_id: to.id,
    to_track_id: to.tracks[1].id,
  });

  const rows = engine.getNavigationSuggestions({ from_release_id: from.id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].release_track.id, to.id);
  assert.equal(rows[0].release_track.chosen_track_id, to.tracks[1].id);

  assert.equal(engine.getNavigationSuggestions({ from_release_id: 0 }).length, 1);

  engine.deleteNavigationSuggestion(id);
  assert.equal(engine.getNavigationSuggestions({ from_release_id: from.id }).length, 0);
});

test('community charts rank by gems', () => {
  const engine = makeEngine();
  const rows = engine.getCommunityTracks({ limit: 5 });
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i - 1].likes >= rows[i].likes, 'rows must be sorted by likes desc');
  }
  assert.ok(rows.every((row) => row.release_track.id));
});

test('play path: filter -> banger -> similar -> navigation suggestion', () => {
  const engine = makeEngine();
  const rand = seededRand('play-path');

  // 1. the user filters the sea (UI state -> API query)
  const filter = { styles_in: ['disco'], bpm_min: 105, bpm_max: 125 };

  // 2. "banger" pick under those filters, with its top conditions
  const first = engine.withTopConditions(engine.getBanger({ filter }, { rand }));
  assert.ok(first.styles.includes('disco'));

  // 3. "similar" keeps the session going, avoiding the just-played track
  const second = engine.postSimilar(
    { current_release_id: first.id, filter },
    { rand, excludeIds: [first.id] },
  );
  assert.ok(second !== null);
  assert.ok(second.styles.includes('disco'));

  // 4. the user curates the path for others
  engine.postNavigationSuggestion({
    from_release_id: first.id,
    to_release_id: second.id,
    to_track_id: second.tracks[0].id,
  });
  const suggestions = engine.getNavigationSuggestions({ from_release_id: first.id });
  assert.equal(suggestions[0].release_track.id, second.id);
});

test('shufflePick never repeats a recent track while alternatives exist', () => {
  const engine = makeEngine();
  const rand = seededRand('shuffle-e2e');
  const recent = engine.releases.slice(0, engine.releases.length - 1).map((r) => r.id);
  const pick = engine.shufflePick({ recentIds: recent, rand });
  assert.equal(pick.id, engine.releases[engine.releases.length - 1].id);
});
