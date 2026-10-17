// Discover candidate YouTube links before searching YouTube. Catalogue links
// are hints, never proof of a playable artist/title match.
import { lookupTrackGenres } from './genres.js';
import { songKey } from './extend.js';
import { candidateMatch, candidateVideoId, videoUrl } from './youtube.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HEADERS = { 'User-Agent': 'radio-sea/0.1 ( https://github.com/jnotse/radio-sea )', Accept: 'application/json' };

export function catalogueCandidates(play, ...lists) {
  const found = new Map();
  for (const raw of lists.flat()) {
    const candidate = typeof raw === 'string' ? { url: raw, source: 'catalogue' } : raw;
    const videoId = candidateVideoId(candidate);
    if (!videoId) continue;
    // Track-matched catalogue records supply artist context for a short video
    // title, but YouTube's actual title/channel are checked again later.
    if (candidate.title && !candidateMatch(play, { title: candidate.title, channel: play.artist }).acceptable) continue;
    if (!found.has(videoId)) found.set(videoId, { ...candidate, videoId, url: videoUrl(videoId) });
  }
  return [...found.values()].slice(0, 10);
}

function discogsIds(urls) {
  return [...new Set(urls.flatMap((url) => {
    try {
      const parsed = new URL(url);
      if (!['discogs.com', 'www.discogs.com'].includes(parsed.hostname)) return [];
      const match = /^\/release\/(\d+)(?:-|\/|$)/.exec(parsed.pathname);
      return match ? [Number(match[1])] : [];
    } catch { return []; }
  }))];
}

/** Enrich pending songs and collect links. Source outages keep their own
 * lookups pending, while cached links and the YouTube fallback remain usable.
 * All network I/O is metadata-only and rate limited. */
export async function discoverCatalogueLinks(plays, { musicbrainz = {}, discogs = {}, cache = {},
  fetchImpl = fetch, lookup = lookupTrackGenres, pause = () => wait(1100),
  backoff = (attempt) => {
    if (attempt >= 1) throw new Error('MusicBrainz is busy; catalogue discovery will resume next run');
    return wait(2000);
  },
  checkpoint = async () => {}, onProgress = () => {}, now = () => new Date() } = {}) {
  const mb = { ...musicbrainz }, links = { ...cache };
  const artistGenres = new Map(), errors = [];
  let mbUnavailable = false, discogsUnavailable = false;
  const get = async (url) => {
    const age = now().getTime() - Date.parse(links[url]?.checkedAt);
    if (age >= 0 && age < 30 * 86400000) return links[url];
    await pause();
    const response = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Catalogue request failed (${response.status}): ${new URL(url).hostname}`);
    const body = await response.json();
    // Retain only link facts, not full release tracklists or API responses.
    links[url] = { checkedAt: now().toISOString(),
      ...(Array.isArray(body.relations) ? { relations: body.relations.filter((r) => r.url?.resource)
        .map((r) => ({ url: { resource: r.url.resource } })) } : {}),
      ...(Array.isArray(body.videos) ? { videos: body.videos.map((v) => ({ uri: v.uri, title: v.title })) } : {}) };
    return links[url];
  };
  const prepared = [];
  for (const [index, play] of plays.entries()) {
    const key = songKey(play), hints = discogs[key] ?? {};
    let metadata = mb[key] ?? {};
    let candidates = catalogueCandidates(play, play.youtubeCandidates ?? [], hints.youtubeCandidates ?? [], metadata.youtubeCandidates ?? []);
    if (!candidates.length && !mbUnavailable && !Array.isArray(metadata.youtubeCandidates)) {
      try {
        const found = await lookup({ ...play, ids: { ...play.ids,
          ...(metadata.recording ? { musicbrainz: metadata.recording } : {}) } },
        { fetchImpl, pause, backoff, artistGenres, includeVideoLinks: true });
        metadata = mb[key] = { ...metadata, ...found, checkedAt: now().toISOString() };
      } catch (error) {
        mbUnavailable = true;
        errors.push({ provider: 'musicbrainz', message: error.message });
      }
    }
    candidates = catalogueCandidates(play, candidates, metadata.youtubeCandidates ?? []);
    let releaseIds = [...new Set([...(hints.releases ?? []), ...(play.ids?.discogs ? [play.ids.discogs] : [])])];
    if (!candidates.length && !mbUnavailable) {
      try {
        for (const id of metadata.videoRecordings ?? []) {
          const recording = await get(`https://musicbrainz.org/ws/2/recording/${encodeURIComponent(id)}?inc=url-rels&fmt=json`);
          candidates = catalogueCandidates(play, candidates, (recording.relations ?? []).map((r) => ({
            url: r.url?.resource, source: 'musicbrainz', sourceUrl: `https://musicbrainz.org/recording/${id}`,
          })));
        }
        for (const id of candidates.length ? [] : metadata.releaseIds ?? []) {
          const release = await get(`https://musicbrainz.org/ws/2/release/${encodeURIComponent(id)}?inc=url-rels&fmt=json`);
          const urls = (release.relations ?? []).map((r) => r.url?.resource).filter(Boolean);
          releaseIds.push(...discogsIds(urls));
          candidates = catalogueCandidates(play, candidates, urls.map((url) => ({
            url, source: 'musicbrainz', sourceUrl: `https://musicbrainz.org/release/${id}`,
          })));
        }
      } catch (error) {
        mbUnavailable = true;
        errors.push({ provider: 'musicbrainz', message: error.message });
      }
    }
    if (!candidates.length && !discogsUnavailable) {
      try {
        for (const id of [...new Set(releaseIds)].filter((id) => /^\d+$/.test(String(id))).slice(0, 5)) {
          const release = await get(`https://api.discogs.com/releases/${id}`);
          candidates = catalogueCandidates(play, candidates, (release.videos ?? []).map((v) => ({
            url: v.uri, title: v.title, source: 'discogs', sourceUrl: `https://www.discogs.com/release/${id}`,
          })));
        }
      } catch (error) {
        discogsUnavailable = true;
        errors.push({ provider: 'discogs', message: error.message });
      }
    }
    prepared.push({ ...play, youtubeCandidates: candidates });
    await checkpoint({ musicbrainz: mb, cache: links });
    onProgress({ index: index + 1, total: plays.length, play, candidates: candidates.length });
  }
  return { plays: prepared, musicbrainz: mb, cache: links, errors };
}
