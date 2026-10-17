import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCatalogue } from '../src/catalog/resolve.js';
import { factsOnMap, interleavePlays, playToRaw, withOwnGenres } from '../scripts/build-demo.js';
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

test('YouTube fills in length, album and label last, and they reach the map', () => {
  const song = { ...sample, artist: 'Uranium Club', title: "God's Chest", youtube: { ...sample.youtube, videoId: 'VxuNvoiel2g' } };
  const key = songKey(song);
  const youtube = { VxuNvoiel2g: { length: 258, album: 'All Of Them Naturals', label: 'Static Shock' } };
  const alone = withOwnGenres(song, {}, {}, {}, youtube);
  assert.deepEqual([alone.length, alone.album, alone.label], [258, 'All Of Them Naturals', 'Static Shock']);
  assert.equal(withOwnGenres(song, {}, { [key]: { genres: [], length: 125 } }, {}, youtube).length, 125, 'catalogue lengths come first');
  assert.equal(withOwnGenres({ ...song, label: 'Own Label' }, {}, {}, {}, youtube).label, 'Own Label');
  const [release] = mergeCatalogue([playToRaw(alone)]).releases;
  assert.deepEqual([release.tracks[0].album, release.label], ['All Of Them Naturals', 'Static Shock']);
});

test('richer descriptors (instruments, credits, formats, curator channels and co-play sequence) flow into similarity and explainability', () => {
  const songA = {
    ...sample,
    artist: 'Larry Heard',
    title: 'Micro-Gravity',
    position: 3,
    youtube: { videoId: 'H_AKKQ-f9LM', url: 'https://www.youtube.com/watch?v=H_AKKQ-f9LM' },
  };
  const songB = {
    ...sample,
    artist: 'Mr. Fingers',
    title: 'Mystery of Love',
    position: 4,
    youtube: { videoId: 'FiCEdQl91v4', url: 'https://www.youtube.com/watch?v=FiCEdQl91v4' },
  };
  const keyA = songKey(songA);
  const keyB = songKey(songB);
  const discogs = {
    [keyA]: { genres: ['Electronic'], styles: ['Deep House'], year: 1996, label: 'Alleviated', country: 'US', formats: ['12"'], instruments: ['synthesizer', 'fender rhodes'], credits: ['Larry Heard'] },
    [keyB]: { genres: ['Electronic'], styles: ['Deep House'], year: 1985, label: 'Alleviated', country: 'US', formats: ['12"'], instruments: ['synthesizer', 'fender rhodes'], credits: ['Larry Heard'] },
  };
  const youtube = {
    'H_AKKQ-f9LM': { length: 621, channel: 'Shindō Vibrations', views: 35000 },
    'FiCEdQl91v4': { length: 412, channel: 'Shindō Vibrations', views: 1500 },
  };

  const enrichedA = withOwnGenres(songA, discogs, {}, {}, youtube);
  const enrichedB = withOwnGenres(songB, discogs, {}, {}, youtube);
  const { releases } = mergeCatalogue([playToRaw(enrichedA), playToRaw(enrichedB)]);
  assert.equal(releases[0].country, 'US');
  assert.equal(releases[0].label, 'Alleviated');
  assert.ok(releases[0].tags.all.includes('inst:fender rhodes'));
  assert.ok(releases[0].tags.all.includes('credit:larry heard'));
  assert.ok(releases[0].tags.all.includes('format:12"'));
  assert.ok(releases[0].tags.all.includes('channel:Shindō Vibrations'));
});

test("Guano's facts: genres on the map, and artists only for the songs their fact was checked against", () => {
  const written = {
    genres: { kuduro: 'Kuduro comes from Luanda.', polka: 'Polka is from Bohemia.' },
    artists: {
      'Buraka Som Sistema': { songs: ['Kalemba (Wegue Wegue)'], text: 'A Lisbon kuduro group.' },
      Solar: { songs: ['Your Secret'], text: 'A Dutch duo.' },
    },
  };
  const releases = [
    { artist: 'Buraka Som Sistema', name: 'kalemba (wegue wegue)', tags: ['kuduro', 'show-genre:polka', 'station:nts'] },
    // Another song under a name with a fact: maybe someone else, so no fact until it is checked.
    { artist: 'Solar', name: 'Your Secret', tags: [] }, { artist: 'Solar', name: 'Something Else', tags: [] },
  ];
  assert.deepEqual(factsOnMap(releases, written), {
    genres: { kuduro: { text: 'Kuduro comes from Luanda.' } },
    artists: { 'Buraka Som Sistema': { text: 'A Lisbon kuduro group.' } },
  });
  // Names written with combining accents still match.
  assert.deepEqual(factsOnMap([{ artist: 'Jose\u0301', name: 'Song', tags: ['funana\u0301'] }],
    { genres: { 'funaná': 'From Cape Verde.' }, artists: { 'José': { songs: ['Song'], text: 'A singer.' } } }),
  { genres: { 'funana\u0301': { text: 'From Cape Verde.' } }, artists: { 'Jose\u0301': { text: 'A singer.' } } });
  assert.deepEqual(factsOnMap(releases), { genres: {}, artists: {} }, 'nothing written yet');
});

test('every written fact fits a speech bubble and names something on the map', async () => {
  const { readFile } = await import('node:fs/promises');
  const written = JSON.parse(await readFile(new URL('../data/guano-facts.json', import.meta.url), 'utf8'));
  const map = JSON.parse(await readFile(new URL('../demo/sea-data.json', import.meta.url), 'utf8'));
  for (const text of [...Object.values(written.genres), ...Object.values(written.artists).map((a) => a.text)]) {
    assert.ok(text.length >= 30 && text.length <= 220, `fits a bubble: ${text}`);
  }
  const facts = factsOnMap(map.releases, written);
  assert.equal(Object.keys(facts.genres).length, Object.keys(written.genres).length, 'every genre fact is for a genre on the map');
  const key = (name) => name.normalize('NFC').toLowerCase();
  const used = new Set(Object.keys(facts.artists).map(key));
  for (const name of Object.keys(written.artists)) assert.ok(used.has(key(name)), `${name}'s fact is for songs on the map`);
});

test('a channel upload takes its linked record\'s spelling, album and label before the uploader\'s own', () => {
  const upload = { ...sample, station: 'floorlengthskirts', show: null, artist: 'koji nakamura', title: 'the right world', releaseYear: 1993,
    labelHint: 'cultdep', youtube: { ...sample.youtube, via: 'channel' } };
  const key = songKey(upload);
  const discogs = { [key]: { genres: ['Electronic'], styles: ['Synth-pop'], year: 2012, source: 'link', album: 'Tokio Explosion Vol.2',
    label: 'Cultdep', artistName: 'Koji Nakamura', trackTitle: 'The Right World' } };
  const song = withOwnGenres(upload, discogs);
  assert.deepEqual([song.artist, song.title, song.album, song.label, song.releaseYear], ['Koji Nakamura', 'The Right World', 'Tokio Explosion Vol.2', 'Cultdep', 1993]);
  assert.equal(withOwnGenres(upload).label, 'cultdep', 'without Discogs, the uploader\'s label');
  const [release] = mergeCatalogue([playToRaw(song)]).releases;
  assert.equal(release.radioPlays[0].show, '');
});
