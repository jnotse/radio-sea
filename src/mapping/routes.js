// Trade routes: automatic "from here sail there" edges across islands,
// combining per-release nearest cross-island neighbours with H0 topological
// nerve bridges from the Vietoris-Rips minimum spanning forest.

import { computePersistentHomology } from './tda.js';

export function tradeRoutes(releases, similarity, { islands = [], minScore = 0.3, perRelease = 1 } = {}) {
  const islandOf = new Map();
  for (const island of islands) {
    for (const id of island.memberIds) islandOf.set(id, island.id);
  }

  // Identify H0 persistence bridge edges that cross islands.
  const { mstEdges } = computePersistentHomology(releases, similarity, { maxScale: 1 - minScore });
  const nerveBridgeKeys = new Set();
  for (const edge of mstEdges) {
    if (islandOf.size === 0 || islandOf.get(edge.from) !== islandOf.get(edge.to)) {
      nerveBridgeKeys.add([edge.from, edge.to].sort().join('>'));
    }
  }

  const seen = new Set();
  const routes = [];
  const addRoute = (fromId, toId, rawScore) => {
    const key = [fromId, toId].sort().join('>');
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({
      from: fromId,
      to: toId,
      score: Number(rawScore.toFixed(3)),
      fromIsland: islandOf.get(fromId) ?? null,
      toIsland: islandOf.get(toId) ?? null,
      bridge: nerveBridgeKeys.has(key),
    });
  };

  // First include H0 nerve bridges that meet minScore.
  for (const edge of mstEdges) {
    if (edge.similarity < minScore) continue;
    if (islandOf.size > 0 && islandOf.get(edge.from) === islandOf.get(edge.to)) continue;
    addRoute(edge.from, edge.to, edge.similarity);
  }

  for (const from of releases) {
    const candidates = releases
      .filter((to) => to.id !== from.id)
      .filter((to) => islandOf.size === 0 || islandOf.get(to.id) !== islandOf.get(from.id))
      .map((to) => ({ to, score: similarity(from, to) }))
      .filter((row) => row.score >= minScore)
      .sort((a, b) => b.score - a.score || a.to.id.localeCompare(b.to.id))
      .slice(0, perRelease);

    for (const { to, score } of candidates) {
      addRoute(from.id, to.id, score);
    }
  }

  return routes.sort((a, b) => b.score - a.score || Number(b.bridge) - Number(a.bridge) || a.from.localeCompare(b.from));
}
