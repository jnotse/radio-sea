import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNtsTracklist,
  parseMixcloudCloudcast,
  fetchNtsSchedule,
  fetchNtsPlays,
  fetchMixcloudPlays,
  fetchRadioPlays,
} from '../src/catalog/radio.js';

function mockFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [pattern, payload] of routes) {
      if (String(url).includes(pattern)) {
        return {
          ok: true,
          status: 200,
          json: async () => payload,
          text: async () => JSON.stringify(payload),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  fn.calls = calls;
  return fn;
}

const NTS_TRACKLIST_FIXTURE = {
  metadata: { resultset: { count: 1, offset: 0, limit: 0 } },
  results: [
    {
      artist: 'Uranium Club',
      title: "God's Chest",
      uid: '26857165-5b01-405d-a765-9d65765ba0a2',
      offset: 0,
      duration: 205,
      isrc_id: 'GBHLW1603489',
      deezer_track_id: 137844667,
      musicbrainz_track_id: '7513ebc4-a9ae-4143-97b8-be178c826aa2',
    },
    { artist: 'Bedroom', title: 'In My Head', uid: 'x', offset: 214, duration: 344, isrc_id: 'QZ4JJ1725439' },
  ],
};

test('parseNtsTracklist keeps identifiers for later matching', () => {
  const [first, second] = parseNtsTracklist(NTS_TRACKLIST_FIXTURE, {
    show: 'SHAMOS',
    date: '2026-10-13',
    episodeUrl: 'https://www.nts.live/api/v2/shows/shamos/episodes/shamos-13th-october-2026',
  });
  assert.equal(first.station, 'nts');
  assert.equal(first.artist, 'Uranium Club');
  assert.equal(first.ids.isrc, 'GBHLW1603489');
  assert.equal(first.ids.musicbrainz, '7513ebc4-a9ae-4143-97b8-be178c826aa2');
  assert.equal(second.ids.deezer, null);
});

test('fetchNtsPlays walks schedule -> episode tracklists', async () => {
  const fetchImpl = mockFetch([
    [
      '/radio/schedule/',
      {
        results: [
          {
            date: '2026-10-13',
            broadcasts: [
              {
                broadcast_title: 'SHAMOS',
                start_timestamp: '2026-10-13T20:00:00+01:00',
                links: [{ rel: 'details', href: 'https://www.nts.live/api/v2/shows/shamos/episodes/shamos-13th-october-2026' }],
              },
            ],
          },
        ],
      },
    ],
    ['/tracklist', NTS_TRACKLIST_FIXTURE],
  ]);

  const schedule = await fetchNtsSchedule({ fetchImpl });
  assert.equal(schedule[0].show, 'SHAMOS');

  const plays = await fetchNtsPlays({ fetchImpl, maxEpisodes: 5 });
  assert.equal(plays.length, 2);
  assert.ok(fetchImpl.calls.some((url) => url.endsWith('/tracklist')));
});

test('parseMixcloudCloudcast reads sections and show tags', () => {
  const plays = parseMixcloudCloudcast(
    {
      name: 'Worldwide FM Show',
      url: 'https://www.mixcloud.com/worldwidefm/show/',
      created_time: '2026-10-12T12:00:00Z',
      tags: [{ name: 'jazz' }, { name: 'afrobeat' }],
      sections: [
        { track: { name: 'Water No Get Enemy', artist: { name: 'Fela Kuti' } } },
        { track: { name: 'Untitled', artist: { name: 'Someone' } } },
        { comment: 'chatting' },
      ],
    },
    'worldwidefm',
  );
  assert.equal(plays.length, 2);
  assert.equal(plays[0].station, 'worldwidefm');
  assert.equal(plays[0].date, '2026-10-12');
  assert.deepEqual(plays[0].showGenres, ['jazz', 'afrobeat']);
});

test('fetchMixcloudPlays lists recent cloudcasts then reads each tracklist', async () => {
  const fetchImpl = mockFetch([
    ['/cloudcasts/', { data: [{ slug: 'show-one' }, { slug: 'show-two' }] }],
    ['show-one', { name: 'One', sections: [{ track: { name: 'T1', artist: { name: 'A1' } } }] }],
    ['show-two', { name: 'Two', sections: [] }],
  ]);
  const plays = await fetchMixcloudPlays({ user: 'thelotradio', station: 'lotradio', limit: 2, fetchImpl });
  assert.equal(plays.length, 1);
  assert.equal(plays[0].station, 'lotradio');
});

test('fetchRadioPlays aggregates stations and survives one failing station', async () => {
  const fetchImpl = mockFetch([
    ['/radio/schedule/', { results: [] }],
    ['/cloudcasts/', { data: [] }],
  ]);
  const broken = [
    { id: 'nts', label: 'NTS', kind: 'nts' },
    { id: 'down', label: 'Down FM', kind: 'mixcloud', user: 'downfm' },
    { id: 'lotradio', label: 'Lot', kind: 'mixcloud', user: 'thelotradio' },
  ];
  // Make the 'downfm' user call fail hard.
  const failingFetch = async (url, opts) => {
    if (String(url).includes('downfm')) throw new Error('network down');
    return fetchImpl(url, opts);
  };

  const { plays, errors } = await fetchRadioPlays({ stations: broken, fetchImpl: failingFetch });
  assert.ok(Array.isArray(plays));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].station, 'down');
});
