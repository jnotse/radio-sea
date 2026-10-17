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

test('optional link discovery reads recording URLs, video relationships and release IDs', async () => {
  const { fetchImpl, calls } = fakeFetch({ '/recording/rec-1': { ...RECORDING,
    genres: [{ name: 'jazz', count: 1 }],
    releases: [{ id: 'release-1' }, { id: 'release-1' }, { id: 'release-2' }],
    relations: [{ url: { resource: 'https://youtu.be/aaaaaaaaaaa' } },
      { url: { resource: 'https://evil.test/watch?v=bbbbbbbbbbb' } },
      { type: 'music video', recording: { id: 'video-recording' } }],
  } });
  const found = await lookupTrackGenres({ ...play, ids: { musicbrainz: 'rec-1' } }, { fetchImpl, ...fast, includeVideoLinks: true });
  assert.match(calls[0], /url-rels\+recording-rels/);
  assert.deepEqual(found.youtubeCandidates.map((c) => c.videoId), ['aaaaaaaaaaa']);
  assert.deepEqual(found.releaseIds, ['release-1', 'release-2']);
  assert.deepEqual(found.videoRecordings, ['video-recording']);
});

test('genre-only cache entries are upgraded for pending-song link discovery', async () => {
  const key = JSON.stringify(['mccoy tyner', 'my favorite things']);
  let calls = 0;
  const result = await lookupGenresForPlays([play], {
    cache: { [key]: { genres: ['jazz'], length: 819, recording: 'rec-1' } }, includeVideoLinks: true,
    lookup: async () => { calls++; return { genres: ['jazz'], length: 819, youtubeCandidates: [] }; },
  });
  assert.equal(calls, 1); assert.deepEqual(result.cache[key].youtubeCandidates, []);
});

test('extracts folksonomy tags, earliest release year, country, instruments and credits from MusicBrainz', async () => {
  const { fetchImpl } = fakeFetch({
    '/recording/rec-1': {
      ...RECORDING,
      'first-release-date': '1963-08',
      genres: [{ name: 'jazz', count: 4 }],
      tags: [{ name: 'modal jazz', count: 3 }, { name: 'seen live', count: 9 }, { name: 'spiritual', count: 2 }],
      releases: [{ country: 'XW', date: '2010' }, { country: 'US', date: '1963-08-01' }],
      relations: [
        { type: 'instrument', attributes: ['piano', 'Fender Rhodes'] },
        { type: 'producer', artist: { name: 'Bob Thiele' } },
      ],
    },
  });
  const found = await lookupTrackGenres({ ...play, ids: { musicbrainz: 'rec-1' } }, { fetchImpl, ...fast });
  assert.deepEqual(found.genres, ['jazz']);
  assert.deepEqual(found.tags, ['modal jazz', 'spiritual']);
  assert.equal(found.year, 1963);
  assert.equal(found.country, 'US');
  assert.deepEqual(found.instruments, ['piano', 'fender rhodes']);
  assert.deepEqual(found.credits, ['Bob Thiele']);
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
  const withIsrc = fakeFetch({ '/isrc/USX120000001': { recordings: [{ id: 'rec-1', title: 'My Favorite Things' }] },
    '/recording/rec-1': { ...RECORDING, genres: [{ name: 'jazz', count: 1 }] } });
  assert.deepEqual((await lookupTrackGenres({ ...play, ids: { isrc: 'USX120000001' } }, { fetchImpl: withIsrc.fetchImpl, ...fast })).genres, ['jazz']);

  const bySearch = fakeFetch({ '/recording?query=': { recordings: [{ ...RECORDING, score: 100 }] },
    '/recording/rec-1': { ...RECORDING, genres: [{ name: 'jazz', count: 1 }] } });
  assert.deepEqual((await lookupTrackGenres(play, { fetchImpl: bySearch.fetchImpl, ...fast })).genres, ['jazz']);
  assert.ok(decodeURIComponent(bySearch.calls[0]).includes('recording:"My Favorite Things" AND artist:"McCoy Tyner"'));
});

test('ISRCs written lowercase or hyphenated are normalized; malformed ones are skipped', async () => {
  const { fetchImpl, calls } = fakeFetch({ '/isrc/USY282016137': { recordings: [{ id: 'rec-1', title: 'My Favorite Things' }] },
    '/recording/rec-1': { ...RECORDING, genres: [{ name: 'jazz', count: 1 }] } });
  assert.deepEqual((await lookupTrackGenres({ ...play, ids: { isrc: 'usy-28-20-16137' } }, { fetchImpl, ...fast })).genres, ['jazz']);
  assert.ok(calls[0].startsWith('/isrc/USY282016137'));
  const skipped = fakeFetch({});
  await lookupTrackGenres({ ...play, ids: { isrc: 'not an isrc' } }, { fetchImpl: skipped.fetchImpl, ...fast });
  assert.ok(!skipped.calls.some((c) => c.startsWith('/isrc/')));
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
