import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogueCandidates, discoverCatalogueLinks } from '../src/catalog/catalogue-links.js';
import { songKey } from '../src/catalog/extend.js';

const play = { artist: 'Larry Heard', title: 'Micro-Gravity' };
const key = songKey(play);
const id = 'H_AKKQ-f9LM';
const url = `https://www.youtube.com/watch?v=${id}`;
const fast = { pause: async () => {}, backoff: async () => {} };
const ok = (body) => ({ ok: true, json: async () => body });

test('catalogue candidates are bounded, deduplicated and reject wrong titles and hosts', () => {
  const candidates = catalogueCandidates(play, [url, { url, title: 'Micro-Gravity', source: 'discogs' },
    { url: 'https://youtu.be/aaaaaaaaaaa', title: 'Another Song' },
    { url: 'https://evil.test/watch?v=bbbbbbbbbbb' }, null]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].videoId, id);
  assert.equal(candidates[0].source, 'catalogue');
  assert.equal(candidates[0][0], undefined, 'URL strings do not become character properties');
});

test('cached catalogue links skip all network discovery', async () => {
  const result = await discoverCatalogueLinks([play], { ...fast,
    musicbrainz: { [key]: { youtubeCandidates: [{ url, source: 'musicbrainz' }] } },
    fetchImpl: async () => assert.fail('no network needed'),
    lookup: async () => assert.fail('no lookup needed'),
  });
  assert.equal(result.plays[0].youtubeCandidates[0].videoId, id);
});

test('pending songs get MusicBrainz lookup before YouTube, preserving metadata', async () => {
  let calls = 0, checkpoints = 0;
  const result = await discoverCatalogueLinks([play], { ...fast,
    musicbrainz: { [key]: { recording: 'known-id', genres: ['house'] } },
    lookup: async (p, options) => {
      calls++;
      assert.equal(p.ids.musicbrainz, 'known-id');
      assert.equal(options.includeVideoLinks, true);
      return { youtubeCandidates: [{ url, source: 'musicbrainz' }], recording: 'known-id' };
    },
    checkpoint: async () => { checkpoints++; },
  });
  assert.equal(calls, 1); assert.equal(checkpoints, 1);
  assert.deepEqual(result.musicbrainz[key].genres, ['house']);
  assert.equal(result.plays[0].youtubeCandidates[0].source, 'musicbrainz');
  assert.equal(result.plays[0].youtube, undefined, 'hints are not accepted resolutions');
});

test('follow release relationships to Discogs, cache link facts and filter album videos', async () => {
  const calls = [];
  const musicbrainz = { [key]: { youtubeCandidates: [], releaseIds: ['release-id'] } };
  const result = await discoverCatalogueLinks([play], { ...fast, musicbrainz,
    fetchImpl: async (request, options) => {
      calls.push(request);
      assert.match(options.headers['User-Agent'], /radio-sea/);
      if (request.includes('musicbrainz.org/ws/2/release/')) return ok({
        relations: [{ url: { resource: 'https://www.discogs.com/release/13131-Alien' } }], tracklist: 'discard me',
      });
      assert.equal(request, 'https://api.discogs.com/releases/13131');
      return ok({ videos: [{ uri: url, title: 'Larry Heard - Micro-Gravity' },
        { uri: 'https://youtu.be/aaaaaaaaaaa', title: 'Larry Heard - Another Song' }], tracklist: 'discard me' });
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(result.plays[0].youtubeCandidates.map((c) => c.videoId), [id]);
  assert.equal(result.plays[0].youtubeCandidates[0].source, 'discogs');
  assert.ok(Object.values(result.cache).every((v) => !v.tracklist && v.checkedAt));
  await discoverCatalogueLinks([play], { ...fast, musicbrainz, cache: result.cache,
    fetchImpl: async () => assert.fail('cached relationships must be reused'),
  });
});

test('follow music-video recording relationships and retain provenance', async () => {
  const result = await discoverCatalogueLinks([play], { ...fast,
    musicbrainz: { [key]: { youtubeCandidates: [], videoRecordings: ['video-recording'] } },
    fetchImpl: async (request) => {
      assert.match(request, /recording\/video-recording\?inc=url-rels/);
      return ok({ relations: [{ url: { resource: url } }] });
    },
  });
  const candidate = result.plays[0].youtubeCandidates[0];
  assert.equal(candidate.videoId, id);
  assert.equal(candidate.sourceUrl, 'https://musicbrainz.org/recording/video-recording');
});

test('provider outages are not cached as absence and do not block other providers', async () => {
  const second = { ...play, title: 'Other Song' };
  let lookups = 0;
  const result = await discoverCatalogueLinks([play, second], { ...fast,
    discogs: { [key]: { releases: [13131] } },
    lookup: async () => { lookups++; throw new Error('busy'); },
    fetchImpl: async () => ok({ videos: [{ uri: url, title: 'Micro-Gravity' }] }),
  });
  assert.equal(lookups, 1, 'an unavailable provider is not hammered for every song');
  assert.equal(result.musicbrainz[key], undefined);
  assert.equal(result.errors[0].provider, 'musicbrainz');
  assert.equal(result.plays[0].youtubeCandidates[0].source, 'discogs');
  const retry = await discoverCatalogueLinks([second], { ...fast, musicbrainz: result.musicbrainz,
    lookup: async () => { lookups++; return { youtubeCandidates: [] }; },
  });
  assert.equal(lookups, 2);
  assert.deepEqual(retry.musicbrainz[songKey(second)].youtubeCandidates, []);
});
