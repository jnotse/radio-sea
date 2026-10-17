import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupDeezer, lookupDeezerForPlays, deezerQuery, DeezerUnavailable } from '../src/catalog/deezer.js';

const TRACK = { id: 137844667, title: "God's Chest", duration: 125, bpm: 162.4, gain: -8.1, artist: { id: 1, name: 'Uranium Club' } };
const play = { artist: 'Uranium Club', title: "God's Chest" };
const fast = { pause: async () => {} };

// Fake Deezer: routes match the request path; unknown paths answer "no data".
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    const path = url.replace('https://api.deezer.com', '');
    calls.push(path);
    const route = Object.entries(routes).find(([prefix]) => path.startsWith(prefix));
    const body = route ? route[1] : { error: { type: 'DataException', message: 'no data', code: 800 } };
    if (typeof body === 'number') return { ok: false, status: body, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

test('the Deezer ID from the tracklist gives tempo, length and loudness', async () => {
  const { fetchImpl, calls } = fakeFetch({ '/track/137844667': TRACK });
  assert.deepEqual(await lookupDeezer({ ...play, ids: { deezer: 137844667 } }, { fetchImpl, ...fast }),
    { deezer: 137844667, bpm: 162, length: 125, gain: -8.1 });
  assert.equal(calls.length, 1);
});

test('an unknown tempo (0) stays unknown', async () => {
  const { fetchImpl } = fakeFetch({ '/track/isrc:GBHLW1603489': { ...TRACK, bpm: 0 } });
  const found = await lookupDeezer({ ...play, ids: { isrc: 'GBHLW1603489' } }, { fetchImpl, ...fast });
  assert.equal(found.bpm, null);
  assert.equal(found.length, 125);
});

test('without IDs, a strict search finds the track; other songs are refused', async () => {
  const { fetchImpl, calls } = fakeFetch({
    '/search?': { data: [{ ...TRACK, id: 9, title: 'Zombie Ritual', artist: { name: 'Death' } }, { ...TRACK, id: 137844667 }] },
    '/track/137844667': TRACK,
  });
  assert.equal((await lookupDeezer(play, { fetchImpl, ...fast })).deezer, 137844667);
  assert.ok(decodeURIComponent(calls[0]).includes(`artist:"Uranium Club" track:"God's Chest"`));
  const wrong = fakeFetch({ '/search?': { data: [{ ...TRACK, title: 'Another Song' }] } });
  assert.deepEqual(await lookupDeezer(play, { fetchImpl: wrong.fetchImpl, ...fast }), { deezer: null, bpm: null, length: null, gain: null });
});

test('a tracklist ID pointing at another song is not trusted', async () => {
  const { fetchImpl } = fakeFetch({ '/track/1': { ...TRACK, id: 1, title: 'Something Else', artist: { name: 'Someone' } } });
  assert.equal((await lookupDeezer({ ...play, ids: { deezer: 1 } }, { fetchImpl, ...fast })).deezer, null);
});

test('quota errors and outages are temporary, never "no data"', async () => {
  const quota = fakeFetch({ '/search?': { error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } } });
  await assert.rejects(lookupDeezer(play, { fetchImpl: quota.fetchImpl, ...fast }), DeezerUnavailable);
  const down = fakeFetch({ '/search?': 503 });
  await assert.rejects(lookupDeezer(play, { fetchImpl: down.fetchImpl, ...fast }), /503/);
  const offline = async () => { throw new Error('offline'); };
  await assert.rejects(lookupDeezer(play, { fetchImpl: offline, ...fast }), DeezerUnavailable);
});

test('a stopped run keeps what it found and resumes with the rest', async () => {
  const plays = [play, { artist: 'Death', title: 'Keep on Knocking' }];
  const first = await lookupDeezerForPlays(plays, { lookup: async (p) => {
    if (p.artist === 'Death') throw new DeezerUnavailable('quota');
    return { deezer: 1, bpm: 162, length: 125, gain: -8 };
  } });
  assert.equal(first.done, 1); assert.match(first.error.message, /quota/);
  const second = await lookupDeezerForPlays(plays, { cache: first.cache, lookup: async () => ({ deezer: 2, bpm: null, length: 180, gain: null }) });
  assert.equal(second.total, 1);
  assert.equal(Object.keys(second.cache).length, 2);
});

test('search queries drop quotes and use the primary artist', () => {
  assert.equal(deezerQuery({ artist: 'T.I., Chris Brown', title: 'Say "Yes"' }), 'artist:"T.I." track:"Say Yes"');
});
