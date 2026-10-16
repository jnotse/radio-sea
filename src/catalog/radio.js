// Radio tracklist adapters: NTS, Worldwide FM, The Lot Radio.
//
// All three normalize into RadioPlay:
//   { station, show, date, artist, title, ids: { isrc, deezer, musicbrainz }, sourceUrl, tags[] }
//
// NTS has a first-party JSON API (the public client token is embedded in their
// own web app). Worldwide FM and The Lot Radio publish their shows on
// Mixcloud, whose keyless API returns per-show tracklists.

const NTS_API = 'https://www.nts.live/api/v2';

import { fetchLotRadioPlays } from './lotradio.js';
import { fetchRadioooooPlays } from './radiooooo.js';
// Public client token, shipped in https://www.nts.live/js/app.min.*.js
// (window.nts_env.NTS_API_TOKEN, used as `Authorization: Basic <token>`).
export const NTS_CLIENT_TOKEN = '48fhsdjEK7349fCJBS';

const NTS_HEADERS = { Authorization: `Basic ${NTS_CLIENT_TOKEN}` };

// --- NTS ------------------------------------------------------------------

/** One day of broadcasts on a channel (1 or 2). */
export async function fetchNtsSchedule({ channel = 1, pastDays = 3, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${NTS_API}/radio/schedule/${channel}?past_days=${pastDays}`, {
    headers: NTS_HEADERS,
  });
  if (!res.ok) throw new Error(`nts schedule failed: ${res.status}`);
  const json = await res.json();
  return (json.results ?? []).flatMap((day) =>
    (day.broadcasts ?? []).map((broadcast) => ({
      date: broadcast.start_timestamp ?? day.date ?? null,
      show: broadcast.broadcast_title ?? '',
      episodeUrl: (broadcast.links ?? []).find((l) => l.rel === 'details')?.href ?? null,
    })),
  );
}

export function parseNtsTracklist(json, { show = '', date = null, episodeUrl = null, genres = [] } = {}) {
  return (json.results ?? []).map((track) => ({
    station: 'nts',
    show,
    date,
    artist: track.artist ?? '',
    title: track.title ?? '',
    ids: {
      isrc: track.isrc_id ?? null,
      deezer: track.deezer_track_id ?? null,
      musicbrainz: track.musicbrainz_track_id ?? null,
    },
    sourceUrl: episodeUrl,
    tags: genres,
  }));
}

/** Fetch tracklists for NTS episodes of the last `pastDays` days (with genres). */
export async function fetchNtsPlays({ channel = 1, pastDays = 3, maxEpisodes = 10, fetchImpl = fetch } = {}) {
  const broadcasts = (await fetchNtsSchedule({ channel, pastDays, fetchImpl }))
    .filter((b) => b.episodeUrl)
    .slice(0, maxEpisodes);

  const plays = [];
  for (const broadcast of broadcasts) {
    const res = await fetchImpl(`${broadcast.episodeUrl}/tracklist`, { headers: NTS_HEADERS });
    if (!res.ok) continue;

    // Episode details carry the show's genre and mood tags — the mapping
    // layer's main sound signal for NTS plays.
    let genres = [];
    try {
      const detail = await fetchImpl(broadcast.episodeUrl, { headers: NTS_HEADERS });
      if (detail.ok) {
        const json = await detail.json();
        const names = (list) => (list ?? []).map((g) => (typeof g === 'string' ? g : g.value ?? g.name)).filter(Boolean);
        genres = [...names(json.genres), ...names(json.moods)];
      }
    } catch {}

    plays.push(...parseNtsTracklist(await res.json(), { ...broadcast, genres }));
  }
  return plays;
}

// --- Mixcloud (Worldwide FM, The Lot Radio) --------------------------------

export function parseMixcloudCloudcast(cloudcast, station) {
  const tags = (cloudcast.tags ?? []).map((t) => t.name ?? t).filter(Boolean);
  return (cloudcast.sections ?? [])
    .filter((section) => section.track)
    .map((section) => ({
      station,
      show: cloudcast.name ?? '',
      date: cloudcast.created_time ? String(cloudcast.created_time).slice(0, 10) : null,
      artist: section.track.artist?.name ?? '',
      title: section.track.name ?? '',
      ids: {},
      sourceUrl: cloudcast.url ?? null,
      tags,
    }));
}

export async function fetchMixcloudPlays({ user, station = user, limit = 5, fetchImpl = fetch } = {}) {
  // Recent uploads often have no tracklist yet, so look deeper and keep only
  // the shows that actually carry one.
  const listRes = await fetchImpl(`https://api.mixcloud.com/${user}/cloudcasts/?limit=${limit * 3}`);
  if (!listRes.ok) throw new Error(`mixcloud list failed: ${listRes.status}`);
  const list = await listRes.json();

  const plays = [];
  for (const cast of list.data ?? []) {
    if (plays.length >= limit * 10) break;
    const detailRes = await fetchImpl(`https://api.mixcloud.com/${user}/${cast.slug}/`);
    if (!detailRes.ok) continue;
    plays.push(...parseMixcloudCloudcast(await detailRes.json(), station));
  }
  return plays;
}

// --- one entry point -------------------------------------------------------

export const RADIO_STATIONS = [
  { id: 'nts', label: 'NTS Radio', kind: 'nts', channel: 1 },
  { id: 'worldwidefm', label: 'Worldwide FM', kind: 'mixcloud', user: 'worldwidefm' },
  { id: 'lotradio', label: 'The Lot Radio', kind: 'lotshow', categories: ['special-guests'] },
  { id: 'radiooooo', label: 'Radiooooo', kind: 'radiooooo' },
];

/**
 * Pull recent plays from all stations. Per-station failures are reported, not
 * fatal: a station with no tracklists published should not sink the scan.
 */
export async function fetchRadioPlays({ stations = RADIO_STATIONS, fetchImpl = fetch, maxEpisodes = 8 } = {}) {
  const plays = [];
  const errors = [];
  for (const station of stations) {
    try {
      let rows;
      if (station.kind === 'nts') {
        rows = await fetchNtsPlays({ channel: station.channel ?? 1, maxEpisodes, fetchImpl });
      } else if (station.kind === 'lotshow') {
        const { plays: lotPlays, errors: lotErrors } = await fetchLotRadioPlays({
          categories: station.categories ?? ['special-guests'],
          fetchImpl,
        });
        rows = lotPlays;
        errors.push(...lotErrors.map((e) => ({ station: station.id, message: `${e.category}: ${e.message}` })));
      } else if (station.kind === 'radiooooo') {
        rows = await fetchRadioooooPlays({ samples: 8, fetchImpl });
      } else {
        rows = await fetchMixcloudPlays({ user: station.user, station: station.id, limit: maxEpisodes, fetchImpl });
      }
      plays.push(...rows);
    } catch (error) {
      errors.push({ station: station.id, message: error.message });
    }
  }
  return { plays, errors };
}
