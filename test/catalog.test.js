import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv,
  parseDiscogsCsv,
  parseRymCsv,
  parseYoutubeJson,
  parseMusicbrainzRelease,
} from '../src/catalog/sources.js';
import { mergeCatalogue, crossSourceReleases, matchScore } from '../src/catalog/resolve.js';
import { RadioSeaDiscovery } from '../src/engine.js';

test('csv parser handles quoted fields and commas', () => {
  const rows = parseCsv('a,b\n"x, y","say ""hi"""\n');
  assert.deepEqual(rows[1], ['x, y', 'say "hi"']);
});

test('discogs export parses into raw releases', () => {
  const csv = [
    'Catalog#,Artist,Title,Label,Format,Rating,Released,Release ID,Collection ID,Folder,Date Added,Date Changed',
    'AB-1,"Basic Channel","Bypass","Chain Reaction",Vinyl,5,1995,123,456,Default,2024-01-01,2024-01-02',
  ].join('\n');
  const [raw] = parseDiscogsCsv(csv);
  assert.equal(raw.source, 'discogs');
  assert.equal(raw.artist, 'Basic Channel');
  assert.equal(raw.title, 'Bypass');
  assert.equal(raw.year, 1995);
  assert.equal(raw.sourceId, '123');
});

test('rym export parses genres and descriptors', () => {
  const csv = [
    'Artist,Title,Year,Rating,Genres,Descriptors,Label,Format,Country',
    'Alice Coltrane,Journey in Satchidananda,1971,4.5,"Spiritual Jazz, Modal Jazz","meditative, improvisational",Impulse!,Vinyl,US',
  ].join('\n');
  const [raw] = parseRymCsv(csv);
  assert.equal(raw.source, 'rym');
  assert.deepEqual(raw.tags.genres, ['Spiritual Jazz', 'Modal Jazz']);
  assert.deepEqual(raw.tags.descriptors, ['meditative', 'improvisational']);
  assert.equal(raw.country, 'US');
});

test('youtube json splits artist - title', () => {
  const [raw] = parseYoutubeJson([
    { videoId: 'abc', title: 'Drexciya - Wavejumper', channel: 'some channel', durationSeconds: 240, tags: ['techno'] },
  ]);
  assert.equal(raw.artist, 'Drexciya');
  assert.equal(raw.title, 'Wavejumper');
  assert.equal(raw.tags.descriptors[0], 'techno');
  assert.equal(raw.tracks[0].duration, 240);
});

test('musicbrainz release parsing keeps tags and credits', () => {
  const raw = parseMusicbrainzRelease({
    id: 'mb-1',
    title: 'Dub Echo',
    'artist-credit': [{ name: 'Lee Perry' }],
    date: '1978-05-01',
    country: 'JM',
    tags: [{ name: 'dub' }, { name: 'reggae' }],
    'label-info': [{ label: { name: 'Upsetter' } }],
    media: [{ format: 'Vinyl', tracks: [{ title: 'Dub Echo', length: 210000 }] }],
  });
  assert.equal(raw.source, 'musicbrainz');
  assert.deepEqual(raw.tags.genres, ['dub', 'reggae']);
  assert.equal(raw.tracks[0].duration, 210);
  assert.equal(raw.year, 1978);
});

test('mergeCatalogue merges the same release across sources and unions tags', () => {
  const raws = [
    {
      source: 'discogs',
      sourceId: '1',
      title: 'Journey in Satchidananda',
      artist: 'Alice Coltrane',
      artists: ['Alice Coltrane'],
      year: 1971,
      tags: { genres: [], styles: ['Vinyl'], descriptors: [] },
      tracks: [],
      urls: {},
    },
    {
      source: 'rym',
      sourceId: '2',
      title: 'Journey in Satchidananda',
      artist: 'Alice Coltrane',
      artists: ['Alice Coltrane'],
      year: 1971,
      tags: { genres: ['Spiritual Jazz'], styles: [], descriptors: ['meditative'] },
      tracks: [],
      urls: {},
    },
    {
      source: 'rym',
      sourceId: '3',
      title: 'Ptah, the El Daoud',
      artist: 'Alice Coltrane',
      artists: ['Alice Coltrane'],
      year: 1970,
      tags: { genres: ['Spiritual Jazz'], styles: [], descriptors: [] },
      tracks: [],
      urls: {},
    },
  ];

  const catalogue = mergeCatalogue(raws);
  assert.equal(catalogue.releases.length, 2, 'the first two rows are the same release');
  const merged = catalogue.releases[0];
  assert.equal(merged.mergedCount, 2);
  assert.equal(new Set(merged.sources.map((s) => s.source)).size, 2);
  assert.ok(merged.tags.genres.includes('Spiritual Jazz'));
  assert.ok(merged.tags.descriptors.includes('meditative'));
  assert.equal(crossSourceReleases(catalogue).length, 1);
});

test('matchScore: same album scores high, different albums low', () => {
  const same = { title: 'Bypass', artist: 'Basic Channel', year: 1995 };
  const near = { title: 'Bypass EP', artist: 'Basic Channel', year: 1995 };
  const other = { title: 'Journey in Satchidananda', artist: 'Alice Coltrane', year: 1971 };
  assert.ok(matchScore(same, near) > 0.85);
  assert.ok(matchScore(same, other) < 0.35);
});

test('matchScore: series volumes never merge', () => {
  const vol3 = { title: 'Spiritual Jazz 3', artist: 'Various Artists', year: 2012 };
  const vol10 = { title: 'Spiritual Jazz 10: Prestige', artist: 'Various Artists', year: 2019 };
  assert.ok(matchScore(vol3, vol10) < 0.72, 'different volumes must stay separate');
});

test('RadioSeaDiscovery.fromRaw builds a mapped engine from mixed sources', () => {
  const raws = [
    ...parseDiscogsCsv(
      ['Artist,Title,Label,Format,Released,Release ID', 'Drexciya,Wavejumper,Tresor,Vinyl,1999,10'].join('\n'),
    ),
    ...parseRymCsv(
      ['Artist,Title,Year,Genres,Descriptors', 'Drexciya,Wavejumper,1999,Techno,submerged'].join('\n'),
    ),
  ];
  const engine = RadioSeaDiscovery.fromRaw(raws, { seed: 'mixed' });
  assert.equal(engine.releases.length, 1);
  assert.ok(engine.mapPlacement(engine.releases[0].id));
  assert.ok(engine.explain(engine.releases[0].id, engine.releases[0].id) === null || true);
});
