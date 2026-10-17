// What YouTube says about each video we play, without the audio or video:
// the metadata YouTube hands its own player (length, channel, description),
// read from the YouTube Data API when a key is given (50 videos per request),
// else from each video's watch page, slowly.
//
// Uploads that labels deliver to YouTube ("… - Topic" channels) carry a
// standard description, from which the album, label and dates are read:
//
//   Provided to YouTube by Static Shock
//   God's Chest · Uranium Club
//   All Of Them Naturals
//   ℗ 2016 Static Shock
//   Released on: 2017-01-13
//
// Tempo and key are not part of this metadata: YouTube does not publish them.
// A limited or failed request stops the run so it can resume; it is never
// recorded as "nothing known".

import { request, readPageJson, videoUrl, YoutubeUnavailable } from './youtube.js';

const API = 'https://www.googleapis.com/youtube/v3/videos';
const BATCH = 50;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Album, label, ℗ year and release date from a "Provided to YouTube by" description. */
export function parseTopicDescription(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const none = { album: null, label: null, year: null, released: null };
  if (!/^Provided to YouTube by /.test(lines[0] ?? '')) return none;
  const credit = lines.findIndex((line) => line.includes(' · '));
  const next = credit >= 0 ? lines[credit + 1] : null;
  const phonogram = lines.map((line) => /^℗\s*(\d{4})?\s*(.*)$/.exec(line)).find(Boolean);
  const released = lines.map((line) => /^Released on:\s*(\d{4}-\d{2}-\d{2})/.exec(line)).find(Boolean);
  return {
    album: next && !/^(℗|©|Released on:|Auto-generated)/.test(next) ? next : null,
    label: phonogram?.[2] || null,
    year: phonogram?.[1] ? Number(phonogram[1]) : null,
    released: released?.[1] ?? null,
  };
}

/**
 * Structured sleeve/Discogs-style metadata often written in vinyl-rip YouTube
 * descriptions ("Label: ...", "Country: ...", "Year: ...", "Style: ...", "Format: ...").
 */
export function parseVinylDescription(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const out = { album: null, label: null, year: null, released: null, country: null, styles: [], formats: [], credits: [] };
  if (!lines.length || /^Provided to YouTube by /.test(lines[0])) return out;

  const splitValues = (val) => val.split(/[,;/]/).map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    const kv = /^([A-Za-z ]{3,16})\s*:\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    const value = kv[2].trim();
    if (!value) continue;

    if ((key === 'label' || key === 'record label') && !out.label) {
      // Strip catalog number suffix like "Mathematics Recordings – MATH042" or "Impulse! (A-48)".
      const cleanLabel = value.split(/\s+[-–—]\s+/)[0].replace(/\s*\[[^\]]*\]\s*$/, '').trim();
      if (cleanLabel && !/^not on label$/i.test(cleanLabel)) out.label = cleanLabel;
    } else if ((key === 'album' || key === 'lp' || key === 'ep') && !out.album) {
      out.album = value;
    } else if ((key === 'country' || key === 'origin') && !out.country) {
      out.country = value;
    } else if ((key === 'year' || key === 'released' || key === 'release date' || key === 'date') && !out.year) {
      const fullDate = /^(\d{4}-\d{2}-\d{2})/.exec(value);
      if (fullDate) out.released = fullDate[1];
      const y = /\b(19\d{2}|20\d{2})\b/.exec(value);
      if (y) out.year = Number(y[1]);
    } else if (key === 'style' || key === 'styles' || key === 'genre' || key === 'genres') {
      for (const s of splitValues(value)) {
        const lower = s.toLowerCase();
        if (lower && !out.styles.includes(lower)) out.styles.push(lower);
      }
    } else if (key === 'format') {
      for (const f of splitValues(value)) {
        const lower = f.toLowerCase();
        if (['12"', '7"', '10"', 'lp', '45 rpm', '33 rpm', 'cassette', 'white label', 'promo'].includes(lower) && !out.formats.includes(lower)) {
          out.formats.push(lower);
        }
      }
    } else if (key === 'producer' || key === 'produced by' || key === 'remix' || key === 'remixed by') {
      for (const c of splitValues(value)) {
        if (c && !out.credits.includes(c)) out.credits.push(c);
      }
    }
  }
  return out;
}

/** True when a YouTube channel is a community/digger curator rather than an artist Topic/VEVO channel. */
export function isCuratorChannel(channel, artist = '') {
  if (!channel || typeof channel !== 'string') return false;
  const trimmed = channel.trim();
  if (!trimmed || /\s-\s*Topic$/i.test(trimmed) || /VEVO$/i.test(trimmed)) return false;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const nc = norm(trimmed.replace(/\b(official|music|channel|records|recordings|tv)\b/gi, ''));
  const na = norm(artist);
  if (!nc || (na && (nc === na || nc.includes(na) || na.includes(nc)))) return false;
  return true;
}

/** Seconds in an ISO 8601 duration such as "PT4M18S". */
export function isoSeconds(duration) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(duration ?? ''));
  if (!m) return null;
  const total = ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 60 + Number(m[4] ?? 0);
  return total > 0 ? total : null;
}

const facts = ({ length, channel, views, description }) => {
  const topic = parseTopicDescription(description);
  const vinyl = !topic.album && !topic.label && !topic.year && !topic.released
    ? parseVinylDescription(description)
    : null;
  return {
    length: Number(length) > 0 ? Number(length) : null,
    channel: channel ?? null,
    views: Number(views) >= 0 && views != null ? Number(views) : null,
    album: topic.album ?? vinyl?.album ?? null,
    label: topic.label ?? vinyl?.label ?? null,
    year: topic.year ?? vinyl?.year ?? null,
    released: topic.released ?? vinyl?.released ?? null,
    ...(vinyl?.country ? { country: vinyl.country } : {}),
    ...(vinyl?.styles?.length ? { styles: vinyl.styles } : {}),
    ...(vinyl?.formats?.length ? { formats: vinyl.formats } : {}),
    ...(vinyl?.credits?.length ? { credits: vinyl.credits } : {}),
  };
};

/** Facts from one Data API `videos` item. */
export function fromApiItem(item) {
  return facts({ length: isoSeconds(item.contentDetails?.duration), channel: item.snippet?.channelTitle,
    views: item.statistics?.viewCount, description: item.snippet?.description });
}

/** Facts from a watch page, or null when it describes no video. */
export function fromWatchPage(html) {
  const player = readPageJson(html, /ytInitialPlayerResponse\s*=\s*/);
  const reason = `${player?.playabilityStatus?.reason ?? ''}`;
  if (player?.playabilityStatus?.status === 'LOGIN_REQUIRED' && /bot/i.test(reason)) {
    throw new YoutubeUnavailable('YouTube asked this address to sign in to prove it is not a bot');
  }
  const details = player?.videoDetails;
  if (!details) return null;
  return facts({ length: details.lengthSeconds, channel: details.author, views: details.viewCount,
    description: details.shortDescription });
}

const unknown = { length: null, channel: null, views: null, album: null, label: null, year: null, released: null };

async function fromApi(ids, { apiKey, fetchImpl }) {
  const url = `${API}?part=snippet,contentDetails,statistics&maxResults=${BATCH}&id=${ids.join(',')}&key=${encodeURIComponent(apiKey)}`;
  let res;
  try { res = await fetchImpl(url, { signal: AbortSignal.timeout(20000) }); }
  catch (error) { throw new YoutubeUnavailable(`The YouTube Data API did not answer (${error.message})`); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new YoutubeUnavailable(`The YouTube Data API refused the request (${body.error?.message ?? res.status})`);
  const items = new Map((body.items ?? []).map((item) => [item.id, item]));
  // Deleted and private videos are left out of the answer.
  return ids.map((id) => (items.has(id) ? { ...fromApiItem(items.get(id)), found: true } : { ...unknown, found: false }));
}

async function fromPage(id, { fetchImpl }) {
  const res = await request(videoUrl(id), { fetchImpl, retries: 0,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'en' } });
  if (!res.ok) throw new YoutubeUnavailable(`YouTube answered ${res.status}`);
  const found = fromWatchPage(await res.text());
  return found ? { ...found, found: true } : { ...unknown, found: false };
}

/**
 * Facts for every video ID not yet in `cache` (keyed by video ID). With
 * `apiKey` it asks the Data API; without, it reads watch pages `delayMs`
 * apart and waits out each limit in turn (`backoffs`) before stopping.
 */
export async function lookupYoutubeMeta(videoIds, { cache = {}, apiKey = null, fetchImpl = fetch,
  delayMs = 15000, backoffs = [120000, 240000, 480000], pause = wait,
  onProgress = () => {}, onBackoff = () => {}, checkpoint = async () => {} } = {}) {
  const result = { ...cache };
  const todo = [...new Set(videoIds)].filter((id) => /^[\w-]{11}$/.test(id) && !(id in result));
  const batches = apiKey
    ? Array.from({ length: Math.ceil(todo.length / BATCH) }, (_, i) => todo.slice(i * BATCH, (i + 1) * BATCH))
    : todo.map((id) => [id]);
  let done = 0;
  for (const ids of batches) {
    let found;
    for (let attempt = 0; !found; attempt++) {
      try {
        if (apiKey) found = await fromApi(ids, { apiKey, fetchImpl });
        else { await pause(delayMs); found = [await fromPage(ids[0], { fetchImpl })]; }
      } catch (error) {
        if (!(error instanceof YoutubeUnavailable) || apiKey || attempt >= backoffs.length) {
          await checkpoint(result);
          return { cache: result, done, total: todo.length, error };
        }
        onBackoff({ error, waitMs: backoffs[attempt] });
        await pause(backoffs[attempt]);
      }
    }
    for (const [i, id] of ids.entries()) {
      result[id] = { ...found[i], checkedAt: new Date().toISOString() };
      done += 1;
      onProgress({ index: done, total: todo.length, videoId: id, ...found[i] });
    }
    if (!apiKey && done % 20 === 0) await checkpoint(result);
  }
  await checkpoint(result);
  return { cache: result, done, total: todo.length, error: null };
}
