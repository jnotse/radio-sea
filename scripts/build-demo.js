// Build the demo: scan real radio tracklists (NTS, Worldwide FM, The Lot
// Radio), resolve every track to a VALIDATED YouTube link (tracks without one
// are dropped), map the result onto the sea, and write demo/sea-data.js.
//
//   node scripts/build-demo.js [--max 40] [--episodes 4]
//   node scripts/build-demo.js --genres   # look up per-track genres (MusicBrainz)
//   node scripts/build-demo.js --reuse    # rebuild the map from the caches only
//
// Network required, except with --reuse. Everything is cached in demo/sea-data.js
// afterwards, so the demo itself runs offline.

import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fetchRadioPlays, RADIO_STATIONS } from '../src/catalog/radio.js';
import { resolvePlaysToYoutube } from '../src/catalog/youtube.js';
import { mergeCatalogue } from '../src/catalog/resolve.js';
import { RadioSeaDiscovery } from '../src/engine.js';
import { candidateMatch } from '../src/catalog/youtube.js';
import { extendRadioCache, songKey } from '../src/catalog/extend.js';
import { lookupGenresForPlays } from '../src/catalog/genres.js';
import { fetchRadioooooPlays } from '../src/catalog/radiooooo.js';
import { decodeEntities } from '../src/catalog/text.js';

export function interleavePlays(plays, limit) {
  const groups = new Map();
  for (const play of plays) {
    if (!groups.has(play.station)) groups.set(play.station, []);
    groups.get(play.station).push(play);
  }
  const lists = [...groups.values()], mixed = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && mixed.length < limit; i++) {
    for (const list of lists) if (list[i] && mixed.length < limit) mixed.push(list[i]);
  }
  return mixed;
}

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const maxTracks = argValue('max', 40);
const maxEpisodes = argValue('episodes', 4);

// A track's own genres (looked up per recording) and per-track tags such as
// Radiooooo's mood and decade are sound tags. The genres a station lists for a
// show describe the whole set, so they are kept as `show-genre:` context.
export function playToRaw(play) {
  const show = decodeEntities(play.show);
  return {
    source: 'radio',
    sourceId: `${play.station}|${play.show}|${play.artist}|${play.title}`,
    title: play.title,
    artist: play.artist,
    artists: [play.artist].filter(Boolean),
    label: play.label ?? null,
    year: play.releaseYear ?? null, // Never treat broadcast date as release year.
    country: play.country ?? null,
    format: 'Radio',
    rating: null,
    tags: {
      genres: [...(play.genres ?? []), ...(play.tags ?? [])],
      styles: [`station:${play.station}`],
      descriptors: [
        ...(show ? [`show:${show}`] : []),
        ...(play.showGenres ?? []).slice(0, 4).map((genre) => `show-genre:${genre}`),
      ],
    },
    tracks: [{ title: play.title, duration: null, bpm: null, key: null }],
    urls: { youtube: play.youtube.url },
    youtubeId: play.youtube.videoId,
    station: play.station,
    show,
    date: play.date,
    sourceUrl: play.sourceUrl?.replace('www.nts.live/api/v2/', 'www.nts.live/'),
  };
}

async function main() {
  const cacheFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'resolved-plays.json');
  await mkdir(join(dirname(cacheFile)), { recursive: true });

  let resolved = [];
  let dropped = 0;
  let plays = [];
  let errors = [];

  if (['--reuse', '--repair', '--extend', '--radiooooo', '--genres'].some((flag) => args.includes(flag))) {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
    resolved = cached.resolved;
    dropped = cached.dropped;
    plays = cached.plays;
    console.log(`reusing cached resolution: ${resolved.length} tracks (dropped ${dropped})`);
    if (args.includes('--radiooooo')) {
      console.log('Sampling public Radiooooo selections (metadata only; no audio requests)…');
      const incoming = await fetchRadioooooPlays({ samples: argValue('max', 16) });
      console.log(`Received ${incoming.length} distinct public selections. Resolving YouTube matches…`);
      const keys = new Set(cached.plays.map((p) => `${p.station}|${p.ids?.radiooooo ?? ''}|${p.artist}|${p.title}`));
      cached.plays.push(...incoming.filter((p) => !keys.has(`${p.station}|${p.ids?.radiooooo ?? ''}|${p.artist}|${p.title}`)));
      plays = cached.plays;
    }
    if (args.includes('--extend') || args.includes('--radiooooo')) {
      const result = await extendRadioCache(cached, {
        limit: argValue('max', 160),
        stations: args.includes('--radiooooo') ? ['radiooooo'] : null,
        checkpoint: async (cache) => {
          await writeFile(`${cacheFile}.next`, JSON.stringify(cache, null, 1));
          await rename(`${cacheFile}.next`, cacheFile);
        },
        onProgress: ({ index, total, play, youtube, added }) => console.log(
          `  ${index}/${total} ${youtube?.confirmed ? 'matched' : 'excluded'} (+${added}): ${play.artist} — ${play.title}`),
      });
      resolved = result.cache.resolved;
      dropped = result.cache.dropped;
      console.log(`Added ${result.added} verified matches from ${result.attempted} new lookups; kept existing tracks.`);
    }
    if (args.includes('--repair')) {
      const sample = [...resolved, ...interleavePlays(plays, maxTracks)].filter((p, i, all) =>
        all.findIndex((other) => other.station === p.station && other.artist === p.artist && other.title === p.title) === i);
      const result = await resolvePlaysToYoutube(sample, { delayMs: 1100, onProgress: ({ index, total, play, youtube }) =>
        console.log(`  ${index}/${total} ${youtube ? 'matched' : 'excluded'}: ${play.artist} — ${play.title}`) });
      resolved = result.resolved;
      dropped = result.dropped;
      await writeFile(cacheFile, JSON.stringify({ plays, resolved, dropped }, null, 1));
    }
  } else {
    console.log('scanning radio tracklists ...');
    ({ plays, errors } = await fetchRadioPlays({ maxEpisodes }));
    for (const station of RADIO_STATIONS) {
      const count = plays.filter((p) => p.station === station.id).length;
      console.log(`  ${station.label}: ${count} tracks`);
    }
    for (const error of errors) console.log(`  ! ${error.station}: ${error.message}`);
    if (plays.length === 0) throw new Error('no radio plays found');

    console.log(`\nresolving ${Math.min(plays.length, maxTracks)} tracks to YouTube (validated) ...`);
    // Round-robin across stations so one station's block does not eat the quota.
    const mixed = interleavePlays(plays, maxTracks);

    ({ resolved, dropped } = await resolvePlaysToYoutube(mixed, { delayMs: 1100 }));
    console.log(`  resolved ${resolved.length}, dropped ${dropped} (no valid YouTube link)`);
    await writeFile(cacheFile, JSON.stringify({ plays, resolved, dropped }, null, 1));
    console.log(`  cached to ${cacheFile}`);
  }

  // Reject stale/unverified or unrelated cached candidates too.
  resolved = resolved.filter((p) => p.youtube?.confirmed === true && candidateMatch(p, p.youtube).acceptable);
  if (!resolved.length) throw new Error('No verified matches. Run build-demo with --repair to refresh the cache.');
  // Per-track genres live in their own cache so lookups survive rebuilds.
  const genresFile = join(dirname(cacheFile), 'track-genres.json');
  let trackGenres = {};
  try { trackGenres = JSON.parse(await readFile(genresFile, 'utf8')); } catch { /* none looked up yet */ }
  if (args.includes('--genres')) {
    console.log('Looking up per-track genres on MusicBrainz (about one request per second)…');
    const result = await lookupGenresForPlays(resolved, {
      cache: trackGenres,
      checkpoint: async (cache) => {
        await writeFile(`${genresFile}.next`, JSON.stringify(cache, null, 1));
        await rename(`${genresFile}.next`, genresFile);
      },
      onProgress: ({ index, total, play, genres, source }) => console.log(
        `  ${index}/${total} ${genres.length ? `${genres.join(', ')} (${source})` : 'no genres'}: ${play.artist} — ${play.title}`),
    });
    trackGenres = result.cache;
    if (result.error) console.log(`Stopped after ${result.done}/${result.total}: ${result.error.message}. Run again to continue.`);
  }
  const withGenres = resolved.map((play) => ({ ...play, genres: trackGenres[songKey(play)]?.genres ?? [] }));
  console.log(`  ${withGenres.filter((p) => p.genres.length).length}/${withGenres.length} tracks have their own genres`);
  const { releases } = mergeCatalogue(withGenres.map(playToRaw));
  console.log(`  merged into ${releases.length} unique tracks`);

  const engine = new RadioSeaDiscovery({ releases, seed: 'radio-sea' });

  // Precompute what the demo needs: neighbours with reasons + trade routes.
  const neighbours = new Map();
  for (const release of releases) {
    const rows = engine
      .getRelated({ current_release_id: release.id, limit: 3 })
      .map((row) => {
        const other = engine.releases.find((r) => r.id === row.release_track.id);
        return {
          id: other.id,
          name: other.name,
          artist: other.artist,
          score: row.score,
          reasons: engine.explain(release.id, other.id).reasons,
        };
      });
    neighbours.set(release.id, rows);
  }

  const tradeRoutes = engine.tradeRoutes({ minScore: 0.15 }).slice(0, 25);

  const payload = {
    generatedAt: new Date().toISOString(),
    stats: {
      stations: RADIO_STATIONS.map((s) => ({
        id: s.id,
        label: s.label,
        tracks: releases.filter((r) => r.stations.includes(s.id)).length,
      })),
      scanned: plays.length,
      resolved: resolved.length,
      dropped,
      merged: releases.length,
      islands: engine.islands.length,
    },
    islands: engine.islands.map((island) => ({
      ...island,
      name: island.name.replace(/^station:/, ''),
    })),
    releases: releases.map((release) => {
      const placement = engine.mapPlacement(release.id);
      return {
        id: release.id,
        name: release.name,
        artist: release.artist,
        year: release.year,
        country: release.country,
        station: release.station,
        stations: release.stations,
        radioPlays: release.radioPlays,
        show: release.show,
        date: release.date,
        tags: release.tags.all,
        youtubeId: release.youtubeId,
        youtubeUrl: release.urls.youtube,
        youtubeTitle: resolved.find((p) => p.youtube.videoId === release.youtubeId)?.youtube.title,
        youtubeCheckedAt: resolved.find((p) => p.youtube.videoId === release.youtubeId)?.youtube.checkedAt ?? null,
        sourceUrl: release.sourceUrl,
        islandId: engine.islandOf(release.id)?.id ?? null,
        depth: engine.depthOf(release.id),
        x: placement.x,
        y: placement.y,
        neighbours: neighbours.get(release.id),
      };
    }),
    tradeRoutes,
  };

  for (const r of payload.releases) {
    if (!r.station || !r.youtubeId || !r.sourceUrl) throw new Error(`Incomplete demo track: ${r.id}`);
  }
  const demoDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'demo');
  await mkdir(demoDir, { recursive: true });
  await writeFile(join(demoDir, 'sea-data.js'), `window.SEA_DATA = ${JSON.stringify(payload, null, 1).replace(/</g, '\\u003c')};\n`);
  await writeFile(join(demoDir, 'sea-data.json'), JSON.stringify(payload, null, 1));
  console.log(`\nwrote demo/sea-data.js (${payload.releases.length} tiles, ${engine.islands.length} islands)`);
  console.log('open demo/index.html in a browser');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error('build failed:', error.message);
  process.exitCode = 1;
});
