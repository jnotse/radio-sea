import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createDiscogsMatcher, scanDiscogsDump } from '../src/catalog/discogs-dump.js';
import { songKey } from '../src/catalog/extend.js';

// Releases a record channel's uploads link to (https://data.discogs.com/ layout).
const credit = ([id, name]) => `<artist><id>${id}</id><name>${name}</name><anv/><join/><role/><tracks/></artist>`;
function release({ id, artists, title, styles, released, master, main = true, label = 'Label', tracks }) {
  const tracklist = tracks.map((t) => `<track><position>A</position><title>${t.title}</title><duration>${t.duration ?? '4:00'}</duration>` +
    `${t.artists ? `<artists>${t.artists.map(credit).join('')}</artists>` : ''}</track>`).join('');
  return `<release id="${id}" status="Accepted"><artists>${artists.map(credit).join('')}</artists><title>${title}</title>` +
    `<labels><label name="${label}" catno="X1" id="9"/></labels><genres><genre>Electronic</genre></genres>` +
    `<styles>${styles.map((s) => `<style>${s}</style>`).join('')}</styles><country>Japan</country><released>${released}</released>` +
    `${master ? `<master_id is_main_release="${main}">${master}</master_id>` : ''}<tracklist>${tracklist}</tracklist></release>`;
}
const RELEASES = [
  // A compilation the upload links: the track names its real artist.
  release({ id: 7009353, artists: [[194, 'Various']], title: 'Tokio Explosion Vol.2', styles: ['Synth-pop'], released: '2012', label: 'Cultdep',
    tracks: [{ title: 'The Right World', artists: [[1, 'Koji Nakamura (2)']], duration: '5:10' }, { title: 'Other', artists: [[2, 'Someone']] }] }),
  // A linked master: its main release names the record, the earliest year wins.
  release({ id: 31, artists: [[3, 'Gutbrod']], title: 'Endless Vacation', styles: ['Downtempo'], released: '2009', master: 1790115, main: false,
    label: 'Reissue Label', tracks: [{ title: 'You & Me' }] }),
  release({ id: 30, artists: [[3, 'Gutbrod']], title: 'Endless Vacation', styles: ['Balearic'], released: '2005', master: 1790115, main: true,
    label: 'Bes Recordings', tracks: [{ title: 'You & Me' }] }),
  // The uploader did not know the artist; the record does.
  release({ id: 555, artists: [[4, 'Mystery Sound System']], title: 'Dub Chug', styles: ['Dub'], released: '1996', tracks: [{ title: 'Dub Chug' }] }),
  // Same title by somebody else, not linked: never used.
  release({ id: 999, artists: [[5, 'Koji Nakamura']], title: 'Wrong', styles: ['Noise'], released: '1980', tracks: [{ title: 'The Right World' }] }),
];
const upload = (artist, title, ids) => ({ artist, title, ids, youtube: { videoId: 'aaaaaaaaaaa', via: 'channel' } });
const PLAYS = [
  upload('koji nakamura', 'the right world', { discogsRelease: 7009353 }),
  upload('gutbrod', 'you & me', { discogsMaster: 1790115 }),
  upload('Unknown artist', 'dub chug', { discogsRelease: 555 }),
];

async function scan() {
  const matcher = createDiscogsMatcher(PLAYS);
  await scanDiscogsDump(Readable.from([`<releases>${RELEASES.join('\n')}</releases>`]), matcher);
  return matcher.results();
}
const of = (songs, artist, title) => songs[songKey({ artist, title })];

test('a linked release is the record: its styles, label, album and spelling, even on a compilation', async () => {
  const song = of(await scan(), 'koji nakamura', 'the right world');
  assert.equal(song.source, 'link');
  assert.deepEqual(song.styles, ['Synth-pop'], 'the unlinked record with the same title is ignored');
  assert.deepEqual([song.album, song.label, song.country, song.length], ['Tokio Explosion Vol.2', 'Cultdep', 'Japan', 310]);
  assert.deepEqual([song.artistName, song.trackTitle], ['Koji Nakamura', 'The Right World']);
});

test('a linked master takes its earliest year and its main release names the record', async () => {
  const song = of(await scan(), 'gutbrod', 'you & me');
  assert.equal(song.year, 2005);
  assert.deepEqual([song.album, song.label], ['Endless Vacation', 'Bes Recordings']);
  assert.deepEqual(song.styles.sort(), ['Balearic', 'Downtempo']);
});

test('an upload without an artist learns it from the linked record', async () => {
  const song = of(await scan(), 'Unknown artist', 'dub chug');
  assert.deepEqual([song.artistName, song.trackTitle, song.year], ['Mystery Sound System', 'Dub Chug', 1996]);
});
