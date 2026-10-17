import { test } from 'node:test';
import assert from 'node:assert/strict';
import { songKey, newRadioCandidates, extendRadioCache } from '../src/catalog/extend.js';

const play = (title, show = 'One', station = 'nts') => ({ artist: 'Example Artist', title,
  station, show, sourceUrl: `https://example.com/${station}/${show}` });
const match = (p) => ({ title: `${p.artist} - ${p.title}`, channel: p.artist,
  videoId: 'VxuNvoiel2g', url: 'https://www.youtube.com/watch?v=VxuNvoiel2g', confirmed: true });

test('incremental candidate selection keeps version identity and skips accepted/attempted songs', () => {
  const a = play('Song 1'), b = play('Song 2'), remix = play('Song 1 (Remix)');
  const cache = { plays: [a, b, remix, { ...remix, station: 'lotradio' }],
    resolved: [{ ...a, youtube: match(a) }], attemptedKeys: [songKey(b)] };
  assert.deepEqual(newRadioCandidates(cache), [remix]);
  assert.notEqual(songKey(a), songKey(remix));
});

test('catalogue expansion samples different episodes instead of exhausting the first show', () => {
  const a = play('A'), b = play('B'), c = play('C', 'Two'), d = play('D', 'Three', 'lotradio');
  assert.deepEqual(newRadioCandidates({ plays: [a, b, c, d] }, 3), [a, c, d]);
  assert.deepEqual(newRadioCandidates({ plays: [] }), []);
});

test('a source-specific extension does not consume the lookup budget on other sources', () => {
  const a = play('A'), b = play('B', 'Shuffle', 'radiooooo');
  assert.deepEqual(newRadioCandidates({ plays: [a, b] }, 10, ['radiooooo']), [b]);
});

test('extension appends verified songs, keeps existing songs and leaves the input cache unchanged', async () => {
  const old = play('Old Song'), fresh = play('Fresh Song'), missing = play('Missing Song');
  const cache = { plays: [old, fresh, missing], resolved: [{ ...old, youtube: match(old) }], dropped: 2 };
  let checkpointCount = 0;
  const { cache: expanded, added, attempted } = await extendRadioCache(cache, {
    resolvePlay: async (p) => p.title === fresh.title ? match(p) : null,
    checkpoint: async () => checkpointCount++,
  });
  assert.equal(added, 1); assert.equal(attempted, 2);
  assert.deepEqual(expanded.resolved.map((p) => p.title), ['Old Song', 'Fresh Song']);
  assert.equal(expanded.dropped, 3); assert.equal(checkpointCount, 1);
  assert.equal(cache.resolved.length, 1); assert.equal(cache.dropped, 2);
  assert.deepEqual(newRadioCandidates(expanded), [], 'next run does not repeat failed lookups');
});

test('an unrelated video is excluded, and a failed lookup is never counted as one', async () => {
  const a = play('Song A'), b = play('Song B');
  const waits = [];
  const result = await extendRadioCache({ plays: [a, b], resolved: [] }, {
    resolvePlay: async (p) => {
      if (p.title === b.title) throw new Error('YouTube is limiting requests from this address');
      return { ...match(p), title: 'A monitor review', channel: 'Tech reviews' };
    },
    backoffs: [10, 20], pause: async (ms) => { waits.push(ms); },
  });
  assert.equal(result.added, 0); assert.equal(result.cache.resolved.length, 0);
  assert.equal(result.cache.dropped, 1, 'only the unrelated video counts as excluded');
  assert.deepEqual(waits, [10, 20], 'backs off before giving up');
  assert.match(result.stopped.message, /limiting/);
  assert.deepEqual(newRadioCandidates(result.cache), [b], 'the failed song is retried on the next run');
});

test('after backing off, a lookup that succeeds carries on with the scan', async () => {
  const a = play('Song A'), b = play('Song B');
  let failures = 1;
  const result = await extendRadioCache({ plays: [a, b], resolved: [] }, {
    resolvePlay: async (p) => { if (failures-- > 0) throw new Error('offline'); return match(p); },
    backoffs: [0], pause: async () => {},
  });
  assert.equal(result.stopped, null);
  assert.equal(result.added, 2);
});

const now = () => new Date('2026-10-17T12:00:00Z');
const emptySearch = () => ({ ok: true, status: 200, text: async () => 'var ytInitialData = {"contents":[]};' });

test('real 403 and bot responses leave attempted/dropped unchanged and resumable', async () => {
  const a = play('Song A');
  for (const response of [{ ok: false, status: 403 }, { ok: true, status: 200, text: async () => "Confirm you're not a bot" }]) {
    const result = await extendRadioCache({ plays: [a], resolved: [], dropped: 2 }, {
      fetchImpl: async () => response, delayMs: 0, backoffs: [], now,
    });
    assert.equal(result.attempted, 0); assert.equal(result.cache.dropped, 2);
    assert.deepEqual(newRadioCandidates(result.cache), [a]);
    assert.equal(result.cache.youtubeLookups[songKey(a)].status, 'pending');
    assert.equal(result.cache.youtubeSearchUsage.web, 1);
  }
});

test('search budget survives restarts and does not prevent later known-link matches', async () => {
  const a = play('Song A'), b = play('Song B');
  const linked = { ...play('Known Song'), youtubeCandidates: [{ videoId: 'VxuNvoiel2g', source: 'discogs' }] };
  const requests = [];
  const options = { now, delayMs: 0, searchBudget: 1, backoffs: [],
    fetchImpl: async (url) => {
      requests.push(url);
      if (url.includes('/results')) return emptySearch();
      assert.ok(url.includes('/oembed?'));
      return { ok: true, status: 200, json: async () => ({ title: linked.title, author_name: linked.artist }) };
    },
  };
  const result = await extendRadioCache({ plays: [a, b, linked], resolved: [] }, options);
  assert.equal(result.added, 1); assert.equal(result.attempted, 2);
  assert.equal(result.cache.dropped, 1);
  assert.equal(result.stopped.code, 'search_budget');
  assert.deepEqual(newRadioCandidates(result.cache), [b]);
  assert.equal(result.cache.youtubeSearchUsage.web, 1);
  const resumed = await extendRadioCache(result.cache, options);
  assert.equal(resumed.attempted, 0);
  assert.equal(requests.filter((url) => url.includes('/results')).length, 1);
  const tomorrow = await extendRadioCache(resumed.cache, { ...options, now: () => new Date('2026-10-18T12:00:00Z') });
  assert.equal(tomorrow.attempted, 1);
  assert.equal(tomorrow.stopped, null);
  assert.equal(tomorrow.cache.youtubeSearchUsage.day, '2026-10-18');
});

test('every fallback query counts and usage is checkpointed before the request', async () => {
  const a = { ...play('Song A'), ids: { isrc: 'USX120000001' } };
  let saved = 0, calls = 0;
  const result = await extendRadioCache({ plays: [a], resolved: [] }, {
    now, delayMs: 0, searchBudget: 2, backoffs: [],
    checkpoint: async (cache) => { saved = cache.youtubeSearchUsage.web ?? 0; },
    fetchImpl: async () => { calls++; assert.equal(saved, calls); return emptySearch(); },
  });
  assert.equal(calls, 2); assert.equal(result.cache.youtubeSearchUsage.web, 2);
  assert.equal(result.cache.youtubeLookups[songKey(a)].status, 'no_match');
});

test('API known links batch across songs, consume no searches and survive a search quota error', async () => {
  const missing = play('Missing'), a = { ...play('Song A'), youtubeCandidates: [{ videoId: 'aaaaaaaaaaa', source: 'musicbrainz' }] };
  const b = { ...play('Song B'), youtubeCandidates: [{ videoId: 'bbbbbbbbbbb', source: 'discogs' }] };
  let videos = 0, searches = 0;
  const result = await extendRadioCache({ plays: [missing, a, b], resolved: [] }, {
    now, delayMs: 0, apiKey: 'key', backoffs: [],
    fetchImpl: async (request) => {
      const url = new URL(request);
      if (url.pathname.endsWith('/search')) {
        searches++;
        return { ok: false, status: 403, json: async () => ({ error: { errors: [{ reason: 'quotaExceeded' }] } }) };
      }
      videos++;
      assert.equal(url.searchParams.get('id'), 'aaaaaaaaaaa,bbbbbbbbbbb');
      return { ok: true, json: async () => ({ items: [a, b].map((p) => ({ id: p.youtubeCandidates[0].videoId,
        snippet: { title: p.title, channelTitle: p.artist }, status: { embeddable: true, privacyStatus: 'public' },
      })) }) };
    },
  });
  assert.equal(videos, 1); assert.equal(searches, 1);
  assert.equal(result.added, 2); assert.equal(result.cache.youtubeSearchUsage.api, 1);
  assert.equal(result.stopped.code, 'quota');
  assert.equal(result.cache.dropped, 0);
});

test('legacy negatives are retried only explicitly and successful recovery corrects dropped', async () => {
  const a = play('Song A');
  const cache = { plays: [a], resolved: [], dropped: 1, attemptedKeys: [songKey(a)] };
  assert.deepEqual(newRadioCandidates(cache), []);
  assert.deepEqual(newRadioCandidates(cache, 10, null, { retryUnmatched: true }), [a]);
  const result = await extendRadioCache(cache, { retryUnmatched: true, resolvePlay: async () => match(a) });
  assert.equal(result.added, 1); assert.equal(result.cache.dropped, 0);
  const blocked = await extendRadioCache(cache, { retryUnmatched: true, backoffs: [],
    resolvePlay: async () => { throw new Error('blocked'); },
  });
  assert.deepEqual(newRadioCandidates(blocked.cache), [a]);
  assert.equal(blocked.cache.youtubeLookups[songKey(a)].status, 'pending');
  const resumed = await extendRadioCache(blocked.cache, { resolvePlay: async () => match(a) });
  assert.equal(resumed.cache.dropped, 0, 'a temporary block must not lose the legacy negative count');
});

test('internal HTTP retries also consume and persist search budget', async () => {
  let calls = 0, saved = 0;
  const result = await extendRadioCache({ plays: [play('Song A')], resolved: [] }, {
    now, delayMs: 0, searchBudget: 2, backoffs: [],
    checkpoint: async (cache) => { saved = cache.youtubeSearchUsage.web ?? 0; },
    fetchImpl: async () => { calls++; assert.equal(saved, calls); return { ok: false, status: 429 }; },
  });
  assert.equal(calls, 2); assert.equal(result.stopped.code, 'search_budget');
  assert.equal(result.cache.youtubeSearchUsage.web, 2);
  assert.equal(result.cache.dropped, 0);
});
