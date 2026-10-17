// A bounded import of metadata returned by Radiooooo's public shuffle player.
// This is NOT a database dump or a downloader: no private/premium endpoints,
// authentication, stream URLs, audio, artwork or listening reports are used.
// Radiooooo publishes no catalogue, only one pick at a time, so breadth comes
// from asking for one song per country and decade, a capped number per run.
import { seededRand } from '../rng.js';

const API = 'https://app.radiooooo.com';
const ENDPOINT = `${API}/play/random`;
const MOODS = ['SLOW', 'FAST', 'WEIRD'];
export const RADIOOOOO_DECADES = Array.from({ length: 13 }, (_, i) => 1900 + 10 * i);
export const MAX_PLACE_SAMPLES = 200;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseRadioooooTrack(track) {
  if (!track || typeof track.artist !== 'string' || typeof track.title !== 'string' ||
      !track.artist.trim() || !track.title.trim()) return null;
  const year = Number(track.year);
  const releaseYear = Number.isInteger(year) && year >= 1800 && year <= new Date().getFullYear() + 1 ? year : null;
  const decade = Number(track.decade);
  const country = typeof track.country === 'string' ? track.country : null;
  const mood = typeof track.mood === 'string' ? track.mood.toLowerCase() : null;
  return {
    station: 'radiooooo',
    show: [country, Number.isInteger(decade) && decade >= 1800 ? `${decade}s` : null].filter(Boolean).join(' / ') || 'Public shuffle',
    date: null, // This is a curated selection, not a broadcast timestamp.
    artist: track.artist.trim(), title: track.title.trim(),
    releaseYear, country,
    label: typeof track.label === 'string' ? track.label : null,
    album: typeof track.album === 'string' ? track.album : null,
    ids: { radiooooo: typeof track._id === 'string' ? track._id : null },
    sourceUrl: 'https://app.radiooooo.com/',
    tags: [mood ? `mood:${mood}` : null, Number.isInteger(decade) && decade >= 1800 ? `decade:${decade}s` : null].filter(Boolean),
  };
}

export async function fetchRadioooooPlays({ samples = 16, fetchImpl = fetch, delayMs = 2000 } = {}) {
  if (!Number.isInteger(samples) || samples < 1 || samples > 30) throw new Error('Radiooooo sample count must be between 1 and 30.');
  const result = [], seen = new Set();
  for (let i = 0; i < samples; i++) {
    if (i && delayMs > 0) await wait(delayMs);
    const res = await fetchImpl(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'random', moods: ['SLOW', 'FAST'], priority: 'auto' }),
      signal: AbortSignal.timeout(20000) });
    // Stop on auth challenges or throttling; never try to bypass them.
    if (!res.ok) throw new Error(`Radiooooo public player unavailable (${res.status}). No access workarounds attempted.`);
    const data = await res.json();
    if (data.error) throw new Error(`Radiooooo public player: ${data.error}`);
    const play = parseRadioooooTrack(data);
    if (!play) continue;
    const key = JSON.stringify([play.artist.toLowerCase(), play.title.toLowerCase()]);
    if (!seen.has(key)) { seen.add(key); result.push(play); }
  }
  return result;
}

/** "IRN/1970": a country in a decade, the unit Radiooooo's map is made of. */
export const placeKey = ({ country, decade }) => `${country}/${decade}`;

/** The place a parsed Radiooooo pick came from, or null. */
export function placeOf(play) {
  const decade = Number(/^decade:(\d{4})s$/.exec((play.tags ?? []).find((t) => t.startsWith('decade:')) ?? '')?.[1]);
  return play.station === 'radiooooo' && play.country && decade ? { country: play.country, decade } : null;
}

/** Every country Radiooooo has songs for in each decade, as { country, decade } places. */
export async function fetchRadioooooPlaces({ decades = RADIOOOOO_DECADES, fetchImpl = fetch, delayMs = 2000 } = {}) {
  const places = [];
  for (const [i, decade] of decades.entries()) {
    if (i && delayMs > 0) await wait(delayMs);
    const res = await fetchImpl(`${API}/country/mood?decade=${decade}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Radiooooo country list unavailable (${res.status}). No access workarounds attempted.`);
    const byMood = await res.json();
    const countries = new Set(Object.values(byMood ?? {}).flat().filter((c) => typeof c === 'string' && /^[A-Z]{3}$/.test(c)));
    for (const country of [...countries].sort()) places.push({ country, decade });
  }
  return places;
}

/**
 * Places in visiting order: each decade in turn, countries shuffled within it
 * (seeded, so reruns agree), skipping places already sampled. A capped run
 * then spreads over the whole century and many countries.
 */
export function spreadPlaces(places, { skip = new Set(), seed = 'radiooooo' } = {}) {
  const rand = seededRand(seed);
  const byDecade = new Map();
  for (const place of places) {
    if (skip.has(placeKey(place))) continue;
    if (!byDecade.has(place.decade)) byDecade.set(place.decade, []);
    byDecade.get(place.decade).push(place);
  }
  const lists = [...byDecade.keys()].sort((a, b) => a - b).map((decade) => {
    const list = byDecade.get(decade);
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  });
  const order = [];
  for (let i = 0; i < Math.max(0, ...lists.map((l) => l.length)); i++) {
    for (const list of lists) if (list[i]) order.push(list[i]);
  }
  return order;
}

/**
 * One public pick per place, `delayMs` apart, until `max` distinct songs. A
 * place with nothing to play is skipped; a refusal or limit stops the run and
 * keeps what was picked so far.
 */
export async function sampleRadioooooPlaces(places, { max = 120, fetchImpl = fetch, delayMs = 2000, onPick = () => {} } = {}) {
  if (!Number.isInteger(max) || max < 1 || max > MAX_PLACE_SAMPLES) {
    throw new Error(`Radiooooo sample count must be between 1 and ${MAX_PLACE_SAMPLES}.`);
  }
  const plays = [], seen = new Set();
  for (const [i, place] of places.entries()) {
    if (plays.length >= max) break;
    if (i && delayMs > 0) await wait(delayMs);
    let res;
    try {
      res = await fetchImpl(`${API}/play`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'explore', isocodes: [place.country], decades: [place.decade], moods: MOODS }),
        signal: AbortSignal.timeout(20000) });
    } catch (error) {
      return { plays, error: new Error(`Radiooooo did not answer (${error.message})`) };
    }
    if (res.status === 404) { onPick({ place, play: null }); continue; }
    // Stop on auth challenges or throttling; never try to bypass them.
    if (!res.ok) return { plays, error: new Error(`Radiooooo public player unavailable (${res.status}). No access workarounds attempted.`) };
    const data = await res.json();
    const play = data.error ? null : parseRadioooooTrack(data);
    const key = play && JSON.stringify([play.artist.toLowerCase(), play.title.toLowerCase()]);
    if (play && !seen.has(key)) { seen.add(key); plays.push(play); }
    onPick({ place, play: play && plays.at(-1) === play ? play : null });
  }
  return { plays, error: null };
}
