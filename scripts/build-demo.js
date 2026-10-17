// Build the demo: scan real radio tracklists (NTS, Worldwide FM, The Lot
// Radio), resolve every track to a VALIDATED YouTube link (tracks without one
// are dropped), map the result onto the sea, and write demo/sea-data.js.
//
//   node scripts/build-demo.js [--max 40] [--episodes 4]
//   node scripts/build-demo.js --genres   # look up per-track genres (MusicBrainz)
//   node scripts/discogs-import.js <dump>  # genres, styles and years from a Discogs dump
//   node scripts/build-demo.js --deezer   # tempo (BPM), length and loudness from Deezer
//   node scripts/build-demo.js --youtube-meta  # length, album and label from YouTube
//                                         (Data API if YOUTUBE_API_KEY is set, else watch pages)
//   node scripts/build-demo.js --radiooooo [--max 120]  # one Radiooooo song per country
//                                         and decade not yet sampled, matched on YouTube
//   node scripts/build-demo.js --channel floorlengthskirts  # every record a YouTube channel uploaded
//   node scripts/build-demo.js --reuse    # rebuild the map from the caches only
//   add --search-budget 100 for a durable daily search-call cap (Pacific time)
//   add --retry-unmatched to reconsider legacy negative lookups
//   add --no-wait to checkpoint and stop immediately on a YouTube block
//   add --delay 8 to wait 8 s between YouTube lookups where YouTube limits searches
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
import { regionName } from '../src/mapping/cartography.js';
import { candidateMatch } from '../src/catalog/youtube.js';
import { extendRadioCache, songKey } from '../src/catalog/extend.js';
import { lookupGenresForPlays } from '../src/catalog/genres.js';
import { lookupDeezerForPlays } from '../src/catalog/deezer.js';
import { lookupYoutubeMeta, isCuratorChannel } from '../src/catalog/youtube-meta.js';
import { fetchRadioooooPlaces, spreadPlaces, sampleRadioooooPlaces, placeOf, placeKey } from '../src/catalog/radiooooo.js';
import { decodeEntities } from '../src/catalog/text.js';
import { fetchChannelUploads, uploadToPlay } from '../src/catalog/youtube-channel.js';
import { discoverCatalogueLinks } from '../src/catalog/catalogue-links.js';

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
// Seconds between YouTube lookups; raise it where YouTube limits searches.
const delayMs = argValue('delay', 1.1) * 1000;
// With a YouTube Data API key, songs are matched through the API (no bot
// checks, a daily quota) instead of YouTube's search pages.
const youtubeApiKey = process.env.YOUTUBE_API_KEY || null;

// A track's own genres (looked up per recording) and per-track tags such as
// Radiooooo's mood and decade are sound tags. The genres a station lists for a
// show describe the whole set, so they are kept as `show-genre:` context.
// Each song's own genres: Discogs genres and styles of the releases that list
// it first, then MusicBrainz. Lowercase, so the two vocabularies line up.
// Length comes from Deezer or MusicBrainz (measured recordings) before
// Discogs (listed on sleeves), then the YouTube video; tempo only from
// Deezer. Album and label come from YouTube's description of label uploads.
export function withOwnGenres(play, discogs = {}, musicbrainz = {}, deezer = {}, youtube = {}) {
  const key = songKey(play);
  const found = discogs[key];
  const mb = musicbrainz[key];
  const dz = deezer[key];
  const video = youtube[play.youtube?.videoId];
  const fromDiscogs = found ? [...(found.genres ?? []), ...(found.styles ?? [])] : [];
  const fromMb = [...(mb?.genres ?? []), ...(mb?.tags ?? [])];
  const genres = fromDiscogs.length ? fromDiscogs : fromMb.length ? fromMb : (video?.styles ?? []);
  const instruments = [...new Set([...(found?.instruments ?? []), ...(mb?.instruments ?? [])])];
  const credits = [...new Set([...(found?.credits ?? []), ...(mb?.credits ?? []), ...(video?.credits ?? [])])];
  const formats = [...new Set([...(found?.formats ?? []), ...(video?.formats ?? [])])];
  const audio = dz?.audio ?? play.audio ?? null;
  // A record the upload links names its artist and title properly ("koji nakamura" is Koji Nakamura).
  const linked = found?.source === 'link';
  return {
    ...play,
    ...(linked && found.artistName ? { artist: found.artistName } : {}),
    ...(linked && found.trackTitle ? { title: found.trackTitle } : {}),
    genres: [...new Set(genres.map((genre) => genre.toLowerCase()))],
    releaseYear: play.releaseYear ?? found?.year ?? mb?.year ?? null,
    country: play.country ?? found?.country ?? mb?.country ?? video?.country ?? null,
    length: dz?.length ?? mb?.length ?? found?.length ?? video?.length ?? null,
    bpm: dz?.bpm ?? audio?.bpm ?? null,
    ...(play.key ?? audio?.key ? { key: play.key ?? audio.key } : {}),
    ...(audio ? { audio } : {}),
    album: play.album ?? found?.album ?? video?.album ?? null,
    label: play.label ?? found?.label ?? play.labelHint ?? video?.label ?? null,
    ...(instruments.length ? { instruments } : {}),
    ...(credits.length ? { credits } : {}),
    ...(formats.length ? { formats } : {}),
    ...(video?.channel ? { channel: video.channel } : {}),
    ...(video?.views != null ? { views: video.views } : {}),
    // A compilation's styles describe the whole record, not this song.
    ...(play.compilation || found?.compilation ? { compilation: true } : {}),
  };
}

// Guano's facts (data/guano-facts.json) for the genres and artists on the
// map, which he tells while their songs play. An artist's fact lists the songs
// it was written for, and only goes on the map while those are all the songs
// under that name: a new song, or another artist called the same, gets nothing
// until someone who knows checks it.
export function factsOnMap(releases, written = {}) {
  const facts = { genres: {}, artists: {} };
  const key = (text) => String(text ?? '').normalize('NFC').toLowerCase();
  const genres = new Map(Object.entries(written.genres ?? {}).map(([tag, text]) => [key(tag), text]));
  const artists = new Map(Object.entries(written.artists ?? {}).map(([name, fact]) => [key(name), fact]));
  const own = (tag) => !/^(show|station|show-genre|mood|decade):/.test(tag);
  const songsBy = new Map();
  for (const r of releases) songsBy.set(r.artist, [...(songsBy.get(r.artist) ?? []), r.name]);
  for (const [artist, songs] of songsBy) {
    const fact = artists.get(key(artist));
    const checked = new Set((fact?.songs ?? []).map(key));
    if (fact?.text && songs.every((song) => checked.has(key(song)))) facts.artists[artist] = { text: fact.text };
  }
  for (const r of releases) {
    for (const tag of (r.tags ?? []).filter(own)) {
      if (genres.has(key(tag))) facts.genres[tag] = { text: genres.get(key(tag)) };
    }
  }
  return facts;
}

export function playToRaw(play) {
  const show = decodeEntities(play.show);
  const audio = play.audio ?? null;
  return {
    source: 'radio',
    sourceId: `${play.station}|${play.show}|${play.artist}|${play.title}`,
    title: play.title,
    artist: play.artist,
    artists: [play.artist].filter(Boolean),
    label: play.label ?? null,
    year: play.releaseYear ?? null, // Never treat broadcast date as release year.
    country: play.country ?? null,
    format: play.formats?.[0] ?? 'Radio',
    rating: null,
    ...(play.views != null ? { views: play.views } : {}),
    ...(play.position != null ? { position: play.position } : {}),
    tags: {
      genres: [
        ...(play.genres ?? []),
        ...(play.tags ?? []),
        ...(play.instruments ?? []).map((inst) => `inst:${inst.toLowerCase()}`),
        ...(play.credits ?? []).map((credit) => `credit:${credit.toLowerCase()}`),
        ...(play.formats ?? []).map((fmt) => `format:${fmt.toLowerCase()}`),
        ...(play.compilation ? ['format:compilation'] : []),
      ],
      styles: [`station:${play.station}`],
      descriptors: [
        ...(show ? [`show:${show}`] : []),
        ...(play.showGenres ?? []).slice(0, 4).map((genre) => `show-genre:${genre}`),
        ...(play.showMoods ?? []).slice(0, 3).map((mood) => `mood:${mood.toLowerCase()}`),
        ...(play.showLocation ? [`city:${play.showLocation}`] : []),
        ...(isCuratorChannel(play.channel, play.artist) ? [`channel:${play.channel}`] : []),
      ],
    },
    tracks: [{
      title: play.title,
      duration: play.length ?? null,
      bpm: play.bpm ?? null,
      key: play.key ?? audio?.key ?? null,
      album: play.album ?? null,
      ...(audio ? {
        mode: audio.mode ?? null,
        chroma: audio.chroma ?? null,
        brightness: audio.brightness ?? null,
        pulseClarity: audio.pulseClarity ?? null,
        bandEnergy: audio.bandEnergy ?? null,
        spectralFlatness: audio.spectralFlatness ?? null,
        dynamicRange: audio.dynamicRange ?? null,
      } : {}),
    }],
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
  const readCache = async (file, fallback = {}) => {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return fallback; }
  };
  const saveCache = async (file, value) => {
    await writeFile(`${file}.next`, JSON.stringify(value, null, 1));
    await rename(`${file}.next`, file);
  };
  const genresFile = join(dirname(cacheFile), 'track-genres.json');
  const linksFile = join(dirname(cacheFile), 'catalogue-links.json');
  let trackGenres = await readCache(genresFile);
  const discogs = (await readCache(join(dirname(cacheFile), 'discogs-matches.json'))).songs ?? {};
  let catalogueLinks = await readCache(linksFile);
  const extend = async (cached, options = {}) => extendRadioCache(cached, {
    delayMs, apiKey: youtubeApiKey, searchBudget: argValue('search-budget', 100),
    retryUnmatched: args.includes('--retry-unmatched'),
    ...(args.includes('--no-wait') ? { backoffs: [] } : {}),
    prepareCandidates: async (pending) => {
      console.log(`Discovering catalogue links for ${pending.length} pending songs (MusicBrainz / Discogs)…`);
      const result = await discoverCatalogueLinks(pending, {
        musicbrainz: trackGenres, discogs, cache: catalogueLinks,
        checkpoint: async ({ musicbrainz, cache }) => {
          trackGenres = musicbrainz; catalogueLinks = cache;
          await saveCache(genresFile, musicbrainz);
          await saveCache(linksFile, cache);
        },
        onProgress: ({ index, total, play, candidates }) => console.log(
          `  catalogue ${index}/${total}: ${candidates} link hints — ${play.artist} — ${play.title}`),
      });
      for (const error of result.errors) console.log(`  ! ${error.provider}: ${error.message}; using other sources and cached links.`);
      console.log(youtubeApiKey ? 'Verifying known IDs in API batches of 50; searching only leftovers…'
        : 'Verifying known links via oEmbed; searching only leftovers (no API key set)…');
      return result.plays;
    },
    onBackoff: ({ waitMs, error }) => console.log(`  YouTube refused (${error.message}); waiting ${waitMs / 60000} min before retrying…`),
    checkpoint: (cache) => saveCache(cacheFile, cache),
    onProgress: ({ index, total, play, youtube, added, pending }) => console.log(
      `  ${index}/${total} ${pending ? 'pending' : youtube?.confirmed ? `matched via ${youtube.via}` : 'no match'} (+${added}): ${play.artist} — ${play.title}`),
    ...options,
  });

  let resolved = [];
  let dropped = 0;
  let plays = [];
  let errors = [];

  if (['--reuse', '--repair', '--extend', '--radiooooo', '--genres', '--deezer', '--youtube-meta', '--channel'].some((flag) => args.includes(flag))) {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
    resolved = cached.resolved;
    dropped = cached.dropped;
    plays = cached.plays;
    console.log(`reusing cached resolution: ${resolved.length} tracks (dropped ${dropped})`);
    if (args.includes('--radiooooo')) {
      console.log('Asking Radiooooo for one song per country and decade (metadata only; no audio requests)…');
      const places = await fetchRadioooooPlaces();
      const sampled = new Set(cached.plays.map(placeOf).filter(Boolean).map(placeKey));
      console.log(`  ${places.length} countries-in-decades on Radiooooo, ${sampled.size} sampled before`);
      const { plays: incoming, error } = await sampleRadioooooPlaces(spreadPlaces(places, { skip: sampled }), {
        max: argValue('max', 120),
        onPick: ({ place, play }) => console.log(`  ${placeKey(place)}: ${play ? `${play.artist} — ${play.title}` : 'nothing new'}`),
      });
      if (error) console.log(`Stopped early: ${error.message}`);
      console.log(`Received ${incoming.length} distinct public selections. Resolving YouTube matches…`);
      const keys = new Set(cached.plays.map((p) => `${p.station}|${p.ids?.radiooooo ?? ''}|${p.artist}|${p.title}`));
      cached.plays.push(...incoming.filter((p) => !keys.has(`${p.station}|${p.ids?.radiooooo ?? ''}|${p.artist}|${p.title}`)));
      plays = cached.plays;
    }
    if (args.includes('--channel')) {
      // A record channel's uploads are its own videos: they join the map as they are.
      const handle = String(args[args.indexOf('--channel') + 1] ?? '').replace(/^@/, '');
      const station = RADIO_STATIONS.find((s) => s.kind === 'youtube' && s.handle === handle);
      if (!station) throw new Error(`Add @${handle} to RADIO_STATIONS in src/catalog/radio.js (kind 'youtube') first`);
      console.log(`Listing every upload of @${handle} with the YouTube Data API…`);
      const { videos } = await fetchChannelUploads({ handle, apiKey: youtubeApiKey });
      const checkedAt = new Date().toISOString();
      const known = new Set(cached.resolved.map((p) => p.youtube?.videoId));
      const uploads = videos.map((video) => uploadToPlay(video, station, checkedAt));
      const fresh = uploads.filter((p) => !known.has(p.youtube.videoId));
      // Uploads already on the map learn which of them link a compilation.
      const compilations = new Set(uploads.filter((p) => p.compilation).map((p) => p.youtube.videoId));
      for (const play of [...cached.plays, ...cached.resolved]) {
        if (play.youtube?.via === 'channel' && compilations.has(play.youtube.videoId)) play.compilation = true;
      }
      cached.plays.push(...fresh);
      cached.resolved.push(...fresh);
      cached.attemptedKeys = [...new Set([...(cached.attemptedKeys ?? []), ...fresh.map(songKey)])];
      await saveCache(cacheFile, cached);
      ({ resolved, plays } = cached);
      const linked = fresh.filter((p) => p.ids.discogsRelease || p.ids.discogsMaster).length;
      console.log(`  ${videos.length} playable uploads; added ${fresh.length} new songs, ${linked} of them linking their Discogs record.`);
      if (linked) console.log('  Run npm run catalog:discogs -- <releases dump> to read those records.');
    }
    if (args.includes('--extend') || args.includes('--radiooooo')) {
      const result = await extend(cached, {
        // Every new Radiooooo pick is looked up: --max already capped the sample.
        limit: args.includes('--radiooooo') ? Infinity : argValue('max', 160),
        stations: args.includes('--radiooooo') ? ['radiooooo'] : null,
      });
      resolved = result.cache.resolved;
      dropped = result.cache.dropped;
      console.log(`Added ${result.added} verified matches from ${result.attempted} new lookups; kept existing tracks.`);
      const usage = result.cache.youtubeSearchUsage;
      if (usage.day) console.log(`Search calls saved for ${usage.day} (Pacific): API ${usage.api ?? 0}, web ${usage.web ?? 0}.`);
      if (result.stopped) console.log(`Pending: ${result.stopped.message}. Run again later to continue.`);
    }
    if (args.includes('--repair')) {
      const sample = [...resolved, ...interleavePlays(plays, maxTracks)].filter((p, i, all) =>
        all.findIndex((other) => other.station === p.station && other.artist === p.artist && other.title === p.title) === i);
      const result = await resolvePlaysToYoutube(sample, { delayMs, apiKey: youtubeApiKey, onProgress: ({ index, total, play, youtube }) =>
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

    const result = await extend({ plays: mixed, resolved: [], dropped: 0 }, {
      limit: maxTracks, checkpoint: (cache) => saveCache(cacheFile, { ...cache, plays }),
    });
    ({ resolved, dropped } = result.cache);
    if (result.stopped) console.log(`Pending: ${result.stopped.message}. Run catalog:extend later to continue.`);
    console.log(`  resolved ${resolved.length}, dropped ${dropped} (no valid YouTube link)`);
    console.log(`  cached to ${cacheFile}`);
  }

  // Reject stale/unverified or unrelated cached candidates too.
  // A channel's own upload is its song by definition; searched matches must agree with their song.
  resolved = resolved.filter((p) => p.youtube?.confirmed === true && (p.youtube.via === 'channel' || candidateMatch(p, p.youtube).acceptable));
  if (!resolved.length) throw new Error('No verified matches. Run build-demo with --repair to refresh the cache.');
  // Per-track genres live in their own cache so lookups survive rebuilds.
  if (args.includes('--genres')) {
    console.log('Looking up per-track genres on MusicBrainz (about one request per second)…');
    const result = await lookupGenresForPlays([...resolved, ...plays], {
      cache: trackGenres, includeVideoLinks: true,
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
  const deezerFile = join(dirname(cacheFile), 'deezer-tracks.json');
  let deezer = {};
  try { deezer = JSON.parse(await readFile(deezerFile, 'utf8')); } catch { /* none looked up yet */ }
  if (args.includes('--deezer')) {
    console.log('Looking up tempo and length on Deezer…');
    const result = await lookupDeezerForPlays(resolved, {
      cache: deezer,
      checkpoint: async (cache) => {
        await writeFile(`${deezerFile}.next`, JSON.stringify(cache, null, 1));
        await rename(`${deezerFile}.next`, deezerFile);
      },
      onProgress: ({ index, total, play, bpm, length }) => console.log(
        `  ${index}/${total} ${bpm ? `${bpm} BPM` : 'no tempo'}${length ? `, ${length}s` : ''}: ${play.artist} — ${play.title}`),
    });
    deezer = result.cache;
    if (result.error) console.log(`Stopped after ${result.done}/${result.total}: ${result.error.message}. Run again to continue.`);
  }
  const youtubeFile = join(dirname(cacheFile), 'youtube-meta.json');
  let youtubeMeta = {};
  try { youtubeMeta = JSON.parse(await readFile(youtubeFile, 'utf8')); } catch { /* none read yet */ }
  let guanoFacts = {};
  try { guanoFacts = JSON.parse(await readFile(join(dirname(cacheFile), 'guano-facts.json'), 'utf8')); } catch { /* none written yet */ }
  if (args.includes('--youtube-meta')) {
    const apiKey = process.env.YOUTUBE_API_KEY || null;
    const pageDelayMs = args.includes('--delay') ? delayMs : 15000;
    console.log(apiKey ? 'Reading video details from the YouTube Data API…'
      : `Reading YouTube watch pages (no YOUTUBE_API_KEY set), one every ${pageDelayMs / 1000} s…`);
    const byVideo = new Map(resolved.map((play) => [play.youtube.videoId, play]));
    const result = await lookupYoutubeMeta([...byVideo.keys()], {
      cache: youtubeMeta,
      apiKey,
      delayMs: pageDelayMs,
      checkpoint: async (cache) => {
        await writeFile(`${youtubeFile}.next`, JSON.stringify(cache, null, 1));
        await rename(`${youtubeFile}.next`, youtubeFile);
      },
      onBackoff: ({ error, waitMs }) => console.log(`  ${error.message}; waiting ${waitMs / 60000} min`),
      onProgress: ({ index, total, videoId, length, album, found }) => {
        const play = byVideo.get(videoId);
        console.log(`  ${index}/${total} ${found ? `${length ?? '?'}s${album ? `, from ${album}` : ''}` : 'video not found'}: ${play.artist} — ${play.title}`);
      },
    });
    youtubeMeta = result.cache;
    if (result.error) console.log(`Stopped after ${result.done}/${result.total}: ${result.error.message}. Run again to continue.`);
  }
  const withGenres = resolved.map((play) => withOwnGenres(play, discogs, trackGenres, deezer, youtubeMeta));
  console.log(`  ${withGenres.filter((p) => p.album).length}/${withGenres.length} tracks name their album`);
  console.log(`  ${withGenres.filter((p) => p.length).length}/${withGenres.length} tracks have a length, ${withGenres.filter((p) => p.bpm).length} a tempo`);
  const fromDiscogs = resolved.filter((play) => discogs[songKey(play)]?.styles.length || discogs[songKey(play)]?.genres.length).length;
  console.log(`  ${withGenres.filter((p) => p.genres.length).length}/${withGenres.length} tracks have their own genres (${fromDiscogs} from Discogs)`);
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
  const islands = engine.islands.map((island) => ({
    ...island,
    name: island.basis === 'station' ? RADIO_STATIONS.find((s) => s.id === island.name)?.label ?? island.name : island.name,
  }));

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
    islands,
    regions: engine.regions.map((region) => ({
      ...region,
      name: regionName(region.islandIds.map((id) => islands.find((island) => island.id === id).name)),
    })),
    releases: releases.map((release) => {
      const placement = engine.mapPlacement(release.id);
      const coord3d = engine.topology?.coordinates?.find((c) => c.id === release.id);
      return {
        id: release.id,
        name: release.name,
        artist: release.artist,
        year: release.year,
        country: release.country,
        length: release.tracks?.[0]?.duration ?? null,
        album: release.tracks?.[0]?.album ?? null,
        label: release.label ?? null,
        bpm: release.tracks?.[0]?.bpm ?? null,
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
        tx: coord3d?.tx ?? placement.x,
        ty: coord3d?.ty ?? placement.y,
        tz: coord3d?.tz ?? 0,
        neighbours: neighbours.get(release.id),
      };
    }),
    tradeRoutes,
    facts: {},
    topology: {
      cycles: engine.cycles(),
      bridges: engine.bridges().slice(0, 30),
      mapper: engine.topology?.mapper ?? { nodes: [], edges: [], triangles: [], bridges: [] },
    },
  };

  for (const r of payload.releases) {
    if (!r.station || !r.youtubeId || !r.sourceUrl) throw new Error(`Incomplete demo track: ${r.id}`);
  }
  payload.facts = factsOnMap(payload.releases, guanoFacts);
  console.log(`  Guano's facts for ${Object.keys(payload.facts.genres).length} genres and ${Object.keys(payload.facts.artists).length} artists`);
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
