import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRadioooooTrack, fetchRadioooooPlays } from '../src/catalog/radiooooo.js';
import { playToRaw } from '../scripts/build-demo.js';

const track = { _id: 'public-track-id', artist: 'Example Artist', title: 'Example Song', year: '1975',
  country: 'FRA', decade: 1970, mood: 'SLOW', label: 'Example Label', album: 'Example Album',
  links: { audio: 'https://private-audio.example/never-download.mp3' }, reportId: 'never-copy' };

test('Radiooooo parsing keeps metadata but never audio links, artwork or report tokens', () => {
  const p = parseRadioooooTrack(track);
  assert.equal(p.station, 'radiooooo'); assert.equal(p.releaseYear, 1975);
  assert.equal(p.country, 'FRA'); assert.equal(p.ids.radiooooo, 'public-track-id');
  assert.deepEqual(p.tags, ['mood:slow', 'decade:1970s']);
  assert.equal(p.date, null);
  assert.equal(p.sourceUrl, 'https://app.radiooooo.com/');
  const text = JSON.stringify(p);
  assert.ok(!text.includes('never-download')); assert.ok(!text.includes('never-copy'));
});

test('Radiooooo import preserves real year/country rather than substituting today', () => {
  const raw = playToRaw({ ...parseRadioooooTrack(track), youtube: { videoId: 'VxuNvoiel2g', url: 'https://www.youtube.com/watch?v=VxuNvoiel2g' } });
  assert.equal(raw.year, 1975); assert.equal(raw.country, 'FRA'); assert.equal(raw.label, 'Example Label');
  assert.equal(parseRadioooooTrack({ ...track, year: 'unknown' }).releaseYear, null);
  assert.equal(parseRadioooooTrack({ title: 'No artist' }), null);
});

test('public sampler uses a small bounded shuffle request and deduplicates metadata', async () => {
  const calls = [];
  const plays = await fetchRadioooooPlays({ samples: 2, delayMs: 0, fetchImpl: async (url, opts) => {
    calls.push({ url, opts }); return { ok: true, json: async () => track };
  } });
  assert.equal(plays.length, 1); assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.url === 'https://app.radiooooo.com/play/random'));
  assert.deepEqual(JSON.parse(calls[0].opts.body), { mode: 'random', moods: ['SLOW', 'FAST'], priority: 'auto' });
});

test('sampler stops on access restrictions/rate limits and rejects bulk-import sizes', async () => {
  for (const status of [401, 403, 429]) {
    let calls = 0;
    await assert.rejects(fetchRadioooooPlays({ samples: 3, delayMs: 0, fetchImpl: async () => {
      calls++; return { ok: false, status };
    } }), /No access workarounds/);
    assert.equal(calls, 1);
  }
  await assert.rejects(fetchRadioooooPlays({ samples: 1000 }), /between 1 and 30/);
});
