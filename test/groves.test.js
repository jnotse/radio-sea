import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMapSimilarity } from '../src/mapping/embed.js';
import { clusterReleases, mapCatalogue, regionName } from '../src/mapping/cartography.js';
import { mulberry32 } from '../src/rng.js';

// How the 2D map forms, names and lays out its groves once it holds a big catalogue.
const song = (id, tags, extra = {}) => ({ id, artist: `Artist ${id}`, artists: [`Artist ${id}`], tags: { all: tags }, tracks: [{}], ...extra });
const groveOf = (islands, id) => islands.find((island) => island.memberIds.includes(id));
const centre = (island) => island.centre;

test('average linkage merges exactly as searching every pair of groups would', () => {
  const rand = mulberry32(7);
  const points = Array.from({ length: 40 }, (_, i) => ({ id: `p${String(i).padStart(2, '0')}`, v: [rand(), rand()] }));
  const sim = (a, b) => Math.max(0, 1 - Math.hypot(a.v[0] - b.v[0], a.v[1] - b.v[1]) * 2);
  const link = (a, b) => a.reduce((sum, x) => sum + b.reduce((s, y) => s + sim(x, y), 0), 0) / (a.length * b.length);
  let groups = points.map((p) => [p]);
  for (;;) {
    let best = null;
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const value = link(groups[i], groups[j]);
        if (value > 0.3 && (!best || value > best.value)) best = { i, j, value };
      }
    }
    if (!best) break;
    groups = [...groups.filter((_, k) => k !== best.i && k !== best.j), [...groups[best.i], ...groups[best.j]]];
  }
  const ids = (list) => list.map((group) => group.map((p) => p.id).sort().join(' ')).sort();
  assert.deepEqual(ids(clusterReleases(points, sim).map((island) => island.members)), ids(groups));
});

test('on the map, one- and two-song groves join their closest grove; songs related to none gather by station', () => {
  const releases = [
    ...Array.from({ length: 6 }, (_, i) => song(`house${i}`, ['electronic', 'deep house', 'house', 'station:nts'], { station: 'nts' })),
    ...Array.from({ length: 6 }, (_, i) => song(`jazz${i}`, ['jazz', 'hard bop', 'station:nts'], { station: 'nts' })),
    // Shares one style with the house grove, too little to have grown into it.
    song('lone', ['electronic', 'deep house', 'acid', 'minimal', 'dub techno', 'station:nts'], { station: 'nts' }),
    // Nothing known about these but the channel that uploaded them.
    song('up1', ['station:channel'], { station: 'channel' }),
    song('up2', ['station:channel'], { station: 'channel' }),
  ];
  const similarity = buildMapSimilarity(releases);
  assert.equal(clusterReleases(releases, similarity).find((island) => island.members.some((m) => m.id === 'lone')).members.length, 1);
  const { islands } = mapCatalogue(releases, similarity);
  assert.equal(groveOf(islands, 'lone'), groveOf(islands, 'house0'));
  assert.deepEqual([groveOf(islands, 'up1').name, groveOf(islands, 'up1').basis, groveOf(islands, 'up1').memberIds.length], ['channel', 'station', 2]);
  assert.equal(islands.length, 3);
});

test('a decade never names a grove', () => {
  const releases = [
    ...Array.from({ length: 4 }, (_, i) => song(`a${i}`, ['electronic', 'house', 'decade:1990s'])),
    ...Array.from({ length: 4 }, (_, i) => song(`b${i}`, ['electronic', 'house'])),
  ];
  const islands = clusterReleases(releases, buildMapSimilarity(releases));
  assert.deepEqual(islands.map((island) => island.name), ['house']);
});

test('a grove takes a style a larger grove has not already named it after', () => {
  const releases = [
    ...Array.from({ length: 6 }, (_, i) => song(`a${i}`, ['rock', 'psychedelic rock', 'folk rock'])),
    ...Array.from({ length: 4 }, (_, i) => song(`b${i}`, ['rock', 'psychedelic rock', 'krautrock', 'space rock'])),
  ];
  const sim = (x, y) => (x.id[0] === y.id[0] ? 1 : 0);
  const names = clusterReleases(releases, sim).map((island) => island.name);
  assert.equal(new Set(names).size, 2, `distinct names, not ${names}`);
});

test('related groves are laid down side by side, and the map stays compact around a big grove', () => {
  // One big grove and thirty small ones; groves 3 and 17, and 5 and 22, are related.
  const releases = Array.from({ length: 100 }, (_, i) => ({ id: `big${String(i).padStart(3, '0')}`, g: 0 }));
  for (let g = 1; g <= 30; g += 1) for (let i = 0; i < 5; i += 1) releases.push({ id: `g${String(g).padStart(2, '0')}-${i}`, g });
  const related = (a, b) => [[3, 17], [5, 22]].some(([x, y]) => (a === x && b === y) || (a === y && b === x));
  const sim = (a, b) => (a.g === b.g ? 0.9 : related(a.g, b.g) ? 0.25 : 0.02);
  const { islands, placements } = mapCatalogue(releases, sim);
  const grove = (g) => groveOf(islands, releases.find((r) => r.g === g).id);
  const apart = (x, y) => Math.hypot(centre(grove(x)).x - centre(grove(y)).x, centre(grove(x)).y - centre(grove(y)).y);
  // Touching: as close as any two of the small groves are (give or take a little jitter).
  const closest = Math.min(...[...Array(30).keys()].flatMap((x) => [...Array(30).keys()].filter((y) => y > x).map((y) => apart(x + 1, y + 1))));
  const touching = (x, y) => apart(x, y) <= closest + 3;
  assert.ok(touching(3, 17) && touching(5, 22), 'related groves touch');
  assert.ok(!touching(3, 22) && !touching(17, 5), 'unrelated ones need not');
  // Songs stand 3 apart, about 9 square units each. With open ground between
  // the groves the map is a few times that, never tens of times (as when the
  // big grove's size set how far apart all the others were spread).
  const xs = [...placements.values()].map((p) => p.x), ys = [...placements.values()].map((p) => p.y);
  const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  assert.ok(area < releases.length * 9 * 8, `map area ${area} for ${releases.length} songs`);
});

test('on the map, a broad genre beside a style counts little and a compilation counts less than a song\'s own record', () => {
  const releases = [
    song('a', ['rock', 'new wave']), song('b', ['rock', 'krautrock']), song('c', ['rock', 'new wave']),
    song('d', ['rock', 'new wave', 'format:compilation']), song('e', ['jazz', 'hard bop']), song('f', ['pop', 'italo-disco']),
  ];
  const sim = buildMapSimilarity(releases);
  const [a, b, c, d] = releases;
  assert.ok(sim(a, c) > 0.6, `same styles: ${sim(a, c)}`);
  assert.ok(sim(a, b) < 0.1, `only "rock" in common: ${sim(a, b)}`);
  assert.ok(sim(a, d) < sim(a, c) - 0.2 && sim(a, d) > 0.3, `compilation: ${sim(a, d)}`);
});

test('on the map, the year and country two songs share are a weak tie, and context most songs share none', () => {
  const releases = [
    song('a', ['station:channel', 'house'], { year: 1984, country: 'Japan' }),
    song('b', ['station:channel', 'synth-pop'], { year: 1984, country: 'Japan' }),
    song('c', ['station:channel'], { year: 1990 }),
    song('d', ['station:radio', 'jazz']),
  ];
  const sim = buildMapSimilarity(releases);
  assert.ok(sim(releases[0], releases[1]) < 0.15, `different genres, same year and country: ${sim(releases[0], releases[1])}`);
  assert.equal(sim(releases[2], releases[3]), 0, 'a song known only by its channel is like nothing');
});

test('groves join into regions: about √(groves) of them, each one stretch of land, every grove in one', () => {
  // Thirty-six groves of five songs: six families of six related groves.
  const releases = [];
  for (let g = 0; g < 36; g += 1) for (let i = 0; i < 5; i += 1) releases.push({ id: `g${String(g).padStart(2, '0')}-${i}`, g, styles: [`style ${g}`] });
  const sim = (a, b) => (a.g === b.g ? 0.9 : Math.floor(a.g / 6) === Math.floor(b.g / 6) ? 0.2 : 0.01);
  const { islands, regions } = mapCatalogue(releases, sim);
  assert.equal(regions.length, 6);
  const regionOf = new Map(islands.map((island) => [island.id, island.regionId]));
  assert.deepEqual(regions.flatMap((r) => r.islandIds).sort((a, b) => a - b), islands.map((i) => i.id).sort((a, b) => a - b));
  for (const region of regions) {
    assert.ok(region.islandIds.every((id) => regionOf.get(id) === region.id));
    assert.equal(region.songs, region.islandIds.length * 5);
    // Connected through groves that touch.
    const members = region.islandIds.map((id) => islands.find((i) => i.id === id));
    const touch = (a, b) => Math.hypot(a.centre.x - b.centre.x, a.centre.y - b.centre.y) <= a.radius + b.radius + 18;
    const reached = new Set([members[0]]);
    for (let grew = true; grew;) {
      grew = false;
      for (const m of members) if (!reached.has(m) && [...reached].some((r) => touch(r, m))) { reached.add(m); grew = true; }
    }
    assert.equal(reached.size, members.length, `${region.name} is one stretch of land`);
  }
  // Mostly one family per region, since related groves were laid side by side.
  const pure = regions.filter((r) => new Set(r.islandIds.map((id) => Math.floor(releases.find((s) => s.id === islands.find((i) => i.id === id).memberIds[0]).g / 6))).size <= 2);
  assert.ok(pure.length >= 4, `${pure.length} of 6 regions hold at most two families`);
  assert.deepEqual(mapCatalogue(releases.filter((r) => r.g < 6), sim).regions, [], 'small maps have no regions');
});

test('a region is named after its three largest groves', () => {
  assert.equal(regionName(['dub', 'house', 'breakbeat', 'techno']), 'dub · house · breakbeat');
  assert.equal(regionName(['dub', 'dub (2)', 'rock']), 'dub · rock');
});
