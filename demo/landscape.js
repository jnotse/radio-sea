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

  // Bushes of the steppe, from the biggest groves to single tufts.
  const BUSHES = {
    lenga: { base: '#c4612d', light: '#e08a3c', dark: '#94401f', size: 3 },        // autumn southern beech
    calafate: { base: '#4f6b3a', light: '#6f8c45', dark: '#34472a', size: 2, berry: '#6b3a6e' },
    neneo: { base: '#a3a13e', light: '#c8c25a', dark: '#7a7a2e', size: 2 },        // cushion bush
    coiron: { base: '#d9c27a', light: '#efdc9a', dark: '#a98f4c', size: 1 },       // tussock grass
  };
  const bushOf = (members) => (members >= 8 ? 'lenga' : members >= 4 ? 'calafate' : members >= 2 ? 'neneo' : 'coiron');

  /**
   * Top-down Patagonian steppe for the map, in world units. Every cluster of
   * songs is a grove of bushes: lenga forest for the big ones, calafate and
   * neneo thickets for smaller ones, coirón tussocks for single songs. Where
   * no song is near, the Andes rise in the west with glacial lakes at their
   * feet, and rivers wind across the steppe. Returns a bitmap with `scale`
   * pixels per world unit and its world origin.
   */
  function buildTerrain(data, scale = 2) {
    const songs = data.releases.filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y));
    const islands = data.islands;
    const pad = 60; // enough land to fill a tall phone screen at the widest zoom
    const minX = Math.floor(Math.min(...songs.map((r) => r.x)) - pad), maxX = Math.ceil(Math.max(...songs.map((r) => r.x)) + pad);
    const minY = Math.floor(Math.min(...songs.map((r) => r.y)) - pad), maxY = Math.ceil(Math.max(...songs.map((r) => r.y)) + pad);
    const W = (maxX - minX) * scale, H = (maxY - minY) * scale;
    const toPx = (wx) => Math.round((wx - minX) * scale), toPy = (wy) => Math.round((wy - minY) * scale);

    // How far each pixel is from the nearest song (capped): features keep their distance.
    const FAR = 14;
    const clearance = new Float32Array(W * H).fill(FAR);
    for (const song of songs) {
      const cx = toPx(song.x), cy = toPy(song.y), reach = FAR * scale;
      for (let py = Math.max(0, cy - reach); py <= Math.min(H - 1, cy + reach); py += 1) {
        for (let px = Math.max(0, cx - reach); px <= Math.min(W - 1, cx + reach); px += 1) {
          const d = Math.hypot(px - cx, py - cy) / scale, i = py * W + px;
          if (d < clearance[i]) clearance[i] = d;
        }
      }
    }
    // Which grove each pixel belongs to, and how dense the bushes are there.
    const density = new Float32Array(W * H), grove = new Int16Array(W * H).fill(-1);
    for (const island of islands) {
      const members = island.memberIds.map((id) => songs.find((r) => r.id === id)).filter(Boolean);
      for (const song of members) {
        const cx = toPx(song.x), cy = toPy(song.y), r = (members.length > 1 ? 4.2 : 2.6) * scale, reach = Math.ceil(r);
        for (let py = Math.max(0, cy - reach); py <= Math.min(H - 1, cy + reach); py += 1) {
          for (let px = Math.max(0, cx - reach); px <= Math.min(W - 1, cx + reach); px += 1) {
            const v = 1 - Math.hypot(px - cx, py - cy) / r, i = py * W + px;
            if (v > density[i]) { density[i] = v; grove[i] = island.memberIds.length; }
          }
        }
      }
    }

    const bitmap = document.createElement('canvas');
    bitmap.width = W; bitmap.height = H;
    const g = bitmap.getContext('2d');
    const image = g.createImageData(W, H);
    const paint = (px, py, c) => {
      if (px < 0 || py < 0 || px >= W || py >= H) return;
      const o = (py * W + px) * 4; image.data[o] = c[0]; image.data[o + 1] = c[1]; image.data[o + 2] = c[2]; image.data[o + 3] = 255;
    };
    const span = maxX - minX;
    const mountainAt = (px, py) => {
      const wx = minX + px / scale, wy = minY + py / scale;
      // The range runs down the western edge; further east only a few lone massifs rise.
      const west = Math.max(0, 1 - (wx - minX) / (span * 0.3));
      const range = noise(wx / 10, wy / 10, 40) * 0.5 + noise(wx / 3.5, wy / 3.5, 41) * 0.2 + west * 0.75 - 0.75;
      const massif = (noise(wx / 16, wy / 16, 51) - 0.74) * 2.2 + (noise(wx / 3.5, wy / 3.5, 41) - 0.5) * 0.2;
      const room = Math.min(1, Math.max(0, (clearance[py * W + px] - 7) / 4));
      return Math.max(range, massif) * room;
    };
    for (let py = 0; py < H; py += 1) {
      for (let px = 0; px < W; px += 1) {
        const i = py * W + px, wx = minX + px / scale, wy = minY + py / scale, room = clearance[i];
        const dither = (px + py) % 2 === 0;
        const patch = noise(wx / 4, wy / 4, 42), fine = hash(px, py, 43);
        // Golden steppe with olive and pale straw patches and scattered tufts.
        let c = patch > 0.68 ? (fine < 0.22 ? COLORS.oliveDark : COLORS.olive)
          : patch < 0.26 ? (fine < 0.3 ? COLORS.steppe : COLORS.gravel)
          : fine < (patch < 0.42 ? 0.2 : 0.07) ? COLORS.steppeDark : COLORS.steppe;
        if (fine > 0.988) c = COLORS.gravelDark;
        // Mountains, lit orange from the west, with snow and glaciers on top.
        const m = mountainAt(px, py);
        if (m > 0.02) {
          const facing = mountainAt(px - 1, py) - mountainAt(px + 1, py) + (mountainAt(px, py - 1) - mountainAt(px, py + 1)) * 0.5;
          const lit = facing < -0.003, shaded = facing > 0.006;
          c = m > 0.26 ? (shaded ? COLORS.snowShade : dither && !lit ? COLORS.glacier : COLORS.snow)
            : m > 0.09 ? (lit ? COLORS.granite : shaded ? COLORS.graniteShade : COLORS.graniteDark)
            : dither ? COLORS.lengaDark : COLORS.lenga; // lenga forest at the foot of the range
        }
        // Glacial lakes in open ground, and rivers winding between the groves.
        const lake = noise(wx / 11, wy / 11, 44) + (m > 0 ? 0.08 : 0) - Math.max(0, 5.5 - room) * 0.2;
        if (lake > 0.78 && m < 0.09) c = lake > 0.82 ? (lake > 0.86 && dither ? COLORS.lake : COLORS.lakeLight) : COLORS.shallow;
        const bend = Math.abs(noise(wx / 30, wy / 30, 45) - 0.5);
        if (bend < 0.01 && room > 2.5 && m < 0.09) c = bend < 0.005 ? COLORS.lakeLight : COLORS.shallow;
        paint(px, py, c);
      }
    }
    // Groves: bushes on a jittered grid, denser near the songs, lit from the west.
    const cell = 3;
    for (let gy = 0; gy < H; gy += cell) {
      for (let gx = 0; gx < W; gx += cell) {
        const px = gx + Math.floor(hash(gx, gy, 46) * cell), py = gy + Math.floor(hash(gx, gy, 47) * cell);
        if (px >= W || py >= H) continue;
        const i = py * W + px;
        if (grove[i] < 0 || hash(gx, gy, 48) > density[i] * 1.6) continue;
        const kind = BUSHES[bushOf(grove[i])], base = rgb(kind.base), light = rgb(kind.light), dark = rgb(kind.dark);
        const r = Math.max(1, kind.size - (hash(gx, gy, 49) > 0.6 ? 1 : 0));
        paint(px + r, py + r, COLORS.steppeDark); // shadow falls east
        for (let dy = -r; dy <= r; dy += 1) {
          for (let dx = -r; dx <= r; dx += 1) {
            if (dx * dx + dy * dy > r * r + 0.5) continue;
            paint(px + dx, py + dy, dx + dy < -r * 0.6 ? light : dx + dy > r * 0.6 ? dark : base);
          }
        }
        if (kind.berry && hash(gx, gy, 50) > 0.55) paint(px, py, rgb(kind.berry));
      }
    }
    g.putImageData(image, 0, 0);
    return { bitmap, minX, minY, scale, ground: PALETTE.steppe };
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

  window.RadioSeaLandscape = { PALETTE, buildTerrain, drawBanner };
})();
