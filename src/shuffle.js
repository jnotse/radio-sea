// Shuffle with recent-track exclusion:
//
//   - if the loaded pool already covers the whole playlist, draw from the pool,
//     excluding recently played tracks;
//   - otherwise make up to 3 random offset draws against the full track list,
//     skipping recently played ones, keeping the first draw as fallback.

export function pickRandomExcluding(pool, excludeIds, rand = Math.random) {
  const excluded = excludeIds instanceof Set ? excludeIds : new Set(excludeIds);
  const candidates = pool.filter((item) => !excluded.has(item.id));
  const source = candidates.length > 0 ? candidates : pool;
  if (source.length === 0) return null;
  return source[Math.floor(rand() * source.length)] ?? null;
}

export function drawRandomTrack({ totalTracks, readAtOffset, excludeIds, rand = Math.random }) {
  const excluded = excludeIds instanceof Set ? excludeIds : new Set(excludeIds);
  if (totalTracks <= 0) return null;
  let fallback = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = Math.floor(rand() * totalTracks);
    let track = null;
    try {
      track = readAtOffset(offset);
    } catch {
      return fallback;
    }
    if (track) {
      if (!excluded.has(track.id)) return track;
      fallback ??= track;
    }
  }
  return fallback;
}

export function shufflePick({
  pool,
  totalTracks,
  readAtOffset,
  recentIds = [],
  rand = Math.random,
}) {
  const excluded = recentIds instanceof Set ? recentIds : new Set(recentIds);
  const remoteDraw =
    pool.length >= totalTracks
      ? null
      : drawRandomTrack({ totalTracks, readAtOffset, excludeIds: excluded, rand });
  return remoteDraw ?? pickRandomExcluding(pool, excluded, rand);
}
