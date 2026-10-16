// Pickers: the server-side "one call, one pick" endpoints of the real product
// (related / similar / banger / radio) plus gems. Pure functions over engine state.

import { releaseMatchesFilters } from './filters.js';
import { similarity as layoutSimilarity } from './layout.js';

const similarityOf = (state) => state.similarity ?? layoutSimilarity;

export function rankedRelated(state, releaseId, { filter, reactionRegistry = null } = {}) {
  const current = state.releaseById(releaseId);
  if (!current) return [];
  const sim = similarityOf(state);
  return state.releases
    .filter((r) => r.id !== releaseId)
    .filter((r) => (filter ? releaseMatchesFilters(r, filter, reactionRegistry) : true))
    .map((r) => ({ release: r, score: sim(current, r) }))
    .sort((a, b) => b.score - a.score || a.release.id.localeCompare(b.release.id));
}

/** GET /v2/maps/:mapId/releases/related */
export function related(state, releaseId, { limit = 10, filter, reactionRegistry = null } = {}) {
  return rankedRelated(state, releaseId, { filter, reactionRegistry })
    .slice(0, limit)
    .map((row) => ({ release_track: state.asReleaseTrack(row.release).release_track, score: row.score }));
}

/**
 * POST /v2/maps/:mapId/releases/similar — one weighted pick among the nearest
 * neighbourhood that passes the filters. Weight falls off with dissimilarity.
 */
export function similarPick(state, releaseId, { filter, reactionRegistry = null, rand = Math.random, excludeIds = [] } = {}) {
  const neighbours = rankedRelated(state, releaseId, { filter, reactionRegistry }).slice(0, 50);
  const excluded = excludeIds instanceof Set ? excludeIds : new Set(excludeIds);
  const candidates = neighbours.filter((row) => !excluded.has(row.release.id));
  const source = candidates.length > 0 ? candidates : neighbours;
  if (source.length === 0) return null;

  const weights = source.map((row) => Math.pow(row.score + 0.05, 3));
  const row = weightedPick(source, weights, rand);
  return row ? row.release : null;
}

/**
 * GET /v2/maps/:mapId/releases/banger — a popular pick under the current
 * filters. Weight = 1 + gems + reaction votes, with a little age bonus.
 */
export function bangerPick(state, { filter, reactionRegistry = null, rand = Math.random, excludeIds = [] } = {}) {
  const excluded = excludeIds instanceof Set ? excludeIds : new Set(excludeIds);
  const candidates = state.releases
    .filter((r) => !excluded.has(r.id))
    .filter((r) => releaseMatchesFilters(r, filter ?? {}, reactionRegistry));
  if (candidates.length === 0) return null;

  const weights = candidates.map((r) => {
    const gems = state.gemCount(r.id);
    const votes = reactionRegistry ? reactionRegistry.score(r.id) : 0;
    return 1 + gems + votes;
  });
  return weightedPick(candidates, weights, rand);
}

/**
 * GET /v2/{resource}/{id}/radio — one pick from an entity's pool
 * (artists | labels | sellers | users), optionally narrowed by style / country
 * and `gem_only`.
 */
export function radioPick(state, { resource, id, style, country, gemOnly = false, reactionRegistry = null, rand = Math.random, excludeIds = [] } = {}) {
  const entityField = { artists: 'artistId', labels: 'labelId', sellers: 'sellerId', users: 'userId' }[resource];
  if (!entityField) throw new Error(`unknown radio resource: ${resource}`);

  let pool = state.releases.filter((r) => String(r[entityField]) === String(id));
  if (style) pool = pool.filter((r) => r.styles.includes(style));
  if (country) pool = pool.filter((r) => releaseMatchesFilters(r, { country_in: [country] }, reactionRegistry));
  if (gemOnly) pool = pool.filter((r) => state.gemCount(r.id) > 0);

  const excluded = excludeIds instanceof Set ? excludeIds : new Set(excludeIds);
  const candidates = pool.filter((r) => !excluded.has(r.id));
  const source = candidates.length > 0 ? candidates : pool;
  if (source.length === 0) return null;

  const weights = source.map((r) => 1 + state.gemCount(r.id));
  return weightedPick(source, weights, rand);
}

/** Gems-shuffle's server helper: one random gem of a user. */
export function randomGem(state, userId, rand = Math.random) {
  const gems = state.gems.filter((g) => g.userId === userId);
  if (gems.length === 0) return null;
  return gems[Math.floor(rand() * gems.length)] ?? null;
}

function weightedPick(items, weights, rand) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[0] ?? null;
  let roll = rand() * total;
  for (let i = 0; i < items.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}
