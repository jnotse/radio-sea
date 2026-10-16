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
  const stationNames = new Map(DATA.stats.stations.map((s) => [s.id, s.label]));
  const stationIds = (r) => r?.stations?.length ? r.stations : r?.station ? [r.station] : [];
  const state = { cam: { x: 0, y: 0, zoom: 8 }, selected: null, hovered: null,
    trail: [], stations: new Set(DATA.stats.stations.filter((s) => s.tracks > 0).map((s) => s.id)),
    tags: new Set(), query: '', showRoutes: true };
  let pointer = null, animation = null, player = null, playerGeneration = 0, playerTimer;
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
  function soundTags(r) {
    return (r.tags ?? []).filter((t) => !/^(show|station):/.test(t));
  }
  function passesFilter(r) {
    return !!r && stationIds(r).some((s) => state.stations.has(s)) &&
      [...state.tags].every((t) => (r.tags ?? []).includes(t)) &&
      `${r.artist} ${r.name} ${r.radioPlays?.map((p) => p.show).join(' ') ?? r.show ?? ''}`
        .toLowerCase().includes(state.query);
  }
  const pool = () => releases.filter(passesFilter);

  $('stats').append(node('div', `${String(releases.length).padStart(3, '0')} TRACKS / ${String(DATA.islands.length).padStart(2, '0')} ISLANDS`),
    node('div', 'RADIO ARCHIVE // YOUTUBE PLAYBACK', 'sub'));
  for (const station of DATA.stats.stations) {
    const chip = node('button', `${station.label} (${station.tracks})`, 'chip');
    chip.dataset.station = station.id;
    chip.disabled = !station.tracks;
    chip.title = station.tracks ? `Toggle ${station.label}` : 'No tracklists imported in this snapshot';
    chip.onclick = () => { toggle(state.stations, station.id); refreshFilters(); };
    $('station-chips').append(chip);
  }
  const tagCounts = new Map();
  releases.forEach((r) => soundTags(r).forEach((t) => tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)));
  for (const [tag] of [...tagCounts].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    const chip = node('button', tag, 'chip');
    chip.dataset.tag = tag;
    chip.onclick = () => { toggle(state.tags, tag); refreshFilters(); };
    $('tag-chips').append(chip);
  }
  function toggle(set, value) { if (set.has(value)) set.delete(value); else set.add(value); }
  $('search').addEventListener('input', (e) => { state.query = e.target.value.trim().toLowerCase(); refreshFilters(); });
  $('btn-clear').onclick = () => {
    state.stations = new Set(DATA.stats.stations.filter((s) => s.tracks > 0).map((s) => s.id));
    state.tags.clear(); state.query = ''; $('search').value = ''; refreshFilters();
  };
  function refreshFilters() {
    document.querySelectorAll('[data-station]').forEach((c) => {
      const on = state.stations.has(c.dataset.station);
      c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('[data-tag]').forEach((c) => {
      const on = state.tags.has(c.dataset.tag);
      c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on));
    });
    const visible = pool();
    $('track-count').textContent = `tracklist [${String(visible.length).padStart(2, '0')}/${releases.length}]`;
    $('map-status').textContent = visible.length ? `${visible.length} tracks match` : 'No matches — clear filters to explore again';
    $('btn-banger').disabled = !visible.length;
    $('btn-similar').disabled = !visible.some((r) => r.id !== state.selected);
    $('transport-prev').disabled = visible.length < 2;
    $('transport-next').disabled = visible.length < 2;
    $('track-list').replaceChildren();
    visible.forEach((r) => {
      const button = node('button', `${r.artist} — ${r.name}`);
      button.dataset.trackId = r.id;
      button.setAttribute('aria-pressed', String(r.id === state.selected));
      button.onclick = () => select(r.id, true);
      const li = node('li'); li.append(button); $('track-list').append(li);
    });
    state.hovered = null; $('tooltip').hidden = true;
    draw();
  }

  // Camera is in pixels per world unit. Keep one consistent range for fit,
  // flying and wheel zoom (the old wheel handler clamped fitted zoom to 4).
  const MIN_ZOOM = 0.5, MAX_ZOOM = 100;
  const toScreen = (x, y) => ({ x: (x - state.cam.x) * state.cam.zoom + canvas.clientWidth / 2,
    y: (y - state.cam.y) * state.cam.zoom + canvas.clientHeight / 2 });
  function cancelFly() { if (animation !== null) cancelAnimationFrame(animation); animation = null; }
  function fitView() {
    cancelFly();
    const minX = Math.min(...releases.map((r) => r.x)) - 5;
    const maxX = Math.max(...releases.map((r) => r.x)) + 5;
    const minY = Math.min(...releases.map((r) => r.y)) - 5;
    const maxY = Math.max(...releases.map((r) => r.y)) + 5;
    Object.assign(state.cam, { x: (minX + maxX) / 2, y: (minY + maxY) / 2,
      zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, canvas.clientWidth / (maxX - minX), canvas.clientHeight / (maxY - minY))) });
    draw();
  }
  function flyTo(r) {
    cancelFly();
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
    const old = state.cam.zoom, next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, old * factor));
    state.cam.x += (x - canvas.clientWidth / 2) * (1 / old - 1 / next);
    state.cam.y += (y - canvas.clientHeight / 2) * (1 / old - 1 / next);
    state.cam.zoom = next; draw();
  }
  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    canvas.dataset.zoom = String(state.cam.zoom);
    canvas.dataset.cameraX = String(state.cam.x); canvas.dataset.cameraY = String(state.cam.y);
    canvas.dataset.selected = state.selected ?? '';
    canvas.dataset.matching = String(pool().length);
    // Four-shade LCD geography: pixel-dithered land instead of smooth glows.
    ctx.imageSmoothingEnabled = false;
    for (const island of DATA.islands) {
      const p = toScreen(island.centre.x, island.centre.y);
      const radius = Math.max(18, island.radius * state.cam.zoom * 1.25);
      if (island.memberIds.length > 1) {
        ctx.fillStyle = '#607d4230';
        const step = 6;
        const left = Math.max(0, Math.floor((p.x - radius) / step) * step);
        const top = Math.max(0, Math.floor((p.y - radius) / step) * step);
        for (let y = top; y < Math.min(h, p.y + radius); y += step) {
          for (let x = left; x < Math.min(w, p.x + radius); x += step) {
            if (((x + y) / step) % 2 !== 0) continue;
            if (((x - p.x) / radius) ** 2 + ((y - p.y) / (radius * .75)) ** 2 < 1) ctx.fillRect(x, y, 2, 2);
          }
        }
        const label = island.name.trim().toUpperCase();
        ctx.font = '9px Silkscreen, monospace'; ctx.textAlign = 'center';
        const labelWidth = ctx.measureText(label).width + 10;
        ctx.fillStyle = '#a5b877';
        ctx.fillRect(Math.round(p.x - labelWidth / 2), Math.round(p.y - radius - 17), labelWidth, 15);
        ctx.fillStyle = '#334d2c'; ctx.fillText(label, Math.round(p.x), Math.round(p.y - radius - 7));
      }
    }
    if (state.showRoutes) {
      ctx.strokeStyle = '#48633488'; ctx.setLineDash([2, 5]);
      for (const r of DATA.tradeRoutes) {
        const a = byId.get(r.from), b = byId.get(r.to);
        if (!passesFilter(a) || !passesFilter(b)) continue;
        const p = toScreen(a.x, a.y), q = toScreen(b.x, b.y);
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    if (state.trail.length > 1) {
      ctx.strokeStyle = '#243c25'; ctx.lineWidth = 1.5; ctx.beginPath();
      state.trail.slice(-40).forEach((id, i) => {
        const r = byId.get(id), p = toScreen(r.x, r.y);
        if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      }); ctx.stroke(); ctx.lineWidth = 1;
    }
    for (const r of releases) {
      const projected = toScreen(r.x, r.y), p = { x: Math.round(projected.x), y: Math.round(projected.y) };
      const size = Math.round(Math.max(6, Math.min(14, state.cam.zoom * .78)));
      ctx.globalAlpha = passesFilter(r) ? 1 : .12;
      ctx.fillStyle = '#263e25';
      ctx.fillRect(Math.round(p.x - size / 2), Math.round(p.y - size / 2), size, size);
      if (size >= 8) {
        ctx.fillStyle = '#a5b877'; ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
      }
      if (r.id === state.selected || r.id === state.hovered) {
        ctx.strokeStyle = '#1c3320';
        ctx.strokeRect(Math.round(p.x - size / 2 - 3) + .5, Math.round(p.y - size / 2 - 3) + .5, size + 6, size + 6);
        if (r.id === state.selected) {
          ctx.fillStyle = '#1c3320'; ctx.fillRect(p.x - 1, p.y - size / 2 - 8, 3, 3);
        }
      }
    }
    ctx.globalAlpha = 1;
  }
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr); canvas.height = Math.round(canvas.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); draw();
  }
  document.fonts?.ready.then(draw);
  function tileAt(event) {
    const rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    let best = null, distance = Math.max(7, Math.min(11, state.cam.zoom * .5));
    for (const r of pool()) {
      const p = toScreen(r.x, r.y), d = Math.hypot(p.x - x, p.y - y);
      if (d < distance) { best = r; distance = d; }
    }
    return best;
  }
  function hideTooltip() { state.hovered = null; $('tooltip').hidden = true; }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    cancelFly(); hideTooltip(); canvas.focus(); canvas.setPointerCapture(e.pointerId);
    pointer = { id: e.pointerId, startX: e.clientX, startY: e.clientY,
      x: e.clientX, y: e.clientY, moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointer?.id === e.pointerId) {
      if (Math.hypot(e.clientX - pointer.startX, e.clientY - pointer.startY) > 5) pointer.moved = true;
      if (pointer.moved) {
        canvas.classList.add('dragging');
        state.cam.x -= (e.clientX - pointer.x) / state.cam.zoom;
        state.cam.y -= (e.clientY - pointer.y) / state.cam.zoom;
        draw();
      }
      pointer.x = e.clientX; pointer.y = e.clientY; return;
    }
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
  canvas.addEventListener('pointerup', (e) => {
    if (!pointer || e.pointerId !== pointer.id) return;
    const click = !pointer.moved; pointer = null; canvas.classList.remove('dragging');
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (click) { const r = tileAt(e); if (r) select(r.id, true); }
  });
  for (const type of ['pointercancel', 'lostpointercapture']) canvas.addEventListener(type, () => {
    pointer = null; canvas.classList.remove('dragging');
  });
  canvas.addEventListener('pointerleave', () => { hideTooltip(); draw(); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault(); hideTooltip(); const rect = canvas.getBoundingClientRect();
    zoomAt(Math.exp(-Math.max(-250, Math.min(250, e.deltaY)) * .002), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.key === '=') zoomAt(1.2);
    else if (e.key === '-') zoomAt(1 / 1.2);
    else if (e.key === 'Home') fitView();
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
    const active = ['ready', 'playing', 'paused', 'buffering'].includes(mode);
    $('transport-pause').disabled = !active;
    $('transport-stop').disabled = !active;
    if (mode === 'error') { playerReady = false; resetSeeking(); }
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
    $('seek-time').value = ''; $('seek-time').disabled = true; $('seek-go').disabled = true;
    $('seek-message').hidden = true; $('seek-readout').textContent = '00:00 / --:--';
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
      $('seek-time').disabled = false; $('seek-go').disabled = false;
    } else {
      songDuration = 0; $('player-seek').disabled = true;
      $('seek-time').disabled = true; $('seek-go').disabled = true;
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
    $('seek-message').hidden = true;
  }
  $('player-seek').addEventListener('pointerdown', () => { scrubbing = true; });
  $('player-seek').addEventListener('input', (e) => { scrubbing = true; showPosition(Number(e.target.value)); });
  $('player-seek').addEventListener('change', (e) => seekTo(Number(e.target.value)));
  $('player-seek').addEventListener('pointercancel', () => { scrubbing = false; syncTimeline(); });
  $('player-seek').addEventListener('blur', () => { if (scrubbing) seekTo(Number($('player-seek').value)); });
  $('seek-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('seek-time').value.trim().replace(/s$/i, '').trim();
    const parts = raw.split(':');
    const valid = /^\d+(?::\d{1,2}){0,2}$/.test(raw) &&
      (parts.length === 1 || parts.slice(1).every((p) => Number(p) < 60));
    if (!valid) {
      $('seek-message').textContent = 'Enter seconds (83), mm:ss (1:23), or hh:mm:ss.';
      $('seek-message').hidden = false; return;
    }
    seekTo(parts.reduce((total, p) => total * 60 + Number(p), 0));
  });
  function startSelected() {
    if (isLocalFile) return;
    if (player && !['idle', 'error'].includes(playbackMode)) { player.playVideo(); return; }
    if (playbackMode === 'error') preparePlayer(byId.get(state.selected));
    $('play-track')?.click();
  }
  $('transport-play').onclick = startSelected;
  $('transport-pause').onclick = () => player?.pauseVideo?.();
  $('transport-stop').onclick = () => {
    player?.stopVideo?.(); clearTimeout(playerTimer); setPlayback('stopped');
    scrubbing = false; pendingSeek = null; showPosition(0);
    $('player-status').textContent = 'Stopped. Press Play to listen again.';
  };
  function adjacentTrack(direction) {
    const tracks = pool(); if (!tracks.length) return;
    const index = tracks.findIndex((r) => r.id === state.selected);
    const next = tracks[(Math.max(0, index) + direction + tracks.length) % tracks.length];
    const resume = ['playing', 'buffering'].includes(playbackMode);
    select(next.id, true);
    if (resume) startSelected();
  }
  $('transport-prev').onclick = () => adjacentTrack(-1);
  $('transport-next').onclick = () => adjacentTrack(1);
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
    const valid = /^[\w-]{11}$/.test(r.youtubeId ?? '');
    $('transport-play').disabled = !valid || isLocalFile;
    $('d-youtube').href = valid ? `https://www.youtube.com/watch?v=${r.youtubeId}` : r.youtubeUrl ?? '#';
    const play = node('button', valid ? '▶ Play this track' : 'No valid YouTube video', 'play-button');
    play.id = 'play-track'; play.disabled = !valid || isLocalFile;
    if (valid) {
      const poster = node('div', null, 'video-poster');
      const fallback = node('div', null, 'poster-fallback');
      fallback.append(node('span', '▤'), node('span', 'RADIO SEA / YOUTUBE'));
      fallback.setAttribute('aria-hidden', 'true'); poster.append(fallback);
      const image = node('img'); image.src = `https://i.ytimg.com/vi/${r.youtubeId}/mqdefault.jpg`;
      image.alt = ''; image.loading = 'lazy';
      image.onerror = () => image.remove();
      poster.append(image); $('d-player').append(poster);
    }
    $('d-player').append(play);
    $('player-status').textContent = isLocalFile ? 'Embedded playback needs localhost. See the notice on the left.' :
      'Press Play to load YouTube. If a video is restricted, use the watch link below.';
    play.onclick = async () => {
      setPlayback('loading');
      const generation = ++playerGeneration;
      const frame = node('iframe'); frame.id = 'youtube-player';
      frame.title = `${r.artist} — ${r.name}`;
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.allow = 'accelerometer; autoplay; encrypted-media; picture-in-picture';
      frame.allowFullscreen = true;
      frame.src = `https://www.youtube.com/embed/${r.youtubeId}?enablejsapi=1&playsinline=1&origin=${encodeURIComponent(location.origin)}`;
      $('d-player').replaceChildren(frame);
      $('player-status').textContent = 'Loading YouTube…';
      try {
        const YT = await loadPlayerApi();
        if (generation !== playerGeneration) return;
        player = new YT.Player(frame, { events: {
          onReady: (e) => { if (generation !== playerGeneration) return;
            playerReady = true; syncTimeline(e.target);
            e.target.setVolume?.(volume); setPlayback('ready');
            $('player-status').textContent = 'YouTube player ready. Press Play in the video if needed.';
            e.target.playVideo(); },
          onStateChange: (e) => { if (generation !== playerGeneration) return;
            syncTimeline(e.target ?? player);
            clearTimeout(playerTimer);
            if (e.data === 1) { setPlayback('playing'); $('player-status').textContent = 'Playing on YouTube'; }
            else if (e.data === 2) { setPlayback('paused'); $('player-status').textContent = 'Paused'; }
            else if (e.data === 0) { setPlayback('ended'); $('player-status').textContent = 'Track finished. Choose a neighbour or another track.'; }
            else if (e.data === 3) {
              setPlayback('buffering');
              $('player-status').textContent = 'Buffering YouTube…';
              playerTimer = setTimeout(() => {
                if (generation === playerGeneration) $('player-status').textContent =
                  'YouTube is taking a long time to buffer. Check your connection or use the watch link below.';
              }, 12000);
            } },
          onError: (e) => { if (generation !== playerGeneration) return;
            setPlayback('error');
            clearTimeout(playerTimer);
            $('player-status').textContent = `YouTube cannot play this video here (error ${e.data}). Use the watch link below.`; },
        } });
      } catch (error) { if (generation === playerGeneration) { setPlayback('error'); $('player-status').textContent = error.message; } }
    };
  }
  function select(id, sail) {
    const r = byId.get(id); if (!r) return;
    const changed = state.selected !== id; state.selected = id;
    if (state.trail.at(-1) !== id) state.trail.push(id);
    state.trail = state.trail.slice(-60);
    $('trail').replaceChildren();
    state.trail.slice(-8).forEach((trackId) => {
      const t = byId.get(trackId), button = node('button', `${t.artist} — ${t.name}`), li = node('li');
      button.onclick = () => select(trackId, true); li.append(button); $('trail').append(li);
    });
    if (sail) flyTo(r);
    $('detail-empty').hidden = true; $('detail-body').hidden = false;
    $('d-title').textContent = r.name; $('d-artist').textContent = r.artist;
    $('deck-index').textContent = `${String(releases.indexOf(r) + 1).padStart(2, '0')} / ${releases.length}`;
    const island = islands.get(r.islandId);
    $('d-meta').replaceChildren(node('span', soundTags(r).join(' · ') || 'No sound tags yet'),
      node('span', `${island?.name?.trim() ?? 'Uncharted'} · depth ${(r.depth ?? 0).toFixed(2)} · ${r.x}~${r.y}`));
    if (r.year || r.country) $('d-meta').append(node('span', [r.year, r.country].filter(Boolean).join(' · ')));
    if (changed) preparePlayer(r);
    $('d-sources').replaceChildren();
    for (const p of r.radioPlays ?? [{ station: r.station, show: r.show, date: r.date, sourceUrl: r.sourceUrl }]) {
      const li = node('li'), label = `${stationNames.get(p.station) ?? p.station ?? 'Radio'} · ${p.show ?? ''} · ${p.date?.slice(0, 10) ?? ''}`;
      li.append(link(p.sourceUrl, label)); $('d-sources').append(li);
    }
    $('d-neighbours').replaceChildren();
    for (const n of r.neighbours ?? []) {
      if (!byId.has(n.id)) continue;
      const li = node('li'), button = node('button');
      button.append(node('b', `${n.artist} — ${n.name}`), node('span', n.reasons.join(' · '), 'why'));
      button.onclick = () => select(n.id, true); li.append(button); $('d-neighbours').append(li);
    }
    $('d-routes').replaceChildren();
    for (const route of DATA.tradeRoutes.filter((v) => v.from === id || v.to === id).slice(0, 5)) {
      const t = byId.get(route.from === id ? route.to : route.from); if (!t) continue;
      const li = node('li'), button = node('button');
      button.append(node('b', `${t.artist} — ${t.name}`), node('span', `Route score ${route.score}`, 'why'));
      button.onclick = () => select(t.id, true); li.append(button); $('d-routes').append(li);
    }
    if (!$('d-routes').children.length) $('d-routes').append(node('li', 'No cross-island routes in this snapshot.', 'sub'));
    refreshFilters();
  }
  $('btn-banger').onclick = () => {
    const all = pool(), alternatives = all.filter((r) => r.id !== state.selected);
    const source = alternatives.length ? alternatives : all;
    if (source.length) select(source[Math.floor(Math.random() * source.length)].id, true);
  };
  $('btn-similar').onclick = () => {
    const current = byId.get(state.selected);
    const neighbours = (current?.neighbours ?? []).filter((n) => n.id !== state.selected && passesFilter(byId.get(n.id)));
    const alternatives = pool().filter((r) => r.id !== state.selected);
    const source = neighbours.length ? neighbours : alternatives;
    if (source.length) select(source[Math.floor(Math.random() * source.length)].id, true);
  };
  $('btn-routes').onclick = () => {
    state.showRoutes = !state.showRoutes;
    $('btn-routes').textContent = `trade routes: ${state.showRoutes ? 'on' : 'off'}`;
    $('btn-routes').setAttribute('aria-pressed', String(state.showRoutes)); draw();
  };
  $('btn-home').onclick = fitView;
  $('zoom-in').onclick = () => zoomAt(1.25);
  $('zoom-out').onclick = () => zoomAt(1 / 1.25);
  new ResizeObserver(resize).observe($('map-wrap'));
  resize(); fitView(); select(releases[0].id, false);
})();
