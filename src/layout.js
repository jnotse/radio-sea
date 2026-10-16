// The "digital sea" layout.
//
// Releases that are similar end up near each other on a 2D integer grid, and
// the result is fully deterministic.
//
// Pipeline:
//   1. feature vectors per release (styles, era, country, format, key, bpm)
//   2. similarity in [0, 1]
//   3. cluster by dominant style -> archipelago centres on a coarse lattice
//   4. ring placement within each cluster (ordered by era/country/name)
//   5. force relaxation: attract similar pairs, repel too-close pairs
//   6. snap to integer grid, resolve collisions deterministically

import { fnv1aHash } from './fnv1a.js';
import { mulberry32 } from './rng.js';
import { normalizeCountry } from './filters.js';

const KEY_PITCH = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

// Distance on the circle of fifths, 0..6 -> 0..1.
export function keyDistance(keyA, keyB) {
  const a = KEY_PITCH[keyA];
  const b = KEY_PITCH[keyB];
  if (a == null || b == null) return 1;
  const fifthsOrder = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]; // pitch class by fifths index
  const ia = fifthsOrder.indexOf(a);
  const ib = fifthsOrder.indexOf(b);
  const step = Math.min((ia - ib + 12) % 12, (ib - ia + 12) % 12);
  return step / 6;
}

function dominantStyle(release) {
  return release.styles[0] ?? 'unknown';
}

function meanBpm(release) {
  const bpms = release.tracks.map((t) => t.bpm).filter((b) => Number.isFinite(b));
  return bpms.length ? bpms.reduce((a, b) => a + b, 0) / bpms.length : null;
}

function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const s of setA) if (setB.has(s)) inter += 1;
  return inter / (setA.size + setB.size - inter);
}

export function similarity(a, b) {
  const styleScore = jaccard(a.styles, b.styles); // dominant signal
  const eraScore = Math.max(0, 1 - Math.abs(a.year - b.year) / 25);
  const countryScore = normalizeCountry(a.country) === normalizeCountry(b.country) ? 1 : 0;
  const formatScore = a.format === b.format ? 1 : 0;
  const keyScore = 1 - keyDistance(a.tracks[0]?.key, b.tracks[0]?.key);
  const bpmA = meanBpm(a);
  const bpmB = meanBpm(b);
  const bpmScore = bpmA != null && bpmB != null ? Math.max(0, 1 - Math.abs(bpmA - bpmB) / 60) : 0;

  return (
    3 * styleScore +
    1 * eraScore +
    1 * countryScore +
    0.5 * formatScore +
    0.5 * keyScore +
    0.5 * bpmScore
  ) / 6.5;
}

// --- layout ---------------------------------------------------------------

function clusterCentres(count, spacing) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const centres = [];
  for (let i = 0; i < count; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    centres.push({ x: col * spacing, y: row * spacing });
  }
  return centres;
}

function relax(points, sims, rand) {
  const MIN_DIST = 2.2;
  const PULL_START = 0.35;
  const iterations = 4;
  for (let iter = 0; iter < iterations; iter += 1) {
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const dx = points[j].x - points[i].x;
        const dy = points[j].y - points[i].y;
        const dist = Math.max(0.01, Math.hypot(dx, dy));
        const ux = dx / dist;
        const uy = dy / dist;

        let move = 0;
        const s = sims[i][j];
        if (dist < MIN_DIST) {
          move = -(MIN_DIST - dist) / 2; // push apart
        } else if (s > PULL_START && dist > 1.5) {
          move = (s - PULL_START) * 0.6; // pull together
        }
        if (move === 0) continue;

        points[i].x += ux * move;
        points[i].y += uy * move;
        points[j].x -= ux * move;
        points[j].y -= uy * move;
      }
    }
  }
  // Deterministic jitter so seeds produce genuinely different (but stable) worlds
  // and ties do not stack. Amplitude stays well below the 2.2 cell spacing.
  for (const p of points) {
    p.x += (rand() - 0.5) * 0.7;
    p.y += (rand() - 0.5) * 0.7;
  }
}

function snapAndResolve(entries) {
  const occupied = new Map(); // "x~y" -> releaseId
  const placements = new Map();
  const key = (x, y) => `${x}~${y}`;

  for (const entry of entries) {
    let x = Math.round(entry.x);
    let y = Math.round(entry.y);
    if (occupied.has(key(x, y))) {
      // Deterministic outward spiral until a free cell is found.
      let radius = 1;
      let found = false;
      while (!found && radius < 200) {
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
    occupied.set(key(x, y), entry.id);
    placements.set(entry.id, { x, y });
  }
  return placements;
}

/**
 * Lay releases out on the sea.
 * @returns {{ placements: Map<string, {x:number,y:number}>, similarity: (a,b)=>number }}
 */
export function layoutSea(releases, { seed = 'radio-sea' } = {}) {
  const rand = mulberry32(fnv1aHash(String(seed)));

  // Group by dominant style; deterministic cluster order.
  const groups = new Map();
  for (const release of releases) {
    const style = dominantStyle(release);
    const list = groups.get(style) ?? [];
    list.push(release);
    groups.set(style, list);
  }
  const clusterNames = [...groups.keys()].sort(
    (a, b) => groups.get(b).length - groups.get(a).length || a.localeCompare(b),
  );

  const avgMembers = releases.length / clusterNames.length;
  const clusterRadius = 1.5 + Math.sqrt(avgMembers) * 1.6;
  const spacing = 3 * clusterRadius; // archipelagos with open sea between them
  const centres = clusterCentres(clusterNames.length, spacing);

  const entries = [];
  clusterNames.forEach((name, clusterIndex) => {
    const members = groups
      .get(name)
      .slice()
      .sort((a, b) => a.year - b.year || a.country.localeCompare(b.country) || a.name.localeCompare(b.name));

    const centre = centres[clusterIndex];
    const radius = 1.5 + Math.sqrt(members.length) * 1.6;
    const placed = members.map((release, i) => {
      const angle = (i / members.length) * Math.PI * 2;
      const ring = radius * (0.55 + 0.45 * ((i % 3) / 2));
      return {
        id: release.id,
        release,
        x: centre.x + Math.cos(angle) * ring,
        y: centre.y + Math.sin(angle) * ring,
      };
    });

    // Similarity matrix within the cluster for relaxation.
    const sims = placed.map((p) => placed.map((q) => similarity(p.release, q.release)));
    relax(placed, sims, rand);
    entries.push(...placed);
  });

  const placements = snapAndResolve(entries);
  return { placements, similarity };
}
