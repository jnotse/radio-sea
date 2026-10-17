// Our mapping algorithm: turn a catalogue into a sea.
//
// 1. islands  — agglomerative clustering on the similarity function; releases
//               merge into an island while their average linkage stays above a
//               threshold, so islands emerge from the data instead of from a
//               fixed genre list. On the map, islands of one or two songs
//               join the island they are closest to; songs related to no
//               island at all gather by the station they came from.
// 2. world map — islands are laid down one by one, largest first, each
//               against the ones it is most related to, so related islands
//               neighbour each other and the map stays compact however many
//               songs it holds. Open ground keeps them apart.
// 3. shores   — releases inside an island fill a compact grove ordered by era
//               and relaxed by pairwise similarity, so the coastline walks
//               smoothly through the island's variants.
// 4. depth    — each release gets a depth value: how deep-cut / unexplored it
//               is (isolation + low cross-source agreement). Depth can be
//               rendered as water darkening.
//
// Everything is deterministic for a given seed.

import { fnv1aHash } from '../fnv1a.js';
import { mulberry32 } from '../rng.js';
import { isBroadGenre, isGenreTag, tagLabel } from './tags.js';

// Cluster while average linkage stays above this. Measured on the radio
// catalogue with per-song genres: songs sharing nothing score ~0 (p90 0.16),
// sharing only a broad genre ~0.07 (p90 0.20), sharing a style ~0.27
// (p90 0.49). 0.30 forms islands of one sound across shows and stations.
const LINKAGE_THRESHOLD = 0.30;

// Islands on the map smaller than this join their closest island, if they
// relate to one at least this much.
const MIN_GROVE = 3;
const FOLD_FLOOR = 0.05;
// Open ground between neighbouring islands, in map units.
const GROUND = 8;

/** Every pairwise similarity, once: clustering, layout and depth share them. */
function similarityMatrix(releases, similarity) {
  const n = releases.length;
  const matrix = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    matrix[i * n + i] = 1;
    for (let j = i + 1; j < n; j += 1) {
      const value = similarity(releases[i], releases[j]);
      matrix[i * n + j] = value;
      matrix[j * n + i] = value;
    }
  }
  return matrix;
}

/** Mean similarity between two lists of release indices. */
function meanLink(matrix, n, groupA, groupB) {
  let total = 0;
  for (const a of groupA) for (const b of groupB) total += matrix[a * n + b];
  return groupA.length && groupB.length ? total / (groupA.length * groupB.length) : 0;
}

// Average linkage: always merge the two groups with the highest mean
// similarity. Merged links follow from the old ones (Lance–Williams), and each
// group remembers its closest partner, so a thousand songs take moments.
function averageLinkage(matrix, n, threshold) {
  const link = Float64Array.from(matrix);
  const members = Array.from({ length: n }, (_, i) => [i]);
  const active = new Uint8Array(n).fill(1);
  const best = new Int32Array(n).fill(-1);
  const findBest = (i) => {
    let partner = -1;
    for (let k = 0; k < n; k += 1) {
      if (k !== i && active[k] && (partner < 0 || link[i * n + k] > link[i * n + partner])) partner = k;
    }
    best[i] = partner;
  };
  for (let i = 0; i < n; i += 1) findBest(i);
  for (;;) {
    let a = -1;
    for (let i = 0; i < n; i += 1) {
      if (active[i] && best[i] >= 0 && link[i * n + best[i]] > threshold && (a < 0 || link[i * n + best[i]] > link[a * n + best[a]])) a = i;
    }
    if (a < 0) break;
    const b = best[a];
    const [sizeA, sizeB] = [members[a].length, members[b].length];
    for (let k = 0; k < n; k += 1) {
      if (!active[k] || k === a || k === b) continue;
      const value = (sizeA * link[a * n + k] + sizeB * link[b * n + k]) / (sizeA + sizeB);
      link[a * n + k] = value;
      link[k * n + a] = value;
    }
    members[a].push(...members[b]);
    members[b] = null;
    active[b] = 0;
    for (let k = 0; k < n; k += 1) {
      if (!active[k]) continue;
      if (k === a || best[k] === a || best[k] === b) findBest(k);
      else if (link[k * n + a] > link[k * n + best[k]]) best[k] = a;
    }
  }
  return members.filter(Boolean);
}

// Islands smaller than `minSize` join the larger island they are closest to.
// Songs that relate to none (nothing known but who played them) gather by
// station instead of joining an island at random.
function foldSmall(groups, matrix, n, minSize, stationOf) {
  const large = groups.filter((group) => group.length >= minSize);
  if (minSize <= 1 || !large.length) return groups;
  const extra = large.map(() => []);
  const strays = new Map();
  for (const group of groups.filter((g) => g.length < minSize)) {
    let target = 0;
    let bestLink = -Infinity;
    large.forEach((other, index) => {
      const value = meanLink(matrix, n, group, other);
      if (value > bestLink) [target, bestLink] = [index, value];
    });
    if (bestLink >= FOLD_FLOOR) extra[target].push(...group);
    else for (const i of group) strays.set(stationOf(i), [...(strays.get(stationOf(i)) ?? []), i]);
  }
  return [...large.map((group, index) => [...group, ...extra[index]]), ...strays.values()];
}

export function clusterReleases(releases, similarity, { threshold = LINKAGE_THRESHOLD, minSize = 1, matrix = similarityMatrix(releases, similarity) } = {}) {
  const n = releases.length;
  const groups = foldSmall(averageLinkage(matrix, n, threshold), matrix, n, minSize, (i) => releases[i].station ?? '')
    .map((indices) => indices.sort((a, b) => a - b).map((i) => releases[i]));

  // Deterministic order: larger islands first, then by first member id.
  groups.sort((a, b) => b.length - a.length || a[0].id.localeCompare(b[0].id));
  const documentFrequency = new Map();
  for (const release of releases) {
    for (const tag of new Set(release.tags?.all ?? release.styles ?? [])) documentFrequency.set(tag, (documentFrequency.get(tag) ?? 0) + 1);
  }
  const taken = new Set();
  return distinctNames(groups.map((members, index) => {
    const { name, basis } = islandName(members, documentFrequency, taken);
    taken.add(name);
    return { id: index, name: name ?? `island-${index}`, basis, members };
  }));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Separate episodes of one show can form separate islands. Tell them apart by
// air date, then by number.
function distinctNames(islands) {
  const counts = new Map();
  for (const island of islands) counts.set(island.name, (counts.get(island.name) ?? 0) + 1);
  for (const island of islands) {
    if (island.basis !== 'show' || counts.get(island.name) < 2) continue;
    const day = majorityTag(island.members, (m) => (m.date ? [String(m.date).slice(0, 10)] : []));
    const [, month, date] = (day ?? '').split('-').map(Number);
    if (MONTHS[month - 1] && date) island.name = `${island.name} · ${date} ${MONTHS[month - 1]}`;
  }
  const seen = new Map();
  for (const island of islands) {
    const n = (seen.get(island.name) ?? 0) + 1;
    seen.set(island.name, n);
    if (n > 1) island.name = `${island.name} (${n})`;
  }
  return islands;
}

// An island may only claim a genre that at least half of its tracks really
// have. Of those, it takes the most specific: the one rarest in the whole
// catalogue, so doo-wop songs that also carry "rock" make a "doo wop" island.
// A decade is never a sound: songs of the 1990s share no genre by that.
// A mixed set, where most tracks have genres but none is shared by half, is
// named after its two commonest. Only when most of its tracks have no genre
// at all is it named after the show most of them were played on, since that
// is what grouped them, or else the station or channel. Station-supplied show
// genres never name an island: they describe a whole set, not its tracks. A
// name a larger island already has goes to another style the island shares.
function islandName(members, documentFrequency = new Map(), taken = new Set()) {
  const tagsOf = (member) => member.tags?.all ?? member.styles ?? [];
  const soundOf = (member) => tagsOf(member).filter(isGenreTag);
  const genres = majorityTags(members, soundOf, documentFrequency);
  const genre = genres.find((tag) => !taken.has(tagLabel(tag)) && !isBroadGenre(tag)) ?? genres[0];
  if (genre) return { name: tagLabel(genre), basis: 'sound' };
  if (members.filter((m) => soundOf(m).length > 0).length * 2 >= members.length) {
    return { name: commonestTags(members, soundOf, documentFrequency).slice(0, 2).map(tagLabel).join(' & '), basis: 'mixed' };
  }
  const show = majorityTag(members, (m) => tagsOf(m).filter((t) => t.startsWith('show:')));
  if (show) return { name: tagLabel(show), basis: 'show' };
  const station = majorityTag(members, (m) => tagsOf(m).filter((t) => t.startsWith('station:')));
  if (station) return { name: tagLabel(station), basis: 'station' };
  return { name: null, basis: null };
}

function tagCounts(members, tagsOf) {
  const counts = new Map();
  for (const member of members) {
    for (const tag of new Set(tagsOf(member))) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()];
}

/** Tags at least half the members share: the rarest in the catalogue first, then the commonest here. */
function majorityTags(members, tagsOf, documentFrequency = new Map()) {
  const shared = tagCounts(members, tagsOf).filter(([, count]) => count * 2 >= members.length);
  const rarity = (tag) => documentFrequency.get(tag) ?? Infinity;
  shared.sort((a, b) => rarity(a[0]) - rarity(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0]));
  return shared.map(([tag]) => tag);
}

function majorityTag(members, tagsOf, documentFrequency) {
  return majorityTags(members, tagsOf, documentFrequency)[0] ?? null;
}

/** Every tag the members carry, commonest here first; ties go to the rarest in the catalogue. */
function commonestTags(members, tagsOf, documentFrequency = new Map()) {
  const rarity = (tag) => documentFrequency.get(tag) ?? Infinity;
  return tagCounts(members, tagsOf)
    .sort((a, b) => b[1] - a[1] || rarity(a[0]) - rarity(b[0]) || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

function islandRadius(memberCount) {
  return 1.5 + Math.sqrt(memberCount) * 1.7;
}

// Islands go down one at a time, largest first; the next is always the one
// most related to those already down. It takes the spot, touching an island
// already down, that is nearest to the islands it relates to and to the
// middle of the map. Nothing overlaps, and the map grows only as fast as its
// islands do.
const COMPACT = 0.6;

function arrangeIslands(islands, links, rand) {
  const k = islands.length;
  const radius = islands.map((island) => islandRadius(island.members.length));
  const placed = new Map();
  const pending = new Set(islands.keys());
  const gap = (i, j) => radius[i] + radius[j] + GROUND;

  function bestSpot(i) {
    let area = 0;
    const middle = { x: 0, y: 0 };
    for (const [j, c] of placed) {
      area += radius[j] ** 2;
      middle.x += c.x * radius[j] ** 2;
      middle.y += c.y * radius[j] ** 2;
    }
    middle.x /= area;
    middle.y /= area;
    let best = null;
    let bestScore = Infinity;
    for (const [j, c] of placed) {
      for (let step = 0; step < 24; step += 1) {
        const angle = (step / 24) * 2 * Math.PI;
        const spot = { x: c.x + Math.cos(angle) * gap(i, j), y: c.y + Math.sin(angle) * gap(i, j) };
        if ([...placed].some(([l, o]) => Math.hypot(spot.x - o.x, spot.y - o.y) < gap(i, l) - 1e-6)) continue;
        // Strong relations pull hardest; unrelated islands barely at all.
        let total = 0;
        let weights = 0;
        for (const [l, o] of placed) {
          const weight = Math.max(0, links[i * k + l]) ** 2 + 1e-4;
          total += weight * Math.hypot(spot.x - o.x, spot.y - o.y);
          weights += weight;
        }
        const score = total / weights + COMPACT * Math.hypot(spot.x - middle.x, spot.y - middle.y);
        if (score < bestScore) [best, bestScore] = [spot, score];
      }
    }
    return best;
  }

  while (pending.size) {
    // Ties go to the larger island: pending keeps the islands' size order.
    let next = -1;
    let nextLink = -Infinity;
    for (const i of pending) {
      let link = 0;
      for (const j of placed.keys()) link = Math.max(link, links[i * k + j]);
      if (link > nextLink) [next, nextLink] = [i, link];
    }
    pending.delete(next);
    placed.set(next, placed.size ? bestSpot(next) : { x: 0, y: 0 });
  }

  return islands.map((island, i) => ({
    island,
    x: placed.get(i).x + (rand() - 0.5) * 1.5,
    y: placed.get(i).y + (rand() - 0.5) * 1.5,
    radius: radius[i],
  }));
}

function placeIslandMembers(members, similarity, rand) {
  const ordered = members
    .slice()
    .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.id.localeCompare(b.id));
  const radius = islandRadius(ordered.length) * 0.75;
  const points = ordered.map((release, index) => {
    // A filled spiral scales with area; a single ring crowds larger groves.
    const angle = index * 2.399963;
    const distance = ordered.length === 1 ? 0 : radius * Math.sqrt(index / (ordered.length - 1));
    return {
      release,
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance,
    };
  });

  for (let iter = 0; iter < 4; iter += 1) {
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const a = points[i];
        const b = points[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(0.05, Math.hypot(dx, dy));
        const ux = dx / dist;
        const uy = dy / dist;
        const sim = similarity(a.release, b.release);
        const move = dist < 2 ? -(2 - dist) / 2 : sim > 0.5 ? (sim - 0.5) * 0.8 : 0;
        if (move === 0) continue;
        a.x += ux * move;
        a.y += uy * move;
        b.x -= ux * move;
        b.y -= uy * move;
      }
    }
  }
  for (const point of points) {
    point.x += (rand() - 0.5) * 0.7;
    point.y += (rand() - 0.5) * 0.7;
  }
  return points;
}

function snapAndResolve(entries) {
  const occupied = new Map();
  const placements = new Map();
  const key = (x, y) => `${x}~${y}`;
  // Distinct grid cells alone still allow neighbouring song markers to touch.
  const free = (x, y) => {
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dy = -2; dy <= 2; dy += 1) {
        if (dx * dx + dy * dy < 9 && occupied.has(key(x + dx, y + dy))) return false;
      }
    }
    return true;
  };

  for (const entry of entries) {
    let x = Math.round(entry.x);
    let y = Math.round(entry.y);
    if (!free(x, y)) {
      let radius = 1;
      let found = false;
      while (!found && radius < 400) {
        for (let dx = -radius; dx <= radius && !found; dx += 1) {
          for (let dy = -radius; dy <= radius && !found; dy += 1) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (free(nx, ny)) {
              x = nx;
              y = ny;
              found = true;
            }
          }
        }
        radius += 1;
      }
    }
    occupied.set(key(x, y), entry.release.id);
    placements.set(entry.release.id, { x, y });
  }
  return placements;
}

/**
 * Map a catalogue onto the sea.
 * @returns {{placements, islands, depths, similarity}}
 */
export function mapCatalogue(releases, similarity, { seed = 'radio-sea' } = {}) {
  const rand = mulberry32(fnv1aHash(String(seed)));
  const n = releases.length;
  const matrix = similarityMatrix(releases, similarity);
  const islands = clusterReleases(releases, similarity, { minSize: MIN_GROVE, matrix });
  const index = new Map(releases.map((release, i) => [release.id, i]));
  const groups = islands.map((island) => island.members.map((member) => index.get(member.id)));
  const k = islands.length;
  const links = new Float64Array(k * k);
  for (let a = 0; a < k; a += 1) {
    for (let b = a + 1; b < k; b += 1) {
      links[a * k + b] = meanLink(matrix, n, groups[a], groups[b]);
      links[b * k + a] = links[a * k + b];
    }
  }
  const centres = arrangeIslands(islands, links, rand);

  const entries = [];
  centres.forEach((centre) => {
    const points = placeIslandMembers(centre.island.members, similarity, rand);
    for (const point of points) {
      entries.push({
        release: point.release,
        x: centre.x + point.x,
        y: centre.y + point.y,
      });
    }
  });

  const placements = snapAndResolve(entries);

  // Depth: isolation + lack of cross-source agreement -> deep cut.
  const depths = new Map();
  releases.forEach((release, i) => {
    let simSum = 0;
    for (let j = 0; j < n; j += 1) if (j !== i) simSum += matrix[i * n + j];
    const meanSim = n > 1 ? simSum / (n - 1) : 0;
    const sources = new Set(release.sources?.map((s) => s.source) ?? []).size;
    const depth = Math.min(1, Math.max(0, 1 - meanSim - 0.08 * (sources - 1)));
    depths.set(release.id, Number(depth.toFixed(3)));
  });

  const mappedIslands = centres.map((centre) => ({
    id: centre.island.id,
    name: centre.island.name,
    basis: centre.island.basis,
    memberIds: centre.island.members.map((m) => m.id),
    centre: { x: Math.round(centre.x), y: Math.round(centre.y) },
    radius: centre.radius,
  }));

  return {
    placements,
    islands: mappedIslands,
    depths,
    similarity,
  };
}
