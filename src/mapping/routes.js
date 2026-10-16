// Trade routes: automatic "from here sail there" edges across islands.
//
// Idea: zig-zag's navigation suggestions are written by humans. Here we also
// generate candidate routes mechanically: for each release, the most similar
// release that lives on a DIFFERENT island. Crossing water to a related sound
// is exactly the serendipity the sea is for.

export function tradeRoutes(releases, similarity, { islands = [], minScore = 0.3, perRelease = 1 } = {}) {
  const islandOf = new Map();
  for (const island of islands) {
    for (const id of island.memberIds) islandOf.set(id, island.id);
  }

  const seen = new Set();
  const routes = [];

  for (const from of releases) {
    const candidates = releases
      .filter((to) => to.id !== from.id)
      .filter((to) => islandOf.size === 0 || islandOf.get(to.id) !== islandOf.get(from.id))
      .map((to) => ({ to, score: similarity(from, to) }))
      .filter((row) => row.score >= minScore)
      .sort((a, b) => b.score - a.score || a.to.id.localeCompare(b.to.id))
      .slice(0, perRelease);

    for (const { to, score } of candidates) {
      const key = [from.id, to.id].sort().join('>');
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({
        from: from.id,
        to: to.id,
        score: Number(score.toFixed(3)),
        fromIsland: islandOf.get(from.id) ?? null,
        toIsland: islandOf.get(to.id) ?? null,
      });
    }
  }

  return routes.sort((a, b) => b.score - a.score || a.from.localeCompare(b.from));
}
