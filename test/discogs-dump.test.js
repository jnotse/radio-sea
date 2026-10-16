import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { createDiscogsMatcher, parseDumpRelease, scanDiscogsDump } from '../src/catalog/discogs-dump.js';
import { songKey } from '../src/catalog/extend.js';

// Miniature of the Discogs releases dump layout (https://data.discogs.com/).
const credit = ([id, name]) => `<artist><id>${id}</id><name>${name}</name><anv/><join/><role/><tracks/></artist>`;
const tags = (tag, list = []) => (list.length ? `<${tag}s>${list.map((x) => `<${tag}>${x}</${tag}>`).join('')}</${tag}s>` : '');
function release({ id, artists, title, genres, styles, released = '', master, tracks = [], videos = [] }) {
  const tracklist = tracks.map((t) => (typeof t === 'string' ? { title: t } : t)).map((t) =>
    `<track><position>A</position><title>${t.title}</title><duration>3:00</duration>` +
    `${t.artists ? `<artists>${t.artists.map(credit).join('')}</artists>` : ''}${t.sub ?? ''}</track>`).join('');
  return `<release id="${id}" status="Accepted"><artists>${artists.map(credit).join('')}</artists>` +
    `<title>${title}</title><labels><label name="Label" catno="X1" id="9"/></labels>` +
    `<extraartists>${credit([99, 'Engineer'])}</extraartists>${tags('genre', genres)}${tags('style', styles)}` +
    `<country>US</country><released>${released}</released><data_quality>Correct</data_quality>` +
    `${master ? `<master_id is_main_release="true">${master}</master_id>` : ''}<tracklist>${tracklist}</tracklist>` +
    `${videos.length ? `<videos>${videos.map((v) => `<video src="https://www.youtube.com/watch?v=${v}" duration="200" embed="true"><title>Video</title></video>`).join('')}</videos>` : ''}</release>`;
}
const dump = (releases) => `<?xml version="1.0" encoding="UTF-8"?><releases>${releases.join('\n')}</releases>`;

const play = (artist, title, videoId = 'aaaaaaaaaaa') => ({ artist, title, youtube: { videoId } });
const PLAYS = [
  play('McCoy Tyner', 'My Favorite Things'),
  play('Death', 'Keep on Knocking'),
  play('Death', 'Politicians in My Eyes'),
  play('Nolan Porter', 'If I Could Only Be Sure', 'NOLANvideo1'),
  play('Throbbing Gristle', 'Walkabout'),
  play('Solar', 'Your Secret'),
  play('Unknown Artist', 'Untitled'),
  play('Preoccupations', 'Espionage'),
];
const RELEASES = [
  release({ id: 1, artists: [[10, 'McCoy Tyner']], title: 'Live At Newport', genres: ['Jazz'], styles: ['Hard Bop', 'Modal'],
    released: '1963-08-00', master: 500, tracks: ['My Favorite Things', 'Newport Romp'] }),
  // A reissue of the same album must not count twice.
  release({ id: 2, artists: [[10, 'McCoy Tyner']], title: 'Live At Newport', genres: ['Jazz'], styles: ['Hard Bop', 'Modal'],
    released: '2004', master: 500, tracks: ['My Favorite Things'] }),
  release({ id: 3, artists: [[10, 'McCoy Tyner']], title: 'Other Album', genres: ['Jazz'], styles: ['Post Bop'], released: '1970',
    master: 501, tracks: ['My Favorite Things (Live)'] }),
  // Same title by an unrelated artist.
  release({ id: 4, artists: [[11, 'Julie Andrews']], title: 'The Sound Of Music', genres: ['Stage & Screen'], styles: ['Musical'],
    tracks: ['My Favorite Things'] }),
  // Two Discogs artists are called Death; only the proto-punk band has these songs.
  release({ id: 5, artists: [[20, 'Death (2)']], title: 'Scream Bloody Gore', genres: ['Rock'], styles: ['Death Metal'], released: '1987', tracks: ['Zombie Ritual'] }),
  release({ id: 6, artists: [[21, 'Death']], title: '...For The Whole World To See', genres: ['Rock'], styles: ['Proto-Punk', 'Garage Rock'],
    released: '2009', master: 600, tracks: ['Keep On Knocking', 'Politicians In My Eyes'] }),
  // A compilation credits each track; its year is not the song's.
  release({ id: 7, artists: [[194, 'Various']], title: 'Soul Spectrum', genres: ['Funk / Soul'], styles: ['Soul', 'Funk'], released: '2015',
    tracks: [{ title: 'If I Could Only Be Sure', artists: [[30, 'Nolan Porter']] }] }),
  // Found only through the exact YouTube video we play.
  release({ id: 8, artists: [[31, 'N. Porter &amp; Band']], title: 'Single', genres: ['Funk / Soul'], styles: ['Northern Soul'],
    released: '1972', tracks: ['Sure'], videos: ['NOLANvideo1'] }),
  // No release lists "Walkabout": fall back to the artist's styles.
  release({ id: 9, artists: [[40, 'Throbbing Gristle']], title: '20 Jazz Funk Greats', genres: ['Electronic'], styles: ['Industrial', 'Experimental'],
    released: '1979', master: 700, tracks: ['Hot On The Heels Of Love'] }),
  release({ id: 10, artists: [[40, 'Throbbing Gristle']], title: 'D.o.A.', genres: ['Electronic'], styles: ['Industrial', 'Noise'],
    released: '1978', master: 701, tracks: [{ title: 'Index', sub: '<sub_tracks><track><title>Hamburger Lady</title></track></sub_tracks>' }] }),
  // Two different artists called Solar and neither has the song: too ambiguous to guess.
  release({ id: 11, artists: [[50, 'Solar']], title: 'A', genres: ['Electronic'], styles: ['Trance'], tracks: ['Other'] }),
  release({ id: 12, artists: [[51, 'Solar (3)']], title: 'B', genres: ['Jazz'], styles: ['Fusion'], tracks: ['Else'] }),
  // Discogs holds thousands of anonymous untitled tracks.
  release({ id: 13, artists: [[355, 'Unknown Artist']], title: 'Field Tapes', genres: ['Non-Music'], styles: ['Field Recording'],
    released: '1914', tracks: ['Untitled'] }),
  // On the band's own album and on a mixed compilation: the album decides.
  release({ id: 14, artists: [[60, 'Preoccupations']], title: 'New Material', genres: ['Rock'], styles: ['Post-Punk', 'Indie Rock'],
    released: '2018', master: 800, tracks: ['Espionage'] }),
  release({ id: 15, artists: [[194, 'Various']], title: 'Summer Mix', genres: ['Reggae', 'Rock'], styles: ['Dub', 'Reggae'], released: '2019',
    tracks: [{ title: 'Espionage', artists: [[60, 'Preoccupations']] }] }),
];

async function scan(text, { gzip = false, chunk = 7, limit } = {}) {
  const bytes = gzip ? gzipSync(text) : Buffer.from(text);
  const pieces = [];
  for (let i = 0; i < bytes.length; i += chunk) pieces.push(bytes.subarray(i, i + chunk));
  const matcher = createDiscogsMatcher(PLAYS);
  const { scanned } = await scanDiscogsDump(Readable.from(pieces), matcher, { limit });
  return { scanned, songs: matcher.results() };
}
const of = (songs, artist, title) => songs[songKey({ artist, title })];

test('parses a release, including nested index tracks and escaped names', () => {
  const r = parseDumpRelease(RELEASES[9]);
  assert.equal(r.id, 10);
  assert.deepEqual(r.artists, [{ id: 40, names: ['Throbbing Gristle'] }]);
  assert.deepEqual([r.title, r.year, r.masterId], ['D.o.A.', 1978, 701]);
  assert.deepEqual([r.genres, r.styles], [['Electronic'], ['Industrial', 'Noise']]);
  assert.deepEqual(r.tracks.map((t) => t.title), ['Index', 'Hamburger Lady']);
  assert.deepEqual(parseDumpRelease(RELEASES[7]).artists[0].names, ['N. Porter & Band']);
  assert.deepEqual(parseDumpRelease(RELEASES[7]).videoIds, ['NOLANvideo1']);
});

test('songs get the styles of the releases that list them, counting each album once', async () => {
  const { scanned, songs } = await scan(dump(RELEASES));
  assert.equal(scanned, RELEASES.length);
  assert.deepEqual(of(songs, 'McCoy Tyner', 'My Favorite Things'),
    { genres: ['Jazz'], styles: ['Hard Bop', 'Modal', 'Post Bop'], year: 1963, source: 'track', releases: [1, 3] });
  const death = of(songs, 'Death', 'Keep on Knocking');
  assert.deepEqual([death.styles, death.source], [['Garage Rock', 'Proto-Punk'], 'track']);
  assert.ok(!death.styles.includes('Death Metal'), 'the other band called Death must not leak in');
});

test('compilations and YouTube videos count, but a compilation year is not the song year', async () => {
  const nolan = of((await scan(dump(RELEASES))).songs, 'Nolan Porter', 'If I Could Only Be Sure');
  assert.deepEqual(nolan.styles, ['Funk', 'Northern Soul', 'Soul']);
  assert.equal(nolan.year, 1972);
  assert.deepEqual(nolan.releases, [7, 8]);
});

test('without a listed song, the artist styles are used only when the name is unambiguous', async () => {
  const { songs } = await scan(dump(RELEASES));
  assert.deepEqual(of(songs, 'Throbbing Gristle', 'Walkabout'),
    { genres: ['Electronic'], styles: ['Industrial', 'Experimental', 'Noise'], year: null, source: 'artist', releases: [] });
  assert.deepEqual(of(songs, 'Solar', 'Your Secret'), { genres: [], styles: [], year: null, source: null, releases: [] });
});

test('own releases outrank compilations, and placeholder artists are never matched', async () => {
  const { songs } = await scan(dump(RELEASES));
  assert.deepEqual(of(songs, 'Preoccupations', 'Espionage'),
    { genres: ['Rock'], styles: ['Indie Rock', 'Post-Punk'], year: 2018, source: 'track', releases: [14] });
  assert.deepEqual(of(songs, 'Unknown Artist', 'Untitled'), { genres: [], styles: [], year: null, source: null, releases: [] });
});

test('the dump streams as gzip or plain XML in any chunk size, and --limit stops early', async () => {
  const plain = await scan(dump(RELEASES), { chunk: 3 });
  const gzipped = await scan(dump(RELEASES), { gzip: true, chunk: 5 });
  assert.deepEqual(gzipped, plain);
  const partial = await scan(dump(RELEASES), { gzip: true, limit: 2 });
  assert.equal(partial.scanned, 2);
});
