import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupTrackGenres, lookupGenresForPlays, topGenres, searchQuery } from '../src/catalog/genres.js';

const MCCOY = { id: 'artist-mccoy', name: 'McCoy Tyner' };
const credit = (artist) => [{ name: artist.name, joinphrase: '', artist }];
const RECORDING = { id: 'rec-1', title: 'My Favorite Things', 'artist-credit': credit(MCCOY), genres: [], length: 819400 };

// Fake MusicBrainz: routes are matched on the request path; unknown paths 404.
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    const path = url.replace('https://musicbrainz.org/ws/2', '');
    calls.push(path);
    const route = Object.entries(routes).find(([prefix]) => path.startsWith(prefix));
    if (!route) return { ok: false, status: 404, json: async () => ({}) };
    const body = route[1];
    if (typeof body === 'number') return { ok: false, status: body, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}
const fast = { pause: async () => {} };
const play = { artist: 'McCoy Tyner', title: 'My Favorite Things' };

test('topGenres keeps the most-voted genres', () => {
  assert.deepEqual(topGenres({ genres: [{ name: 'Jazz', count: 3 }, { name: 'hard bop', count: 5 },
    { name: 'modal jazz', count: 1 }, { name: 'post-bop', count: 2 }, { name: 'noise', count: 0 }] }),
  ['hard bop', 'jazz', 'post-bop']);
});

test('recording genres win; the ID from the tracklist is used directly', async () => {
  const { fetchImpl, calls } = fakeFetch({
    '/recording/rec-1': { ...RECORDING, genres: [{ name: 'jazz', count: 4 }, { name: 'hard bop', count: 2 }] },
  });
  const found = await lookupTrackGenres({ ...play, ids: { musicbrainz: 'rec-1' } }, { fetchImpl, ...fast });
  assert.deepEqual(found, { genres: ['jazz', 'hard bop'], source: 'recording', recording: 'rec-1', length: 819 });
  assert.equal(calls.length, 1);
});

test('untagged recordings fall back to the artist, looked up once per artist', async () => {
  const { fetchImpl, calls } = fakeFetch({
    '/recording/rec-1': RECORDING,
    '/artist/artist-mccoy': { ...MCCOY, genres: [{ name: 'jazz', count: 9 }, { name: 'post-bop', count: 4 }] },
  });
  const artistGenres = new Map();
  const options = { fetchImpl, artistGenres, ...fast };
  const first = await lookupTrackGenres({ ...play, ids: { musicbrainz: 'rec-1' } }, options);
  const second = await lookupTrackGenres({ ...play, ids: { musicbrainz: 'rec-1' } }, options);
  assert.deepEqual(first, { genres: ['jazz', 'post-bop'], source: 'artist', recording: 'rec-1', length: 819 });
  assert.deepEqual(second, first);
  assert.equal(calls.filter((c) => c.startsWith('/artist/')).length, 1);
});

test('ISRC is tried when there is no recording ID, then strict search', async () => {
  const withIsrc = fakeFetch({ '/isrc/USX1': { recordings: [{ id: 'rec-1', title: 'My Favorite Things' }] },
    '/recording/rec-1': { ...RECORDING, genres: [{ name: 'jazz', count: 1 }] } });
  assert.deepEqual((await lookupTrackGenres({ ...play, ids: { isrc: 'USX1' } }, { fetchImpl: withIsrc.fetchImpl, ...fast })).genres, ['jazz']);

  const bySearch = fakeFetch({ '/recording?query=': { recordings: [{ ...RECORDING, score: 100 }] },
    '/recording/rec-1': { ...RECORDING, genres: [{ name: 'jazz', count: 1 }] } });
  assert.deepEqual((await lookupTrackGenres(play, { fetchImpl: bySearch.fetchImpl, ...fast })).genres, ['jazz']);
  assert.ok(decodeURIComponent(bySearch.calls[0]).includes('recording:"My Favorite Things" AND artist:"McCoy Tyner"'));
});

test('a search hit for another artist or song is not accepted', async () => {
  const death = { id: 'artist-death-metal', name: 'Death' };
  const { fetchImpl } = fakeFetch({ '/recording?query=': { recordings: [
    { id: 'rec-x', score: 100, title: 'Zombie Ritual', 'artist-credit': credit(death) },
    { id: 'rec-y', score: 95, title: 'My Favorite Things', 'artist-credit': credit({ id: 'a2', name: 'Julie Andrews' }) },
    { id: 'rec-z', score: 60, title: 'My Favorite Things', 'artist-credit': credit(MCCOY) },
  ] } });
  assert.deepEqual(await lookupTrackGenres(play, { fetchImpl, ...fast }), { genres: [], source: null, recording: null, length: null });
});

test('entries saved before lengths were recorded are looked up again', async () => {
  const key = JSON.stringify(['mccoy tyner', 'my favorite things']);
  const result = await lookupGenresForPlays([play], { cache: { [key]: { genres: ['jazz'], source: 'artist', recording: 'rec-1' } },
    lookup: async () => ({ genres: ['jazz'], source: 'artist', recording: 'rec-1', length: 819 }) });
  assert.equal(result.total, 1);
  assert.equal(result.cache[key].length, 819);
});

test('search queries are escaped and use the primary artist', () => {
  assert.equal(searchQuery({ artist: 'T.I., Chris Brown', title: 'Say "Yes"' }), 'recording:"Say \\"Yes\\"" AND artist:"T.I."');
});

test('a failed request stops the run without caching a false "no genres"', async () => {
  const plays = [play, { artist: 'Death', title: 'Keep on Knocking' }];
  let checkpoints = 0;
  const lookup = async (p) => {
    if (p.artist === 'Death') throw new Error('MusicBrainz request failed (503)');
    return { genres: ['jazz'], source: 'artist', recording: 'rec-1', length: 200 };
  };
  const result = await lookupGenresForPlays(plays, { lookup, checkpoint: async () => { checkpoints += 1; } });
  assert.match(result.error.message, /503/);
  assert.equal(result.done, 1);
  assert.equal(Object.keys(result.cache).length, 1);
  assert.ok(checkpoints >= 1);

  const resumed = await lookupGenresForPlays(plays, { cache: result.cache,
    lookup: async () => ({ genres: ['proto-punk'], source: 'artist', recording: 'rec-2', length: null }) });
  assert.equal(resumed.error, null);
  assert.equal(resumed.total, 1, 'only the song that failed is looked up again');
  assert.equal(Object.keys(resumed.cache).length, 2);
});

test('a busy MusicBrainz (503) is retried with growing waits before giving up', async () => {
  const waits = [];
  let busy = 2;
  const fetchImpl = async () => (busy-- > 0
    ? { ok: false, status: 503, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => ({ ...RECORDING, genres: [{ name: 'jazz', count: 1 }] }) });
  const backoff = async (attempt) => { waits.push(attempt); };
  const found = await lookupTrackGenres({ ...play, ids: { musicbrainz: 'rec-1' } }, { fetchImpl, backoff, ...fast });
  assert.deepEqual(found.genres, ['jazz']);
  assert.deepEqual(waits, [0, 1]);

  const alwaysBusy = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(lookupTrackGenres({ ...play, ids: { musicbrainz: 'rec-1' } }, { fetchImpl: alwaysBusy, backoff, ...fast }), /503/);
  const brokenRequest = async () => ({ ok: false, status: 400, json: async () => ({}) });
  waits.length = 0;
  await assert.rejects(lookupTrackGenres({ ...play, ids: { musicbrainz: 'rec-1' } }, { fetchImpl: brokenRequest, backoff, ...fast }), /400/);
  assert.deepEqual(waits, [], 'only "busy" is retried');
});
