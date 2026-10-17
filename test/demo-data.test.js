import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCatalogue } from '../src/catalog/resolve.js';
import { interleavePlays, playToRaw, withOwnGenres } from '../scripts/build-demo.js';
import { songKey } from '../src/catalog/extend.js';

const sample = { station: 'nts', artist: 'Artist', title: 'Song', show: 'Show',
  date: '2026-10-13T00:00:00Z', sourceUrl: 'https://www.nts.live/api/v2/shows/example/episodes/example',
  tags: ['Jazz'], youtube: { videoId: 'VxuNvoiel2g', url: 'https://www.youtube.com/watch?v=VxuNvoiel2g' } };

test('radio -> merge -> demo preserves video ID and human-readable provenance', () => {
  const { releases: [r] } = mergeCatalogue([playToRaw(sample)]);
  assert.equal(r.youtubeId, 'VxuNvoiel2g');
  assert.equal(r.station, 'nts');
  assert.equal(r.show, 'Show');
  assert.equal(r.date, sample.date);
  assert.equal(r.sourceUrl, 'https://www.nts.live/shows/example/episodes/example');
  assert.equal(r.year, null, 'air date must not be passed off as release year');
});

test('same song aired on two stations retains both provenances after deduplication', () => {
  const { releases } = mergeCatalogue([playToRaw(sample), playToRaw({ ...sample, station: 'lotradio',
    sourceUrl: 'https://www.thelotradio.com/shows/example/date' })]);
  assert.equal(releases.length, 1);
  assert.deepEqual(releases[0].stations, ['nts', 'lotradio']);
  assert.equal(releases[0].radioPlays.length, 2);
});

test('interleaving terminates even if max exceeds all available tracks', () => {
  assert.deepEqual(interleavePlays([], 40), []);
  assert.deepEqual(interleavePlays([sample], 40), [sample]);
  const other = { ...sample, station: 'lotradio' };
  assert.deepEqual(interleavePlays([sample, sample, other], 40), [sample, other, sample]);
});

test('Discogs genres and styles come first, then MusicBrainz; Discogs fills a missing year', () => {
  const song = { ...sample, artist: 'McCoy Tyner', title: 'My Favorite Things' };
  const key = songKey(song);
  const discogs = { [key]: { genres: ['Jazz'], styles: ['Hard Bop', 'Modal'], year: 1963, source: 'track' } };
  const musicbrainz = { [key]: { genres: ['post-bop'] } };
  assert.deepEqual(withOwnGenres(song, discogs, musicbrainz).genres, ['jazz', 'hard bop', 'modal']);
  assert.equal(withOwnGenres(song, discogs, musicbrainz).releaseYear, 1963);
  assert.equal(withOwnGenres({ ...song, releaseYear: 1961 }, discogs).releaseYear, 1961, 'a known year is kept');
  const empty = { [key]: { genres: [], styles: [], year: null, source: null } };
  assert.deepEqual(withOwnGenres(song, empty, musicbrainz).genres, ['post-bop']);
  assert.deepEqual(withOwnGenres(song).genres, []);
});

test('length prefers measured recordings over sleeve listings; tempo comes from Deezer', () => {
  const song = { ...sample, artist: 'McCoy Tyner', title: 'My Favorite Things' };
  const key = songKey(song);
  const discogs = { [key]: { genres: [], styles: [], length: 820 } };
  assert.equal(withOwnGenres(song, discogs).length, 820);
  assert.equal(withOwnGenres(song, discogs, { [key]: { genres: [], length: 819 } }).length, 819);
  const both = withOwnGenres(song, discogs, { [key]: { genres: [], length: 819 } }, { [key]: { bpm: 132, length: 818 } });
  assert.deepEqual([both.length, both.bpm], [818, 132]);
  const [release] = mergeCatalogue([playToRaw(both)]).releases;
  assert.deepEqual([release.tracks[0].duration, release.tracks[0].bpm], [818, 132]);
});
