// Search results are candidates, NOT proof that the requested song was found.
// Admission requires artist/title agreement and a successful oEmbed response.
import { youtubeIdFromUrl } from './youtube-link.js';
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
function coverage(expected, actual) {
  const tokens = words(expected).filter((w) => !IGNORED.has(w));
  if (!tokens.length) return 0;
  const available = new Set(words(actual));
  return tokens.filter((w) => available.has(w)).length / tokens.length;
}

/** Unicode-aware conservative matching, also used to audit cached matches. */
export function candidateMatch(play, candidate) {
  const title = coverage(play.title, candidate.title);
  const artist = Math.max(...String(play.artist ?? '').split(',').map((alias) =>
    coverage(alias, `${candidate.title} ${candidate.channel ?? candidate.author_name ?? ''}`)));
  const expected = words(play.title), actual = words(candidate.title);
  const numbers = (value) => String(value ?? '').match(/\d+(?:[.:]\d+)*/g) ?? [];
  const actualNumbers = numbers(candidate.title);
  const differentNumbers = numbers(play.title).some((n) => !actualNumbers.includes(n));
  const extraVersion = ['remix', 'live', 'cover', 'karaoke'].some((v) => actual.includes(v) && !expected.includes(v));
  return { score: 0.7 * title + 0.3 * artist,
    acceptable: title >= 0.8 && artist >= 0.5 && !differentNumbers && !extraVersion };
}

/**
 * YouTube did not answer, or is limiting requests: after too many searches it
 * redirects to a Google "unusual traffic" check. Temporary, so a song that
 * hits this must be retried later, never recorded as having no video.
 */
export class YoutubeUnavailable extends Error {}

export async function request(url, { fetchImpl, retries = 2, delayMs = 900, headers } = {}) {
  for (let i = 0; ; i++) {
    let res;
    try { res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20000) }); }
    catch (error) { throw new YoutubeUnavailable(`YouTube did not answer (${error.message})`); }
    const limited = res.status === 429 || /\/\/(www\.)?google\.[a-z.]+\/sorry/.test(res.url ?? '');
    if (!limited && res.status !== 503) return res;
    if (i === retries) throw new YoutubeUnavailable(limited ? 'YouTube is limiting requests from this address' : `YouTube answered ${res.status}`);
    await sleep(delayMs * (i + 1));
  }
}

export async function searchYoutube(query, { fetchImpl = fetch, retries = 2, delayMs = 900 } = {}) {
  const res = await request(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    { fetchImpl, retries, delayMs,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'en' } });
  if (!res.ok) throw new Error(`youtube search failed: ${res.status}`);
  return extractSearchResults(await res.text());
}

export async function validateYoutubeUrl(url, { fetchImpl = fetch } = {}) {
  // Unreachable or limited counts as unavailable here: validation fails closed.
  if (!youtubeIdFromUrl(url)) return false;
  try {
    const res = await request(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { fetchImpl });
    return res.ok;
  } catch { return false; }
}

export async function resolvePlayToYoutube(play, { fetchImpl = fetch, delayMs = 1100 } = {}) {
  const queries = [`${play.artist} ${play.title}`, ...(play.ids?.isrc ? [play.ids.isrc] : [])];
  const seen = new Set();
  for (const query of queries) {
    if (delayMs > 0) await sleep(delayMs);
    let candidates;
    try { candidates = await searchYoutube(query, { fetchImpl, delayMs }); }
    catch (error) { if (error instanceof YoutubeUnavailable) throw error; continue; }
    // Search context cannot substitute for matching metadata (ISRC queries can
    // return completely unrelated popular videos when the recording is absent).
    const ranked = candidates.map((c) => ({ ...c, match: candidateMatch(play, c) }))
      .filter((c) => c.match.acceptable).sort((a, b) => b.match.score - a.match.score);
    for (const candidate of ranked) {
      if (seen.has(candidate.videoId)) continue;
      seen.add(candidate.videoId);
      try {
        const res = await request(`https://www.youtube.com/oembed?url=${encodeURIComponent(candidate.url)}&format=json`, { fetchImpl, delayMs });
        if (!res.ok) continue; // Not found or not embeddable: NOT verified.
        const meta = await res.json();
        const verified = { ...candidate, title: meta.title, channel: meta.author_name };
        const match = candidateMatch(play, verified);
        if (!match.acceptable) continue;
        return { videoId: candidate.videoId, url: candidate.url, title: meta.title,
          channel: meta.author_name, query, matchScore: match.score,
          confirmed: true, checkedAt: new Date().toISOString() };
      } catch (error) {
        // Fail closed: never invent availability. An unreachable YouTube is retried later.
        if (error instanceof YoutubeUnavailable) throw error;
      }
    }
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
