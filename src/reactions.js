// Reaction system ("conditions" in zig-zag's code): users vote animated tags per
// track. Play-path picks carry `top_conditions`, and the map's "landscapes"
// filter queries condition_in / condition_in_or.

export const DEFAULT_CONDITIONS = ['light_breeze', 'banger', 'peak', 'sunny', 'rainy', 'crab'];

export class ReactionRegistry {
  constructor() {
    // key: `${releaseId}:${trackId}` -> Map<condition, Set<userId>>
    this.trackVotes = new Map();
    // key: `${releaseId}` -> Map<condition, Set<userId>>
    this.releaseVotes = new Map();
  }

  static key(releaseId, trackId) {
    return `${releaseId}:${trackId}`;
  }

  #bucket(map, key) {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = new Map();
      map.set(key, bucket);
    }
    return bucket;
  }

  // Toggle semantics match the site's ConditionGrid: clicking again removes.
  toggle({ userId, releaseId, trackId = null, condition }) {
    const map = trackId == null ? this.releaseVotes : this.trackVotes;
    const key = trackId == null ? String(releaseId) : ReactionRegistry.key(releaseId, trackId);
    const bucket = this.#bucket(map, key);
    const voters = bucket.get(condition) ?? new Set();
    let added;
    if (voters.has(userId)) {
      voters.delete(userId);
      added = false;
    } else {
      voters.add(userId);
      added = true;
    }
    if (voters.size === 0) bucket.delete(condition);
    else bucket.set(condition, voters);
    return added;
  }

  voteCount(releaseId, trackId = null, condition) {
    const map = trackId == null ? this.releaseVotes : this.trackVotes;
    const key = trackId == null ? String(releaseId) : ReactionRegistry.key(releaseId, trackId);
    return map.get(key)?.get(condition)?.size ?? 0;
  }

  /** Conditions of a release (union over its tracks + release-level votes). */
  conditionsFor(releaseId) {
    const names = new Set();
    for (const [key, bucket] of this.releaseVotes) {
      if (key === String(releaseId)) for (const c of bucket.keys()) names.add(c);
    }
    const prefix = `${releaseId}:`;
    for (const [key, bucket] of this.trackVotes) {
      if (key.startsWith(prefix)) for (const c of bucket.keys()) names.add(c);
    }
    return [...names].sort();
  }

  /**
   * `top_conditions` as returned with play-path picks: per track, conditions
   * sorted by vote count desc, then name; ties broken deterministically.
   */
  topConditions(releaseId, trackId, limit = 3) {
    const bucket = this.trackVotes.get(ReactionRegistry.key(releaseId, trackId));
    const releaseBucket = this.releaseVotes.get(String(releaseId));
    const counts = new Map();
    for (const [condition, voters] of bucket ?? []) counts.set(condition, voters.size);
    for (const [condition, voters] of releaseBucket ?? []) {
      counts.set(condition, (counts.get(condition) ?? 0) + voters.size);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([condition, votes]) => ({ condition, votes }));
  }

  /** Popularity score used to weight "banger" picks. */
  score(releaseId) {
    let total = 0;
    const prefix = `${releaseId}:`;
    for (const [key, bucket] of this.trackVotes) {
      if (key.startsWith(prefix)) for (const voters of bucket.values()) total += voters.size;
    }
    for (const [key, bucket] of this.releaseVotes) {
      if (key === String(releaseId)) for (const voters of bucket.values()) total += voters.size;
    }
    return total;
  }
}
