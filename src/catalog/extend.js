import { resolvePlayToYoutube, candidateMatch } from './youtube.js';

// Keep recording/version text intact. This is a fetch-cache key, not fuzzy
// entity resolution (two remixes must not share a YouTube lookup).
export function songKey(play) {
  const normalize = (s) => String(s ?? '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  return JSON.stringify([normalize(play.artist), normalize(play.title)]);
}

/** Round-robin episodes, not just stations, to avoid filling the map with
 * hundreds of tracks from the first programme in the schedule. */
export function newRadioCandidates(cache, limit = 160, stations = null) {
  const tried = new Set([...(cache.attemptedKeys ?? []), ...(cache.resolved ?? []).map(songKey)]);
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
 * Negative lookups are remembered so subsequent extensions make progress. */
export async function extendRadioCache(cache, { limit = 160, resolvePlay = resolvePlayToYoutube,
  delayMs = 1100, stations = null, onProgress = () => {}, checkpoint = async () => {} } = {}) {
  const result = { ...cache, resolved: [...(cache.resolved ?? [])], dropped: cache.dropped ?? 0 };
  const attempted = new Set([...(cache.attemptedKeys ?? []), ...result.resolved.map(songKey)]);
  const candidates = newRadioCandidates(cache, limit, stations);
  let added = 0;
  for (const [index, play] of candidates.entries()) {
    let youtube = null;
    try { youtube = await resolvePlay(play, { delayMs }); } catch { /* retry next run if desired */ }
    attempted.add(songKey(play));
    if (youtube?.confirmed === true && candidateMatch(play, youtube).acceptable) {
      result.resolved.push({ ...play, youtube }); added++;
    } else result.dropped++;
    result.attemptedKeys = [...attempted];
    onProgress({ index: index + 1, total: candidates.length, play, youtube, added });
    if ((index + 1) % 10 === 0) await checkpoint(result);
  }
  result.attemptedKeys = [...attempted];
  await checkpoint(result);
  return { cache: result, added, attempted: candidates.length };
}
