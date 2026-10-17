// Per-track genres from MusicBrainz, so tracks are mapped by what they are
// rather than by how a station describes the whole show.
//
// For each play: find its MusicBrainz recording (by the recording ID or ISRC
// some tracklists carry, else by a strict artist + title search) and take the
// recording's community genres. Recordings are often untagged, so fall back to
// the primary artist's genres. No confident match means no genres: unknown
// stays unknown rather than borrowing the show's tags.
//
// MusicBrainz asks for a descriptive User-Agent and at most one request per
// second, and answers 503 when busy: those requests are retried after a
// growing wait. A request that still fails stops the run so it can resume
// later; it is never recorded as "no genres".

import { songKey } from './extend.js';
import { titleSimilarity, artistSimilarity, normalizeIsrc } from './text.js';
import { youtubeIdFromUrl } from './youtube-link.js';

const API = 'https://musicbrainz.org/ws/2';
const HEADERS = { 'User-Agent': 'g-digs/0.1 ( https://github.com/jnotse/radio-sea )', Accept: 'application/json' };
const MAX_GENRES = 3;
const MAX_TAGS = 4;
const NOISE_TAGS = new Set([
  'seen live', 'favorites', 'favourites', 'favorite', 'favourite', 'owned',
  'check', 'spotify', 'awesome', 'love', 'loved', 'good', 'best', 'my music',
]);
const NON_COUNTRIES = new Set(['XW', 'XE', 'XU']);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The most-voted genres of a recording or artist, lowercase as MusicBrainz names them. */
export function topGenres(entity, limit = MAX_GENRES) {
  return [...(entity?.genres ?? [])]
    .filter((genre) => genre?.name && (genre.count ?? 1) > 0)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((genre) => genre.name.toLowerCase());
}

/** Community folksonomy tags not already in `genres`, excluding personal bookmark tags. */
export function topTags(entity, exclude = [], limit = MAX_TAGS) {
  const skip = new Set([...exclude.map((g) => g.toLowerCase()), ...NOISE_TAGS]);
  return [...(entity?.tags ?? [])]
    .map((tag) => ({ name: String(tag?.name ?? '').trim().toLowerCase(), count: tag?.count ?? 1 }))
    .filter((tag) => tag.name.length > 1 && tag.count > 0 && !skip.has(tag.name) && !/^\d+$/.test(tag.name))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((tag) => tag.name);
}

function releaseYear(recording) {
  const dates = [
    recording?.['first-release-date'],
    ...(recording?.releases ?? []).map((r) => r?.date),
  ].filter(Boolean);
  const years = dates
    .map((d) => Number(String(d).match(/^(\d{4})/)?.[1]))
    .filter((y) => y >= 1900 && y <= new Date().getFullYear() + 1);
  return years.length ? Math.min(...years) : null;
}

function releaseCountry(recording, artist = null) {
  for (const rel of recording?.releases ?? []) {
    const code = String(rel?.country ?? '').trim().toUpperCase();
    if (code && !NON_COUNTRIES.has(code)) return code;
  }
  const artistCountry = String(artist?.country ?? artist?.area?.['iso-3166-1-codes']?.[0] ?? '').trim().toUpperCase();
  return artistCountry && !NON_COUNTRIES.has(artistCountry) ? artistCountry : null;
}

function recordingRelations(recording) {
  const instruments = new Set();
  const credits = new Set();
  for (const rel of recording?.relations ?? []) {
    const type = String(rel?.type ?? '').toLowerCase();
    if (type === 'instrument' || type === 'vocal') {
      for (const attr of rel?.attributes ?? []) {
        const clean = String(attr ?? '').trim().toLowerCase();
        if (clean && clean !== 'lead vocals' && clean !== 'background vocals') instruments.add(clean);
        else if (clean.includes('vocal')) instruments.add('vocals');
      }
    } else if (['producer', 'remixer', 'arranger', 'mix'].includes(type) && rel?.artist?.name) {
      credits.add(String(rel.artist.name).trim());
    }
  }
  return {
    instruments: [...instruments].slice(0, 5),
    credits: [...credits].slice(0, 3),
  };
}

function creditName(recording) {
  return (recording['artist-credit'] ?? []).map((c) => `${c.name ?? c.artist?.name ?? ''}${c.joinphrase ?? ''}`).join('');
}

/** Same song and artist? Search hits must also score highly. */
export function recordingMatches(play, recording, { minScore = 90 } = {}) {
  return (recording?.score ?? 100) >= minScore
    && titleSimilarity(play.title, recording.title ?? '') >= 0.6
    && artistSimilarity(play.artist, creditName(recording)) >= 0.5;
}

export function searchQuery(play) {
  const quote = (text) => `"${String(text).replace(/[\\"]/g, '\\$&')}"`;
  const primaryArtist = String(play.artist).split(/,\s+|\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0];
  return `recording:${quote(play.title)} AND artist:${quote(primaryArtist)}`;
}

const BUSY_RETRIES = 5;

async function getJson(path, fetchImpl, backoff) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetchImpl(`${API}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (res.status === 404) return null;
    if (res.ok) return res.json();
    if (res.status !== 503 || attempt === BUSY_RETRIES) throw new Error(`MusicBrainz request failed (${res.status})`);
    await backoff(attempt);
  }
}

/**
 * Genres for one play: { genres, source: 'recording' | 'artist' | null, recording, length }.
 * `length` is the recording's length in seconds when MusicBrainz knows it.
 * `artistGenres` caches artist lookups across plays.
 */
export async function lookupTrackGenres(play, { fetchImpl = fetch, pause = () => wait(1100),
  backoff = (attempt) => wait(2000 * 2 ** attempt), artistGenres = new Map(), includeVideoLinks = false } = {}) {
  const get = async (path) => { await pause(); return getJson(path, fetchImpl, backoff); };
  const recordingById = async (id) => {
    const recording = await get(`/recording/${encodeURIComponent(id)}?inc=genres+tags+artist-credits+releases+artist-rels${includeVideoLinks ? '+url-rels+recording-rels' : ''}&fmt=json`);
    return recording && recordingMatches(play, recording, { minScore: 0 }) ? recording : null;
  };

  let recording = null;
  if (play.ids?.musicbrainz) recording = await recordingById(play.ids.musicbrainz);
  const isrc = normalizeIsrc(play.ids?.isrc);
  if (!recording && isrc) {
    // ISRC listings may omit artist credits; the recording lookup checks the artist.
    const listed = await get(`/isrc/${isrc}?fmt=json`);
    const hit = (listed?.recordings ?? []).find((r) => titleSimilarity(play.title, r.title ?? '') >= 0.6);
    if (hit) recording = await recordingById(hit.id);
  }
  if (!recording) {
    const found = await get(`/recording?query=${encodeURIComponent(searchQuery(play))}&limit=5&fmt=json`);
    const hit = (found?.recordings ?? []).find((r) => recordingMatches(play, r));
    if (hit) recording = await recordingById(hit.id);
  }
  if (!recording) return { genres: [], source: null, recording: null, length: null,
    ...(includeVideoLinks ? { youtubeCandidates: [], releaseIds: [], videoRecordings: [] } : {}) };

  const linkFacts = includeVideoLinks ? {
    youtubeCandidates: (recording.relations ?? []).filter((r) => youtubeIdFromUrl(r.url?.resource)).map((r) => ({
      videoId: youtubeIdFromUrl(r.url.resource), url: r.url.resource, source: 'musicbrainz',
      sourceUrl: `https://musicbrainz.org/recording/${recording.id}`,
    })),
    releaseIds: [...new Set((recording.releases ?? []).map((r) => r.id).filter(Boolean))].slice(0, 2),
    videoRecordings: (recording.relations ?? []).filter((r) => r.type === 'music video' && r.recording?.id)
      .map((r) => r.recording.id).slice(0, 2),
  } : {};

  const length = recording.length > 0 ? Math.round(recording.length / 1000) : null;
  const year = releaseYear(recording);
  const { instruments, credits } = recordingRelations(recording);
  const own = topGenres(recording);
  if (own.length) {
    const tags = topTags(recording, own);
    const country = releaseCountry(recording);
    return {
      ...linkFacts,
      genres: own,
      source: 'recording',
      recording: recording.id,
      length,
      ...(tags.length ? { tags } : {}),
      ...(year ? { year } : {}),
      ...(country ? { country } : {}),
      ...(instruments.length ? { instruments } : {}),
      ...(credits.length ? { credits } : {}),
    };
  }
  const artistId = recording['artist-credit']?.[0]?.artist?.id;
  if (!artistId) {
    const tags = topTags(recording);
    const country = releaseCountry(recording);
    return {
      ...linkFacts,
      genres: [],
      source: null,
      recording: recording.id,
      length,
      ...(tags.length ? { tags } : {}),
      ...(year ? { year } : {}),
      ...(country ? { country } : {}),
      ...(instruments.length ? { instruments } : {}),
      ...(credits.length ? { credits } : {}),
    };
  }
  if (!artistGenres.has(artistId)) {
    const artist = await get(`/artist/${encodeURIComponent(artistId)}?inc=genres+tags&fmt=json`);
    const genres = topGenres(artist);
    artistGenres.set(artistId, {
      genres,
      tags: topTags(artist, genres),
      country: releaseCountry(null, artist),
    });
  }
  const cachedArtist = artistGenres.get(artistId);
  const fromArtist = Array.isArray(cachedArtist) ? cachedArtist : cachedArtist.genres;
  const artistTags = Array.isArray(cachedArtist) ? [] : cachedArtist.tags;
  const tags = [...new Set([...topTags(recording, fromArtist), ...artistTags])].slice(0, MAX_TAGS);
  const country = releaseCountry(recording) ?? (Array.isArray(cachedArtist) ? null : cachedArtist.country);
  return {
    ...linkFacts,
    genres: fromArtist,
    source: fromArtist.length ? 'artist' : null,
    recording: recording.id,
    length,
    ...(tags.length ? { tags } : {}),
    ...(year ? { year } : {}),
    ...(country ? { country } : {}),
    ...(instruments.length ? { instruments } : {}),
    ...(credits.length ? { credits } : {}),
  };
}

/**
 * Look up every song not yet in `cache` (keyed like the radio cache), with
 * checkpoints. Stops at the first failed request and reports it, keeping
 * what was found so far.
 */
export async function lookupGenresForPlays(plays, { cache = {}, lookup = lookupTrackGenres,
  onProgress = () => {}, checkpoint = async () => {}, ...options } = {}) {
  const result = { ...cache };
  // Entries saved before lengths were recorded are looked up again.
  const todo = [...new Map(plays.map((play) => [songKey(play), play])).entries()]
    .filter(([key]) => !(key in result) || !('length' in result[key])
      || (options.includeVideoLinks && !('youtubeCandidates' in result[key])));
  const artistGenres = new Map();
  for (const [index, [key, play]] of todo.entries()) {
    let found;
    try {
      found = await lookup(play, { artistGenres, ...options });
    } catch (error) {
      await checkpoint(result);
      return { cache: result, done: index, total: todo.length, error };
    }
    result[key] = { ...found, checkedAt: new Date().toISOString() };
    onProgress({ index: index + 1, total: todo.length, play, ...found });
    if ((index + 1) % 10 === 0) await checkpoint(result);
  }
  await checkpoint(result);
  return { cache: result, done: todo.length, total: todo.length, error: null };
}
