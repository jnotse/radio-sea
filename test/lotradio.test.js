import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLotRadioShowPage } from '../src/catalog/lotradio.js';

// A faithful miniature of the page structure: Next.js flight payloads
// (self.__next_f.push([1,"<escaped json>"])) carrying episode objects with
// tracklists, genres, and show metadata.
function buildPage(episodes) {
  const payloadText = `38:["$","$L39",null,{"initialData":{"items":${JSON.stringify(episodes)},"total":1430}}]`;
  return `<html><script>self.__next_f.push([1,${JSON.stringify(payloadText)}])</script></html>`;
}

const EPISODE = {
  sys: { id: '56gQpCJjzZrfprBobGEQD4' },
  title: 'Royce Laroca',
  slug: '2026-10-15-1800',
  date: '2026-10-15T22:00:00.000Z',
  tracklist: [
    { title: 'Freckles (Beatless)', artist: 'Fabrizio Lapiana', timestamp: '2026-10-15T22:00:12.000Z' },
    { title: 'The Acid Test', artist: 'Darwin Chamber', timestamp: '2026-10-15T22:04:41.000Z' },
  ],
  genres: { items: [{ name: 'House' }, { name: 'Techno' }] },
  show: { name: 'Special Guests', slug: 'special-guests' },
};

test('parseLotRadioShowPage extracts tracklists with artist, title and genres', () => {
  const plays = parseLotRadioShowPage(buildPage([EPISODE]));
  assert.equal(plays.length, 2);
  assert.equal(plays[0].station, 'lotradio');
  assert.equal(plays[0].artist, 'Fabrizio Lapiana');
  assert.equal(plays[0].title, 'Freckles (Beatless)');
  assert.equal(plays[0].date, '2026-10-15');
  assert.equal(plays[0].show, 'Special Guests: Royce Laroca');
  assert.deepEqual(plays[0].showGenres, ['House', 'Techno']);
  assert.match(plays[0].sourceUrl, /thelotradio\.com\/shows\/special-guests\/2026-10-15-1800/);
});

test('episodes without tracklists are skipped', () => {
  const empty = { ...EPISODE, tracklist: [] };
  const plays = parseLotRadioShowPage(buildPage([empty, EPISODE]));
  assert.equal(plays.length, 2, 'only the episode with tracks contributes');
});

test('malformed payloads do not break the parser', () => {
  const html = '<script>self.__next_f.push([1,"not json {"]))</script>' + buildPage([EPISODE]);
  const plays = parseLotRadioShowPage(html);
  assert.equal(plays.length, 2);
});

test('escaped characters in titles survive the flight decoding', () => {
  const tricky = {
    ...EPISODE,
    tracklist: [{ title: 'Chez Moi [feat. "X"] & Y', artist: 'CC:DISCO!' }],
  };
  const [play] = parseLotRadioShowPage(buildPage([tricky]));
  assert.equal(play.title, 'Chez Moi [feat. "X"] & Y');
});
