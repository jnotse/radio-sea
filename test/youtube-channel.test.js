import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchChannelUploads, parseUploadDescription, parseUploadTitle, uploadToPlay, UNKNOWN_ARTIST } from '../src/catalog/youtube-channel.js';

test('upload titles read as artist, title and year or decade', () => {
  assert.deepEqual(parseUploadTitle('laura b - oo oo oo (2010)'), { artist: 'laura b', title: 'oo oo oo', year: 2010, decade: null });
  assert.deepEqual(parseUploadTitle('steve moore - mechanical opening (198x)'), { artist: 'steve moore', title: 'mechanical opening', year: null, decade: '1980s' });
  assert.deepEqual(parseUploadTitle('the cool front- fly 99 (1993)'), { artist: 'the cool front', title: 'fly 99', year: 1993, decade: null });
  assert.deepEqual(parseUploadTitle('double bind- flowers of evil (uptown mix) (1990)'),
    { artist: 'double bind', title: 'flowers of evil (uptown mix)', year: 1990, decade: null });
  assert.equal(parseUploadTitle('jean-michel jarre - oxygène (1976)').artist, 'jean-michel jarre', 'a hyphen inside a name never splits');
  assert.deepEqual(parseUploadTitle('unknown bedroom reggae (199x)'), { artist: UNKNOWN_ARTIST, title: 'unknown bedroom reggae', year: null, decade: '1990s' });
});

test('descriptions give the label and the linked Discogs release or master', () => {
  assert.deepEqual(parseUploadDescription('cultdep \n\nhttps://www.discogs.com/release/7009353-Various-Tokio-Explosion-Vol2'),
    { label: 'cultdep', discogs: { release: 7009353, compilation: true } });
  assert.deepEqual(parseUploadDescription('bes recordings\n\nhttps://www.discogs.com/master/1790115-Various-Endless'),
    { label: 'bes recordings', discogs: { master: 1790115, compilation: true } });
  assert.deepEqual(parseUploadDescription('not on label\n\nhttps://www.discogs.com/fr/Base-Line/release/1105367'),
    { label: null, discogs: { release: 1105367 } });
  assert.equal(parseUploadDescription('x\nhttps://www.discogs.com/Various-Rare-Grooves/release/12').discogs.compilation, true, 'old-style links too');
  assert.deepEqual(parseUploadDescription('buy, NOW: https://number-one.bandcamp.com/album/overview\n\nwow'), { label: null, discogs: null });
});

const VIDEO = { id: 'VxuNvoiel2g', snippet: { title: 'koji nakamura - the right world (1993)', channelTitle: 'floor length skirt(s)',
  publishedAt: '2026-10-01T12:00:00Z', description: 'cultdep\n\nhttps://www.discogs.com/release/7009353-Various-Tokio-Explosion-Vol2' },
  status: { embeddable: true, privacyStatus: 'public' } };
const STATION = { id: 'floorlengthskirts', label: 'floor length skirt(s)', kind: 'youtube', handle: 'floorlengthskirts' };

test('an upload becomes a resolved song with its own video, year, label hint and Discogs link', () => {
  const play = uploadToPlay(VIDEO, STATION, '2026-10-17T00:00:00Z');
  assert.deepEqual(play, {
    station: 'floorlengthskirts', show: null, date: '2026-10-01T12:00:00Z', sourceUrl: 'https://www.youtube.com/watch?v=VxuNvoiel2g',
    artist: 'koji nakamura', title: 'the right world', releaseYear: 1993, labelHint: 'cultdep', compilation: true, tags: [], ids: { discogsRelease: 7009353 },
    youtube: { videoId: 'VxuNvoiel2g', url: 'https://www.youtube.com/watch?v=VxuNvoiel2g', title: 'koji nakamura - the right world (1993)',
      channel: 'floor length skirt(s)', via: 'channel', confirmed: true, matchScore: 1, checkedAt: '2026-10-17T00:00:00Z' },
  });
  assert.deepEqual(uploadToPlay({ ...VIDEO, snippet: { ...VIDEO.snippet, title: 'purple om - aiee (199x)', description: '' } }, STATION).tags, ['decade:1990s']);
});

test('the whole channel is listed page by page; videos that cannot play embedded are left out', async () => {
  const urls = [];
  const ids = Array.from({ length: 60 }, (_, i) => `v${String(i).padStart(10, '0')}`);
  const fetchImpl = async (url) => {
    urls.push(url);
    const u = new URL(url), json = (body) => ({ ok: true, json: async () => body });
    if (u.pathname.endsWith('/channels')) return json({ items: [{ id: 'UC1', snippet: { title: 'floor length skirt(s)' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] });
    if (u.pathname.endsWith('/playlistItems')) {
      const second = u.searchParams.get('pageToken') === 'p2';
      return json({ items: (second ? ids.slice(50) : ids.slice(0, 50)).map((videoId) => ({ contentDetails: { videoId } })), ...(second ? {} : { nextPageToken: 'p2' }) });
    }
    return json({ items: u.searchParams.get('id').split(',').map((id, i) => ({ id, snippet: { title: `a - ${id}` },
      status: { embeddable: !(id === ids[3]), privacyStatus: i === 5 && id === ids[5] ? 'private' : 'public' } })) });
  };
  const { channel, videos } = await fetchChannelUploads({ handle: 'floorlengthskirts', apiKey: 'KEY', fetchImpl });
  assert.equal(channel.title, 'floor length skirt(s)');
  assert.equal(videos.length, 58);
  assert.ok(urls.every((url) => url.includes('key=KEY')));
  assert.equal(urls.filter((url) => url.includes('/videos?')).length, 2, 'details in batches of 50');
});

test('without a key, or for an unknown channel, it says why', async () => {
  await assert.rejects(fetchChannelUploads({ handle: 'x', apiKey: '' }), /YOUTUBE_API_KEY/);
  const none = async () => ({ ok: true, json: async () => ({ items: [] }) });
  await assert.rejects(fetchChannelUploads({ handle: 'nobody', apiKey: 'K', fetchImpl: none }), /no YouTube channel @nobody/);
  const refused = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'API key not valid' } }) });
  await assert.rejects(fetchChannelUploads({ handle: 'x', apiKey: 'K', fetchImpl: refused }), /API key not valid/);
});
