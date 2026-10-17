// Tempo, length and loudness from Deezer's public API: no key and no audio.
//
// Each play is matched to a Deezer track by the Deezer ID some tracklists
// carry, else its ISRC, else a strict artist + title search, and the track's
// own artist and title must agree with the play. Deezer reports BPM 0 when it
// does not know the tempo, which is kept as unknown rather than as 0 BPM.
//
// Deezer allows about 50 requests per 5 seconds. A refused or failed request
// stops the run so it can resume; it is never recorded as "no data".

import { songKey } from './extend.js';
import { titleSimilarity, artistSimilarity, normalizeIsrc } from './text.js';

const API = 'https://api.deezer.com';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DeezerUnavailable extends Error {}

/** Same song and artist? */
export function deezerMatches(play, track) {
  return titleSimilarity(play.title, track?.title ?? '') >= 0.6 && artistSimilarity(play.artist, track?.artist?.name ?? '') >= 0.5;
}

export function deezerQuery(play) {
  const quote = (text) => `"${String(text).replace(/"/g, '')}"`;
  const primaryArtist = String(play.artist).split(/,\s+|\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0];
  return `artist:${quote(primaryArtist)} track:${quote(play.title)}`;
}

async function getJson(path, fetchImpl) {
  let res;
  try { res = await fetchImpl(`${API}${path}`, { signal: AbortSignal.timeout(20000) }); }
  catch (error) { throw new DeezerUnavailable(`Deezer did not answer (${error.message})`); }
  if (!res.ok) throw new DeezerUnavailable(`Deezer answered ${res.status}`);
  const body = await res.json();
  if (body?.error) {
    // 800 is Deezer's "no data"; anything else (quota, outage) is temporary.
    if (body.error.code === 800) return null;
    throw new DeezerUnavailable(`Deezer refused the request (${body.error.message ?? body.error.code})`);
  }
  return body;
}

/** { deezer, bpm, length, gain } for one play, or nulls when Deezer has no matching track. */
export async function lookupDeezer(play, { fetchImpl = fetch, pause = () => wait(150) } = {}) {
  const get = async (path) => { await pause(); return getJson(path, fetchImpl); };
  const checked = (track) => (track && deezerMatches(play, track) ? track : null);
  const isrc = normalizeIsrc(play.ids?.isrc);
  let track = null;
  if (play.ids?.deezer) track = checked(await get(`/track/${encodeURIComponent(play.ids.deezer)}`));
  if (!track && isrc) track = checked(await get(`/track/isrc:${isrc}`));
  if (!track) {
    const found = await get(`/search?q=${encodeURIComponent(deezerQuery(play))}&limit=5`);
    const hit = (found?.data ?? []).find((t) => deezerMatches(play, t));
    // Search results leave out the tempo, so fetch the full track.
    if (hit) track = checked(await get(`/track/${hit.id}`));
  }
  if (!track) return { deezer: null, bpm: null, length: null, gain: null };
  return {
    deezer: track.id,
    bpm: track.bpm > 0 ? Math.round(track.bpm) : null,
    length: track.duration > 0 ? track.duration : null,
    gain: Number.isFinite(track.gain) ? track.gain : null,
  };
}

/**
 * Look up every song not yet in `cache` (keyed like the radio cache), with
 * checkpoints. Stops at the first failed request and reports it.
 */
export async function lookupDeezerForPlays(plays, { cache = {}, lookup = lookupDeezer,
  onProgress = () => {}, checkpoint = async () => {}, ...options } = {}) {
  const result = { ...cache };
  const todo = [...new Map(plays.map((play) => [songKey(play), play])).entries()].filter(([key]) => !(key in result));
  for (const [index, [key, play]] of todo.entries()) {
    let found;
    try {
      found = await lookup(play, options);
    } catch (error) {
      await checkpoint(result);
      return { cache: result, done: index, total: todo.length, error };
    }
    result[key] = { ...found, checkedAt: new Date().toISOString() };
    onProgress({ index: index + 1, total: todo.length, play, ...found });
    if ((index + 1) % 20 === 0) await checkpoint(result);
  }
  await checkpoint(result);
  return { cache: result, done: todo.length, total: todo.length, error: null };
}
