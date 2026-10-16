// Discogs data dump import.
//
// Discogs publishes its whole catalogue every month as free, reusable XML
// dumps (CC0, https://data.discogs.com/). This reads the releases dump as a
// stream (gzip or plain XML, from a file or a pipe) without storing it, and
// keeps only what our songs need:
//
//   track match   a release by the song's artist lists the song
//   video match   a release lists the exact YouTube video we play
//   artist match  no release lists the song: the artist's most common styles,
//                 but only when the artist name is not shared by several
//                 Discogs artists (Death the proto-punk band vs Death (2))
//
// Reissues of one album share a Discogs "master", so each master counts once.
// The artist's own releases outrank compilations the song appears on, whose
// styles describe the whole compilation. Placeholder artists ("Unknown
// Artist") are never matched: their thousands of "Untitled" tracks say nothing.

import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { songKey } from './extend.js';
import { canonicalArtist, canonicalTitle, decodeEntities } from './text.js';

const MAX_GENRES = 2;
const MAX_STYLES = 3;
const VARIOUS = 'various';
const PLACEHOLDER_ARTISTS = new Set([VARIOUS, 'unknown artist', 'unknown', 'anonymous', 'no artist']);

const first = (text, pattern) => text.match(pattern)?.[1] ?? null;
const every = (text, pattern) => [...text.matchAll(pattern)].map((m) => decodeEntities(m[1]));

function credits(block) {
  if (!block) return [];
  return block.split('<artist>').slice(1).map((part) => ({
    id: Number(first(part, /<id>(\d+)<\/id>/)),
    names: [first(part, /<name>([^<]*)<\/name>/), first(part, /<anv>([^<]+)<\/anv>/)].filter(Boolean).map(decodeEntities),
  }));
}

/** Discogs disambiguates shared names as "Death (2)"; compare the plain name. */
export function artistKey(name) {
  return canonicalArtist(String(name).replace(/\s+\(\d+\)$/, ''));
}

/** "Mr. Me Too (Instrumental)" also matches plain "Mr. Me Too". */
export function titleKeys(title) {
  const keys = [canonicalTitle(title), canonicalTitle(String(title).replace(/\([^)]*\)/g, ' '))];
  return new Set(keys.filter((key) => key.length > 1));
}

/** Fields of one `<release>…</release>` element that matching needs. */
export function parseDumpRelease(xml) {
  const tracklistAt = xml.indexOf('<tracklist>');
  const head = tracklistAt >= 0 ? xml.slice(0, tracklistAt) : xml;
  const tracklist = tracklistAt >= 0 ? xml.slice(tracklistAt, xml.indexOf('</tracklist>', tracklistAt)) : '';
  const master = xml.match(/<master_id is_main_release="(?:true|false)">(\d+)<\/master_id>/);
  const year = Number(first(xml, /<released>(\d{4})/));
  return {
    id: Number(first(xml, /<release id="(\d+)"/)),
    artists: credits(first(head, /<artists>([\s\S]*?)<\/artists>/)),
    title: decodeEntities(first(head, /<title>([^<]*)<\/title>/) ?? ''),
    genres: every(xml, /<genre>([^<]*)<\/genre>/g),
    styles: every(xml, /<style>([^<]*)<\/style>/g),
    year: year >= 1900 ? year : null,
    masterId: master ? Number(master[1]) : null,
    // Index tracks nest sub-tracks, so split at each opening tag instead of pairing tags.
    tracks: tracklist.split('<track>').slice(1).map((part) => ({
      title: decodeEntities(first(part, /<title>([^<]*)<\/title>/) ?? ''),
      artists: credits(first(part, /<artists>([\s\S]*?)<\/artists>/)),
    })),
    videoIds: [...xml.matchAll(/<video src="[^"]*?(?:[?&]v=|youtu\.be\/)([\w-]{11})/g)].map((m) => m[1]),
  };
}

function count(tally, names) {
  for (const name of names) tally.set(name, (tally.get(name) ?? 0) + 1);
}

function top(tally, limit) {
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([name]) => name);
}

/**
 * Collects Discogs evidence for a set of radio plays. Feed it releases with
 * `wants(xml)` (a cheap pre-check) and `add(parseDumpRelease(xml))`; then
 * `results()` gives { [songKey]: { genres, styles, year, source, releases } }.
 */
export function createDiscogsMatcher(plays) {
  const songs = new Map();
  const byArtist = new Map();
  const byVideo = new Map();
  const tallies = new Map(); // primary artist key -> Discogs artist id -> styles of their releases

  for (const play of plays) {
    const key = songKey(play);
    if (songs.has(key)) continue;
    // "T.I., Chris Brown" credits both; "The Brothers & Sisters" is one name.
    const parts = String(play.artist).split(/,\s+|\s+(?:feat\.?|ft\.?|featuring)\s+/i);
    const primary = artistKey(parts[0]);
    const names = new Set([play.artist, ...parts].map(artistKey).filter((name) => name && !PLACEHOLDER_ARTISTS.has(name)));
    songs.set(key, { titles: titleKeys(play.title), primary, names, groups: new Map(), artistIds: new Set() });
    for (const name of names) {
      if (!byArtist.has(name)) byArtist.set(name, new Set());
      byArtist.get(name).add(key);
    }
    if (play.youtube?.videoId) byVideo.set(play.youtube.videoId, key);
    if (names.has(primary)) tallies.set(primary, tallies.get(primary) ?? new Map());
  }

  const keyed = (list) => list.flatMap((credit) => credit.names.map((name) => ({ id: credit.id, key: artistKey(name) })));

  return {
    wants(xml) {
      const head = xml.slice(0, xml.indexOf('</artists>') + 10);
      if (keyed(credits(first(head, /<artists>([\s\S]*?)<\/artists>/))).some(({ key }) => key === VARIOUS || byArtist.has(key))) return true;
      return xml.includes('<videos>') && parseDumpRelease(xml).videoIds.some((id) => byVideo.has(id));
    },

    add(release) {
      const group = release.masterId ? `m${release.masterId}` : `r${release.id}`;
      const found = { genres: release.genres, styles: release.styles, year: release.year, releaseId: release.id };
      const releaseArtists = keyed(release.artists);

      for (const { id, key } of releaseArtists) {
        const byId = tallies.get(key);
        if (!byId) continue;
        if (!byId.has(id)) byId.set(id, { groups: new Set(), styles: new Map(), genres: new Map() });
        const tally = byId.get(id);
        if (tally.groups.has(group)) continue;
        tally.groups.add(group); count(tally.styles, release.styles); count(tally.genres, release.genres);
      }

      for (const track of release.tracks) {
        let titles = null;
        for (const { id, key } of track.artists.length ? keyed(track.artists) : releaseArtists) {
          for (const songId of byArtist.get(key) ?? []) {
            const song = songs.get(songId);
            titles ??= titleKeys(track.title);
            if (![...song.titles].some((title) => titles.has(title))) continue;
            if (key === song.primary) song.artistIds.add(id);
            // A compilation's year is not the song's.
            const own = releaseArtists.some((artist) => artist.key === key);
            if (!song.groups.has(group)) song.groups.set(group, { ...found, own, year: own ? release.year : null, via: 'track' });
          }
        }
      }

      for (const videoId of release.videoIds) {
        const song = songs.get(byVideo.get(videoId));
        const own = Boolean(song) && releaseArtists.some((artist) => song.names.has(artist.key));
        if (song && !song.groups.has(group)) song.groups.set(group, { ...found, own, via: 'video' });
      }
    },

    results() {
      const confirmed = new Map(); // primary artist key -> Discogs ids seen on matched tracks
      for (const song of songs.values()) {
        for (const id of song.artistIds) confirmed.set(song.primary, (confirmed.get(song.primary) ?? new Set()).add(id));
      }
      const out = {};
      for (const [key, song] of songs) {
        const matched = [...song.groups.values()];
        const groups = matched.some((group) => group.own) ? matched.filter((group) => group.own) : matched;
        if (groups.length) {
          const styles = new Map(), genres = new Map();
          for (const group of groups) { count(styles, group.styles); count(genres, group.genres); }
          const years = groups.map((group) => group.year).filter(Boolean);
          out[key] = { genres: top(genres, MAX_GENRES), styles: top(styles, MAX_STYLES),
            year: years.length ? Math.min(...years) : null,
            source: groups.some((group) => group.via === 'track') ? 'track' : 'video',
            releases: groups.map((group) => group.releaseId).slice(0, 5) };
          continue;
        }
        const byId = tallies.get(song.primary) ?? new Map();
        const ids = [...byId.keys()];
        const known = ids.filter((id) => confirmed.get(song.primary)?.has(id));
        const id = ids.length === 1 ? ids[0] : known.length === 1 ? known[0] : null;
        const tally = id == null ? null : byId.get(id);
        out[key] = tally
          ? { genres: top(tally.genres, MAX_GENRES), styles: top(tally.styles, MAX_STYLES), year: null, source: 'artist', releases: [] }
          : { genres: [], styles: [], year: null, source: null, releases: [] };
      }
      return out;
    },
  };
}

async function* bytesOf(head, iterator) {
  try {
    yield head;
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) yield next.value;
  } finally {
    await iterator.return?.();
  }
}

/** Text of a dump stream, gunzipped when it starts with the gzip magic bytes. */
export async function* dumpText(input) {
  const iterator = input[Symbol.asyncIterator]();
  const head = await iterator.next();
  if (head.done) return;
  const bytes = Readable.from(bytesOf(head.value, iterator), { objectMode: false });
  const source = head.value[0] === 0x1f && head.value[1] === 0x8b ? bytes.pipe(createGunzip()) : bytes;
  const decoder = new TextDecoder();
  for await (const chunk of source) yield decoder.decode(chunk, { stream: true });
  yield decoder.decode();
}

/** Stream every release of a dump through the matcher. */
export async function scanDiscogsDump(input, matcher, { limit = Infinity, onProgress = () => {}, progressEvery = 250000 } = {}) {
  let buffer = '';
  let scanned = 0;
  for await (const text of dumpText(input)) {
    buffer += text;
    let from = 0;
    let end;
    while ((end = buffer.indexOf('</release>', from)) >= 0) {
      const start = buffer.lastIndexOf('<release ', end);
      if (start >= from) {
        const xml = buffer.slice(start, end + 10);
        if (matcher.wants(xml)) matcher.add(parseDumpRelease(xml));
        scanned += 1;
        if (scanned % progressEvery === 0) onProgress({ scanned });
        if (scanned >= limit) return { scanned };
      }
      from = end + 10;
    }
    buffer = buffer.slice(from);
  }
  return { scanned };
}
