import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RadioSea } from '../src/engine.js';
import { seededRand } from '../src/rng.js';
import { buildFixture } from '../src/fixture.js';

function makeEngine() {
  const { releases, users, gems } = buildFixture();
  return new RadioSea({ releases, users, gems, seed: 'seed-1' });
}

test('related excludes the current release, respects limit, ranks by score', () => {
  const engine = makeEngine();
  const rows = engine.getRelated({ current_release_id: 'rel-001', limit: 5 });

  assert.equal(rows.length, 5);
  assert.ok(rows.every((row) => row.release_track.id !== 'rel-001'));
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i - 1].score >= rows[i].score, 'scores must be sorted desc');
  }
  assert.equal(rows[0].release_track.chosen_track_id, rows[0].release_track.tracks[0].id);
});

test('related honours filters', () => {
  const engine = makeEngine();
  const rows = engine.getRelated({
    current_release_id: 'rel-001',
    limit: 10,
    filter: { styles_in: ['jazz'] },
  });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.release_track.styles.includes('jazz')));
});

test('similar returns one filtered pick and avoids recent ids', () => {
  const engine = makeEngine();
  const rand = seededRand('similar-1');
  const pick = engine.postSimilar(
    { current_release_id: 'rel-001', filter: { styles_in: ['jazz'] } },
    { rand, excludeIds: [] },
  );
  assert.ok(pick !== null);
  assert.ok(pick.styles.includes('jazz'));
  assert.notEqual(pick.id, 'rel-001');

  const excludeIds = engine.releases.filter((r) => r.id !== pick.id).map((r) => r.id);
  const forced = engine.postSimilar(
    { current_release_id: 'rel-001', filter: { styles_in: ['jazz'] } },
    { rand: seededRand('similar-2'), excludeIds },
  );
  assert.equal(forced.id, pick.id, 'when everything else is excluded, the pick is forced');
});

test('banger respects filters', () => {
  const engine = makeEngine();
  const pick = engine.getBanger(
    { filter: { styles_in: ['dub'] } },
    { rand: seededRand('banger-1') },
  );
  assert.ok(pick.styles.includes('dub'));

  const impossible = engine.getBanger({ filter: { styles_in: ['k-pop'] } }, { rand: seededRand('banger-2') });
  assert.equal(impossible, null);
});

test('banger is weighted by gems and reaction votes', () => {
  const engine = makeEngine();
  // Make one release overwhelmingly popular.
  const favourite = engine.releases[0];
  for (let u = 0; u < 50; u += 1) {
    engine.gems.push({ userId: `extra-${u}`, releaseId: favourite.id, trackId: favourite.tracks[0].id });
    engine.toggleReaction({
      userId: `extra-${u}`,
      releaseId: favourite.id,
      trackId: favourite.tracks[0].id,
      condition: 'banger',
    });
  }

  const rand = seededRand('banger-dist');
  let hits = 0;
  const draws = 200;
  for (let i = 0; i < draws; i += 1) {
    const pick = engine.getBanger({}, { rand });
    if (pick.id === favourite.id) hits += 1;
  }
  assert.ok(hits > draws / 2, `expected the favourite to dominate, got ${hits}/${draws}`);
});

test('radio narrows by entity, style, country and gem_only', () => {
  const engine = makeEngine();
  const artistId = engine.releases[0].artistId;
  const pool = engine.releases.filter((r) => r.artistId === artistId);
  const style = pool[1].styles[0];

  const pick = engine.getEntityRadio({ resource: 'artists', id: artistId }, { rand: seededRand('radio-1') });
  assert.equal(pick.artistId, artistId);

  const styled = engine.getEntityRadio(
    { resource: 'artists', id: artistId, style },
    { rand: seededRand('radio-2') },
  );
  assert.ok(styled.styles.includes(style));

  const country = pool[0].country;
  const landed = engine.getEntityRadio(
    { resource: 'artists', id: artistId, country },
    { rand: seededRand('radio-3') },
  );
  assert.equal(landed.country, country);

  const gemmed = engine.getEntityRadio(
    { resource: 'artists', id: artistId, gem_only: true },
    { rand: seededRand('radio-4') },
  );
  assert.ok(engine.state.gemCount(gemmed.id) > 0);

  const empty = engine.getEntityRadio({ resource: 'artists', id: 'art-none' }, { rand: seededRand('radio-5') });
  assert.equal(empty, null);

  assert.throws(() => engine.getEntityRadio({ resource: 'podcasts', id: 'x' }), /unknown radio resource/);
});

test('randomGem only returns the user s own gems', () => {
  const engine = makeEngine();
  const userId = engine.users[0].id;
  for (let i = 0; i < 20; i += 1) {
    const gem = engine.getRandomGem(userId, { rand: seededRand(`gem-${i}`) });
    assert.equal(gem.userId, userId);
  }
  assert.equal(engine.getRandomGem('usr-none', { rand: seededRand('gem-none') }), null);
});
