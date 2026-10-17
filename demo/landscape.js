/* Patagonian pixel landscapes, painted in code: the map's terrain and the
   Torres del Paine banner. Colours follow the light of the park at sunset:
   granite lit orange with slate-blue shadows, snow and glacier ice, milky
   turquoise lakes, golden steppe and autumn lenga forests. */
(() => {
  const PALETTE = {
    deep: '#1f5f72', lake: '#2c8394', lakeLight: '#3fa5a6', shallow: '#5cc4bb', foam: '#9ee0d4',
    gravel: '#d8c69b', gravelDark: '#b9a57a',
    steppe: '#cfa548', steppeDark: '#b0873a', olive: '#8c913f', oliveDark: '#6d7633',
    lenga: '#c4612d', lengaDark: '#94401f', lengaLight: '#e08a3c',
    granite: '#c27a4e', graniteDark: '#5d5f7d', graniteShade: '#474a66',
    snow: '#eef3f6', snowShade: '#b8cbe0', glacier: '#a7dbea',
    sky: ['#2b4c80', '#36609a', '#4a7fb3', '#6aa3c9', '#9cc4d6', '#f2c49a', '#f0a678'],
    cloudLight: '#f8e6cf', cloudWarm: '#f3b789', cloudPink: '#e5918a', cloudShade: '#b98a9a',
  };
  const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  const lighten = (hex) => `#${rgb(hex).map((v) => Math.round(v + (255 - v) * 0.45).toString(16).padStart(2, '0')).join('')}`;
  const COLORS = Object.fromEntries(Object.entries(PALETTE).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, rgb(v)]));

  // Deterministic value noise, so the landscape is the same on every visit.
  function hash(x, y, seed = 0) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function noise(x, y, seed = 0) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const s = (t) => t * t * (3 - 2 * t), u = s(xf), v = s(yf);
    const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed), c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  // Pixel sprites, drawn bottom-centre on their spot and lit from the west.
  // Letters take the colours of what is being drawn: l light, b body, d dark,
  // s accent (berries, flowers), S a lighter accent, t trunk; '.' is clear.
  const SPRITES = {
    treeL: ['...lll...', '..llbbb..', '.llbbbbd.', '.lbbsbbbd', 'lbbbbbbdd', 'lbbbbsbdd', '.bbbbbddd', '..dbbdd..', '...ddd...', '....t....', '....t....'],
    treeM: ['..lll..', '.llbbb.', 'lbbsbbd', 'lbbbbdd', '.bbsbdd', '..ddd..', '...t...', '...t...'],
    treeS: ['.lll.', 'lbbbd', 'lbsdd', '.ddd.', '..t..'],
    conifer: ['..l..', '.lbd.', '.lbd.', 'lbbbd', '.lbd.', 'lbbdd', 'lbbbd', 'bbddd', '..t..'],
    coniferS: ['.l.', 'lbd', '.b.', 'lbd', 'bdd', '.t.'],
    bush: ['.lbb.', 'lbsbd', 'bbbsd', '.ddd.'],
    bushS: ['lb.', 'bsd', '.d.'],
    cushion: ['.llb.', 'lbbbd', '.bdd.'],
    cushionS: ['lbd', '.d.'],
    tuft: ['l.l', 'lbd', '.d.'],
    lupine: ['.S.', '.s.', 'SsS', '.b.', 'bdb'],
    lupineS: ['.S.', '.s.', '.b.', 'bbd'],
    reeds: ['l.l', 'b.b', 'bdb', '.d.'],
    boulder: ['.llb.', 'lbbbd', 'bbbdd', '.ddd.'],
    rock: ['...llb...', '..lbbbd..', '.lllbbddd', 'lbbbbbbdd', 'bbbbbdddd', '.ddddddd.'],
    flamingo: ['.P.', 'pp.', '.k.', '.k.'],
    sheep: ['kww.', '.www', '.W.W'],
    guanaco: ['Ck....', 'C.....', 'CcccC.', '.wccc.', '.c..c.'],
    house: ['..RRRR..', '.RRrrrr.', 'RRrrrrrr', '.wwwwwW.', '.wkwkwW.', '.wwkwwW.'],
  };
  // Creatures and buildings keep their own colours.
  const OWN = {
    flamingo: { p: '#ec7f97', P: '#f7b3c2', k: '#3a2a22' },
    sheep: { w: '#f4efe4', W: '#cfc6b4', k: '#2b2236' },
    guanaco: { c: '#b06a32', C: '#cf8a4a', w: '#f1e6d0', k: '#2b2236' },
    house: { r: '#b8322a', R: '#dc5a3e', w: '#f2ead8', W: '#c8bca4', k: '#3a2a22' },
  };

  // Every grove is one piece of Patagonia, picked by what it sounds like:
  // lenga woods in autumn or in summer, ñirre woods, ciprés stands, calafate
  // and notro scrub, lupine meadows, a mallín of yellow flowers, a wet vega
  // with lagoons and flamingos, coirón grassland round an estancia, neneo
  // cushions on gravel, granite outcrops.
  // Each has two colourings, so neighbours of one kind still differ.
  const BIOMES = {
    lengaAutumn: { ground: ['#7a4a26', '#8c5a2c'], cell: 4, density: 0.95, plants: [['treeL', 3], ['treeM', 4], ['treeS', 2]],
      colors: [{ l: '#f0a24a', b: '#d06a2e', d: '#9a3f1f', s: '#f6c35a', t: '#4a3328' }, { l: '#f8d064', b: '#e2963a', d: '#a85a22', s: '#d4642c', t: '#4a3328' }] },
    lengaGreen: { ground: ['#3c5a2a', '#46682e'], cell: 4, density: 0.9, plants: [['treeL', 2], ['treeM', 4], ['treeS', 3]],
      colors: [{ l: '#8fbf5a', b: '#5e9140', d: '#3a612d', s: '#a6cf6a', t: '#4a3328' }, { l: '#b4d46e', b: '#7aa64a', d: '#4b7434', s: '#d2e28c', t: '#4a3328' }] },
    nirre: { ground: ['#5a6a34', '#66763a'], cell: 4, density: 0.9, plants: [['treeM', 3], ['treeS', 5], ['bushS', 1]],
      colors: [{ l: '#e2cf6a', b: '#b39a3e', d: '#7a6a2c', s: '#9fb85a', t: '#4a3328' }, { l: '#d6d878', b: '#a6a648', d: '#6e7232', s: '#e8b85a', t: '#4a3328' }] },
    mallin: { ground: ['#6fa448', '#62983f'], cell: 3, density: 0.7, plants: [['lupineS', 4], ['tuft', 2]],
      colors: [{ l: '#c8de7a', b: '#4f8a38', d: '#356a2c' }, { l: '#d6e48a', b: '#5a9640', d: '#3d7232' }], accents: ['#f2d03a', '#f6e27a', '#e8a83a', '#fff4c0'] },
    cipres: { ground: ['#3f4c2c', '#4a5733'], cell: 4, density: 0.9, plants: [['conifer', 4], ['coniferS', 3]],
      colors: [{ l: '#6a9a64', b: '#2f5a40', d: '#1d3a2b', s: '#7fa070', t: '#3a2a22' }, { l: '#88aa70', b: '#45704a', d: '#2a4a34', s: '#a0b884', t: '#3a2a22' }] },
    calafate: { ground: ['#8c913f', '#7c8237'], cell: 4, density: 0.75, plants: [['bush', 4], ['bushS', 3], ['cushionS', 1]],
      colors: [{ l: '#7c9a4c', b: '#506d3a', d: '#33472a', t: '#33472a' }, { l: '#93a85a', b: '#617a40', d: '#3d522c', t: '#3d522c' }], accents: ['#5b2f6b', '#7d4a8c', '#3e2350'] },
    notro: { ground: ['#6f8a3c', '#61793a'], cell: 4, density: 0.8, plants: [['bush', 5], ['bushS', 2]],
      colors: [{ l: '#6f8f45', b: '#45683a', d: '#2f4a2a', t: '#2f4a2a' }, { l: '#7f9a4a', b: '#55743c', d: '#36502c', t: '#36502c' }], accents: ['#e0442e', '#f26a3a', '#c42d2d'] },
    lupine: { ground: ['#93b04c', '#85a245'], cell: 3, density: 0.75, plants: [['lupine', 4], ['lupineS', 3], ['tuft', 1]],
      colors: [{ l: '#c8d878', b: '#5d8a3a', d: '#3f6a2e' }, { l: '#d4dc84', b: '#6a9640', d: '#467232' }], accents: ['#7b5ec2', '#d77fb8', '#6f86d8', '#efe6f5', '#a868c8', '#e6a0d0'] },
    vega: { ground: ['#79ac46', '#68a03e'], cell: 4, density: 0.55, water: true, plants: [['reeds', 4], ['tuft', 2], ['flamingo', 0.4]],
      colors: [{ l: '#d8d27a', b: '#8f9a3a', d: '#5f6a2a' }, { l: '#e2dc8a', b: '#9aa646', d: '#66722e' }] },
    coiron: { ground: ['#d4ad52', '#c69e47'], cell: 4, density: 0.7, house: true, plants: [['tuft', 7], ['sheep', 0.5]],
      colors: [{ l: '#f1dc98', b: '#cfae5c', d: '#9c7f3c' }, { l: '#f4e4aa', b: '#d8b868', d: '#a68a46' }] },
    neneo: { ground: ['#cdb97e', '#bfab70'], cell: 3, density: 0.9, plants: [['cushion', 4], ['cushionS', 3], ['tuft', 1]],
      colors: [{ l: '#c8cc5c', b: '#8e9a38', d: '#5c6828' }, { l: '#d4cc5a', b: '#a0983a', d: '#6a6428' }] },
    rocky: { ground: ['#a89c84', '#988c76'], cell: 4, density: 0.9, plants: [['boulder', 4], ['rock', 1.5], ['bushS', 2, { l: '#5f6e40', b: '#3f4a2f', d: '#2a3320', s: '#3f4a2f' }]],
      colors: [{ l: '#e0dde6', b: '#9a98ae', d: '#5e5d78' }, { l: '#e6d6c8', b: '#a8907e', d: '#6a5650' }] },
  };
  const BIOME_RULES = [
    [/trip hop|ambient|new age|drone|downtempo|lounge|easy listening|field recording/, 'lengaGreen'],
    [/dub|reggae|dancehall|ragga|ska|rocksteady|lovers rock/, 'vega'],
    [/house|garage/, 'nirre'],
    [/trance|edm|hi nrg|italo|euro|balearic/, 'mallin'],
    [/techno|electro|acid|bleep|ebm|new beat/, 'lengaAutumn'],
    [/drum n bass|jungle|breakbeat|breaks|big beat|bass music|footwork|breakcore|gabber|hip hop|rap\b|trap|drill|g-funk|gangsta|grime/, 'calafate'],
    [/idm|abstract|experimental|glitch|noise|minimal|industrial|leftfield|avant|musique|electroacoustic|sound collage|improvisation/, 'neneo'],
    [/rock|punk|metal|grunge|hardcore|shoegaze|no wave|goth/, 'rocky'],
    [/pop|synth|new wave|disco|boogie|freestyle|dance|darkwave|coldwave/, 'lupine'],
    [/jazz|soul|funk|blues|gospel|rhythm|doo wop|swing|bop|r&b|rnb/, 'notro'],
    [/folk|country|world|latin|african|bossa|samba|cumbia|tango|chanson|highlife|calypso|mpb|flamenco|hawaiian|pacific/, 'coiron'],
    [/classical|baroque|romantic|opera|choral|soundtrack|score|stage|piano|orchestra|symphony|modern/, 'cipres'],
  ];
  const OWN_TAGS = /^(show|station|show-genre|channel|city|mood|decade|inst|credit|format):/;
  /** The scenery a grove gets: by its name, else its commonest genres, else by lot. */
  function biomeOf(island, members) {
    const rule = (text) => BIOME_RULES.find(([pattern]) => pattern.test(text))?.[1];
    const counts = new Map();
    for (const song of members) for (const tag of song.tags ?? []) if (!OWN_TAGS.test(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const tags = [...counts].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
    const names = Object.keys(BIOMES);
    return rule(island.name.toLowerCase()) ?? tags.map(rule).find(Boolean) ?? names[Math.floor(hash(island.id, 7, 61) * names.length)];
  }

  /**
   * Top-down Patagonia for the map, in world units, without an edge. Every
   * grove is one patch of scenery (see BIOMES) with its plants scattered
   * over it, not one bush per song: the songs are inside, picked by pressing
   * the grove. Where no grove is near, the Andes rise in the west with
   * glacial lakes at their feet, rivers wind across the golden steppe, and
   * guanacos graze. The land is painted in square tiles of `scale` pixels per
   * world unit as a view first reaches them, and kept.
   */
  function buildTerrain(data, scale = 2) {
    const songs = data.releases.filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y));
    const byId = new Map(songs.map((r) => [r.id, r]));
    // Pixel (0, 0) lies 60 units north-west of the songs; the range runs down the west.
    const pad = 60;
    const minX = Math.floor(Math.min(...songs.map((r) => r.x)) - pad), maxX = Math.ceil(Math.max(...songs.map((r) => r.x)) + pad);
    const minY = Math.floor(Math.min(...songs.map((r) => r.y)) - pad);
    const span = maxX - minX;
    const TILE = 128, MARGIN = 12, FAR = 14, MAX_TILES = 384;
    // Each grove's patch: centred on its songs, as wide as the room the map gave it.
    const groves = data.islands.map((island) => {
      const members = island.memberIds.map((id) => byId.get(id)).filter(Boolean);
      if (!members.length) return null;
      const x = members.reduce((sum, r) => sum + r.x, 0) / members.length, y = members.reduce((sum, r) => sum + r.y, 0) / members.length;
      const reach = Math.max(0, ...members.map((r) => Math.hypot(r.x - x, r.y - y)));
      const biome = biomeOf(island, members), variant = hash(island.id, 3, 62) > 0.5 ? 1 : 0;
      return { id: island.id, x, y, radius: Math.max(island.radius ?? 0, reach + 1.5), biome, variant,
        px: (x - minX) * scale, py: (y - minY) * scale, seed: 100 + island.id * 7 };
    }).filter(Boolean);
    groves.forEach((g) => { g.pr = g.radius * scale; });
    // The patch's edge wanders a little: no grove is a circle.
    const edgeAt = (g, dx, dy) => {
      const angle = Math.atan2(dy, dx);
      return g.pr * (0.84 + 0.26 * noise(Math.cos(angle) * 1.7 + g.seed, Math.sin(angle) * 1.7 + g.seed, 77));
    };

    /** One tile: pixels [tx, tx + 1) × [ty, ty + 1) in TILE units, worked out with a margin so tiles meet. */
    function paintTile(tx, ty) {
      const x0 = tx * TILE - MARGIN, y0 = ty * TILE - MARGIN, W = TILE + 2 * MARGIN, H = W;
      const reach = FAR * scale;
      const near = groves.filter((g) => g.px + g.pr * 1.15 + reach > x0 && g.px - g.pr * 1.15 - reach < x0 + W &&
        g.py + g.pr * 1.15 + reach > y0 && g.py - g.pr * 1.15 - reach < y0 + H);
      // For each pixel: the grove it lies in (and how far out, 0 middle to 1 edge), and how far it is from any grove.
      const clearance = new Float32Array(W * H).fill(FAR), inside = new Int16Array(W * H).fill(-1), depth = new Float32Array(W * H).fill(2);
      for (let py = 0; py < H; py += 1) {
        for (let px = 0; px < W; px += 1) {
          const i = py * W + px, gx = x0 + px, gy = y0 + py;
          near.forEach((g, n) => {
            const dx = gx - g.px, dy = gy - g.py, d = Math.hypot(dx, dy);
            if (d > g.pr * 1.15 + reach) return;
            const edge = edgeAt(g, dx, dy), t = d / edge + (hash(gx, gy, 63) - 0.5) * 0.05;
            if (t < depth[i]) { depth[i] = t; if (t < 1) inside[i] = n; }
            const gap = Math.max(0, d - edge) / scale;
            if (gap < clearance[i]) clearance[i] = gap;
          });
        }
      }
      // The range runs down the west of the groves and falls away to steppe
      // beyond it; further east only a few lone massifs rise.
      const mountain = new Float32Array(W * H);
      for (let py = 0; py < H; py += 1) {
        for (let px = 0; px < W; px += 1) {
          const i = py * W + px, wx = minX + (x0 + px) / scale, wy = minY + (y0 + py) / scale;
          const west = Math.max(0, 1 - Math.abs(wx - minX) / (span * 0.3));
          const range = noise(wx / 10, wy / 10, 40) * 0.5 + noise(wx / 3.5, wy / 3.5, 41) * 0.2 + west * 0.75 - 0.75;
          const massif = (noise(wx / 16, wy / 16, 51) - 0.74) * 2.2 + (noise(wx / 3.5, wy / 3.5, 41) - 0.5) * 0.2;
          const room = Math.min(1, Math.max(0, (clearance[i] - 7) / 4));
          mountain[i] = Math.max(range, massif) * room;
        }
      }

      const bitmap = document.createElement('canvas');
      bitmap.width = TILE; bitmap.height = TILE;
      const g = bitmap.getContext('2d');
      const image = g.createImageData(TILE, TILE);
      const offset = (gx, gy) => {
        const px = gx - x0 - MARGIN, py = gy - y0 - MARGIN;
        return px < 0 || py < 0 || px >= TILE || py >= TILE ? -1 : (py * TILE + px) * 4;
      };
      const paint = (gx, gy, c) => {
        const o = offset(gx, gy); if (o < 0) return;
        image.data[o] = c[0]; image.data[o + 1] = c[1]; image.data[o + 2] = c[2]; image.data[o + 3] = 255;
      };
      const shade = (gx, gy) => {
        const o = offset(gx, gy); if (o < 0) return;
        for (let k = 0; k < 3; k += 1) image.data[o + k] = Math.round(image.data[o + k] * 0.7);
      };
      const open = new Uint8Array(W * H); // plain steppe, where guanacos may graze
      for (let py = 0; py < H; py += 1) {
        for (let px = 0; px < W; px += 1) {
          const i = py * W + px, gx = x0 + px, gy = y0 + py, room = clearance[i];
          const wx = minX + gx / scale, wy = minY + gy / scale;
          const dither = (gx + gy) % 2 === 0;
          const patch = noise(wx / 4, wy / 4, 42), fine = hash(gx, gy, 43);
          // Golden steppe with olive and pale straw patches.
          let c = patch > 0.68 ? (fine < 0.22 ? COLORS.oliveDark : COLORS.olive)
            : patch < 0.26 ? (fine < 0.3 ? COLORS.steppe : COLORS.gravel)
            : fine < (patch < 0.42 ? 0.2 : 0.07) ? COLORS.steppeDark : COLORS.steppe;
          if (fine > 0.988) c = COLORS.gravelDark;
          let plain = true;
          // Mountains, lit orange from the west, with snow and glaciers on top.
          const m = mountain[i];
          if (m > 0.02 && px > 0 && py > 0 && px < W - 1 && py < H - 1) {
            const facing = mountain[i - 1] - mountain[i + 1] + (mountain[i - W] - mountain[i + W]) * 0.5;
            const lit = facing < -0.003, shaded = facing > 0.006;
            c = m > 0.26 ? (shaded ? COLORS.snowShade : dither && !lit ? COLORS.glacier : COLORS.snow)
              : m > 0.09 ? (lit ? COLORS.granite : shaded ? COLORS.graniteShade : COLORS.graniteDark)
              : dither ? COLORS.lengaDark : COLORS.lenga; // lenga forest at the foot of the range
            plain = false;
          }
          // Glacial lakes in open ground, and rivers winding between the groves.
          const lake = noise(wx / 11, wy / 11, 44) + (m > 0 ? 0.08 : 0) - Math.max(0, 5.5 - room) * 0.2;
          if (lake > 0.78 && m < 0.09) { c = lake > 0.82 ? (lake > 0.86 && dither ? COLORS.lake : COLORS.lakeLight) : COLORS.shallow; plain = false; }
          const bend = Math.abs(noise(wx / 30, wy / 30, 45) - 0.5);
          if (bend < 0.01 && room > 2.5 && m < 0.09) { c = bend < 0.005 ? COLORS.lakeLight : COLORS.shallow; plain = false; }
          // A grove's own ground, frayed into the steppe at its edge; a vega has lagoons.
          const n = inside[i];
          if (n >= 0) {
            const grove = near[n], biome = BIOMES[grove.biome], t = depth[i];
            if (t < 0.84 || hash(gx, gy, 64) > (t - 0.84) / 0.16) {
              c = rgb(biome.ground[noise(wx / 2.5, wy / 2.5, grove.seed) > 0.55 ? 1 : 0]);
              if (biome.water && t < 0.78) {
                const pool = noise(wx / 3, wy / 3, grove.seed + 1);
                if (pool > 0.6) c = pool > 0.66 ? (dither ? COLORS.lake : COLORS.lakeLight) : COLORS.shallow;
              }
            }
            plain = false;
          }
          if (plain && room > 3) open[i] = 1;
          paint(gx, gy, c);
        }
      }

      // What grows on the groves, and the guanacos and tussocks of the open
      // steppe: placed on a jittered grid fixed to the world, so tiles agree.
      const things = [];
      for (const grove of near) {
        const biome = BIOMES[grove.biome], cell = biome.cell, colors = biome.colors[grove.variant];
        const total = biome.plants.reduce((sum, [, weight]) => sum + weight, 0);
        const fromX = Math.max(x0, Math.floor((grove.px - grove.pr * 1.15) / cell) * cell), toX = Math.min(x0 + W, grove.px + grove.pr * 1.15);
        const fromY = Math.max(y0, Math.floor((grove.py - grove.pr * 1.15) / cell) * cell), toY = Math.min(y0 + H, grove.py + grove.pr * 1.15);
        for (let cy = Math.floor(fromY / cell) * cell; cy < toY; cy += cell) {
          for (let cx = Math.floor(fromX / cell) * cell; cx < toX; cx += cell) {
            // The spot is where the plant's middle goes, so tall trees cover their ground evenly.
            const x = cx + Math.floor(hash(cx, cy, grove.seed + 2) * cell), y = cy + Math.floor(hash(cx, cy, grove.seed + 3) * cell);
            const dx = x - grove.px, dy = y - grove.py, t = Math.hypot(dx, dy) / edgeAt(grove, dx, dy);
            if (t > 0.92 || hash(cx, cy, grove.seed + 4) > biome.density * (1 - t ** 6)) continue;
            const ix = x - x0, iy = y - y0;
            if (ix >= 0 && iy >= 0 && ix < W && iy < H && inside[iy * W + ix] < 0) continue;
            let pick = hash(cx, cy, grove.seed + 5) * total, plant = biome.plants[0];
            for (const entry of biome.plants) { pick -= entry[1]; if (pick <= 0) { plant = entry; break; } }
            const accent = biome.accents ? biome.accents[Math.floor(hash(cx, cy, grove.seed + 6) * biome.accents.length)] : null;
            things.push({ x, y: y + (SPRITES[plant[0]].length >> 1), sprite: plant[0], colors: { ...(plant[2] ?? colors), ...(accent ? { s: accent } : {}) } });
          }
        }
        // An estancia on the grassland, near the middle.
        if (biome.house && grove.pr >= 9) things.push({ x: Math.round(grove.px - grove.pr * 0.25), y: Math.round(grove.py - grove.pr * 0.1), sprite: 'house' });
      }
      for (let cy = Math.floor(y0 / 6) * 6; cy < y0 + H; cy += 6) {
        for (let cx = Math.floor(x0 / 6) * 6; cx < x0 + W; cx += 6) {
          const x = cx + Math.floor(hash(cx, cy, 70) * 6), y = cy + Math.floor(hash(cx, cy, 71) * 6), ix = x - x0, iy = y - y0;
          if (ix < 0 || iy < 0 || ix >= W || iy >= H || !open[iy * W + ix]) continue;
          const roll = hash(cx, cy, 72);
          if (roll < 0.0035) {
            // A small herd.
            for (let k = 0; k < 2 + Math.floor(hash(cx, cy, 73) * 3); k += 1) {
              things.push({ x: x + Math.round((hash(cx + k, cy, 74) - 0.5) * 16), y: y + Math.round((hash(cx, cy + k, 75) - 0.5) * 8), sprite: 'guanaco', flip: hash(cx, k, 76) > 0.5 });
            }
          } else if (roll < 0.045) {
            things.push({ x, y, sprite: 'tuft', colors: { l: '#ecd690', b: '#b8964a', d: '#93733a' } });
          }
        }
      }
      // Back to front, each with its shadow to the south-east.
      things.sort((a, b) => a.y - b.y || a.x - b.x);
      for (const thing of things) {
        const rows = SPRITES[thing.sprite], h = rows.length, w = rows[0].length, ox = thing.x - (w >> 1), oy = thing.y - h + 1;
        const own = OWN[thing.sprite], colors = thing.colors ?? {};
        const colorOf = (ch) => {
          const hex = own?.[ch] ?? (ch === 'S' ? lighten(colors.s ?? colors.l) : colors[ch]);
          return hex ? rgb(hex) : null;
        };
        for (let j = 0; j < h; j += 1) for (let k = 0; k < w; k += 1) {
          if (rows[j][thing.flip ? w - 1 - k : k] !== '.') shade(ox + k + 1, oy + j + 1);
        }
        for (let j = 0; j < h; j += 1) {
          for (let k = 0; k < w; k += 1) {
            const ch = rows[j][thing.flip ? w - 1 - k : k];
            if (ch === '.') continue;
            const c = colorOf(ch); if (c) paint(ox + k, oy + j, c);
          }
        }
      }
      g.putImageData(image, 0, 0);
      return bitmap;
    }

    // Painted tiles, least recently drawn first, so a long wander keeps memory in check.
    const tiles = new Map();
    /**
     * Draws the land a camera ({ x, y, zoom } in world units and pixels per
     * unit) shows on a `width` × `height` canvas. Tiles not painted yet are
     * painted until `budgetMs` runs out; it returns false if some are left.
     */
    function draw(ctx, cam, width, height, budgetMs = Infinity) {
      const toScreenX = (gx) => Math.round((minX + gx / scale - cam.x) * cam.zoom + width / 2);
      const toScreenY = (gy) => Math.round((minY + gy / scale - cam.y) * cam.zoom + height / 2);
      const toPixelX = (sx) => ((sx - width / 2) / cam.zoom + cam.x - minX) * scale;
      const toPixelY = (sy) => ((sy - height / 2) / cam.zoom + cam.y - minY) * scale;
      const start = performance.now();
      let complete = true;
      for (let ty = Math.floor(toPixelY(0) / TILE); ty <= Math.floor(toPixelY(height) / TILE); ty += 1) {
        for (let tx = Math.floor(toPixelX(0) / TILE); tx <= Math.floor(toPixelX(width) / TILE); tx += 1) {
          const key = `${tx},${ty}`;
          let bitmap = tiles.get(key);
          if (bitmap) tiles.delete(key);
          else if (performance.now() - start < budgetMs) bitmap = paintTile(tx, ty);
          else { complete = false; continue; }
          tiles.set(key, bitmap);
          if (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value);
          const left = toScreenX(tx * TILE), top = toScreenY(ty * TILE);
          ctx.drawImage(bitmap, left, top, toScreenX((tx + 1) * TILE) - left, toScreenY((ty + 1) * TILE) - top);
        }
      }
      return complete;
    }
    // The groves as the land draws them (world units), with their scenery's colours.
    const groveInfo = groves.map(({ id, x, y, radius, biome, variant }) => ({ id, x, y, radius, biome,
      colors: BIOMES[biome].colors[variant], accents: BIOMES[biome].accents ?? null, ground: BIOMES[biome].ground }));
    return { draw, ground: PALETTE.steppe, groves: groveInfo };
  }

  /** The towers of Paine at sunset over a turquoise lake and golden steppe. */
  function drawBanner(canvas, pixel = 3) {
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (!cssW || !cssH) return;
    const W = Math.ceil(cssW / pixel), H = Math.ceil(cssH / pixel);
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext('2d');
    const image = g.createImageData(W, H);
    const put = (x, y, c) => {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const o = (y * W + x) * 4; image.data[o] = c[0]; image.data[o + 1] = c[1]; image.data[o + 2] = c[2]; image.data[o + 3] = 255;
    };
    const horizon = Math.round(H * 0.68), shore = Math.round(H * 0.82);

    // Sky: stepped bands from night blue to a peach horizon.
    const sky = PALETTE.sky.map(rgb);
    for (let y = 0; y < horizon; y += 1) {
      const t = (y / horizon) * (sky.length - 1), band = Math.floor(t);
      for (let x = 0; x < W; x += 1) put(x, y, t - band > 0.55 && (x + y) % 2 === 0 ? sky[Math.min(sky.length - 1, band + 1)] : sky[band]);
    }
    // Two long, wind-combed clouds, lit warm from below.
    for (const [row, seed] of [[0.2, 21], [0.4, 22]]) {
      const y0 = Math.round(H * row);
      for (let x = 0; x < W; x += 1) {
        const n = noise(x / 18, 0, seed);
        if (n < 0.5) continue;
        const thick = n > 0.7 ? 2 : 1;
        for (let dy = 0; dy < thick; dy += 1) put(x, y0 + dy, dy === thick - 1 && row > 0.3 ? COLORS.cloudWarm : COLORS.cloudLight);
        if (n > 0.78) put(x, y0 + thick, COLORS.cloudPink);
      }
    }

    // Far ridges in slate blue with snowy tops.
    for (let x = 0; x < W; x += 1) {
      const top = Math.round(horizon - H * (0.1 + noise(x / 12, 3, 23) * 0.14));
      for (let y = top; y < horizon; y += 1) put(x, y, y - top < 1 + (noise(x / 3, 4, 24) > 0.5 ? 1 : 0) ? COLORS.snow : COLORS.graniteDark);
    }
    // The massif: a snowy shoulder under three granite towers, lit from the west.
    const cx = W * 0.74, unit = H / 28;
    const shoulder = (x) => horizon - H * 0.3 * Math.max(0, 1 - Math.abs(x - cx) / (H * 1.6));
    for (let x = Math.floor(cx - H * 1.6); x <= cx + H * 1.6; x += 1) {
      const top = Math.round(shoulder(x));
      for (let y = top; y < horizon; y += 1) {
        const snowy = y - top < 2 || (y - top < 4 && hash(x, y, 25) > 0.5);
        put(x, y, snowy ? (x < cx ? COLORS.snow : COLORS.snowShade) : x < cx ? COLORS.granite : COLORS.graniteShade);
      }
    }
    for (const [offset, top, half] of [[-4.8, 0.14, 1.5], [0, 0.04, 1.9], [4.6, 0.1, 1.4]]) {
      const tx = cx + offset * unit, t = H * top, base = shoulder(tx) + 2;
      for (let y = Math.round(t); y < base; y += 1) {
        const span = half * unit * Math.min(1, 0.55 + (y - t) / (H * 0.3));
        for (let x = Math.round(tx - span); x <= Math.round(tx + span); x += 1) {
          const west = x <= tx - span * 0.2;
          put(x, y, west ? (hash(x, y, 26) > 0.82 ? COLORS.lengaLight : COLORS.granite) : hash(x, y, 27) > 0.85 ? COLORS.graniteDark : COLORS.graniteShade);
        }
        if (y - t < 1.5) put(tx, y - 1, COLORS.snow);
      }
    }
    // A glacier tongue running down to the lake.
    for (let y = Math.round(horizon - H * 0.1); y < horizon; y += 1) {
      const half = (y - (horizon - H * 0.1)) * 0.8 + 1;
      for (let x = Math.round(cx - half); x <= Math.round(cx + half); x += 1) put(x, y, (x + y) % 3 ? COLORS.glacier : COLORS.snow);
    }

    // Milky turquoise lake with streaks of evening light.
    for (let y = horizon; y < shore; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const streak = noise(x / 9, y, 28) > 0.68;
        put(x, y, y === horizon ? COLORS.shallow : streak ? COLORS.foam : (x + y) % 2 && y > horizon + 2 ? COLORS.lake : COLORS.lakeLight);
      }
    }
    // Golden steppe in front, with a few groves of autumn lenga.
    for (let x = 0; x < W; x += 1) {
      const edge = Math.round(shore - (noise(x / 8, 5, 29) > 0.6 ? 1 : 0));
      for (let y = edge; y < H; y += 1) {
        const n = noise(x / 4, y / 2, 30);
        put(x, y, n > 0.72 ? COLORS.olive : n < 0.3 && (x + y) % 2 ? COLORS.steppeDark : COLORS.steppe);
      }
    }
    for (const at of [0.03, 0.31, 0.47, 0.93]) {
      const gx = Math.round(W * at), width = Math.round(H * 0.5);
      for (let x = gx; x < gx + width; x += 1) {
        const crown = Math.round(shore - 1 - H * 0.12 * (0.6 + noise(x / 2, 6, 31) * 0.6));
        for (let y = crown; y < shore + 2; y += 1) put(x, y, hash(x, y, 32) > 0.6 ? COLORS.lengaLight : hash(x, y, 33) > 0.35 ? COLORS.lenga : COLORS.lengaDark);
      }
    }
    g.putImageData(image, 0, 0);
  }

  window.RadioSeaLandscape = { PALETTE, SPRITES, OWN, BIOMES, buildTerrain, drawBanner };
})();
