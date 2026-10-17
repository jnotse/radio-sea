import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// demo/landscape.js is a browser script. Painting needs a canvas, so a small
// stand-in keeps every tile's pixels for the test to look at.
const painted = [];
const document = { createElement: () => ({ getContext: () => ({
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: (image) => painted.push(image),
}) }) };
const context = { window: {}, document, performance: { now: () => 0 } };
runInNewContext(readFileSync(new URL('../demo/landscape.js', import.meta.url), 'utf8'), context);
const { SPRITES, OWN, BIOMES, buildTerrain } = context.window.RadioSeaLandscape;

test('every sprite is a full rectangle, and every plant a sprite with its colours', () => {
  for (const [name, rows] of Object.entries(SPRITES)) {
    for (const row of rows) assert.equal(row.length, rows[0].length, `${name} rows differ in width`);
    for (const ch of rows.join('')) assert.ok('.lbdsSt'.includes(ch) || ch in (OWN[name] ?? {}), `${name} uses an unknown pixel "${ch}"`);
  }
  for (const [name, biome] of Object.entries(BIOMES)) {
    for (const [sprite, weight] of biome.plants) assert.ok(SPRITES[sprite] && weight > 0, `${name}: ${sprite}`);
    for (const hex of [...biome.ground, ...biome.colors.flatMap((c) => Object.values(c)), ...(biome.accents ?? [])]) assert.match(hex, /^#[0-9a-f]{6}$/);
    assert.equal(biome.colors.length, 2, `${name} has two colourings`);
  }
});

// Nine groves of six songs in a row, 40 units apart.
const kinds = [['house', 'nirre'], ['dub', 'vega'], ['synth-pop', 'lupine'], ['post-punk', 'rocky'], ['folk', 'coiron'],
  ['ambient', 'lengaGreen'], ['idm', 'neneo'], ['soul-jazz', 'notro'], ['electronic', 'lengaAutumn']];
const releases = [], islands = [];
kinds.forEach(([name], g) => {
  const memberIds = [];
  for (let i = 0; i < 6; i += 1) {
    const id = `${g}-${i}`;
    memberIds.push(id);
    releases.push({ id, x: g * 40 + (i % 3) * 3, y: Math.floor(i / 3) * 3, tags: name === 'electronic' ? ['electronic', 'techno'] : [name] });
  }
  islands.push({ id: g, name, memberIds, radius: 6 });
});

test('each grove gets scenery that suits its sound, wide enough for all its songs', () => {
  const { groves } = buildTerrain({ releases, islands });
  assert.deepEqual(groves.map((g) => g.biome), kinds.map(([, biome]) => biome), 'the electronic grove goes by its techno songs');
  for (const grove of groves) {
    for (const r of releases.filter((s) => islands[grove.id].memberIds.includes(s.id))) {
      assert.ok(Math.hypot(r.x - grove.x, r.y - grove.y) < grove.radius, `${islands[grove.id].name} covers its songs`);
    }
  }
});

test("a grove is painted in its own scenery's colours, and the steppe between groves is not", () => {
  const terrain = buildTerrain({ releases, islands });
  const lupine = terrain.groves[2];
  const colours = (image) => new Set(Array.from({ length: image.data.length / 4 }, (_, i) =>
    `#${[0, 1, 2].map((k) => image.data[i * 4 + k].toString(16).padStart(2, '0')).join('')}`));
  const look = (x, y) => {
    painted.length = 0;
    terrain.draw({ drawImage() {} }, { x, y, zoom: 2 }, 40, 40);
    return painted.reduce((all, image) => new Set([...all, ...colours(image)]), new Set());
  };
  const meadow = look(lupine.x, lupine.y);
  assert.ok(BIOMES.lupine.ground.some((hex) => meadow.has(hex)), 'meadow ground');
  assert.ok(BIOMES.lupine.accents.some((hex) => meadow.has(hex)), 'lupine flowers');
  const between = look(lupine.x + 20, lupine.y - 30);
  assert.ok(!BIOMES.lupine.accents.some((hex) => between.has(hex)), 'no lupines out on the steppe');
});
