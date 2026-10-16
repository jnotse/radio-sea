// The engine: one object wiring catalogue + sea layout + filters + pickers +
// reactions + navigation suggestions + community charts. Method names mirror the
// site's endpoints so the mapping is obvious.

import { layoutSea } from './layout.js';
import { buildSimilarity } from './mapping/embed.js';
import { mapCatalogue } from './mapping/cartography.js';
import { tradeRoutes as buildTradeRoutes } from './mapping/routes.js';
import { explainSimilarity, explainPick } from './explain.js';
import { mergeCatalogue } from './catalog/resolve.js';
import { releaseMatchesFilters, buildMusicMapFilterQuery, countActiveFilters, EMPTY_FILTER_STATE, COUNTRY_ALIASES, normalizeCountry, expandCountries } from './filters.js';
import { ReactionRegistry, DEFAULT_CONDITIONS } from './reactions.js';
import { NavigationGraph } from './navigation.js';
import { shufflePick } from './shuffle.js';
import * as pickers from './pickers.js';

export {
  buildMusicMapFilterQuery,
  countActiveFilters,
  EMPTY_FILTER_STATE,
  COUNTRY_ALIASES,
  normalizeCountry,
  expandCountries,
  DEFAULT_CONDITIONS,
  mergeCatalogue,
};

export class ZigZagDiscovery {
  constructor({ releases, users = [], gems = [], seed = 'zig~zag' } = {}) {
    this.releases = releases;
    this.users = users;
    this.gems = gems;
    this.reactions = new ReactionRegistry();
    this.navigation = new NavigationGraph();

    // Our own pipeline: feature-space similarity -> emergent islands -> sea.
    this.similarityFn = buildSimilarity(releases);
    const { placements, islands, depths } = mapCatalogue(releases, this.similarityFn, { seed });
    this.placements = placements;
    this.islands = islands;
    this.depths = depths;

    this.state = {
      releases,
      users,
      gems,
      similarity: this.similarityFn,
      releaseById: (id) => releases.find((r) => r.id === id) ?? null,
      gemCount: (releaseId) => gems.filter((g) => g.releaseId === releaseId).length,
      asReleaseTrack: (release) => ({
        release_track: { ...release, chosen_track_id: release.tracks[0]?.id ?? null },
      }),
    };
  }

  /** Build an engine directly from raw adapter output (any mix of sources). */
  static fromRaw(rawReleases, options = {}) {
    const { releases } = mergeCatalogue(rawReleases);
    return new ZigZagDiscovery({ releases, ...options });
  }

  // --- map ---------------------------------------------------------------

  /** release.maps[mapId] = {x, y} equivalent. */
  mapPlacement(releaseId) {
    return this.placements.get(releaseId) ?? null;
  }

  /** Which island a release belongs to. */
  islandOf(releaseId) {
    return this.islands.find((island) => island.memberIds.includes(releaseId)) ?? null;
  }

  /** 0 = mainstream-ish / well connected, 1 = deep cut. */
  depthOf(releaseId) {
    return this.depths.get(releaseId) ?? null;
  }

  /** Why are these two releases similar (or not)? */
  explain(releaseIdA, releaseIdB) {
    const a = this.state.releaseById(releaseIdA);
    const b = this.state.releaseById(releaseIdB);
    if (!a || !b) return null;
    return explainSimilarity(a, b, this.similarityFn);
  }

  /** Explain a picker result against the release it came from. */
  explainPick(pick, contextReleaseId) {
    return explainPick(
      pick,
      contextReleaseId ? this.state.releaseById(contextReleaseId) : null,
      this.similarityFn,
    );
  }

  /** Auto-generated navigation candidates across islands. */
  tradeRoutes({ minScore = 0.3, perRelease = 1 } = {}) {
    return buildTradeRoutes(this.releases, this.similarityFn, {
      islands: this.islands,
      minScore,
      perRelease,
    });
  }

  /** GET /v2/releases/by-coordinates?xy_x&xy_y */
  getReleaseByCoordinates({ x, y }) {
    for (const [id, pos] of this.placements) {
      if (pos.x === Math.round(x) && pos.y === Math.round(y)) return this.state.releaseById(id);
    }
    return null;
  }

  /** Coordinates in the site's URL format ("x~y"). */
  coordinatesString(releaseId) {
    const pos = this.mapPlacement(releaseId);
    return pos ? `${pos.x}~${pos.y}` : null;
  }

  // --- filters -----------------------------------------------------------

  /** Apply a raw query (API field names) over the catalogue. */
  filterReleases(query = {}) {
    return this.releases.filter((r) => releaseMatchesFilters(r, query, this.reactions));
  }

  // --- pickers -----------------------------------------------------------

  /** GET /v2/maps/:mapId/releases/related */
  getRelated({ current_release_id, limit = 10, filter } = {}) {
    return pickers.related(this.state, current_release_id, {
      limit,
      filter,
      reactionRegistry: this.reactions,
    });
  }

  /** POST /v2/maps/:mapId/releases/similar */
  postSimilar({ current_release_id, filter }, { rand = Math.random, excludeIds = [] } = {}) {
    return pickers.similarPick(this.state, current_release_id, {
      filter,
      reactionRegistry: this.reactions,
      rand,
      excludeIds,
    });
  }

  /** GET /v2/maps/:mapId/releases/banger */
  getBanger({ filter } = {}, { rand = Math.random, excludeIds = [] } = {}) {
    return pickers.bangerPick(this.state, {
      filter,
      reactionRegistry: this.reactions,
      rand,
      excludeIds,
    });
  }

  /** GET /v2/{resource}/{id}/radio */
  getEntityRadio({ resource, id, style, country, gem_only }, { rand = Math.random, excludeIds = [] } = {}) {
    return pickers.radioPick(this.state, {
      resource,
      id,
      style,
      country,
      gemOnly: gem_only,
      reactionRegistry: this.reactions,
      rand,
      excludeIds,
    });
  }

  /** gems-shuffle helper */
  getRandomGem(userId, { rand = Math.random } = {}) {
    return pickers.randomGem(this.state, userId, rand);
  }

  // --- reactions ("conditions") -----------------------------------------

  /** Toggle a reaction vote on a track (ConditionGrid behaviour). */
  toggleReaction({ userId, releaseId, trackId, condition }) {
    return this.reactions.toggle({ userId, releaseId, trackId, condition });
  }

  /** `top_conditions` included in play-path responses. */
  topConditions(releaseId, trackId, limit = 3) {
    return this.reactions.topConditions(releaseId, trackId, limit);
  }

  /** Play-path shape: pick + its top conditions. */
  withTopConditions(release, limit = 3) {
    if (!release) return null;
    const trackId = release.tracks[0]?.id ?? null;
    return { ...release, top_conditions: this.topConditions(release.id, trackId, limit) };
  }

  // --- navigation suggestions -------------------------------------------

  postNavigationSuggestion({ from_release_id, to_release_id, to_track_id = null }) {
    return this.navigation.add({ fromReleaseId: from_release_id, toReleaseId: to_release_id, toTrackId: to_track_id });
  }

  getNavigationSuggestions({ from_release_id = 0, limit = 10 } = {}) {
    return this.navigation
      .list({ fromReleaseId: from_release_id, limit })
      .map((edge) => {
        const release = this.state.releaseById(edge.toReleaseId);
        const base = this.state.asReleaseTrack(release).release_track;
        // The suggestion carries the inviter's chosen track, like the site's
        // attach-a-gem links.
        return {
          ...edge,
          release_track: {
            ...base,
            chosen_track_id: edge.toTrackId ?? base.chosen_track_id,
          },
        };
      });
  }

  deleteNavigationSuggestion(id) {
    return this.navigation.remove(id);
  }

  // --- community --------------------------------------------------------

  /** GET /v2/community/track — gemmed tracks, most liked first. */
  getCommunityTracks({ order_by = 'MOST_LIKED', limit = 20, offset = 0 } = {}) {
    const likes = new Map();
    for (const gem of this.gems) {
      likes.set(gem.releaseId, (likes.get(gem.releaseId) ?? 0) + 1);
    }
    let rows = [...likes.entries()].map(([releaseId, count]) => ({
      ...this.state.asReleaseTrack(this.state.releaseById(releaseId)),
      likes: count,
    }));
    rows.sort((a, b) => b.likes - a.likes || a.release_track.id.localeCompare(b.release_track.id));
    if (order_by === 'LATEST') rows = rows.reverse();
    return rows.slice(offset, offset + limit);
  }

  // --- shuffles ---------------------------------------------------------

  /** pickShuffleRelease equivalent over the catalogue as a "playlist". */
  shufflePick({ recentIds = [], rand = Math.random } = {}) {
    return shufflePick({
      pool: this.releases,
      totalTracks: this.releases.length,
      readAtOffset: (offset) => this.releases[offset] ?? null,
      recentIds,
      rand,
    });
  }
}
