import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateMatch, extractSearchResults, nameForms, resolvePlayToYoutube,
  resolvePlaysToYoutube, validateYoutubeUrl, youtubeIdFromUrl, YoutubeUnavailable } from '../src/catalog/youtube.js';
import { lookupYoutubeVideos, verifyYoutubeCandidates, searchYoutube } from '../src/catalog/youtube.js';

const play = { artist: 'Uranium Club', title: "God's Chest", ids: { isrc: 'GBHLW1603489' } };
const correct = { videoId: 'VxuNvoiel2g', title: "God's Chest", channel: 'Uranium Club - Topic' };
const unrelated = { videoId: '5qju6127G2A', title: 'A Glossy RGB Stripe OLED Monitor Review', channel: 'Display Reviews' };
function html(rows) {
  return `var ytInitialData = ${JSON.stringify({ contents: rows.map((r) => ({ videoRenderer: {
    videoId: r.videoId, title: { runs: [{ text: r.title }] }, ownerText: { runs: [{ text: r.channel }] },
  } })) })};`;
}
function response(status, data) {
  return { ok: status === 200, status, text: async () => data,
    json: async () => typeof data === 'string' ? JSON.parse(data) : data };
}
function mockFetch({ rows = [unrelated, correct], status = 200, metadata = correct } = {}) {
  return async (url) => url.includes('/results') ? response(200, html(rows)) :
    response(status, { title: metadata.title, author_name: metadata.channel });
}

test('YouTube URL parser accepts real hosts/IDs only', () => {
  assert.equal(youtubeIdFromUrl('https://youtu.be/VxuNvoiel2g?t=3'), 'VxuNvoiel2g');
  assert.equal(youtubeIdFromUrl('https://www.youtube.com/watch?v=VxuNvoiel2g'), 'VxuNvoiel2g');
  assert.equal(youtubeIdFromUrl('https://youtube.com/shorts/VxuNvoiel2g'), 'VxuNvoiel2g');
  for (const url of ['https://evil.test/watch?v=VxuNvoiel2g', 'https://youtube.com.evil.test/watch?v=VxuNvoiel2g',
    'https://youtube.com/embed/undefined', 'javascript:alert(1)', null]) assert.equal(youtubeIdFromUrl(url), null);
});

test('search parser keeps IDs, titles and channel from the same renderer', () => {
  const results = extractSearchResults(html([unrelated, correct, correct]));
  assert.equal(results.length, 2);
  assert.equal(results[1].videoId, correct.videoId);
  assert.equal(results[1].channel, correct.channel);
  assert.deepEqual(extractSearchResults('<html>consent page</html>'), []);
});

test('search parser does not cross into another renderer to find a title', () => {
  const page = `var ytInitialData = {"contents":[{"videoRenderer":{"videoId":"5qju6127G2A"}},
    {"videoRenderer":{"videoId":"VxuNvoiel2g","title":{"simpleText":"God's Chest"},"ownerText":{"simpleText":"Uranium Club"}}}]};`;
  const rows = extractSearchResults(page);
  assert.equal(rows[0].title, '');
  assert.equal(rows[1].title, "God's Chest");
});

test('relevance rejects unrelated results, wrong songs and different versions', () => {
  assert.equal(candidateMatch(play, unrelated).acceptable, false);
  assert.equal(candidateMatch(play, correct).acceptable, true);
  assert.equal(candidateMatch({ artist: 'Lord Tusk', title: 'Mothers Love' },
    { title: 'Lord Tusk - Shyne Eyed Gal', channel: 'Lord Tusk' }).acceptable, false);
  assert.equal(candidateMatch({ artist: 'Second Hand Satellites', title: 'Orbit 1.1' },
    { title: 'Second Hand Satellites - Orbit 1.4' }).acceptable, false);
  assert.equal(candidateMatch(play, { title: "Uranium Club - God's Chest (Karaoke)" }).acceptable, false);
});

test('relevance supports non-Latin artist and title names', () => {
  assert.equal(candidateMatch({ artist: 'Молчат Дома, Molchat Doma', title: 'На Дне' },
    { title: 'Молчат Дома - На Дне', channel: 'Molchat Doma' }).acceptable, true);
  assert.equal(candidateMatch({ artist: 'Молчат Дома', title: 'На Дне' },
    { title: 'Судно (Борис Рыжий)', channel: 'Молчат Дома' }).acceptable, false);
});

test('repeated title words require repeated evidence and previews are not full-song matches', () => {
  const repeated = { artist: 'ميادة (Mayada)', title: 'ياي .. ياي .. ياي (Ya..Ya..Ya..)' };
  assert.equal(candidateMatch(repeated, {
    title: 'Mayada Bseliss - Ma Beddi Ya Mama | ميادة بسيليس - ما بدي يا ماما',
  }).acceptable, false);
  assert.equal(candidateMatch(repeated, { title: 'Mayada - Ya Ya Ya' }).acceptable, true);
  assert.equal(candidateMatch({ artist: 'Dar Disku', title: 'Ya Mahmud' }, {
    title: 'Ya Mahmud (Dar Disku Edit) -SNIPPED-',
  }).acceptable, false);
});

test('a name in its own script with a romanization matches a video titled in either one', () => {
  const googoosh = { artist: 'گوگوش (Googoosh)', title: 'ما به هم نمی رسیم (Ma Beh Ham Nemiresim)' };
  assert.deepEqual(nameForms(googoosh.artist), ['گوگوش (Googoosh)', 'گوگوش', 'Googoosh']);
  assert.equal(candidateMatch(googoosh, { title: 'Googoosh - Ma Beh Ham Nemiresim', channel: 'x' }).acceptable, true);
  assert.equal(candidateMatch(googoosh, { title: 'گوگوش - ما به هم نمی رسیم', channel: 'x' }).acceptable, true);
  assert.equal(candidateMatch(googoosh, { title: 'Googoosh - Bi Saranjam', channel: 'x' }).acceptable, false);
  // Brackets in one script are part of the name: a remix never matches the original.
  assert.deepEqual(nameForms('A New Day (H&F Dubhouse Mix)'), ['A New Day (H&F Dubhouse Mix)']);
  assert.equal(candidateMatch({ artist: 'Ron Carroll', title: 'A New Day (H&F Dubhouse Mix)' },
    { title: 'Ron Carroll - A New Day', channel: 'x' }).acceptable, false);
});

test('resolution skips unrelated hits and verifies the right artist/title via oEmbed', async () => {
  const r = await resolvePlayToYoutube(play, { fetchImpl: mockFetch(), delayMs: 0 });
  assert.equal(r.videoId, correct.videoId);
  assert.equal(r.confirmed, true);
  assert.ok(r.checkedAt);
});

test('with an API key, search and the embed check go through the YouTube Data API only', async () => {
  const urls = [];
  const api = ({ embeddable = true, quota = false } = {}) => async (url) => {
    urls.push(url);
    assert.ok(url.startsWith('https://www.googleapis.com/youtube/v3/'), `no search pages: ${url}`);
    if (quota) return response(403, { error: { errors: [{ reason: 'quotaExceeded' }], message: 'quota' } });
    if (url.includes('/search?')) {
      return response(200, { items: [unrelated, correct].map((r) => ({ id: { videoId: r.videoId },
        snippet: { title: r.title.replace("'", '&#39;'), channelTitle: r.channel } })) });
    }
    return response(200, { items: [{ id: correct.videoId, snippet: { title: correct.title, channelTitle: correct.channel },
      status: { embeddable, privacyStatus: 'public' } }] });
  };
  const r = await resolvePlayToYoutube(play, { fetchImpl: api(), apiKey: 'k', delayMs: 0 });
  assert.equal(r.videoId, correct.videoId);
  assert.equal(r.confirmed, true);
  assert.ok(urls[0].includes('q=Uranium+Club+God%27s+Chest') && urls[0].includes('key=k'));
  assert.ok(urls[1].includes(`/videos?part=snippet%2Cstatus&id=${correct.videoId}`));
  // A video that may not be embedded is not admitted; a used-up quota ends the run.
  assert.equal(await resolvePlayToYoutube(play, { fetchImpl: api({ embeddable: false }), apiKey: 'k', delayMs: 0 }), null);
  const quota = await resolvePlayToYoutube(play, { fetchImpl: api({ quota: true }), apiKey: 'k', delayMs: 0 }).catch((e) => e);
  assert.ok(quota instanceof YoutubeUnavailable && quota.final);
  assert.match(quota.message, /quota for today/);
  // A per-minute limit is only a pause: the run waits and carries on.
  const perMinute = async () => response(403, { error: { errors: [{ reason: 'rateLimitExceeded' }],
    message: "Quota exceeded for quota metric 'Search Queries' and limit 'Search Queries per minute'" } });
  const slow = await resolvePlayToYoutube(play, { fetchImpl: perMinute, apiKey: 'k', delayMs: 0 }).catch((e) => e);
  assert.ok(slow instanceof YoutubeUnavailable && !slow.final);
  // A key's daily search cap arrives as a 429 too, but waiting minutes cannot lift it.
  const perDay = async () => response(429, { error: { errors: [{ reason: 'rateLimitExceeded' }],
    message: "Quota exceeded for quota metric 'Search Queries' and limit 'Search Queries per day'" } });
  const done = await resolvePlayToYoutube(play, { fetchImpl: perDay, apiKey: 'k', delayMs: 0 }).catch((e) => e);
  assert.ok(done.final);
  assert.match(done.message, /quota for today/);
});

test('oEmbed metadata disagreement is not admitted even if the search title matched', async () => {
  assert.equal(await resolvePlayToYoutube(play, {
    fetchImpl: mockFetch({ metadata: unrelated }), delayMs: 0,
  }), null);
});

test('404, throttle and network failures never get labelled verified', async () => {
  assert.equal(await resolvePlayToYoutube(play, { fetchImpl: mockFetch({ status: 404 }), delayMs: 0 }), null);
  // Throttling and outages are not "no video": they fail loudly so the song is retried later.
  for (const status of [429, 503]) {
    await assert.rejects(resolvePlayToYoutube(play, { fetchImpl: mockFetch({ status }), delayMs: 0 }), YoutubeUnavailable);
  }
  const offline = async (url) => {
    if (url.includes('/results')) return response(200, html([correct]));
    throw new Error('offline');
  };
  await assert.rejects(resolvePlayToYoutube(play, { fetchImpl: offline, delayMs: 0 }), YoutubeUnavailable);
  // Too many searches: YouTube redirects to Google's "unusual traffic" page.
  const limited = async () => ({ ...response(200, '<html>unusual traffic</html>'), url: 'https://www.google.com/sorry/index?continue=x' });
  await assert.rejects(resolvePlayToYoutube(play, { fetchImpl: limited, delayMs: 0 }), /limiting requests/);
});

test('batch counts exclusions instead of substituting unrelated videos', async () => {
  const { resolved, dropped } = await resolvePlaysToYoutube([play, { artist: 'Someone Else', title: 'Other Song' }],
    { fetchImpl: mockFetch(), delayMs: 0 });
  assert.equal(resolved.length, 1); assert.equal(dropped, 1);
});

test('URL validation fails closed on unavailable videos', async () => {
  const url = 'https://www.youtube.com/watch?v=VxuNvoiel2g';
  assert.equal(await validateYoutubeUrl(url, { fetchImpl: mockFetch() }), true);
  assert.equal(await validateYoutubeUrl(url, { fetchImpl: mockFetch({ status: 404 }) }), false);
});

test('403, consent, bot checks and unreadable search pages are pending, not empty results', async () => {
  for (const res of [response(403, ''), response(200, "Confirm you're not a bot"),
    response(200, '<html>Please enable JavaScript</html>'), response(200, 'var ytInitialData = {};'),
    { ...response(200, ''), url: 'https://consent.youtube.com/m' }]) {
    await assert.rejects(resolvePlayToYoutube(play, { delayMs: 0, fetchImpl: async () => res }), YoutubeUnavailable);
  }
  assert.deepEqual(await searchYoutube('no results', { delayMs: 0, fetchImpl: async () => response(200, html([])) }), []);
});

test('known catalogue links verify without a search and ignore catalogue titles as proof', async () => {
  let searches = 0, requests = 0;
  const options = { delayMs: 0, beforeSearch: async () => { searches++; },
    fetchImpl: async (url) => {
      requests++;
      assert.ok(url.includes('/oembed?'));
      return response(200, { title: correct.title, author_name: correct.channel });
    } };
  const resolved = await resolvePlayToYoutube({ ...play, youtubeCandidates: [
    { videoId: correct.videoId, source: 'discogs' }, { videoId: unrelated.videoId, source: 'discogs' },
  ] }, options);
  assert.equal(resolved.via, 'discogs'); assert.equal(searches, 0); assert.equal(requests, 1);
  assert.equal(await verifyYoutubeCandidates(play, [{ ...correct, source: 'discogs' }], {
    delayMs: 0, fetchImpl: mockFetch({ metadata: unrelated }),
  }), null, 'a good catalogue hint cannot override unrelated YouTube metadata');
});

test('API ID verification deduplicates and batches 50, caching missing and non-embeddable IDs', async () => {
  const ids = Array.from({ length: 52 }, (_, i) => String(i).padStart(11, 'a'));
  const cache = {}, sizes = [];
  let checkpoints = 0;
  await lookupYoutubeVideos([...ids, ids[0], 'invalid'], { apiKey: 'test', videoCache: cache, delayMs: 0,
    checkpoint: async () => { checkpoints++; },
    fetchImpl: async (request) => {
      const url = new URL(request);
      assert.equal(url.pathname, '/youtube/v3/videos');
      assert.equal(url.searchParams.has('maxResults'), false);
      const batch = url.searchParams.get('id').split(','); sizes.push(batch.length);
      return response(200, { items: batch.filter((id) => id !== ids[1]).map((id) => ({ id,
        snippet: { title: correct.title, channelTitle: correct.channel },
        status: { embeddable: id !== ids[2], privacyStatus: id === ids[3] ? 'private' : 'public' },
      })) });
    },
  });
  assert.deepEqual(sizes, [50, 2]); assert.equal(checkpoints, 2);
  assert.equal(Object.keys(cache).length, 52); assert.equal(cache[ids[1]].found, false);
  assert.equal(await verifyYoutubeCandidates(play, ids.slice(1, 4).map((videoId) => ({ videoId })), {
    apiKey: 'test', videoCache: cache, delayMs: 0, fetchImpl: async () => assert.fail('fresh cache is reused'),
  }), null);
  assert.ok(await verifyYoutubeCandidates(play, [{ videoId: ids[0] }], {
    apiKey: 'test', videoCache: cache, delayMs: 0, fetchImpl: async () => assert.fail('fresh cache is reused'),
  }));
});

test('stale video metadata is refreshed and blocked checks are not cached as missing', async () => {
  const cache = { [correct.videoId]: { found: false, method: 'oembed', checkedAt: '2020-01-01T00:00:00Z' } };
  await lookupYoutubeVideos([correct.videoId], { videoCache: cache, delayMs: 0, fetchImpl: mockFetch() });
  assert.equal(cache[correct.videoId].found, true);
  const empty = {};
  for (const res of [response(403, ''), response(200, '<html>challenge</html>')]) {
    await assert.rejects(lookupYoutubeVideos([correct.videoId], {
      videoCache: empty, delayMs: 0, fetchImpl: async () => res,
    }), YoutubeUnavailable);
    assert.deepEqual(empty, {});
  }
});
