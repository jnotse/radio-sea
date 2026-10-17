// Search results are candidates, NOT proof that the requested song was found.
// Admission requires artist/title agreement and verified video metadata.
import { youtubeIdFromUrl } from './youtube-link.js';
import { decodeEntities } from './text.js';
export { youtubeIdFromUrl } from './youtube-link.js';

export const videoUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function text(node) {
  return node?.simpleText ?? node?.runs?.map((r) => r.text ?? '').join('') ?? '';
}

/** The JSON object a YouTube page assigns after `pattern`, or undefined. */
export function readPageJson(html, pattern) {
  const match = pattern.exec(html);
  if (!match) return undefined;
  const start = html.indexOf('{', match.index + match[0].length);
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; start >= 0 && i < html.length; i++) {
    const ch = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return undefined; }
    }
  }
  return undefined;
}

/** Read individual renderers, so a video ID can never borrow another title. */
export function extractSearchResults(html) {
  const data = readPageJson(html, /(?:var\s+ytInitialData\s*=|window\["ytInitialData"\]\s*=)\s*/);
  if (!data) return [];
  const results = [], seen = new Set();
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    const r = node.videoRenderer;
    if (r && /^[\w-]{11}$/.test(r.videoId) && !seen.has(r.videoId)) {
      seen.add(r.videoId);
      results.push({ videoId: r.videoId, title: text(r.title),
        channel: text(r.ownerText ?? r.longBylineText ?? r.shortBylineText), url: videoUrl(r.videoId) });
    }
    // Ignore ads and unrelated shelves; search videos have videoRenderer keys.
    for (const [key, child] of Object.entries(node)) {
      if (/adSlot|promoted|shelfRenderer/i.test(key)) continue;
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child === 'object') walk(child);
    }
  }
  walk(data);
  return results.slice(0, 12);
}

function words(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
}
const IGNORED = new Set(['the', 'a', 'and', 'of', 'ft', 'feat', 'featuring', 'official', 'audio',
  'video', 'lyrics', 'hd', 'hq', 'original', 'mix', 'full', 'version', 'topic']);
function coverage(expected, actual, repeatedTitle = false) {
  const tokens = words(expected).filter((w) => !IGNORED.has(w));
  if (!tokens.length) return 0;
  const actualWords = words(actual);
  // "Ya Ya Ya" must not match any song containing just one generic "Ya".
  // Longer titles can legitimately abbreviate a repeated phrase in uploads.
  if (repeatedTitle && tokens.length > 1 && new Set(tokens).size === 1) {
    return Math.min(tokens.length, actualWords.filter((w) => w === tokens[0]).length) / tokens.length;
  }
  const available = new Set(actualWords);
  return tokens.filter((w) => available.has(w)).length / tokens.length;
}

const LATIN = /\p{Script=Latin}/u;
const OTHER_LETTER = /(?!\p{Script=Latin})\p{L}/u;
const oneScript = (text) => LATIN.test(text) !== OTHER_LETTER.test(text);

/**
 * A name and, when it is written in its own script with a romanization in
 * brackets ("گوگوش (Googoosh)"), each form alone: a video is usually titled
 * in one of them. Other brackets ("(Dub Mix)") are part of the name.
 */
export function nameForms(name) {
  const text = String(name ?? '');
  const m = /^(.*\S)\s*\(([^()]+)\)\s*$/u.exec(text);
  if (!m || !oneScript(m[1]) || !oneScript(m[2]) || LATIN.test(m[1]) === LATIN.test(m[2])) return [text];
  return [text, m[1].trim(), m[2].trim()];
}

/** Unicode-aware conservative matching, also used to audit cached matches. */
export function candidateMatch(play, candidate) {
  const title = Math.max(...nameForms(play.title).map((form) => coverage(form, candidate.title, true)));
  const artist = Math.max(...String(play.artist ?? '').split(',').flatMap(nameForms).map((alias) =>
    coverage(alias, `${candidate.title} ${candidate.channel ?? candidate.author_name ?? ''}`)));
  const expected = words(play.title), actual = words(candidate.title);
  const numbers = (value) => String(value ?? '').match(/\d+(?:[.:]\d+)*/g) ?? [];
  const actualNumbers = numbers(candidate.title);
  const differentNumbers = numbers(play.title).some((n) => !actualNumbers.includes(n));
  const extraVersion = ['remix', 'live', 'cover', 'karaoke', 'snipped', 'snippet', 'preview', 'teaser']
    .some((v) => actual.includes(v) && !expected.includes(v));
  return { score: 0.7 * title + 0.3 * artist,
    acceptable: title >= 0.8 && artist >= 0.5 && !differentNumbers && !extraVersion };
}

/**
 * YouTube did not answer, or is limiting requests: after too many searches it
 * redirects to a Google "unusual traffic" check. Temporary, so a song that
 * hits this must be retried later, never recorded as having no video.
 */
export class YoutubeUnavailable extends Error {}

function unavailable(message, code = 'unavailable') {
  const error = new YoutubeUnavailable(message);
  error.code = code;
  return error;
}

export async function request(url, { fetchImpl = fetch, retries = 2, delayMs = 900, headers,
  beforeRequest = async () => {} } = {}) {
  for (let i = 0; ; i++) {
    await beforeRequest();
    let res;
    try { res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20000) }); }
    catch (error) { throw new YoutubeUnavailable(`YouTube did not answer (${error.message})`); }
    const limited = res.status === 429 || /\/\/(www\.)?google\.[a-z.]+\/sorry/.test(res.url ?? '');
    const gated = res.status === 403 || /\b(consent\.(youtube|google)\.com|accounts\.google\.com)\b/.test(res.url ?? '');
    if (gated) throw unavailable('YouTube blocked the request; the lookup remains pending', 'blocked');
    if (!limited && res.status < 500) return res;
    if (i === retries) throw unavailable(limited ? 'YouTube is limiting requests from this address' : `YouTube answered ${res.status}`, limited ? 'blocked' : 'unavailable');
    await sleep(delayMs * (i + 1));
  }
}

export async function searchYoutube(query, { fetchImpl = fetch, retries = 2, delayMs = 900,
  beforeRequest = async () => {} } = {}) {
  const res = await request(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    { fetchImpl, retries, delayMs, beforeRequest,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'en' } });
  if (!res.ok) throw unavailable(`YouTube search failed (${res.status}); the lookup remains pending`);
  const page = await res.text();
  if (/confirm (?:that )?you(?:'|’|&#39;|&apos;)?re not a bot|unusual traffic|\/sorry\/|g-recaptcha/i.test(page)) {
    throw unavailable('YouTube requested bot verification; the lookup remains pending', 'blocked');
  }
  // An empty, valid result set is different from a consent/challenge page or
  // an unsupported response. Only the first can be recorded as "no match".
  const data = readPageJson(page, /(?:var\s+ytInitialData\s*=|window\["ytInitialData"\]\s*=)\s*/);
  if (!data?.contents || typeof data.contents !== 'object') {
    throw unavailable('YouTube returned an unreadable search page; the lookup remains pending');
  }
  return extractSearchResults(page);
}

const DATA_API = 'https://www.googleapis.com/youtube/v3';

/**
 * One call to the YouTube Data API: the official route for programs, limited
 * by quotas instead of the bot checks on search pages. A per-minute limit or
 * an outage is waited out like any other; a used-up daily quota or a refused
 * key ends the run (`final`).
 */
async function dataApi(path, params, { apiKey, fetchImpl }) {
  const url = `${DATA_API}/${path}?${new URLSearchParams({ ...params, key: apiKey })}`;
  let res;
  try { res = await fetchImpl(url, { signal: AbortSignal.timeout(20000) }); }
  catch (error) { throw new YoutubeUnavailable(`The YouTube Data API did not answer (${error.message})`); }
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    if (!Array.isArray(body.items)) throw unavailable('The YouTube Data API returned an unreadable response');
    return body;
  }
  const reason = body.error?.errors?.[0]?.reason ?? '';
  const message = body.error?.message ?? String(res.status);
  // Daily limits come as 403 quotaExceeded or as 429 "… per day" (a key may
  // allow only 100 searches a day); they reset at midnight Pacific time.
  const daily = /quotaExceeded|dailyLimit/i.test(reason) || /per day/i.test(message);
  if (!daily && (res.status === 429 || res.status >= 500 || /rateLimit/i.test(reason))) {
    throw new YoutubeUnavailable(`The YouTube Data API asks to slow down (${message})`);
  }
  const error = new YoutubeUnavailable(daily
    ? 'The YouTube Data API quota for today is used up; run again tomorrow'
    : `The YouTube Data API refused the request (${message})`);
  error.final = true;
  error.code = daily ? 'quota' : 'credentials';
  error.operation = path;
  throw error;
}

/** Search candidates from the Data API's separate daily search-call bucket. */
export async function searchYoutubeApi(query, options) {
  const body = await dataApi('search', { part: 'snippet', type: 'video', maxResults: '10', q: query }, options);
  return (body.items ?? []).filter((item) => /^[\w-]{11}$/.test(item.id?.videoId ?? '')).map((item) => ({
    videoId: item.id.videoId, url: videoUrl(item.id.videoId),
    // Search snippets come HTML-escaped ("Guns N&#39; Roses").
    title: decodeEntities(item.snippet?.title), channel: decodeEntities(item.snippet?.channelTitle) }));
}

export function candidateVideoId(candidate) {
  if (typeof candidate === 'string') return youtubeIdFromUrl(candidate);
  return youtubeIdFromUrl(candidate?.url) ?? (/^[\w-]{11}$/.test(candidate?.videoId ?? '') ? candidate.videoId : null);
}

const VIDEO_CACHE_AGE = 30 * 24 * 60 * 60 * 1000;

/** Cache and verify known IDs, 50 per API request. Never fetch audio/video. */
export async function lookupYoutubeVideos(ids, { apiKey = null, fetchImpl = fetch, videoCache = {},
  delayMs = 1100, now = () => new Date(), checkpoint = async () => {} } = {}) {
  const unique = [...new Set(ids.filter((id) => /^[\w-]{11}$/.test(id)))];
  const date = now();
  const todo = unique.filter((id) => {
    const cached = videoCache[id];
    const age = date.getTime() - Date.parse(cached?.checkedAt);
    return !cached || !Number.isFinite(age) || age < 0 || age >= VIDEO_CACHE_AGE
      || (apiKey && cached.method !== 'api');
  });
  for (let start = 0; start < todo.length; start += apiKey ? 50 : 1) {
    if (delayMs > 0) await sleep(delayMs);
    const batch = todo.slice(start, start + (apiKey ? 50 : 1));
    const checkedAt = now().toISOString();
    if (apiKey) {
      const body = await dataApi('videos', { part: 'snippet,status', id: batch.join(',') }, { apiKey, fetchImpl });
      if (body.items.some((item) => !/^[\w-]{11}$/.test(item.id ?? '') || !item.snippet?.title
        || !item.snippet?.channelTitle || typeof item.status?.embeddable !== 'boolean')) {
        throw unavailable('The YouTube Data API returned incomplete video metadata');
      }
      const items = new Map(body.items.map((item) => [item.id, item]));
      for (const id of batch) {
        const item = items.get(id);
        videoCache[id] = item ? { found: true, title: item.snippet?.title ?? '',
          channel: item.snippet?.channelTitle ?? '', embeddable: item.status?.embeddable === true,
          privacy: item.status?.privacyStatus ?? null, method: 'api', checkedAt }
          : { found: false, method: 'api', checkedAt };
      }
    } else {
      const id = batch[0];
      const res = await request(`https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl(id))}&format=json`, { fetchImpl, delayMs });
      if (res.status === 401 || res.status === 404) videoCache[id] = { found: false, method: 'oembed', checkedAt };
      else {
        if (!res.ok) throw unavailable(`YouTube metadata lookup failed (${res.status})`);
        const meta = await res.json().catch(() => null);
        if (!meta?.title || !meta.author_name) throw unavailable('YouTube returned unreadable video metadata');
        videoCache[id] = { found: true, title: meta.title, channel: meta.author_name,
          embeddable: true, method: 'oembed', checkedAt };
      }
    }
    await checkpoint(videoCache);
  }
  return videoCache;
}

export async function verifyYoutubeCandidates(play, candidates, options = {}) {
  const videoCache = options.videoCache ?? {};
  const ids = candidates.map(candidateVideoId).filter(Boolean);
  if (options.apiKey) await lookupYoutubeVideos(ids, { ...options, videoCache });
  for (const candidate of candidates) {
    const videoId = candidateVideoId(candidate);
    if (!videoId) continue;
    // Without batching, stop at the first verified link instead of fetching
    // every alternative upload unnecessarily.
    if (!options.apiKey) await lookupYoutubeVideos([videoId], { ...options, videoCache });
    const meta = videoCache[videoId];
    if (!meta?.found || !meta.embeddable || meta.privacy === 'private') continue;
    // Catalogue titles help discover candidates; only YouTube's own metadata
    // is evidence for admission, including the actual artist and version.
    const match = candidateMatch(play, meta);
    if (!match.acceptable) continue;
    return { videoId, url: videoUrl(videoId), title: meta.title, channel: meta.channel,
      matchScore: match.score, confirmed: true, checkedAt: meta.checkedAt,
      ...(candidate.query ? { query: candidate.query } : {}),
      via: candidate.source ?? 'catalogue', ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}) };
  }
  return null;
}

export async function validateYoutubeUrl(url, { fetchImpl = fetch } = {}) {
  // Unreachable or limited counts as unavailable here: validation fails closed.
  if (!youtubeIdFromUrl(url)) return false;
  try {
    const res = await request(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { fetchImpl });
    return res.ok;
  } catch { return false; }
}

/**
 * A verified video for `play`, or null when none matches. With `apiKey` the
 * search and the check go through the YouTube Data API; without, through
 * YouTube's search page and oEmbed, `delayMs` apart.
 */
export async function resolvePlayToYoutube(play, { fetchImpl = fetch, delayMs = 1100, apiKey = null,
  candidates = play.youtubeCandidates ?? [], videoCache = {}, beforeSearch = async () => {},
  checkpointVideos = async () => {}, now = () => new Date() } = {}) {
  const verification = { fetchImpl, delayMs, apiKey, videoCache, checkpoint: checkpointVideos, now };
  const direct = await verifyYoutubeCandidates(play, candidates, verification);
  if (direct) return direct;
  // Romanized names are searched too: a video titled in Latin letters only may
  // not come up for a query that is half in another script.
  const latin = (name) => nameForms(name).slice(1).find((form) => LATIN.test(form)) ?? name;
  const queries = [...new Set([`${play.artist} ${play.title}`, `${latin(play.artist)} ${latin(play.title)}`]),
    ...(play.ids?.isrc ? [play.ids.isrc] : [])];
  const seen = new Set();
  for (const query of queries) {
    // Searches are spaced out on the Data API too: it limits them per minute.
    if (delayMs > 0) await sleep(delayMs);
    let found;
    if (apiKey) {
      await beforeSearch({ query, apiKey: true });
      found = await searchYoutubeApi(query, { apiKey, fetchImpl });
    } else found = await searchYoutube(query, { fetchImpl, delayMs,
      beforeRequest: () => beforeSearch({ query, apiKey: false }) });
    // Search context cannot substitute for matching metadata (ISRC queries can
    // return completely unrelated popular videos when the recording is absent).
    const ranked = found.map((c) => ({ ...c, query, source: 'search', match: candidateMatch(play, c) }))
      .filter((c) => c.match.acceptable).sort((a, b) => b.match.score - a.match.score);
    const fresh = ranked.filter((c) => !seen.has(c.videoId));
    fresh.forEach((c) => seen.add(c.videoId));
    const verified = await verifyYoutubeCandidates(play, fresh, verification);
    if (verified) return verified;
  }
  return null;
}

export async function resolvePlaysToYoutube(plays, options = {}) {
  const resolved = []; let dropped = 0;
  for (const [index, play] of plays.entries()) {
    const youtube = await resolvePlayToYoutube(play, options);
    if (youtube) resolved.push({ ...play, youtube });
    else dropped++;
    options.onProgress?.({ index: index + 1, total: plays.length, play, youtube });
  }
  return { resolved, dropped };
}
