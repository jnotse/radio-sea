import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCatalogue } from '../src/catalog/resolve.js';
import { playToRaw } from '../scripts/build-demo.js';
import { buildSimilarity } from '../src/mapping/embed.js';
import { clusterReleases } from '../src/mapping/cartography.js';
import { explainSimilarity } from '../src/explain.js';

// One real guest set: The Lot Radio lists these genres for the whole show,
// while most of what was played is jazz, soul and proto-punk.
const SHOW_GENRES = ['Jazz', 'Drum & Bass', 'UK Garage', 'Reggae'];
let videos = 0;
function play(artist, title, extra = {}) {
  const videoId = `vid${String(++videos).padStart(8, '0')}`;
  return {
    station: 'lotradio', show: 'Special Guests', date: '2026-10-15', artist, title,
    sourceUrl: 'https://www.thelotradio.com/shows/special-guests/2026-10-15-1800',
    showGenres: SHOW_GENRES, youtube: { videoId, url: `https://www.youtube.com/watch?v=${videoId}` }, ...extra,
  };
}
const build = (plays) => {
  const { releases } = mergeCatalogue(plays.map(playToRaw));
  const similarity = buildSimilarity(releases);
  return { releases, similarity, islands: clusterReleases(releases, similarity) };
};

test("a show's genres are context, never the track's genre or an island name", () => {
  const { releases, similarity, islands } = build([
    play('McCoy Tyner', 'My Favorite Things'),
    play('Death', 'Keep on Knocking'),
    play('Nolan Porter', 'If I Could Only Be Sure'),
  ]);
  for (const release of releases) {
    assert.ok(!release.styles.includes('Drum & Bass'), 'show genres must not become track styles');
    assert.ok(release.tags.all.includes('show-genre:Drum & Bass'));
  }
  // Nothing else is known, so the tracks stay together as one set, named honestly.
  assert.equal(islands.length, 1);
  assert.deepEqual([islands[0].name, islands[0].basis], ['Special Guests', 'show']);
  const why = explainSimilarity(releases[0], releases[1], similarity).reasons;
  assert.ok(why.includes('played on the same show: Special Guests'));
  assert.ok(!why.some((reason) => reason.startsWith('shared tags')));
});

test("per-track genres split a mixed set and name islands after what the tracks are", () => {
  const { islands } = build([
    play('McCoy Tyner', 'My Favorite Things', { genres: ['jazz', 'hard bop'] }),
    play('Chico Hamilton', 'Gengis', { genres: ['jazz', 'hard bop'] }),
    play('Death', 'Keep on Knocking', { genres: ['proto-punk', 'punk'] }),
    play('Death', 'The Change', { genres: ['proto-punk', 'punk'] }),
  ]);
  const islandOf = (artist) => islands.find((island) => island.members.some((m) => m.artist === artist));
  assert.equal(islandOf('McCoy Tyner'), islandOf('Chico Hamilton'));
  assert.notEqual(islandOf('McCoy Tyner'), islandOf('Death'));
  assert.deepEqual([islandOf('McCoy Tyner').name, islandOf('McCoy Tyner').basis], ['hard bop', 'sound']);
  assert.ok(islands.every((island) => !/drum/i.test(island.name)));
});

test('an island only claims a genre that at least half its tracks have', () => {
  const { islands } = build([
    play('A', 'One', { genres: ['jazz'] }),
    play('B', 'Two'),
    play('C', 'Three'),
  ]);
  const island = islands.find((i) => i.members.length > 1);
  assert.equal(island.basis, 'show');
  assert.equal(island.name, 'Special Guests');
});

test('a mixed set whose tracks mostly have genres is named after its two commonest, not the show', () => {
  const { islands } = build([
    play('A', 'One', { genres: ['soul', 'house'] }),
    play('B', 'Two', { genres: ['soul', 'disco'] }),
    play('C', 'Three', { genres: ['soul'] }),
    play('D', 'Four', { genres: ['house'] }),
    play('E', 'Five', { genres: ['funk'] }),
    play('F', 'Six'),
    play('G', 'Seven'),
  ]);
  assert.equal(islands.length, 1);
  assert.deepEqual([islands[0].name, islands[0].basis], ['soul & house', 'mixed']);
});

test('episodes of one show get distinct island names; station HTML entities are decoded', () => {
  const other = { date: '2026-10-16', showGenres: ['Ambient'], sourceUrl: 'https://www.thelotradio.com/shows/special-guests/2026-10-16-1100' };
  const { islands } = build([
    play('A', 'One'), play('B', 'Two'),
    play('C', 'Three', other), play('D', 'Four', other),
  ]);
  assert.deepEqual(islands.map((i) => i.name).sort(), ['Special Guests · 15 Oct', 'Special Guests · 16 Oct']);
  const [release] = mergeCatalogue([playToRaw(play('E', 'Five', { show: 'Low Life w/ A &amp; B' }))]).releases;
  assert.equal(release.show, 'Low Life w/ A & B');
});

test('unknown tempo, year, label or country never adds similarity', () => {
  const { releases, similarity } = build([
    play('A', 'One', { genres: ['deep house'] }),
    play('B', 'Two', { genres: ['doo wop'], station: 'nts', show: 'Other', showGenres: ['Doo Wop'] }),
  ]);
  assert.equal(similarity(releases[0], releases[1]), 0);
});
