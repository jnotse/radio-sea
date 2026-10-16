// Our mapping algorithm: turn a catalogue into a sea.
//
// 1. islands  — agglomerative clustering on the similarity function; releases
//               merge into an island while their average linkage stays above a
//               threshold, so islands emerge from the data instead of from a
//               fixed genre list.
// 2. world map — islands attract/repel each other: related islands end up as
//               neighbouring archipelagos (attraction = cross-island
//               similarity), unrelated ones keep open sea between them
//               (repulsion = island radii).
// 3. shores   — releases inside an island are laid along a ring ordered by era
//               and relaxed by pairwise similarity, so the coastline walks
//               smoothly through the island's variants.
// 4. depth    — each release gets a depth value: how deep-cut / unexplored it
//               is (isolation + low cross-source agreement). Depth can be
//               rendered as water darkening.
//
// Everything is deterministic for a given seed.

import { fnv1aHash } from '../fnv1a.js';
import { mulberry32 } from '../rng.js';
import { isContextTag, tagLabel } from './tags.js';

// Cluster while average linkage stays above this. Measured on radio data:
// unrelated pairs score ~0.32, same-world pairs 0.44-0.77, so 0.50 keeps the
// archipelagos sound-based instead of station-based.
const LINKAGE_THRESHOLD = 0.50;

function averageLinkage(similarity, groupA, groupB) {
  let total = 0;
  let count = 0;
  for (const a of groupA) {
    for (const b of groupB) {
      total += similarity(a, b);
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

export function clusterReleases(releases, similarity, { threshold = LINKAGE_THRESHOLD } = {}) {
  let groups = releases.map((release) => [release]);
  while (groups.length > 1) {
    let bestI = 0;
    let bestJ = 1;
    let bestLink = threshold;
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const link = averageLinkage(similarity, groups[i], groups[j]);
        if (link > bestLink) {
          bestLink = link;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestLink <= threshold) break;
    const merged = [...groups[bestI], ...groups[bestJ]];
    groups = groups.filter((_, index) => index !== bestI && index !== bestJ);
    groups.push(merged);
  }

  // Deterministic order: larger islands first, then by first member id.
  groups.sort((a, b) => b.length - a.length || a[0].id.localeCompare(b[0].id));
  return distinctNames(groups.map((members, index) => {
    const { name, basis } = islandName(members);
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

// An island may only claim a sound that at least half of its tracks really
// have. Otherwise it is named after the show most of them were played on,
// since that is what grouped them. Station-supplied show genres never name an
// island: they describe a whole set, not its tracks.
function islandName(members) {
  const tagsOf = (member) => member.tags?.all ?? member.styles ?? [];
  const genre = majorityTag(members, (m) => tagsOf(m).filter((t) => !isContextTag(t) && !t.startsWith('mood:')));
  if (genre) return { name: tagLabel(genre), basis: 'sound' };
  const show = majorityTag(members, (m) => tagsOf(m).filter((t) => t.startsWith('show:')));
  if (show) return { name: tagLabel(show), basis: 'show' };
  return { name: null, basis: null };
}

function majorityTag(members, tagsOf) {
  const counts = new Map();
  for (const member of members) {
    for (const tag of new Set(tagsOf(member))) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [tag, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) {
      best = tag;
      bestCount = count;
    }
  }
  return bestCount * 2 >= members.length ? best : null;
}

function islandRadius(memberCount) {
  return 1.5 + Math.sqrt(memberCount) * 1.7;
}

function arrangeIslands(islands, similarity, rand) {
  const centres = islands.map((island, index) => {
    const angle = index * 2.399963; // golden angle: deterministic spread
    const distance = index === 0 ? 0 : islandRadius(islands[0].members.length) * 2.2 * Math.sqrt(index);
    return {
      island,
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance,
      radius: islandRadius(island.members.length),
    };
  });

  for (let iter = 0; iter < 60; iter += 1) {
    for (let i = 0; i < centres.length; i += 1) {
      for (let j = i + 1; j < centres.length; j += 1) {
        const a = centres[i];
        const b = centres[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(0.1, Math.hypot(dx, dy));
        const ux = dx / dist;
        const uy = dy / dist;

        const wanted = a.radius + b.radius + 4; // open sea between islands
        const repel = dist < wanted ? (wanted - dist) * 0.25 : 0;

        // Attraction: average cross-island similarity pulls archipelagos close,
        // but only when they really are related.
        const link = averageLinkage(similarity, a.island.members, b.island.members);
        const attract = link > 0.35 ? Math.min((link - 0.35) * 6, (dist - wanted) * 0.2) : 0;

        const move = -repel + attract;
        if (move === 0) continue;
        a.x += ux * move;
        a.y += uy * move;
        b.x -= ux * move;
        b.y -= uy * move;
      }
    }
  }

  for (const centre of centres) {
    centre.x += (rand() - 0.5) * 1.5;
    centre.y += (rand() - 0.5) * 1.5;
  }
  return centres;
}

function placeIslandMembers(members, similarity, rand) {
  const ordered = members
    .slice()
    .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.id.localeCompare(b.id));
  const radius = islandRadius(ordered.length) * 0.75;
  const points = ordered.map((release, index) => {
    const angle = (index / ordered.length) * Math.PI * 2;
    return {
      release,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
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

  for (const entry of entries) {
    let x = Math.round(entry.x);
    let y = Math.round(entry.y);
    if (occupied.has(key(x, y))) {
      let radius = 1;
      let found = false;
      while (!found && radius < 400) {
        for (let dx = -radius; dx <= radius && !found; dx += 1) {
          for (let dy = -radius; dy <= radius && !found; dy += 1) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (!occupied.has(key(nx, ny))) {
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
  const islands = clusterReleases(releases, similarity);
  const centres = arrangeIslands(islands, similarity, rand);

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
  for (const release of releases) {
    let simSum = 0;
    for (const other of releases) {
      if (other.id !== release.id) simSum += similarity(release, other);
    }
    const meanSim = releases.length > 1 ? simSum / (releases.length - 1) : 0;
    const sources = new Set(release.sources?.map((s) => s.source) ?? []).size;
    const depth = Math.min(1, Math.max(0, 1 - meanSim - 0.08 * (sources - 1)));
    depths.set(release.id, Number(depth.toFixed(3)));
  }

  return {
    placements,
    islands: centres.map((centre) => ({
      id: centre.island.id,
      name: centre.island.name,
      basis: centre.island.basis,
      memberIds: centre.island.members.map((m) => m.id),
      centre: { x: Math.round(centre.x), y: Math.round(centre.y) },
      radius: centre.radius,
    })),
    depths,
    similarity,
  };
}
