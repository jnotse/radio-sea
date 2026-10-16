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
