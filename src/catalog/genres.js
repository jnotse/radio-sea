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
import { titleSimilarity, artistSimilarity } from './text.js';

const API = 'https://musicbrainz.org/ws/2';
const HEADERS = { 'User-Agent': 'radio-sea/0.1 ( https://github.com/jnotse/radio-sea )', Accept: 'application/json' };
const MAX_GENRES = 3;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The most-voted genres of a recording or artist, lowercase as MusicBrainz names them. */
export function topGenres(entity, limit = MAX_GENRES) {
  return [...(entity?.genres ?? [])]
    .filter((genre) => genre?.name && (genre.count ?? 1) > 0)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((genre) => genre.name.toLowerCase());
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
  backoff = (attempt) => wait(2000 * 2 ** attempt), artistGenres = new Map() } = {}) {
  const get = async (path) => { await pause(); return getJson(path, fetchImpl, backoff); };
  const recordingById = async (id) => {
    const recording = await get(`/recording/${encodeURIComponent(id)}?inc=genres+artist-credits&fmt=json`);
    return recording && recordingMatches(play, recording, { minScore: 0 }) ? recording : null;
  };

  let recording = null;
  if (play.ids?.musicbrainz) recording = await recordingById(play.ids.musicbrainz);
  if (!recording && play.ids?.isrc) {
    // ISRC listings may omit artist credits; the recording lookup checks the artist.
    const listed = await get(`/isrc/${encodeURIComponent(play.ids.isrc)}?fmt=json`);
    const hit = (listed?.recordings ?? []).find((r) => titleSimilarity(play.title, r.title ?? '') >= 0.6);
    if (hit) recording = await recordingById(hit.id);
  }
  if (!recording) {
    const found = await get(`/recording?query=${encodeURIComponent(searchQuery(play))}&limit=5&fmt=json`);
    const hit = (found?.recordings ?? []).find((r) => recordingMatches(play, r));
    if (hit) recording = await recordingById(hit.id);
  }
  if (!recording) return { genres: [], source: null, recording: null, length: null };

  const length = recording.length > 0 ? Math.round(recording.length / 1000) : null;
  const own = topGenres(recording);
  if (own.length) return { genres: own, source: 'recording', recording: recording.id, length };
  const artistId = recording['artist-credit']?.[0]?.artist?.id;
  if (!artistId) return { genres: [], source: null, recording: recording.id, length };
  if (!artistGenres.has(artistId)) {
    artistGenres.set(artistId, topGenres(await get(`/artist/${encodeURIComponent(artistId)}?inc=genres&fmt=json`)));
  }
  const fromArtist = artistGenres.get(artistId);
  return { genres: fromArtist, source: fromArtist.length ? 'artist' : null, recording: recording.id, length };
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
    .filter(([key]) => !(key in result) || !('length' in result[key]));
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
