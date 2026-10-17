/* No build step. The data file is generated with npm run build-demo:reuse. */
(() => {
  const $ = (id) => document.getElementById(id);
  const DATA = window.SEA_DATA;
  if (!DATA?.releases?.length) {
    $('detail-empty').textContent = 'No tracks loaded. Run npm run build-demo first.';
    return;
  }
  const canvas = $('sea'), ctx = canvas.getContext('2d');
  const releases = DATA.releases.filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y));
  const byId = new Map(releases.map((r) => [r.id, r]));
  const islands = new Map(DATA.islands.map((i) => [i.id, i]));
  const bridgeIds = new Set((DATA.topology?.bridges ?? []).map((b) => b.id));
  const stationNames = new Map(DATA.stats.stations.map((s) => [s.id, s.label]));
  const pos3 = (r) => ({ x: r.tx ?? r.x, y: r.ty ?? r.y, z: r.tz ?? ((0.5 - (r.depth ?? 0.5)) * 18) });
  const state = { cam: { x: 0, y: 0, zoom: 8 },
    cam3d: { yaw: -0.65, pitch: 0.42, zoom: 10, x: 0, y: 0, z: 0 },
    viewMode: '2d', selected: null, hovered: null,
    trail: [], tags: new Set(), query: '', showRoutes: true };
  const pointers = new Map();
  const terrain = window.RadioSeaLandscape.buildTerrain(DATA);
  let landDrawn = false, pendingLand = null, orbitFrame = null, lastOrbitTime = 0, fitted3D = false;
  let animation = null, player = null, playerGeneration = 0, playerTimer;
  let playbackMode = 'idle', volume = 75;
  let playerReady = false, songDuration = 0, scrubbing = false, pendingSeek = null;
  const isLocalFile = location.protocol === 'file:';
  $('file-notice').hidden = !isLocalFile;

  function node(tag, content, className) {
    const el = document.createElement(tag);
    if (content != null) el.textContent = content;
    if (className) el.className = className;
    return el;
  }
  function link(url, content) {
    const a = node('a', content);
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return node('span', content);
      a.href = parsed.href;
    } catch { return node('span', content); }
    a.target = '_blank'; a.rel = 'noopener';
    return a;
  }
  // A song's own genres. Station, show and show-genre tags describe where it
  // was heard; mood and decade tags are not genres.
  function genres(r) {
    return (r.tags ?? []).filter((t) => !/^(show|station|show-genre|channel|city|mood|decade|inst|credit|format):/.test(t));
  }
  function passesFilter(r) {
    return !!r && [...state.tags].every((t) => (r.tags ?? []).includes(t)) &&
      `${r.artist} ${r.name} ${r.radioPlays?.map((p) => p.show).join(' ') ?? r.show ?? ''}`
        .toLowerCase().includes(state.query);
  }
  const pool = () => releases.filter(passesFilter);

  // Where songs come from is shown per song ("Heard on"), not as a list of
  // sources here: there will be more of them.
  $('stats').append(node('div', `${releases.length} SONGS · ${DATA.islands.length} GROVES`));
  const tagCounts = new Map();
  releases.forEach((r) => genres(r).forEach((t) => tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)));
  for (const [tag] of [...tagCounts].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    const chip = node('button', tag, 'chip');
    chip.dataset.tag = tag;
    chip.onclick = () => { toggle(state.tags, tag); refreshFilters(); };
    $('tag-chips').append(chip);
  }
  if (!tagCounts.size) $('tag-chips').append(node('p', 'No genres in this snapshot yet.', 'sub'));
  function toggle(set, value) { if (set.has(value)) set.delete(value); else set.add(value); }
  $('search').addEventListener('input', (e) => { state.query = e.target.value.trim().toLowerCase(); refreshFilters(); });
  $('btn-clear').onclick = () => {
    state.tags.clear(); state.query = ''; $('search').value = ''; refreshFilters();
  };
  function refreshFilters() {
    document.querySelectorAll('[data-tag]').forEach((c) => {
      const on = state.tags.has(c.dataset.tag);
      c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on));
    });
    const visible = pool();
    const filtering = state.query || state.tags.size;
    $('map-status').hidden = !filtering;
    $('map-status').textContent = visible.length ? `${visible.length} of ${releases.length} songs match` : 'No matches — clear filters to explore again';
    $('btn-banger').disabled = !visible.length;
    $('transport-prev').disabled = state.trail.length < 2;
    $('transport-next').disabled = !upNext();
    // Search lists its results; the map itself is the way to browse everything.
    $('search-count').hidden = $('search-results').hidden = !state.query;
    $('search-count').textContent = visible.length ? `${visible.length} ${visible.length === 1 ? 'song' : 'songs'} found` : 'Nothing found';
    $('search-results').replaceChildren(...(state.query ? visible.slice(0, 50) : []).map((r) => {
      const button = node('button', `${r.artist} — ${r.name}`);
      button.dataset.trackId = r.id;
      button.setAttribute('aria-pressed', String(r.id === state.selected));
      button.onclick = () => playTrack(r.id);
      const li = node('li'); li.append(button); return li;
    }));
    showUpNext();
    state.hovered = null; $('tooltip').hidden = true;
    draw();
  }

  // Camera is in pixels per world unit. Keep one consistent range for fit,
  // flying and wheel zoom (the old wheel handler clamped fitted zoom to 4).
  // Zooming out stops at twice the view that fits every song: further out
  // the squares are specks and the land would take long to paint.
  const MIN_ZOOM = 0.5, MAX_ZOOM = 100;
  const songBounds = {
    minX: Math.min(...releases.map((r) => r.x)) - 5, maxX: Math.max(...releases.map((r) => r.x)) + 5,
    minY: Math.min(...releases.map((r) => r.y)) - 5, maxY: Math.max(...releases.map((r) => r.y)) + 5,
  };
  const fittedZoom = () => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, canvas.clientWidth / (songBounds.maxX - songBounds.minX),
    canvas.clientHeight / (songBounds.maxY - songBounds.minY)));
  const minZoom = () => Math.max(MIN_ZOOM, fittedZoom() / 2);
  const toScreen = (x, y) => ({ x: (x - state.cam.x) * state.cam.zoom + canvas.clientWidth / 2,
    y: (y - state.cam.y) * state.cam.zoom + canvas.clientHeight / 2 });
  // How big a song's square is drawn in the 2D map (signs and Guano make room for it); the 3D view sizes by depth.
  const songSize = () => (state.viewMode === '3d' ? Math.round(Math.max(6, Math.min(14, state.cam3d.zoom * .78)))
    : Math.round(Math.max(3, Math.min(14, state.cam.zoom * 1.7))));
  function project3D(wx, wy, wz, w = canvas.clientWidth, h = canvas.clientHeight) {
    const dx = wx - state.cam3d.x, dy = wy - state.cam3d.y, dz = wz - state.cam3d.z;
    const cy = Math.cos(state.cam3d.yaw), sy = Math.sin(state.cam3d.yaw);
    const cp = Math.cos(state.cam3d.pitch), sp = Math.sin(state.cam3d.pitch);
    const x1 = dx * cy - dy * sy;
    const y1 = dx * sy + dy * cy;
    const z2 = y1 * sp + dz * cp;
    const depth = Math.max(8, 95 + (y1 * cp - dz * sp));
    const perspective = 95 / depth;
    const scale = state.cam3d.zoom * perspective;
    return { x: w / 2 + x1 * scale, y: h / 2 - z2 * scale, depth, perspective, scale };
  }
  function screenPos(r, w = canvas.clientWidth, h = canvas.clientHeight) {
    if (state.viewMode === '3d') { const p = pos3(r); return project3D(p.x, p.y, p.z, w, h); }
    return toScreen(r.x, r.y);
  }
  function cancelFly() { if (animation !== null) cancelAnimationFrame(animation); animation = null; }
  function fitView() {
    cancelFly();
    if (state.viewMode === '3d') {
      const pts = releases.map(pos3);
      const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
      const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
      const minZ = Math.min(...pts.map((p) => p.z)), maxZ = Math.max(...pts.map((p) => p.z));
      const span = Math.max(12, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ));
      Object.assign(state.cam3d, {
        x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2,
        yaw: -0.65, pitch: 0.42,
        zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(canvas.clientWidth, canvas.clientHeight) / (span * 0.72))),
      });
      fitted3D = true;
      draw(); return;
    }
    Object.assign(state.cam, { x: (songBounds.minX + songBounds.maxX) / 2, y: (songBounds.minY + songBounds.maxY) / 2,
      zoom: fittedZoom() });
    draw();
  }
  function flyTo(r) {
    cancelFly();
    if (state.viewMode === '3d') {
      const target = pos3(r);
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        Object.assign(state.cam3d, { x: target.x, y: target.y, z: target.z, zoom: Math.max(state.cam3d.zoom, 11) });
        draw(); return;
      }
      const from = { ...state.cam3d }, start = performance.now(), targetZoom = Math.max(from.zoom, 11);
      function step3d(now) {
        const t = Math.min(1, (now - start) / 300), e = 1 - (1 - t) ** 3;
        Object.assign(state.cam3d, {
          x: from.x + (target.x - from.x) * e,
          y: from.y + (target.y - from.y) * e,
          z: from.z + (target.z - from.z) * e,
          zoom: from.zoom + (targetZoom - from.zoom) * e,
        });
        draw(); animation = t < 1 ? requestAnimationFrame(step3d) : null;
      }
      animation = requestAnimationFrame(step3d); return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      Object.assign(state.cam, { x: r.x, y: r.y, zoom: Math.max(state.cam.zoom, 14) }); draw(); return;
    }
    const from = { ...state.cam }, start = performance.now(), targetZoom = Math.max(from.zoom, 14);
    function step(now) {
      const t = Math.min(1, (now - start) / 300), e = 1 - (1 - t) ** 3;
      Object.assign(state.cam, { x: from.x + (r.x - from.x) * e, y: from.y + (r.y - from.y) * e,
        zoom: from.zoom + (targetZoom - from.zoom) * e });
      draw(); animation = t < 1 ? requestAnimationFrame(step) : null;
    }
    animation = requestAnimationFrame(step);
  }
  function zoomAt(factor, x = canvas.clientWidth / 2, y = canvas.clientHeight / 2) {
    cancelFly();
    if (state.viewMode === '3d') {
      state.cam3d.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.cam3d.zoom * factor));
      draw(); return;
    }
    const old = state.cam.zoom, next = Math.min(MAX_ZOOM, Math.max(minZoom(), old * factor));
    state.cam.x += (x - canvas.clientWidth / 2) * (1 / old - 1 / next);
    state.cam.y += (y - canvas.clientHeight / 2) * (1 / old - 1 / next);
    state.cam.zoom = next; draw();
  }
  function draw3D(w, h) {
    // Deep Patagonia night-dusk sky with pixel stars and a 3D topological compass floor.
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#101726');
    grad.addColorStop(0.6, '#1a253d');
    grad.addColorStop(1, '#261f33');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);

    // Deterministic pixel stars in the upper dusk sky.
    ctx.fillStyle = '#f3e7d066';
    for (let i = 0; i < 42; i += 1) {
      const sx = ((i * 97 + 31) % 997) / 997 * w;
      const sy = ((i * 53 + 17) % 991) / 991 * (h * 0.55);
      ctx.fillRect(Math.round(sx), Math.round(sy), i % 5 === 0 ? 2 : 1, i % 5 === 0 ? 2 : 1);
    }

    const pts3 = releases.map(pos3);
    const baseZ = Math.min(...pts3.map((p) => p.z)) - 3;
    const maxR = Math.max(14, ...pts3.map((p) => Math.hypot(p.x, p.y)));

    // 3D base reference rings and radial axes on the z = baseZ plane.
    ctx.strokeStyle = '#5cc4bb33'; ctx.lineWidth = 1;
    for (const frac of [0.4, 0.75, 1.1]) {
      const r = maxR * frac;
      ctx.beginPath();
      for (let s = 0; s <= 40; s += 1) {
        const a = (s / 40) * Math.PI * 2;
        const p = project3D(Math.cos(a) * r, Math.sin(a) * r, baseZ, w, h);
        if (s === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    for (let a = 0; a < Math.PI; a += Math.PI / 4) {
      const p1 = project3D(Math.cos(a) * maxR * 1.1, Math.sin(a) * maxR * 1.1, baseZ, w, h);
      const p2 = project3D(-Math.cos(a) * maxR * 1.1, -Math.sin(a) * maxR * 1.1, baseZ, w, h);
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    }

    // 3D vertical axis pillar at the origin of the manifold.
    const topPole = project3D(0, 0, Math.max(...pts3.map((p) => p.z)) + 4, w, h);
    const botPole = project3D(0, 0, baseZ, w, h);
    ctx.strokeStyle = '#5cc4bb44'; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(botPole.x, botPole.y); ctx.lineTo(topPole.x, topPole.y); ctx.stroke();
    ctx.setLineDash([]);

    // 3D grove rings: draw a 3D orbital halo around each multi-song island.
    ctx.strokeStyle = '#a7dbea33';
    for (const island of DATA.islands) {
      if (island.memberIds.length < 2) continue;
      const members = island.memberIds.map((id) => byId.get(id)).filter((r) => passesFilter(r));
      if (members.length < 2) continue;
      ctx.beginPath();
      members.forEach((r, idx) => {
        const p = screenPos(r, w, h);
        if (idx === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath(); ctx.stroke();
    }

    // Mapper nerve centroids (0-simplices) & 2-simplices (triangles).
    const mapperNodes = new Map();
    for (const mNode of DATA.topology?.mapper?.nodes ?? []) {
      const members = mNode.memberIds.map((id) => byId.get(id)).filter(Boolean);
      if (!members.length) continue;
      const sum = members.reduce((acc, r) => { const p = pos3(r); return { x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }; }, { x: 0, y: 0, z: 0 });
      mapperNodes.set(mNode.id, { x: sum.x / members.length, y: sum.y / members.length, z: sum.z / members.length });
    }
    if (state.showRoutes) {
      // 2-simplices: translucent nerve triangles where three Mapper clusters intersect.
      for (const tri of DATA.topology?.mapper?.triangles ?? []) {
        const [a, b, c] = tri.nodes.map((id) => mapperNodes.get(id));
        if (!a || !b || !c) continue;
        const pa = project3D(a.x, a.y, a.z, w, h), pb = project3D(b.x, b.y, b.z, w, h), pc = project3D(c.x, c.y, c.z, w, h);
        ctx.fillStyle = '#5cc4bb1c'; ctx.strokeStyle = '#5cc4bb44';
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.lineTo(pc.x, pc.y); ctx.closePath();
        ctx.fill(); ctx.stroke();
      }
      // 1-simplices: Mapper nerve edges.
      ctx.strokeStyle = '#5cc4bb40';
      for (const edge of DATA.topology?.mapper?.edges ?? []) {
        const a = mapperNodes.get(edge.from), b = mapperNodes.get(edge.to);
        if (!a || !b) continue;
        const pa = project3D(a.x, a.y, a.z, w, h), pb = project3D(b.x, b.y, b.z, w, h);
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      }
      // Trade routes & H0 persistence bridge edges between songs.
      for (const r of DATA.tradeRoutes) {
        const a = byId.get(r.from), b = byId.get(r.to);
        if (!passesFilter(a) || !passesFilter(b)) continue;
        const pa = screenPos(a, w, h), pb = screenPos(b, w, h);
        ctx.strokeStyle = r.bridge ? '#5cc4bb99' : '#e0b98977';
        ctx.setLineDash(r.bridge ? [] : [2, 4]);
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      }
      ctx.setLineDash([]);

      // H1 persistent homology cycles: closed topological loops of songs.
      for (const cycle of (DATA.topology?.cycles ?? []).slice(0, 6)) {
        const ring = cycle.cycle.map((id) => byId.get(id)).filter((r) => passesFilter(r));
        if (ring.length < 3) continue;
        const active = ring.some((r) => r.id === state.selected || r.id === state.hovered);
        ctx.strokeStyle = active ? '#f0a05aee' : '#d8b04e66';
        ctx.lineWidth = active ? 2 : 1;
        ctx.setLineDash(active ? [] : [3, 3]);
        ctx.beginPath();
        ring.forEach((r, idx) => {
          const p = screenPos(r, w, h);
          if (idx === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath(); ctx.stroke();
      }
      ctx.lineWidth = 1; ctx.setLineDash([]);
    }

    if (state.trail.length > 1) {
      ctx.strokeStyle = '#f0a05a'; ctx.lineWidth = 2; ctx.beginPath();
      state.trail.slice(-40).forEach((id, i) => {
        const r = byId.get(id), p = screenPos(r, w, h);
        if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      }); ctx.stroke(); ctx.lineWidth = 1;
    }

    // Painter's algorithm: sort songs back-to-front by 3D depth.
    const projected = releases.map((r) => {
      const p3 = pos3(r);
      return { r, p3, proj: project3D(p3.x, p3.y, p3.z, w, h) };
    }).sort((a, b) => b.proj.depth - a.proj.depth);

    for (const { r, p3, proj } of projected) {
      const p = { x: Math.round(proj.x), y: Math.round(proj.y) };
      const size = Math.round(Math.max(5, Math.min(16, state.cam3d.zoom * proj.perspective * 0.85)));
      const matched = passesFilter(r);
      const isBridge = bridgeIds.has(r.id);
      ctx.globalAlpha = matched ? Math.max(0.35, Math.min(1, proj.perspective * 1.1)) : 0.15;

      // Vertical elevation stalk to the base plane for selected, hovered, or bridge tracks.
      if (matched && (r.id === state.selected || r.id === state.hovered || isBridge)) {
        const floor = project3D(p3.x, p3.y, baseZ, w, h);
        ctx.strokeStyle = r.id === state.selected ? '#f0a05a88' : '#5cc4bb38';
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(floor.x, floor.y); ctx.stroke();
      }

      // Bridge songs get a turquoise outer frame to mark cross-grove connectors.
      ctx.fillStyle = isBridge ? '#5cc4bb' : '#f6ead2';
      ctx.fillRect(Math.round(p.x - size / 2) - 1, Math.round(p.y - size / 2) - 1, size + 2, size + 2);
      ctx.fillStyle = '#2b2236';
      ctx.fillRect(Math.round(p.x - size / 2), Math.round(p.y - size / 2), size, size);
      if (size >= 7) {
        ctx.fillStyle = isBridge ? '#a7dbea' : '#f0a05a';
        ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
      }
      if (r.id === state.selected || r.id === state.hovered) {
        ctx.strokeStyle = '#fff8ea'; ctx.lineWidth = 2;
        ctx.strokeRect(Math.round(p.x - size / 2 - 4), Math.round(p.y - size / 2 - 4), size + 8, size + 8);
        ctx.lineWidth = 1;
      }
    }
    ctx.globalAlpha = 1;
    drawIslandLabels(w, h);
    drawGuano(w, h);
  }
  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    canvas.dataset.view = state.viewMode;
    canvas.dataset.zoom = String(state.viewMode === '3d' ? state.cam3d.zoom : state.cam.zoom);
    canvas.dataset.cameraX = String(state.viewMode === '3d' ? state.cam3d.yaw : state.cam.x);
    canvas.dataset.cameraY = String(state.viewMode === '3d' ? state.cam3d.pitch : state.cam.y);
    canvas.dataset.selected = state.selected ?? '';
    canvas.dataset.matching = String(pool().length);
    if (state.viewMode === '3d') {
      draw3D(w, h);
      return;
    }
    // Patagonian steppe seen from above, each cluster of songs a grove of
    // bushes. The terrain is painted once in world space and scaled with the
    // camera, so its pixels grow as you zoom.
    // The land has no edge: tiles a view reaches for the first time are
    // painted a few per frame (all at once for the first view) so panning
    // stays smooth, with plain steppe showing until they are ready.
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = terrain.ground; ctx.fillRect(0, 0, w, h);
    if (!terrain.draw(ctx, state.cam, w, h, landDrawn ? 12 : Infinity) && pendingLand === null) {
      pendingLand = requestAnimationFrame(() => { pendingLand = null; draw(); });
    }
    landDrawn = true;
    if (state.showRoutes) {
      ctx.strokeStyle = '#5a3b26cc'; ctx.setLineDash([2, 4]);
      for (const r of DATA.tradeRoutes) {
        const a = byId.get(r.from), b = byId.get(r.to);
        if (!passesFilter(a) || !passesFilter(b)) continue;
        const p = toScreen(a.x, a.y), q = toScreen(b.x, b.y);
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    if (state.trail.length > 1) {
      ctx.strokeStyle = '#2b2236'; ctx.lineWidth = 2; ctx.beginPath();
      state.trail.slice(-40).forEach((id, i) => {
        const r = byId.get(id), p = toScreen(r.x, r.y);
        if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      }); ctx.stroke(); ctx.lineWidth = 1;
    }
    for (const r of releases) {
      const projected = toScreen(r.x, r.y), p = { x: Math.round(projected.x), y: Math.round(projected.y) };
      const size = songSize();
      ctx.globalAlpha = passesFilter(r) ? 1 : .2;
      // Each song is a small cabin-dark square with a lamp-lit centre.
      if (size >= 5) {
        ctx.fillStyle = '#f6ead2'; ctx.fillRect(Math.round(p.x - size / 2) - 1, Math.round(p.y - size / 2) - 1, size + 2, size + 2);
      }
      ctx.fillStyle = '#2b2236'; ctx.fillRect(Math.round(p.x - size / 2), Math.round(p.y - size / 2), size, size);
      if (size >= 8) { ctx.fillStyle = '#f0a05a'; ctx.fillRect(p.x - 1, p.y - 1, 2, 2); }
      if (r.id === state.selected || r.id === state.hovered) {
        ctx.strokeStyle = '#fff8ea'; ctx.lineWidth = 2;
        ctx.strokeRect(Math.round(p.x - size / 2 - 4), Math.round(p.y - size / 2 - 4), size + 8, size + 8);
        ctx.lineWidth = 1;
      }
    }
    ctx.globalAlpha = 1;
    drawIslandLabels(w, h);
    drawGuano(w, h);
  }
  // Signs never overlap each other or cover a song: each goes just above its
  // grove's songs, or below them, or waits until zooming in makes room. The
  // current song's grove and bigger groves choose first. Zoomed out, a grove
  // less than MIN_SIGN_SPAN pixels across goes without one: big groves get
  // their signs first as you zoom in.
  const MIN_SIGN_SPAN = 36;
  function drawIslandLabels(w, h) {
    const current = byId.get(state.selected)?.islandId;
    const order = DATA.islands.filter((island) => island.memberIds.length > 1)
      .sort((a, b) => (b.id === current) - (a.id === current) || b.memberIds.length - a.memberIds.length);
    const size = songSize() + 6;
    const songs = releases.map((r) => screenPos(r, w, h));
    // The hint, status and zoom buttons float over the map; signs stay clear of them.
    const frame = canvas.getBoundingClientRect();
    const placed = ['map-help', 'map-status', 'map-controls'].map($).filter((el) => el && !el.hidden).map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - frame.left, y: r.top - frame.top, w: r.width, h: r.height };
    });
    // They keep clear of Guano too while he stands still; walking, he passes over them.
    if (guano.placed && !guano.walk) {
      const g = guanoPose(w, h);
      placed.push({ x: g.x0, y: g.y0, w: 24 * g.scale, h: 24 * g.scale });
    }
    const overlays = placed.length;
    const clear = (box) => !placed.some((o) => box.x < o.x + o.w + 4 && o.x < box.x + box.w + 4 && box.y < o.y + o.h + 2 && o.y < box.y + box.h + 2) &&
      !songs.some((p) => p.x + size / 2 > box.x && p.x - size / 2 < box.x + box.w && p.y + size / 2 > box.y && p.y - size / 2 < box.y + box.h);
    ctx.font = '9px Silkscreen, monospace'; ctx.textAlign = 'center';
    for (const island of order) {
      const name = island.name.trim().toUpperCase();
      const label = name.length > 26 ? `${name.slice(0, 25).trimEnd()}…` : name;
      const members = island.memberIds.map((id) => byId.get(id)).filter(Boolean).map((r) => screenPos(r, w, h));
      const cx = members.reduce((sum, p) => sum + p.x, 0) / members.length;
      const top = Math.min(...members.map((p) => p.y)), bottom = Math.max(...members.map((p) => p.y));
      const width = ctx.measureText(label).width + 10;
      const span = Math.max(...members.map((p) => p.x)) - Math.min(...members.map((p) => p.x)) + size;
      if (island.id !== current && span < MIN_SIGN_SPAN) continue;
      const box = [top - size / 2 - 17, bottom + size / 2 + 3]
        .map((y) => ({ x: Math.round(cx - width / 2), y: Math.round(y), w: width, h: 15 }))
        .find((b) => b.x + b.w > 0 && b.x < w && b.y + b.h > 0 && b.y < h && clear(b));
      if (!box) continue;
      placed.push(box);
      // Weathered wooden signs.
      ctx.fillStyle = '#4a3328'; ctx.fillRect(box.x - 1, box.y - 1, box.w + 2, box.h + 2);
      ctx.fillStyle = '#f1dfb8'; ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.fillStyle = '#3a2a22'; ctx.fillText(label, Math.round(box.x + box.w / 2), box.y + 10);
    }
    canvas.dataset.labels = String(placed.length - overlays);
  }

  // Guano the guanaco walks to whatever is playing: he trots over when a song
  // starts, dances or vibes while it plays, and lies down while it is paused.
  // He stands beside the song facing it: side -1 is to its left, 1 its right.
  // The music never waits for him; the song starts as he sets off. He keeps
  // his place in the 2D map and the 3D view alike, so either can show him.
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const WALK_SPEED = 11.5; // world units a second
  const SPOT = ['x', 'y', 'x3', 'y3', 'z3', 'side'];
  const guano = { x: 0, y: 0, x3: 0, y3: 0, z3: 0, side: -1, walk: null, placed: false };
  let guanoTimer = null, guanoFrame = null;
  function guanoAt(now) {
    const walk = guano.walk; if (!walk) return guano;
    const t = Math.min(1, (now - walk.start) / walk.duration);
    if (t >= 1) { Object.assign(guano, walk.to); guano.walk = null; return guano; }
    return Object.fromEntries(SPOT.map((key) => [key, walk.from[key] + (walk.to[key] - walk.from[key]) * t]));
  }
  const guanoScreen = (at, w, h) => (state.viewMode === '3d' ? project3D(at.x3, at.y3, at.z3, w, h) : toScreen(at.x, at.y));
  function walkTo(r) {
    const now = performance.now(), here = guanoAt(now), p3 = pos3(r), w = canvas.clientWidth, h = canvas.clientHeight;
    // He faces the way he walks, and ends up on the near side of the song, facing it.
    const fromX = guanoScreen(here, w, h).x, toX = screenPos(r, w, h).x;
    const side = toX < fromX - 4 ? 1 : toX > fromX + 4 ? -1 : Math.sign(here.side) || -1;
    const to = { x: r.x, y: r.y, x3: p3.x, y3: p3.y, z3: p3.z, side };
    if (!guano.placed || reduceMotion.matches) { Object.assign(guano, to, { walk: null, placed: true }); return; }
    const distance = Math.hypot(to.x - here.x, to.y - here.y);
    guano.walk = { from: Object.fromEntries(SPOT.map((key) => [key, here[key]])), to, start: now, leftward: side > 0,
      duration: Math.max(400, Math.min(4000, distance / WALK_SPEED * 1000)) };
  }
  function guanoMood(r) {
    if (guano.walk) return 'walk';
    if (playbackMode === 'paused') return 'rest';
    if (playbackMode !== 'playing' || !r) return 'idle';
    const showGenres = (r.tags ?? []).filter((t) => t.startsWith('show-genre:')).map((t) => t.slice(11));
    return window.Guano.grooves({ genres: genres(r), showGenres, bpm: r.bpm });
  }
  // Where he stands on screen: beside the song with his hooves on its ground
  // line, at 2×, or 1× when the 2D map is zoomed far out.
  function guanoPose(w, h, now = performance.now()) {
    const at = guanoAt(now), p = guanoScreen(at, w, h), is3d = state.viewMode === '3d';
    const size = is3d ? Math.round(Math.max(5, Math.min(16, state.cam3d.zoom * p.perspective * .85))) : songSize();
    const scale = is3d || state.cam.zoom >= 2.5 ? 2 : 1;
    const feetX = p.x + at.side * (12 * scale + size / 2 + 1), feetY = p.y + size / 2 + 1;
    return { scale, feetX, feetY, x0: Math.round(feetX - 12 * scale), y0: Math.round(feetY - 23 * scale),
      facingLeft: guano.walk ? guano.walk.leftward : at.side > 0 };
  }
  const GUANO_SAYS = { walk: 'Guano is trotting over to this song.', dance: 'Guano is dancing to this one.',
    vibe: 'Guano has his eyes closed, vibing to this one.', rest: 'Guano lay down for a rest. Press play and he gets back up.',
    idle: 'Guano is waiting by this song.' };
  // While a song plays, Guano tells a fact now and then: about the artist
  // first, then the song's rarer genres before its common ones. The first comes
  // a few seconds after he starts listening, then one every half minute; each
  // stays up a while over the map, and in the player.
  const FACTS = { genres: DATA.facts?.genres ?? {}, artists: DATA.facts?.artists ?? {} };
  const FACT_DELAY = 3500, FACT_EVERY = 30000, FACT_SHOWN = 10000;
  const talk = { id: null, facts: [], index: 0, next: 0, until: 0, current: null };
  function factsFor(r) {
    const rarestFirst = genres(r).sort((a, b) => (tagCounts.get(a) ?? 0) - (tagCounts.get(b) ?? 0));
    const found = [FACTS.artists[r.artist], ...rarestFirst.map((g) => FACTS.genres[g])].filter(Boolean);
    return found.filter((fact, i) => found.findIndex((other) => other.text === fact.text) === i);
  }
  function showFact(fact) {
    $('guano-fact').hidden = !fact;
    if (fact) $('guano-fact').textContent = fact.text;
  }
  /** What Guano is saying (or null), and how long until that changes. */
  function guanoTalk(now, mood, r) {
    if (talk.id !== (r?.id ?? null)) {
      Object.assign(talk, { id: r?.id ?? null, facts: r ? factsFor(r) : [], index: 0, next: 0, until: 0, current: null });
      showFact(null);
    }
    if ((mood !== 'dance' && mood !== 'vibe') || !talk.facts.length) { talk.next = talk.until = 0; return { fact: null, wait: Infinity }; }
    if (!talk.next) talk.next = now + FACT_DELAY;
    if (now >= talk.next) {
      talk.current = talk.facts[talk.index++ % talk.facts.length];
      talk.until = now + FACT_SHOWN; talk.next = now + FACT_EVERY;
      showFact(talk.current);
    }
    const speaking = now < talk.until;
    return { fact: speaking ? talk.current : null, wait: (speaking ? talk.until : talk.next) - now };
  }
  function placeBubble(fact, feetX, feetY, y0, w) {
    const bubble = $('guano-bubble');
    bubble.hidden = !fact;
    if (!fact) return;
    if (bubble.textContent !== fact.text) bubble.textContent = fact.text;
    // Over his head, kept inside the map, or under his hooves when the top is too close.
    const half = bubble.offsetWidth / 2, left = Math.max(half + 4, Math.min(w - half - 4, feetX));
    const above = y0 - 8 - bubble.offsetHeight >= 4;
    bubble.classList.toggle('below', !above);
    bubble.style.left = `${Math.round(left)}px`;
    bubble.style.top = `${Math.round(above ? y0 - 8 : feetY + 8)}px`;
    bubble.style.setProperty('--tail', `calc(50% + ${Math.round(feetX - left)}px)`);
  }
  function drawGuano(w, h) {
    if (!guano.placed) return;
    const now = performance.now(), { scale, feetX, feetY, x0, y0, facingLeft } = guanoPose(w, h, now);
    const r = byId.get(state.selected), mood = guanoMood(r), walk = guano.walk, still = reduceMotion.matches;
    ctx.fillStyle = '#3a261e47';
    ctx.fillRect(x0 + 4 * scale, y0 + 22 * scale, 16 * scale, 2 * scale);
    ctx.drawImage(window.Guano.sprite(window.Guano.frame(mood, now, { bpm: r?.bpm, still }), facingLeft), x0, y0, 24 * scale, 24 * scale);
    for (const q of window.Guano.particles(mood, now, { still })) {
      const img = window.Guano.sprite(q.name), qx = facingLeft ? 24 - q.x - img.width : q.x;
      ctx.drawImage(img, x0 + qx * scale, y0 + q.y * scale, img.width * scale, img.height * scale);
    }
    Object.assign(canvas.dataset, { guano: mood, guanoX: String(Math.round(feetX)), guanoY: String(Math.round(feetY)),
      guanoFacing: facingLeft ? 'left' : 'right' });
    if ($('guano-says').textContent !== GUANO_SAYS[mood]) $('guano-says').textContent = GUANO_SAYS[mood];
    const onScreen = feetX > -60 && feetX < w + 60 && feetY > -60 && feetY < h + 60;
    const said = guanoTalk(now, mood, r);
    placeBubble(onScreen ? said.fact : null, feetX, feetY, y0, w);
    // Redraw while he moves: every frame while walking, otherwise when his
    // picture or what he says next changes.
    clearTimeout(guanoTimer); cancelAnimationFrame(guanoFrame);
    if (document.hidden) return;
    if (walk) { guanoFrame = requestAnimationFrame(draw); return; }
    const delay = Math.min(onScreen && !still ? window.Guano.wait(mood, now, { bpm: r?.bpm }) : Infinity, said.wait);
    if (Number.isFinite(delay)) guanoTimer = setTimeout(draw, Math.max(16, delay + 5));
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) draw(); });
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr); canvas.height = Math.round(canvas.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); draw();
  }
  document.fonts?.ready.then(draw);
  function tileAt(event) {
    const rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    const activeZoom = state.viewMode === '3d' ? state.cam3d.zoom : state.cam.zoom;
    let best = null, distance = event.pointerType === 'touch' ? 22 : Math.max(7, Math.min(12, activeZoom * .5));
    for (const r of pool()) {
      const p = screenPos(r), d = Math.hypot(p.x - x, p.y - y);
      if (d < distance) { best = r; distance = d; }
    }
    return best;
  }
  function hideTooltip() { state.hovered = null; $('tooltip').hidden = true; }
  function pinchPoints() {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    cancelFly(); hideTooltip(); canvas.focus({ preventScroll: true }); canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, moved: false });
    // Neither finger may select a tile after a multi-touch gesture.
    if (pointers.size > 1) for (const p of pointers.values()) p.moved = true;
  });
  canvas.addEventListener('pointermove', (e) => {
    const pointer = pointers.get(e.pointerId);
    if (pointer && pointers.size > 1) {
      const before = pinchPoints();
      pointer.x = e.clientX; pointer.y = e.clientY;
      const after = pinchPoints(), rect = canvas.getBoundingClientRect();
      if (state.viewMode === '3d') {
        state.cam3d.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.cam3d.zoom * after.distance / before.distance));
        canvas.classList.add('dragging'); draw(); return;
      }
      const old = state.cam.zoom;
      const next = Math.max(minZoom(), Math.min(MAX_ZOOM, old * after.distance / before.distance));
      // Keep the world position under the fingers stable while pinching/panning.
      state.cam.x += (before.x - rect.left - rect.width / 2) / old - (after.x - rect.left - rect.width / 2) / next;
      state.cam.y += (before.y - rect.top - rect.height / 2) / old - (after.y - rect.top - rect.height / 2) / next;
      state.cam.zoom = next; canvas.classList.add('dragging'); draw(); return;
    }
    if (pointer) {
      if (Math.hypot(e.clientX - pointer.startX, e.clientY - pointer.startY) > 5) pointer.moved = true;
      if (pointer.moved) {
        canvas.classList.add('dragging');
        if (state.viewMode === '3d') {
          state.cam3d.yaw += (e.clientX - pointer.x) * 0.008;
          state.cam3d.pitch = Math.max(-1.25, Math.min(1.25, state.cam3d.pitch + (e.clientY - pointer.y) * 0.007));
        } else {
          state.cam.x -= (e.clientX - pointer.x) / state.cam.zoom;
          state.cam.y -= (e.clientY - pointer.y) / state.cam.zoom;
        }
        draw();
      }
      pointer.x = e.clientX; pointer.y = e.clientY; return;
    }
    if (e.pointerType === 'touch') return;
    const r = tileAt(e); state.hovered = r?.id ?? null;
    $('tooltip').hidden = !r;
    if (r) {
      const rect = canvas.getBoundingClientRect();
      $('tooltip').textContent = `${r.artist} — ${r.name}`;
      $('tooltip').style.left = `${Math.min(e.clientX - rect.left + 12, Math.max(0, rect.width - 260))}px`;
      $('tooltip').style.top = `${Math.min(e.clientY - rect.top + 12, rect.height - 70)}px`;
    }
    draw();
  });
  function finishPointer(e, allowSelect) {
    const pointer = pointers.get(e.pointerId); if (!pointer) return;
    const click = allowSelect && !pointer.moved && Math.hypot(e.clientX - pointer.startX, e.clientY - pointer.startY) <= 5;
    pointers.delete(e.pointerId);
    if (!pointers.size) canvas.classList.remove('dragging');
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    // Pressing a square plays it.
    if (click) { const r = tileAt(e); if (r) playTrack(r.id); }
  }
  canvas.addEventListener('pointerup', (e) => finishPointer(e, true));
  for (const type of ['pointercancel', 'lostpointercapture']) canvas.addEventListener(type, (e) => finishPointer(e, false));
  canvas.addEventListener('pointerleave', () => { hideTooltip(); draw(); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault(); hideTooltip(); const rect = canvas.getBoundingClientRect();
    zoomAt(Math.exp(-Math.max(-250, Math.min(250, e.deltaY)) * .002), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.key === '=') zoomAt(1.2);
    else if (e.key === '-') zoomAt(1 / 1.2);
    else if (e.key === 'Home') fitView();
    else if (state.viewMode === '3d' && e.key === 'ArrowLeft') { state.cam3d.yaw -= 0.12; draw(); }
    else if (state.viewMode === '3d' && e.key === 'ArrowRight') { state.cam3d.yaw += 0.12; draw(); }
    else if (state.viewMode === '3d' && e.key === 'ArrowUp') { state.cam3d.pitch = Math.min(1.25, state.cam3d.pitch + 0.1); draw(); }
    else if (state.viewMode === '3d' && e.key === 'ArrowDown') { state.cam3d.pitch = Math.max(-1.25, state.cam3d.pitch - 0.1); draw(); }
    else return;
    e.preventDefault();
  });

  // Never inject remote titles/tracklists as HTML. Never construct an undefined embed.
  function setPlayback(mode) {
    playbackMode = mode;
    document.body.dataset.playback = mode;
    const labels = { idle: 'READY', loading: 'LOAD', ready: 'READY', playing: 'PLAY',
      paused: 'PAUSE', buffering: 'BUFFER', stopped: 'STOP', ended: 'END', error: 'ERROR' };
    $('deck-state').textContent = labels[mode] ?? 'READY';
    const going = ['loading', 'playing', 'buffering'].includes(mode);
    $('transport-play').textContent = going ? 'Ⅱ' : '▶';
    $('transport-play').setAttribute('aria-label', going ? 'Pause' : 'Play');
    $('transport-play').title = going ? 'Pause' : 'Play';
    if (mode === 'error') { playerReady = false; resetSeeking(); }
    draw(); // Guano dances, vibes or lies down with the music.
  }
  function formatTime(seconds) {
    const n = Math.max(0, Math.floor(Number(seconds) || 0));
    const secondsPart = String(n % 60).padStart(2, '0');
    return n >= 3600 ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${secondsPart}` :
      `${String(Math.floor(n / 60)).padStart(2, '0')}:${secondsPart}`;
  }
  function showTime(seconds) {
    $('deck-clock').textContent = formatTime(seconds);
  }
  function resetSeeking() {
    songDuration = 0; scrubbing = false; pendingSeek = null;
    $('player-seek').disabled = true; $('player-seek').max = '0'; $('player-seek').value = '0';
    $('player-seek').style.setProperty('--seek-progress', '0%');
    $('player-seek').setAttribute('aria-valuetext', 'Load a track to seek');
    $('seek-readout').textContent = '00:00 / --:--';
  }
  function showPosition(seconds) {
    const position = Math.max(0, Math.min(songDuration || Infinity, Number(seconds) || 0));
    showTime(position);
    $('player-seek').value = String(Math.floor(position));
    $('player-seek').style.setProperty('--seek-progress', `${songDuration ? 100 * position / songDuration : 0}%`);
    $('seek-readout').textContent = `${formatTime(position)} / ${songDuration ? formatTime(songDuration) : '--:--'}`;
    $('player-seek').setAttribute('aria-valuetext', `${formatTime(position)} of ${songDuration ? formatTime(songDuration) : 'unknown duration'}`);
  }
  function syncTimeline(source = player) {
    if (!playerReady || !source) return;
    // Duration can be 0 in onReady; retry as media metadata arrives. Live or
    // unknown-duration streams do not get a misleading seekable range.
    const duration = Number(source.getDuration?.());
    const live = source.getVideoData?.()?.isLive === true;
    if (Number.isFinite(duration) && duration >= 1 && !live) {
      songDuration = Math.floor(duration);
      $('player-seek').max = String(songDuration); $('player-seek').disabled = false;
    } else {
      songDuration = 0; $('player-seek').disabled = true;
    }
    // Polling must not pull the knob away from the user while it is dragged.
    if (scrubbing) return;
    const time = Number(source.getCurrentTime?.());
    if (pendingSeek && performance.now() < pendingSeek.expires && Math.abs(time - pendingSeek.seconds) > 3) {
      showPosition(pendingSeek.seconds); return;
    }
    pendingSeek = null;
    if (Number.isFinite(time)) showPosition(playbackMode === 'stopped' ? 0 : time);
  }
  setInterval(() => {
    syncTimeline();
  }, 500);
  function seekTo(seconds) {
    if (!playerReady || !player || songDuration < 1 || !Number.isFinite(seconds)) return;
    const target = Math.max(0, Math.min(songDuration, Math.floor(seconds)));
    const stayPaused = ['paused', 'stopped', 'ended'].includes(playbackMode);
    player.seekTo(target, true);
    if (stayPaused) { player.pauseVideo(); setPlayback('paused'); }
    pendingSeek = { seconds: target, expires: performance.now() + 2500 };
    scrubbing = false; showPosition(target);
  }
  $('player-seek').addEventListener('pointerdown', () => { scrubbing = true; });
  $('player-seek').addEventListener('input', (e) => { scrubbing = true; showPosition(Number(e.target.value)); });
  // Touch ranges in WebKit can emit input + pointerup without change. Commit
  // on release too; the guard avoids seeking twice if change follows it.
  for (const type of ['change', 'pointerup']) $('player-seek').addEventListener(type, (e) => {
    if (scrubbing) seekTo(Number(e.target.value));
  });
  $('player-seek').addEventListener('pointercancel', () => { scrubbing = false; syncTimeline(); });
  $('player-seek').addEventListener('blur', () => { if (scrubbing) seekTo(Number($('player-seek').value)); });
  function startSelected() {
    if (isLocalFile) return;
    if (player && !['idle', 'error'].includes(playbackMode)) { player.playVideo(); return; }
    const r = byId.get(state.selected);
    if (!r || !validVideo(r)) return;
    if (playbackMode === 'error') preparePlayer(r);
    createPlayer(r);
  }
  function togglePlay() {
    if (['playing', 'buffering', 'loading'].includes(playbackMode)) player?.pauseVideo?.();
    else startSelected();
  }
  // Where "next" goes: the nearest song not heard yet, in the same grove
  // first, then over to the next grove. Previous goes back through what you played.
  function upNext(fromId = state.selected) {
    const from = byId.get(fromId); if (!from) return null;
    const heard = new Set(state.trail);
    const others = pool().filter((r) => r.id !== fromId);
    const fresh = others.filter((r) => !heard.has(r.id));
    const candidates = fresh.length ? fresh : others;
    const distance = (r) => Math.hypot(r.x - from.x, r.y - from.y);
    return candidates.sort((a, b) => (b.islandId === from.islandId) - (a.islandId === from.islandId) ||
      distance(a) - distance(b) || a.id.localeCompare(b.id))[0] ?? null;
  }
  // Leave it running: when a song ends, the next one starts. Songs load into
  // the same YouTube player, because browsers (iOS Safari above all) let a
  // player that is already playing continue without another tap. Videos
  // YouTube will not play here are skipped, but only a few in a row, so a
  // blocked YouTube does not spin through the whole map.
  const MAX_SKIPS_IN_A_ROW = 5;
  let skippedInARow = 0, continueInPlayer = false;
  function playTrack(id) {
    if (!byId.has(id)) return;
    if (id === state.selected) { startSelected(); return; }
    continueInPlayer = !isLocalFile && typeof player?.loadVideoById === 'function';
    const reused = continueInPlayer;
    select(id, true);
    continueInPlayer = false;
    if (!reused) startSelected();
  }
  function playNext() {
    const next = upNext();
    if (next) playTrack(next.id);
    else if (player?.seekTo) { player.seekTo(0, true); player.playVideo(); }
  }
  function goBack() {
    if (state.trail.length < 2) return;
    state.trail.pop();
    playTrack(state.trail.at(-1));
  }
  function loadInPlayer(r) {
    clearTimeout(playerTimer); resetSeeking(); showTime(0);
    playerReady = true; setPlayback('loading');
    $('d-youtube').href = `https://www.youtube.com/watch?v=${r.youtubeId}`;
    const frame = $('youtube-player'); if (frame) frame.title = `${r.artist} — ${r.name}`;
    $('player-status').textContent = '';
    player.setVolume?.(volume); player.loadVideoById(r.youtubeId);
  }
  const validVideo = (r) => /^[\w-]{11}$/.test(r?.youtubeId ?? '');
  $('transport-play').onclick = togglePlay;
  $('transport-prev').onclick = goBack;
  $('transport-next').onclick = playNext;
  $('player-volume').addEventListener('input', (e) => {
    volume = Number(e.target.value); $('volume-value').value = String(volume);
    player?.setVolume?.(volume);
  });
  let apiPromise;
  function loadPlayerApi() {
    if (window.YT?.Player) return Promise.resolve(window.YT);
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('YouTube did not respond. Use the watch link below.')), 15000);
      window.onYouTubeIframeAPIReady = () => { clearTimeout(timeout); resolve(window.YT); };
      const script = node('script'); script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = () => { clearTimeout(timeout); reject(new Error('YouTube is blocked here. Use the watch link below.')); };
      document.head.append(script);
    });
    apiPromise.catch(() => { apiPromise = null; });
    return apiPromise;
  }
  function preparePlayer(r) {
    clearTimeout(playerTimer);
    playerReady = false; resetSeeking();
    setPlayback('idle'); showTime(0);
    playerGeneration++; if (player) { player.destroy(); player = null; }
    $('d-player').replaceChildren();
    const valid = validVideo(r);
    $('transport-play').disabled = !valid || isLocalFile;
    $('d-youtube').href = valid ? `https://www.youtube.com/watch?v=${r.youtubeId}` : r.youtubeUrl ?? '#';
    $('player-status').textContent = isLocalFile ? 'Embedded playback needs localhost. See the notice in Explore.' :
      valid ? '' : 'No YouTube video for this song.';
    if (!valid) return;
    // The thumbnail is the play button until the video loads in its place.
    const poster = node('button', null, 'video-poster');
    poster.id = 'video-poster'; poster.disabled = isLocalFile;
    poster.setAttribute('aria-label', `Play ${r.artist} — ${r.name}`);
    const fallback = node('div', null, 'poster-fallback');
    fallback.append(node('span', 'PLAY ON YOUTUBE'));
    fallback.setAttribute('aria-hidden', 'true'); poster.append(fallback);
    const image = node('img'); image.src = `https://i.ytimg.com/vi/${r.youtubeId}/mqdefault.jpg`;
    image.alt = ''; image.loading = 'lazy';
    image.onerror = () => image.remove();
    poster.append(image); $('d-player').append(poster);
    poster.onclick = () => createPlayer(r);
  }
  async function createPlayer(r) {
    setPlayback('loading');
    const generation = ++playerGeneration;
    const frame = node('iframe'); frame.id = 'youtube-player';
    frame.title = `${r.artist} — ${r.name}`;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.allow = 'accelerometer; autoplay; encrypted-media; picture-in-picture';
    frame.allowFullscreen = true;
    frame.src = `https://www.youtube.com/embed/${r.youtubeId}?enablejsapi=1&playsinline=1&origin=${encodeURIComponent(location.origin)}`;
    $('d-player').replaceChildren(frame);
    $('player-status').textContent = '';
    try {
      const YT = await loadPlayerApi();
      if (generation !== playerGeneration) return;
      player = new YT.Player(frame, { events: {
        onReady: (e) => { if (generation !== playerGeneration) return;
          playerReady = true; syncTimeline(e.target);
          e.target.setVolume?.(volume); setPlayback('ready');
          $('player-status').textContent = 'If nothing plays, press play in the video.';
          e.target.playVideo(); },
        onStateChange: (e) => { if (generation !== playerGeneration) return;
          syncTimeline(e.target ?? player);
          clearTimeout(playerTimer);
          if (e.data === 1) { skippedInARow = 0; setPlayback('playing'); $('player-status').textContent = ''; }
          else if (e.data === 2) { setPlayback('paused'); $('player-status').textContent = ''; }
          else if (e.data === 0) { setPlayback('ended'); playNext(); }
          else if (e.data === 3) {
            setPlayback('buffering');
            $('player-status').textContent = '';
            playerTimer = setTimeout(() => {
              if (generation === playerGeneration) $('player-status').textContent =
                'YouTube is taking a long time to buffer. Check your connection or use the watch link below.';
            }, 12000);
          } },
        onError: (e) => { if (generation !== playerGeneration) return;
          setPlayback('error');
          clearTimeout(playerTimer);
          const skip = skippedInARow < MAX_SKIPS_IN_A_ROW;
          $('player-status').textContent = `YouTube cannot play this video here (error ${e.data}). ` +
            (skip ? 'Skipping to the next track…' : 'Several in a row failed, so playback stopped. Use the watch link below.');
          if (skip) { skippedInARow += 1; playerTimer = setTimeout(playNext, 1500); } },
      } });
    } catch (error) { if (generation === playerGeneration) { setPlayback('error'); $('player-status').textContent = error.message; } }
  }
  /** A grove's name ("deep house"), or as a sentence ("In the deep house grove"). */
  function islandLabel(islandId, sentence = false) {
    const island = islands.get(islandId);
    if (!island) return sentence ? 'Not in a grove' : '';
    const name = island.name.trim();
    if (!sentence) return name;
    if (island.basis === 'show') return `With songs from the show ${name}`;
    return island.basis === 'station' ? `With songs from ${name}` : `In the ${name} grove`;
  }
  function showUpNext() {
    const next = state.selected ? upNext() : null;
    const box = $('d-next'); if (!box) return;
    box.replaceChildren();
    if (!next) { box.append(node('p', 'Nothing else matches your filters.', 'sub')); return; }
    const here = byId.get(state.selected)?.islandId === next.islandId;
    const button = node('button');
    button.append(node('b', `${next.artist} — ${next.name}`),
      node('span', here ? 'Nearest song in this grove' : `Over to the ${islandLabel(next.islandId)} grove`, 'why'));
    button.onclick = () => playTrack(next.id); box.append(button);
  }
  function select(id, sail) {
    const r = byId.get(id); if (!r) return;
    const changed = state.selected !== id; state.selected = id;
    if (state.trail.at(-1) !== id) state.trail.push(id);
    state.trail = state.trail.slice(-60);
    $('trail').replaceChildren();
    state.trail.slice(-8).forEach((trackId) => {
      const t = byId.get(trackId), button = node('button', `${t.artist} — ${t.name}`), li = node('li');
      button.onclick = () => playTrack(trackId); li.append(button); $('trail').append(li);
    });
    if (sail) flyTo(r);
    $('detail-empty').hidden = true; $('detail-body').hidden = false;
    $('d-title').textContent = r.name; $('d-artist').textContent = r.artist;
    $('deck-island').textContent = islandLabel(r.islandId).toUpperCase();
    $('d-meta').replaceChildren(node('span', genres(r).join(' · ') || 'No genres found for this song'));
    const facts = [r.year, r.country, r.length ? formatTime(r.length) : null, r.bpm ? `${r.bpm} BPM` : null].filter(Boolean);
    if (facts.length) $('d-meta').append(node('span', facts.join(' · ')));
    const release = r.album && r.label ? `From ${r.album}, on ${r.label}` : r.album ? `From ${r.album}` : r.label ? `On ${r.label}` : '';
    if (release) $('d-meta').append(node('span', release));
    $('d-meta').append(node('span', islandLabel(r.islandId, true)));
    if (changed) { if (continueInPlayer && validVideo(r)) loadInPlayer(r); else preparePlayer(r); }
    $('d-sources').replaceChildren();
    for (const p of r.radioPlays ?? [{ station: r.station, show: r.show, date: r.date, sourceUrl: r.sourceUrl }]) {
      const li = node('li'), label = [stationNames.get(p.station) ?? p.station ?? 'Radio', p.show, p.date?.slice(0, 10)].filter(Boolean).join(' · ');
      li.append(link(p.sourceUrl, label)); $('d-sources').append(li);
    }
    $('d-neighbours').replaceChildren();
    const following = upNext(id)?.id;
    for (const n of r.neighbours ?? []) {
      if (!byId.has(n.id) || n.id === following) continue;
      const li = node('li'), button = node('button');
      button.append(node('b', `${n.artist} — ${n.name}`), node('span', n.reasons.join(' · '), 'why'));
      button.onclick = () => playTrack(n.id); li.append(button); $('d-neighbours').append(li);
    }
    $('d-routes').replaceChildren();
    for (const route of DATA.tradeRoutes.filter((v) => v.from === id || v.to === id).slice(0, 5)) {
      const t = byId.get(route.from === id ? route.to : route.from); if (!t) continue;
      const li = node('li'), button = node('button');
      button.append(node('b', `${t.artist} — ${t.name}`), node('span', islandLabel(t.islandId, true), 'why'));
      button.onclick = () => playTrack(t.id); li.append(button); $('d-routes').append(li);
    }
    if (!$('d-routes').children.length) $('d-routes').append(node('li', 'No trails from this song.', 'sub'));
    if (changed) walkTo(r);
    refreshFilters();
  }
  $('btn-banger').onclick = () => {
    const all = pool(), alternatives = all.filter((r) => r.id !== state.selected);
    const source = alternatives.length ? alternatives : all;
    if (source.length) playTrack(source[Math.floor(Math.random() * source.length)].id);
  };
  $('btn-routes').onclick = () => {
    state.showRoutes = !state.showRoutes;
    $('btn-routes').setAttribute('aria-pressed', String(state.showRoutes)); draw();
  };
  if ($('btn-topology')) {
    function stepOrbit(now) {
      if (state.viewMode !== '3d') { orbitFrame = null; return; }
      const dt = lastOrbitTime ? Math.min(64, now - lastOrbitTime) : 16;
      lastOrbitTime = now;
      if (!pointers.size && !state.hovered && animation === null && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        state.cam3d.yaw += dt * 0.00028;
        draw();
      }
      orbitFrame = requestAnimationFrame(stepOrbit);
    }
    $('btn-topology').onclick = () => {
      cancelFly();
      state.hovered = null; $('tooltip').hidden = true;
      state.viewMode = state.viewMode === '3d' ? '2d' : '3d';
      const is3d = state.viewMode === '3d';
      $('btn-topology').setAttribute('aria-pressed', String(is3d));
      if ($('map-window-title')) $('map-window-title').textContent = is3d ? '3d topology · nerve & cycles' : 'the steppe';
      const desktopHint = document.querySelector('#map-help .desktop-hint');
      const touchHint = document.querySelector('#map-help .touch-hint');
      if (desktopHint) desktopHint.textContent = is3d ? 'DRAG TO ORBIT 3D · CLICK TO PLAY' : 'CLICK A SQUARE TO PLAY';
      if (touchHint) touchHint.textContent = is3d ? 'DRAG TO ORBIT 3D · TAP TO PLAY' : 'TAP TO PLAY · PINCH TO ZOOM';
      if (is3d && !fitted3D) fitView();
      else draw();
      if (is3d && orbitFrame === null) {
        lastOrbitTime = 0;
        orbitFrame = requestAnimationFrame(stepOrbit);
      } else if (!is3d && orbitFrame !== null) {
        cancelAnimationFrame(orbitFrame);
        orbitFrame = null;
      }
    };
  }
  $('btn-home').onclick = fitView;
  $('zoom-in').onclick = () => zoomAt(1.25);
  $('zoom-out').onclick = () => zoomAt(1 / 1.25);
  new ResizeObserver(resize).observe($('map-wrap'));
  const banner = $('banner');
  if (banner) {
    const paint = () => window.RadioSeaLandscape.drawBanner(banner);
    new ResizeObserver(paint).observe(banner);
  }
  for (const face of document.querySelectorAll('canvas.guano-face')) window.Guano.drawFace(face);
  resize(); fitView(); select(releases[0].id, false);
})();
