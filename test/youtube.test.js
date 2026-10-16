import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateMatch, extractSearchResults, resolvePlayToYoutube,
  resolvePlaysToYoutube, validateYoutubeUrl, youtubeIdFromUrl, YoutubeUnavailable } from '../src/catalog/youtube.js';

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

test('resolution skips unrelated hits and verifies the right artist/title via oEmbed', async () => {
  const r = await resolvePlayToYoutube(play, { fetchImpl: mockFetch(), delayMs: 0 });
  assert.equal(r.videoId, correct.videoId);
  assert.equal(r.confirmed, true);
  assert.ok(r.checkedAt);
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
