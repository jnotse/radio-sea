import { resolvePlayToYoutube, candidateMatch, candidateVideoId, lookupYoutubeVideos, YoutubeUnavailable } from './youtube.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Keep recording/version text intact. This is a fetch-cache key, not fuzzy
// entity resolution (two remixes must not share a YouTube lookup).
export function songKey(play) {
  const normalize = (s) => String(s ?? '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  return JSON.stringify([normalize(play.artist), normalize(play.title)]);
}

/** Round-robin episodes, not just stations, to avoid filling the map with
 * hundreds of tracks from the first programme in the schedule. */
export function newRadioCandidates(cache, limit = 160, stations = null, { retryUnmatched = false } = {}) {
  const tried = new Set([...(retryUnmatched ? [] : cache.attemptedKeys ?? []), ...(cache.resolved ?? []).map(songKey)]);
  const groups = new Map();
  for (const play of cache.plays ?? []) {
    if (stations && !stations.includes(play.station)) continue;
    if (!play.artist?.trim() || !play.title?.trim() || tried.has(songKey(play))) continue;
    const group = `${play.station}|${play.sourceUrl ?? play.show}`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(play);
  }
  const lists = [...groups.values()], result = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max && result.length < limit; i++) {
    for (const list of lists) {
      const play = list[i];
      if (!play || tried.has(songKey(play))) continue;
      tried.add(songKey(play)); result.push(play);
      if (result.length === limit) break;
    }
  }
  return result;
}

/** Incremental scan: preserve accepted tracks and checkpoint completed work.
 * Negative lookups are remembered so subsequent extensions make progress.
 * A lookup that fails (YouTube unreachable or limiting requests) is not a
 * negative: the scan backs off and retries, and if YouTube keeps refusing it
 * stops, leaving that song for the next run. */
export async function extendRadioCache(cache, { limit = 160, resolvePlay = resolvePlayToYoutube,
  delayMs = 1100, apiKey = null, stations = null, onProgress = () => {}, checkpoint = async () => {},
  backoffs = [120000, 240000, 480000], pause = wait, onBackoff = () => {},
  prepareCandidates = async (plays) => plays, fetchImpl = fetch, retryUnmatched = false,
  searchBudget = 100, now = () => new Date() } = {}) {
  if (!Number.isInteger(searchBudget) || searchBudget < 0) throw new Error('searchBudget must be a non-negative integer');
  const result = { ...cache, resolved: [...(cache.resolved ?? [])], dropped: cache.dropped ?? 0,
    youtubeVideos: { ...(cache.youtubeVideos ?? {}) }, youtubeLookups: { ...(cache.youtubeLookups ?? {}) },
    youtubeSearchUsage: { ...(cache.youtubeSearchUsage ?? {}) } };
  const attempted = new Set([...(cache.attemptedKeys ?? []), ...result.resolved.map(songKey)]);
  const candidates = await prepareCandidates(newRadioCandidates(cache, limit, stations, { retryUnmatched }));
  let searchStopped = null;
  const checkpointVideos = async () => { await checkpoint(result); };
  const beforeSearch = async ({ apiKey: api }) => {
    if (searchStopped) throw searchStopped;
    // The API resets daily limits at midnight Pacific, including DST changes.
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now());
    if (result.youtubeSearchUsage.day !== day) result.youtubeSearchUsage = { day, api: 0, web: 0 };
    const mode = api ? 'api' : 'web';
    if ((result.youtubeSearchUsage[mode] ?? 0) >= searchBudget) {
      const error = new YoutubeUnavailable(`Today's ${mode === 'api' ? 'API' : 'web'} search budget (${searchBudget}) is used up; known links can still be checked`);
      error.code = 'search_budget'; error.final = true;
      throw error;
    }
    result.youtubeSearchUsage[mode] = (result.youtubeSearchUsage[mode] ?? 0) + 1;
    // Persist before sending the request, so a restart does not reset usage.
    await checkpoint(result);
  };
  if (apiKey) {
    try {
      await lookupYoutubeVideos(candidates.flatMap((p) => (p.youtubeCandidates ?? []).map(candidateVideoId)).filter(Boolean),
        { apiKey, fetchImpl, delayMs, videoCache: result.youtubeVideos, now, checkpoint: checkpointVideos });
    } catch (error) {
      await checkpoint(result);
      return { cache: result, added: 0, attempted: 0, stopped: error };
    }
  }
  let added = 0, completed = 0, backoff = 0, stopped = null;
  candidateLoop: for (const [index, play] of candidates.entries()) {
    const key = songKey(play), previouslyDropped = attempted.has(key) || result.youtubeLookups[key]?.previouslyDropped === true;
    let youtube = null;
    for (;;) {
      try { youtube = await resolvePlay(play, { delayMs, apiKey, fetchImpl,
        videoCache: result.youtubeVideos, beforeSearch, checkpointVideos, now }); break; } catch (error) {
        // Waiting does not bring back a day's API quota.
        if (backoff === backoffs.length || error.final) {
          attempted.delete(key);
          result.youtubeLookups[key] = { status: 'pending', reason: error.code ?? 'unavailable',
            error: error.message, checkedAt: now().toISOString(), ...(previouslyDropped ? { previouslyDropped: true } : {}) };
          result.attemptedKeys = [...attempted];
          await checkpoint(result);
          // A search limit must not starve later songs with known links. Their
          // metadata can still be checked without making another search call.
          if (error.code === 'search_budget' || (error.code === 'quota' && error.operation === 'search')) {
            searchStopped = error;
            stopped ??= error;
            onProgress({ index: index + 1, total: candidates.length, play, youtube: null, added, pending: true });
            continue candidateLoop;
          }
          return { cache: result, added, attempted: completed, stopped: error };
        }
        onBackoff({ error, waitMs: backoffs[backoff], play });
        await pause(backoffs[backoff]);
        backoff += 1;
      }
    }
    attempted.add(key);
    completed++;
    if (youtube?.confirmed === true && candidateMatch(play, youtube).acceptable) {
      result.resolved.push({ ...play, youtube }); added++;
      if (previouslyDropped) result.dropped = Math.max(0, result.dropped - 1);
      result.youtubeLookups[key] = { status: 'verified', videoId: youtube.videoId,
        via: youtube.via ?? 'search', checkedAt: now().toISOString() };
    } else {
      if (!previouslyDropped) result.dropped++;
      result.youtubeLookups[key] = { status: 'no_match', checkedAt: now().toISOString() };
    }
    result.attemptedKeys = [...attempted];
    onProgress({ index: index + 1, total: candidates.length, play, youtube, added });
    if ((index + 1) % 10 === 0) await checkpoint(result);
  }
  result.attemptedKeys = [...attempted];
  await checkpoint(result);
  return { cache: result, added, attempted: completed, stopped };
}
