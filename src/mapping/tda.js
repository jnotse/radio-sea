// Topological Data Analysis (TDA) for music catalogues.
//
// Given releases X and a similarity function s(a, b) in [0, 1], induces the
// dissimilarity semimetric d(a, b) = 1 - s(a, b) and computes:
//
//   1. Vietoris-Rips Persistent Homology (H0 & H1):
//      - H0 barcode: connected components born at d = 0 and merged along the
//        single-linkage filtration (Elder Rule), recording each component's
//        death scale, persistence, and the bridge edge that connected it.
//      - H1 barcode: 1-dimensional topological cycles (loops of songs that
//        transition continuously around a ring without a central hub), with
//        birth scale, 2-simplex filling (death) scale, and persistence.
//
//   2. Spectral / Diffusion Lens & Seriation:
//      - Deterministic power-iteration eigenvectors of the normalized affinity
//        matrix, giving intrinsic 1D/2D topological coordinates even when
//        explicit metadata fields are sparse.
//
//   3. Mapper Nerve Complex (Singh, Memoli, Carlsson 2007):
//      - Projects releases through a filter/lens function (spectral + density
//        eccentricity), covers the range with overlapping bins, clusters
//        within each bin, and builds the nerve simplicial complex:
//        0-simplices (nodes), 1-simplices (shared-track edges), 2-simplices
//        (triangles), and bridge records that belong to multiple nodes.

import { isGenreTag, tagLabel } from './tags.js';

/** Dissimilarity d(a, b) = 1 - sim(a, b) in [0, 1]. */
export function distanceMatrix(releases, similarity) {
  const n = releases.length;
  const dist = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const s = Math.max(0, Math.min(1, similarity(releases[i], releases[j])));
      const d = 1 - s;
      dist[i][j] = d;
      dist[j][i] = d;
    }
  }
  return dist;
}

/**
 * Compute k-nearest-neighbour local density and global eccentricity in [0, 1]
 * for each release.
 */
export function computeDensityAndEccentricity(releases, similarity, { k = 5, dist = null } = {}) {
  const n = releases.length;
  if (n === 0) return { density: [], eccentricity: [] };
  const D = dist ?? distanceMatrix(releases, similarity);
  const kEff = Math.max(1, Math.min(k, n - 1));
  const density = new Float64Array(n);
  const eccentricity = new Float64Array(n);

  for (let i = 0; i < n; i += 1) {
    if (n === 1) {
      density[i] = 1;
      eccentricity[i] = 0;
      continue;
    }
    const row = [];
    let sumDist = 0;
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      row.push(D[i][j]);
      sumDist += D[i][j];
    }
    row.sort((a, b) => a - b);
    let knnDist = 0;
    for (let m = 0; m < kEff; m += 1) knnDist += row[m];
    knnDist /= kEff;
    density[i] = Number((1 - knnDist).toFixed(4));
    eccentricity[i] = Number((sumDist / (n - 1)).toFixed(4));
  }
  return { density: Array.from(density), eccentricity: Array.from(eccentricity) };
}

/**
 * Deterministic 2D spectral embedding (first two nontrivial eigenvectors of
 * the random-walk normalized affinity matrix) via deflated power iteration.
 */
export function spectralLens(releases, similarity, { dist = null, iterations = 40 } = {}) {
  const n = releases.length;
  if (n === 0) return [];
  if (n === 1) return [{ u: 0, v: 0 }];
  const D = dist ?? distanceMatrix(releases, similarity);

  // Symmetric normalized affinity W_ij = exp(-d_ij^2 / sigma^2) with self-loops.
  const W = Array.from({ length: n }, () => new Float64Array(n));
  const deg = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const s = i === j ? 0.2 : Math.max(0, 1 - D[i][j]);
      W[i][j] = s;
      deg[i] += s;
    }
  }
  const invSqrtDeg = deg.map((d) => (d > 1e-12 ? 1 / Math.sqrt(d) : 0));
  const M = Array.from({ length: n }, (_, i) => {
    const row = new Float64Array(n);
    for (let j = 0; j < n; j += 1) row[j] = W[i][j] * invSqrtDeg[i] * invSqrtDeg[j];
    return row;
  });

  // Trivial stationary eigenvector v0_i ~ sqrt(deg_i).
  const v0 = new Float64Array(n);
  let norm0 = 0;
  for (let i = 0; i < n; i += 1) {
    v0[i] = Math.sqrt(Math.max(1e-12, deg[i]));
    norm0 += v0[i] * v0[i];
  }
  norm0 = Math.sqrt(norm0) || 1;
  for (let i = 0; i < n; i += 1) v0[i] /= norm0;

  const deflate = (vec, basis) => {
    for (const b of basis) {
      let dot = 0;
      for (let i = 0; i < n; i += 1) dot += vec[i] * b[i];
      for (let i = 0; i < n; i += 1) vec[i] -= dot * b[i];
    }
    let norm = 0;
    for (let i = 0; i < n; i += 1) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 1e-12) {
      for (let i = 0; i < n; i += 1) vec[i] /= norm;
    }
  };

  const findEigenvector = (basis, seedFn) => {
    const vec = new Float64Array(n);
    for (let i = 0; i < n; i += 1) vec[i] = seedFn(i);
    deflate(vec, basis);
    const next = new Float64Array(n);
    for (let iter = 0; iter < iterations; iter += 1) {
      for (let i = 0; i < n; i += 1) {
        let sum = 0;
        const row = M[i];
        for (let j = 0; j < n; j += 1) sum += row[j] * vec[j];
        // Shift by +I so negative eigenvalues never flip sign.
        next[i] = sum + vec[i];
      }
      for (let i = 0; i < n; i += 1) vec[i] = next[i];
      deflate(vec, basis);
    }
    // Canonical sign: first non-zero entry with largest magnitude is positive.
    let maxIdx = 0;
    for (let i = 1; i < n; i += 1) {
      if (Math.abs(vec[i]) > Math.abs(vec[maxIdx])) maxIdx = i;
    }
    if (vec[maxIdx] < 0) {
      for (let i = 0; i < n; i += 1) vec[i] = -vec[i];
    }
    return vec;
  };

  const v1 = findEigenvector([v0], (i) => Math.sin((i + 1) * 1.6180339887));
  const v2 = n > 2 ? findEigenvector([v0, v1], (i) => Math.cos((i + 1) * 2.7182818284)) : new Float64Array(n);
  const v3 = n > 3 ? findEigenvector([v0, v1, v2], (i) => Math.sin((i + 1) * 3.1415926535)) : new Float64Array(n);

  return releases.map((_, i) => ({
    u: Number((v1[i] * invSqrtDeg[i]).toFixed(5)),
    v: Number((v2[i] * invSqrtDeg[i]).toFixed(5)),
    w: Number((v3[i] * invSqrtDeg[i]).toFixed(5)),
  }));
}

/**
 * Minimum distance at which a cycle of vertex indices is filled by 2-simplices
 * in the Vietoris-Rips filtration (minimax triangulation diameter).
 */
function cycleFillingScale(cycleIndices, D) {
  const k = cycleIndices.length;
  if (k <= 3) {
    return Math.max(
      D[cycleIndices[0]][cycleIndices[1]],
      D[cycleIndices[1]][cycleIndices[2]],
      D[cycleIndices[0]][cycleIndices[2]],
    );
  }
  // Dynamic programming over polygon sub-chains [i..j] for exact minimax triangulation.
  const dp = Array.from({ length: k }, () => new Float64Array(k));
  for (let len = 2; len < k; len += 1) {
    for (let i = 0; i + len < k; i += 1) {
      const j = i + len;
      const vi = cycleIndices[i];
      const vj = cycleIndices[j];
      const chordIJ = j - i === k - 1 ? D[vi][vj] : D[vi][vj];
      if (len === 2) {
        const vm = cycleIndices[i + 1];
        dp[i][j] = Math.max(D[vi][vm], D[vm][vj], chordIJ);
      } else {
        let best = Infinity;
        for (let m = i + 1; m < j; m += 1) {
          const vm = cycleIndices[m];
          const tri = Math.max(D[vi][vm], D[vm][vj], chordIJ);
          const cost = Math.max(dp[i][m], dp[m][j], tri);
          if (cost < best) best = cost;
        }
        dp[i][j] = best;
      }
    }
  }
  return dp[0][k - 1];
}

/** Shortest path between u and v in an adjacency list of tree/graph edges. */
function shortestPath(adj, u, v, n) {
  const prev = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);
  const queue = [u];
  visited[u] = 1;
  for (let head = 0; head < queue.length; head += 1) {
    const curr = queue[head];
    if (curr === v) break;
    for (const next of adj[curr]) {
      if (!visited[next]) {
        visited[next] = 1;
        prev[next] = curr;
        queue.push(next);
      }
    }
  }
  if (!visited[v]) return null;
  const path = [];
  for (let at = v; at !== -1; at = prev[at]) path.push(at);
  return path.reverse();
}

/**
 * Compute 0-dimensional (H0) and 1-dimensional (H1) persistent homology of the
 * Vietoris-Rips filtration over (releases, similarity).
 */
export function computePersistentHomology(releases, similarity, {
  maxScale = 0.85,
  minCyclePersistence = 0.05,
  maxCycles = 12,
  dist = null,
} = {}) {
  const n = releases.length;
  if (n === 0) return { h0: [], h1: [], mstEdges: [] };
  const D = dist ?? distanceMatrix(releases, similarity);

  // Collect all pairs with finite similarity (d < 1).
  const edges = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const d = D[i][j];
      if (d <= maxScale) {
        edges.push({ u: i, v: j, distance: d, similarity: Number((1 - d).toFixed(3)) });
      }
    }
  }
  edges.sort((a, b) => a.distance - b.distance || a.u - b.u || a.v - b.v);

  // Union-Find for H0 (Elder Rule: larger component, then lower index survives).
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const size = new Int32Array(n).fill(1);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };

  const h0Deaths = new Map();
  const mstEdges = [];
  const treeAdj = Array.from({ length: n }, () => []);
  const candidateCycles = [];

  for (const edge of edges) {
    const ru = find(edge.u);
    const rv = find(edge.v);
    if (ru !== rv) {
      // Elder rule: keep the larger cluster (or lower index on ties) alive.
      const [survivor, dying] = size[ru] > size[rv] || (size[ru] === size[rv] && ru < rv)
        ? [ru, rv]
        : [rv, ru];
      parent[dying] = survivor;
      size[survivor] += size[dying];
      const death = Number(edge.distance.toFixed(3));
      h0Deaths.set(dying, {
        id: releases[dying].id,
        birth: 0,
        death,
        persistence: death,
        mergedInto: releases[survivor].id,
        bridgeEdge: {
          from: releases[edge.u].id,
          to: releases[edge.v].id,
          distance: death,
          similarity: edge.similarity,
        },
      });
      mstEdges.push({
        from: releases[edge.u].id,
        to: releases[edge.v].id,
        fromIndex: edge.u,
        toIndex: edge.v,
        distance: death,
        similarity: edge.similarity,
      });
      treeAdj[edge.u].push(edge.v);
      treeAdj[edge.v].push(edge.u);
    } else {
      // Edge connects two vertices already in the same H0 component -> 1-cycle!
      const path = shortestPath(treeAdj, edge.u, edge.v, n);
      if (path && path.length >= 4 && path.length <= 10) {
        const birth = edge.distance;
        const death = cycleFillingScale(path, D);
        const persistence = death - birth;
        if (persistence >= minCyclePersistence) {
          candidateCycles.push({
            birth: Number(birth.toFixed(3)),
            death: Number(death.toFixed(3)),
            persistence: Number(persistence.toFixed(3)),
            cycle: path.map((idx) => releases[idx].id),
            indices: path,
          });
        }
      }
      // Add edge to graph adjacency so subsequent cycles are chordless/minimal.
      treeAdj[edge.u].push(edge.v);
      treeAdj[edge.v].push(edge.u);
    }
  }

  const h0 = [];
  for (let i = 0; i < n; i += 1) {
    if (h0Deaths.has(i)) {
      h0.push(h0Deaths.get(i));
    } else {
      h0.push({
        id: releases[i].id,
        birth: 0,
        death: 1,
        persistence: 1,
        mergedInto: null,
        bridgeEdge: null,
      });
    }
  }
  h0.sort((a, b) => b.persistence - a.persistence || a.id.localeCompare(b.id));

  // Deduplicate cycles with high vertex overlap and rank by H1 persistence.
  candidateCycles.sort((a, b) => b.persistence - a.persistence || b.cycle.length - a.cycle.length);
  const h1 = [];
  for (const cand of candidateCycles) {
    if (h1.length >= maxCycles) break;
    const setA = new Set(cand.cycle);
    const overlapsExisting = h1.some((existing) => {
      let shared = 0;
      for (const id of existing.cycle) if (setA.has(id)) shared += 1;
      return shared / Math.min(existing.cycle.length, cand.cycle.length) >= 0.75;
    });
    if (!overlapsExisting) {
      h1.push({
        birth: cand.birth,
        death: cand.death,
        persistence: cand.persistence,
        cycle: cand.cycle,
      });
    }
  }

  return { h0, h1, mstEdges };
}

/**
 * Build the Mapper simplicial complex (nerve of an overlapping pullback cover).
 *
 * Uses a 1D or 2D lens (default: primary spectral diffusion coordinate) covered
 * by `bins` intervals with fractional `overlap` in (0, 1), clusters each bin by
 * single/average linkage at `linkThreshold`, and constructs:
 *   - `nodes` (0-simplices): local clusters within cover bins
 *   - `edges` (1-simplices): pairs of nodes that share bridge releases or cross-link
 *   - `triangles` (2-simplices): triples of nodes with a common intersection
 *   - `bridges`: releases that belong to multiple Mapper nodes or connect islands
 */
export function buildMapperComplex(releases, similarity, {
  bins = 6,
  overlap = 0.35,
  linkThreshold = 0.25,
  dist = null,
  lensValues = null,
} = {}) {
  const n = releases.length;
  if (n === 0) return { nodes: [], edges: [], triangles: [], bridges: [] };
  const D = dist ?? distanceMatrix(releases, similarity);

  // Default lens: primary spectral diffusion coordinate u.
  const lens = lensValues ?? spectralLens(releases, similarity, { dist: D }).map((p) => p.u);
  let minVal = Infinity;
  let maxVal = -Infinity;
  for (const v of lens) {
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }
  const span = maxVal - minVal;
  const numBins = span < 1e-9 ? 1 : Math.max(1, bins);
  const step = span / numBins;
  const halfWidth = (step / (1 - Math.min(0.8, Math.max(0.05, overlap)))) * 0.5;

  // Document frequency for naming Mapper nodes.
  const docFreq = new Map();
  for (const r of releases) {
    for (const tag of new Set(r.tags?.all ?? r.styles ?? [])) {
      docFreq.set(tag, (docFreq.get(tag) ?? 0) + 1);
    }
  }

  const nodes = [];
  for (let b = 0; b < numBins; b += 1) {
    const center = minVal + (b + 0.5) * step;
    const lo = b === 0 ? minVal - 1e-9 : center - halfWidth;
    const hi = b === numBins - 1 ? maxVal + 1e-9 : center + halfWidth;

    const binIndices = [];
    for (let i = 0; i < n; i += 1) {
      if (lens[i] >= lo && lens[i] <= hi) binIndices.push(i);
    }
    if (binIndices.length === 0) continue;

    // Single-linkage / average-linkage clustering inside this cover bin.
    let groups = binIndices.map((idx) => [idx]);
    while (groups.length > 1) {
      let bestI = 0;
      let bestJ = 1;
      let bestSim = linkThreshold;
      for (let i = 0; i < groups.length; i += 1) {
        for (let j = i + 1; j < groups.length; j += 1) {
          let total = 0;
          let count = 0;
          for (const u of groups[i]) {
            for (const v of groups[j]) {
              total += 1 - D[u][v];
              count += 1;
            }
          }
          const avg = count > 0 ? total / count : 0;
          if (avg > bestSim) {
            bestSim = avg;
            bestI = i;
            bestJ = j;
          }
        }
      }
      if (bestSim <= linkThreshold) break;
      const merged = [...groups[bestI], ...groups[bestJ]];
      groups = groups.filter((_, idx) => idx !== bestI && idx !== bestJ);
      groups.push(merged);
    }

    groups.sort((a, b) => b.length - a.length || a[0] - b[0]);
    for (const group of groups) {
      const memberIds = group.map((idx) => releases[idx].id);
      const label = nodeLabel(group.map((idx) => releases[idx]), docFreq);
      nodes.push({
        id: `node-${nodes.length}`,
        bin: b,
        lensCenter: Number(center.toFixed(4)),
        label,
        memberIds,
        memberIndices: group,
      });
    }
  }

  // Nerve 1-simplices (edges) where two nodes share at least one release.
  const edges = [];
  const nodeSets = nodes.map((node) => new Set(node.memberIds));
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const shared = nodes[i].memberIds.filter((id) => nodeSets[j].has(id));
      if (shared.length > 0) {
        edges.push({
          from: nodes[i].id,
          to: nodes[j].id,
          sharedIds: shared,
          weight: shared.length,
        });
      }
    }
  }

  // Nerve 2-simplices (triangles) where three nodes have a non-empty triple intersection.
  const triangles = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const sharedIJ = nodes[i].memberIds.filter((id) => nodeSets[j].has(id));
      if (!sharedIJ.length) continue;
      for (let k = j + 1; k < nodes.length; k += 1) {
        const sharedIJK = sharedIJ.filter((id) => nodeSets[k].has(id));
        if (sharedIJK.length > 0) {
          triangles.push({
            nodes: [nodes[i].id, nodes[j].id, nodes[k].id],
            sharedIds: sharedIJK,
          });
        }
      }
    }
  }

  // Track membership across Mapper nodes to identify topological bridge records.
  const memberships = new Map();
  for (const node of nodes) {
    for (const id of node.memberIds) {
      if (!memberships.has(id)) memberships.set(id, []);
      memberships.get(id).push(node.id);
    }
  }
  const bridges = [];
  for (const [id, nodeIds] of memberships) {
    if (nodeIds.length > 1) {
      bridges.push({ id, nodes: nodeIds, multiplicity: nodeIds.length });
    }
  }
  bridges.sort((a, b) => b.multiplicity - a.multiplicity || a.id.localeCompare(b.id));

  return {
    nodes: nodes.map(({ memberIndices, ...rest }) => rest),
    edges,
    triangles,
    bridges,
  };
}

function nodeLabel(members, docFreq) {
  const counts = new Map();
  for (const m of members) {
    const tags = (m.tags?.all ?? m.styles ?? []).filter((t) => isGenreTag(t));
    for (const t of new Set(tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || (docFreq.get(a[0]) ?? Infinity) - (docFreq.get(b[0]) ?? Infinity) || a[0].localeCompare(b[0]),
  );
  if (ranked.length) return tagLabel(ranked[0][0]);
  const show = (members[0]?.tags?.all ?? []).find((t) => t.startsWith('show:'));
  return show ? tagLabel(show) : members[0]?.id ?? 'cluster';
}

/**
 * Find topological bridge releases across islands: releases that have strong
 * similarity to at least two distinct islands, ranked by cross-island bridge score.
 */
export function findIslandBridges(releases, similarity, islands, { minScore = 0.2 } = {}) {
  if (!islands || islands.length < 2) return [];
  const islandOf = new Map();
  for (const island of islands) {
    for (const id of island.memberIds ?? island.members?.map((m) => m.id) ?? []) {
      islandOf.set(id, island);
    }
  }
  const byId = new Map(releases.map((r) => [r.id, r]));
  const bridges = [];

  for (const release of releases) {
    const home = islandOf.get(release.id);
    if (!home) continue;

    // Best similarity from `release` to each OTHER island.
    const foreignLinks = [];
    for (const otherIsland of islands) {
      if (otherIsland.id === home.id) continue;
      const memberIds = otherIsland.memberIds ?? otherIsland.members?.map((m) => m.id) ?? [];
      let bestSim = 0;
      let bestTargetId = null;
      for (const otherId of memberIds) {
        const other = byId.get(otherId);
        if (!other) continue;
        const s = similarity(release, other);
        if (s > bestSim) {
          bestSim = s;
          bestTargetId = otherId;
        }
      }
      if (bestSim >= minScore && bestTargetId) {
        foreignLinks.push({
          islandId: otherIsland.id,
          islandName: otherIsland.name,
          targetId: bestTargetId,
          score: Number(bestSim.toFixed(3)),
        });
      }
    }

    if (foreignLinks.length > 0) {
      foreignLinks.sort((a, b) => b.score - a.score || a.islandId - b.islandId);
      const top = foreignLinks[0];
      // Bridge strength rewards both the strongest cross-island tie and how many distinct islands it reaches.
      const bridgeScore = Number((top.score * (1 + 0.15 * Math.min(3, foreignLinks.length - 1))).toFixed(3));
      bridges.push({
        id: release.id,
        homeIslandId: home.id,
        homeIslandName: home.name,
        targetIslandId: top.islandId,
        targetIslandName: top.islandName,
        targetReleaseId: top.targetId,
        score: top.score,
        bridgeScore,
        reachesIslands: foreignLinks.length,
        connections: foreignLinks.slice(0, 3),
      });
    }
  }

  return bridges.sort((a, b) => b.bridgeScore - a.bridgeScore || a.id.localeCompare(b.id));
}

/**
 * Order members of an island around a 1D topological loop (greedy nearest-neighbour
 * tour seeded from the earliest release) so adjacent positions along the grove's
 * perimeter share maximum pairwise similarity.
 */
export function seriateIslandMembers(members, similarity) {
  if (members.length <= 2) {
    return members.slice().sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.id.localeCompare(b.id));
  }
  const seedSorted = members
    .slice()
    .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.id.localeCompare(b.id));

  const remaining = new Set(seedSorted.slice(1));
  const tour = [seedSorted[0]];

  while (remaining.size > 0) {
    const current = tour[tour.length - 1];
    let bestNext = null;
    let bestSim = -1;
    for (const cand of remaining) {
      const s = similarity(current, cand);
      // Slight tie-breaker toward era continuity when similarities are close.
      const eraBonus = current.year != null && cand.year != null
        ? Math.max(0, 1 - Math.abs(current.year - cand.year) / 40) * 0.05
        : 0;
      const score = s + eraBonus;
      if (score > bestSim) {
        bestSim = score;
        bestNext = cand;
      }
    }
    tour.push(bestNext);
    remaining.delete(bestNext);
  }
  return tour;
}

/**
 * Compute deterministic 3D topological coordinates (tx, ty, tz) for each release.
 * Islands are arranged on a 3D manifold relaxed by cross-island nerve affinity,
 * with local seriated rings and vertical elevation driven by spectral w and density.
 */
export function layoutTopology3D(releases, similarity, {
  islands = [],
  spectral = null,
  density = null,
  bridges = [],
} = {}) {
  const n = releases.length;
  if (n === 0) return new Map();
  const spec = spectral ?? spectralLens(releases, similarity);
  const dens = density ?? computeDensityAndEccentricity(releases, similarity).density;
  const idxById = new Map(releases.map((r, i) => [r.id, i]));
  const byId = new Map(releases.map((r) => [r.id, r]));

  // Normalize spectral coordinates to [-1, 1] for stable 3D initialization.
  const normAxis = (getter) => {
    const vals = spec.map(getter);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    return vals.map((v) => ((v - min) / span) * 2 - 1);
  };
  const normU = normAxis((p) => p.u);
  const normV = normAxis((p) => p.v);
  const normW = normAxis((p) => p.w ?? 0);

  const groups = islands.length > 0
    ? islands.map((isl) => ({
      id: isl.id,
      memberIds: isl.memberIds ?? isl.members?.map((m) => m.id) ?? [],
    }))
    : [{ id: 0, memberIds: releases.map((r) => r.id) }];

  // Order islands by mean spectral u so the Fibonacci sphere follows the spectral manifold.
  const orderedGroups = groups.slice().sort((a, b) => {
    const meanU = (ids) => ids.reduce((s, id) => s + (normU[idxById.get(id) ?? 0] ?? 0), 0) / Math.max(1, ids.length);
    return meanU(a.memberIds) - meanU(b.memberIds);
  });

  const shellRadius = Math.max(14, Math.cbrt(n) * 7.5);
  const goldenRatio = (1 + Math.sqrt(5)) / 2;
  const centres = new Map();

  orderedGroups.forEach((group, k) => {
    const count = orderedGroups.length;
    const t = count > 1 ? k / (count - 1) : 0.5;
    const y = 1 - 2 * t;
    const rSlice = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = (2 * Math.PI * k) / goldenRatio;
    const meanW = group.memberIds.reduce((s, id) => s + (normW[idxById.get(id) ?? 0] ?? 0), 0) / Math.max(1, group.memberIds.length);
    const radialScale = shellRadius * (0.75 + 0.25 * Math.abs(meanW));

    centres.set(group.id, {
      id: group.id,
      members: group.memberIds.map((id) => byId.get(id)).filter(Boolean),
      x: Math.cos(theta) * rSlice * radialScale,
      y: Math.sin(theta) * rSlice * radialScale,
      z: y * radialScale * 0.75,
      radius: 1.8 + Math.sqrt(group.memberIds.length) * 1.4,
    });
  });

  const centreList = [...centres.values()];
  // 3D nerve relaxation: pull connected islands together, push overlapping islands apart.
  for (let iter = 0; iter < 50; iter += 1) {
    for (let i = 0; i < centreList.length; i += 1) {
      for (let j = i + 1; j < centreList.length; j += 1) {
        const a = centreList[i];
        const b = centreList[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const dist = Math.max(0.1, Math.hypot(dx, dy, dz));
        const ux = dx / dist;
        const uy = dy / dist;
        const uz = dz / dist;

        const wanted = a.radius + b.radius + 3.5;
        const repel = dist < wanted ? (wanted - dist) * 0.28 : 0;

        let maxSim = 0;
        let sumSim = 0;
        let pairs = 0;
        for (const ma of a.members) {
          for (const mb of b.members) {
            const s = similarity(ma, mb);
            sumSim += s;
            pairs += 1;
            if (s > maxSim) maxSim = s;
          }
        }
        const aff = 0.6 * (pairs ? sumSim / pairs : 0) + 0.4 * maxSim;
        const attract = aff > 0.15 && dist > wanted ? Math.min((aff - 0.15) * 4.5, (dist - wanted) * 0.22) : 0;
        const move = -repel + attract;
        if (move === 0) continue;
        a.x += ux * move;
        a.y += uy * move;
        a.z += uz * move;
        b.x -= ux * move;
        b.y -= uy * move;
        b.z -= uz * move;
      }
    }
  }

  const bridgeMap = new Map(bridges.map((b) => [b.id, b]));
  const placements3D = new Map();

  for (const centre of centreList) {
    const ordered = seriateIslandMembers(centre.members, similarity);
    const ringRadius = centre.radius * 0.72;
    // Tilt each island's local ring Plane slightly according to its 3D normal.
    const norm = Math.max(0.1, Math.hypot(centre.x, centre.y, centre.z));
    const nx = centre.x / norm;
    const ny = centre.y / norm;

    ordered.forEach((release, idx) => {
      const i = idxById.get(release.id) ?? 0;
      const angle = (idx / Math.max(1, ordered.length)) * Math.PI * 2;
      const localX = Math.cos(angle) * ringRadius;
      const localY = Math.sin(angle) * ringRadius;
      const localZ = (dens[i] - 0.5) * 4.0 + normW[i] * 2.2 + (localX * nx + localY * ny) * 0.35;

      let x = centre.x + localX;
      let y = centre.y + localY;
      let z = centre.z + localZ;

      // Pull bridge records 20% toward the primary foreign island they connect to.
      const bridge = bridgeMap.get(release.id);
      if (bridge && centres.has(bridge.targetIslandId)) {
        const target = centres.get(bridge.targetIslandId);
        x = x * 0.82 + target.x * 0.18;
        y = y * 0.82 + target.y * 0.18;
        z = z * 0.82 + target.z * 0.18;
      }

      placements3D.set(release.id, {
        tx: Number(x.toFixed(2)),
        ty: Number(y.toFixed(2)),
        tz: Number(z.toFixed(2)),
      });
    });
  }

  return placements3D;
}

/**
 * Full topological summary of a catalogue.
 */
export function analyzeTopology(releases, similarity, { islands = [], minRouteScore = 0.2 } = {}) {
  const dist = distanceMatrix(releases, similarity);
  const { density, eccentricity } = computeDensityAndEccentricity(releases, similarity, { dist });
  const spectral = spectralLens(releases, similarity, { dist });
  const persistence = computePersistentHomology(releases, similarity, { dist });
  const mapper = buildMapperComplex(releases, similarity, {
    dist,
    lensValues: spectral.map((p) => p.u),
  });
  const bridges = findIslandBridges(releases, similarity, islands, { minScore: minRouteScore });
  const placements3D = layoutTopology3D(releases, similarity, { islands, spectral, density, bridges });

  return {
    persistence,
    mapper,
    bridges,
    coordinates: releases.map((r, i) => {
      const p3 = placements3D.get(r.id) ?? { tx: 0, ty: 0, tz: 0 };
      return {
        id: r.id,
        u: spectral[i].u,
        v: spectral[i].v,
        w: spectral[i].w,
        tx: p3.tx,
        ty: p3.ty,
        tz: p3.tz,
        density: density[i],
        eccentricity: eccentricity[i],
      };
    }),
  };
}
