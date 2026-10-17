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
import { candidateMatch, youtubeIdFromUrl } from './youtube.js';

const MAX_GENRES = 3;
const MAX_STYLES = 5;
const MAX_FORMATS = 3;
const MAX_INSTRUMENTS = 5;
const MAX_CREDITS = 3;
const VARIOUS = 'various';
const PLACEHOLDER_ARTISTS = new Set([VARIOUS, 'unknown artist', 'unknown', 'anonymous', 'no artist']);
const PLACEHOLDER_LABELS = new Set(['not on label', 'none', 'unknown', 'unknown label', 'no label', '-']);

const INSTRUMENT_PATTERNS = [
  ['fender rhodes', /\brhodes\b/i],
  ['wurlitzer', /\bwurlitzer\b/i],
  ['clavinet', /\bclavinet\b/i],
  ['harpsichord', /\bharpsichord\b/i],
  ['electric piano', /\belectric piano\b/i],
  ['piano', /\bpiano\b/i],
  ['organ', /\b(?:organ|hammond|farfisa|vox continental)\b/i],
  ['synthesizer', /\b(?:synth|synthesizer|moog|minimoog|arp|juno|jupiter|prophet|dx7|oberheim|mellotron)\b/i],
  ['vibraphone', /\b(?:vibraphone|vibes)\b/i],
  ['marimba', /\b(?:marimba|xylophone|balafon)\b/i],
  ['kalimba', /\b(?:kalimba|mbira|sanza)\b/i],
  ['saxophone', /\b(?:sax|saxophone)\b/i],
  ['flute', /\bflute\b/i],
  ['trumpet', /\b(?:trumpet|cornet|flugelhorn)\b/i],
  ['trombone', /\btrombone\b/i],
  ['clarinet', /\b(?:clarinet|oboe|bassoon)\b/i],
  ['harmonica', /\bharmonica\b/i],
  ['violin', /\b(?:violin|fiddle)\b/i],
  ['cello', /\bcello\b/i],
  ['strings', /\bstrings\b/i],
  ['harp', /\bharp\b/i],
  ['kora', /\b(?:kora|ngoni)\b/i],
  ['sitar', /\b(?:sitar|oud|bouzouki|tanpura)\b/i],
  ['steel drums', /\bsteel\s*(?:drum|pan)s?\b/i],
  ['double bass', /\b(?:double bass|upright bass|contrabass|acoustic bass)\b/i],
  ['bass guitar', /\b(?:bass guitar|electric bass|fretless bass)\b/i],
  ['congas', /\bcongas?\b/i],
  ['bongos', /\bbongos?\b/i],
  ['talking drum', /\btalking drum\b/i],
  ['tabla', /\btabla\b/i],
  ['drum machine', /\b(?:drum machine|drum programming|rhythm machine|tr-?808|tr-?909|linndrum|mpc|sp-?1200)\b/i],
  ['turntables', /\b(?:turntables|scratching|dj mix)\b/i],
  ['percussion', /\b(?:percussion|timbales|shaker|tambourine|cowbell|agogo|berimbau|cuica|djembe|guiro)\b/i],
  ['drums', /\bdrums\b/i],
  ['guitar', /\b(?:guitar|12-string|pedal steel|banjo|mandolin)\b/i],
  ['vocals', /\b(?:vocals?|lead vocals?|backing vocals?|voice|choir|chant)\b/i],
];

const CREDIT_ROLE_PATTERN = /\b(?:producer|co-producer|produced by|remix|remixed by|mixed by|arranged by|arranger|conductor)\b/i;

const FORMAT_MAP = new Map([
  ['12"', '12"'],
  ['7"', '7"'],
  ['10"', '10"'],
  ['lp', 'lp'],
  ['45 rpm', '45 rpm'],
  ['33 ⅓ rpm', '33 rpm'],
  ['33 1/3 rpm', '33 rpm'],
  ['78 rpm', '78 rpm'],
  ['cassette', 'cassette'],
  ['reel-to-reel', 'reel-to-reel'],
  ['shellac', 'shellac'],
  ['flexi-disc', 'flexi-disc'],
  ['white label', 'white label'],
  ['test pressing', 'test pressing'],
  ['promo', 'promo'],
  ['acetate', 'acetate'],
]);

const first = (text, pattern) => text.match(pattern)?.[1] ?? null;
const every = (text, pattern) => [...text.matchAll(pattern)].map((m) => decodeEntities(m[1]));

function cleanDisambiguation(name) {
  return String(name ?? '').replace(/\s+\(\d+\)$/, '').trim();
}

function credits(block) {
  if (!block) return [];
  return block.split('<artist>').slice(1).map((part) => ({
    id: Number(first(part, /<id>(\d+)<\/id>/)),
    names: [first(part, /<name>([^<]*)<\/name>/), first(part, /<anv>([^<]+)<\/anv>/)].filter(Boolean).map(decodeEntities),
  }));
}

/** Extract instruments and key production/arrangement credits from an `<extraartists>` block. */
export function parseExtraArtists(block) {
  if (!block) return { instruments: [], credits: [] };
  const instruments = new Set();
  const creditNames = new Set();
  for (const part of block.split('<artist>').slice(1)) {
    const role = decodeEntities(first(part, /<role>([^<]*)<\/role>/) ?? '');
    if (!role) continue;
    const rawName = decodeEntities(first(part, /<name>([^<]*)<\/name>/) ?? first(part, /<anv>([^<]+)<\/anv>/) ?? '');
    const name = cleanDisambiguation(rawName);
    for (const [label, pattern] of INSTRUMENT_PATTERNS) {
      if (pattern.test(role)) instruments.add(label);
    }
    if (name && !PLACEHOLDER_ARTISTS.has(name.toLowerCase()) && CREDIT_ROLE_PATTERN.test(role)) {
      creditNames.add(name);
    }
  }
  return { instruments: [...instruments], credits: [...creditNames] };
}

function parseLabels(head) {
  const block = first(head, /<labels>([\s\S]*?)<\/labels>/);
  if (!block) return [];
  const out = [];
  for (const raw of every(block, /<label\b[^>]*?\bname="([^"]+)"/g)) {
    const clean = cleanDisambiguation(raw);
    const lower = clean.toLowerCase();
    if (clean && !PLACEHOLDER_LABELS.has(lower) && !lower.startsWith('not on label') && !out.includes(clean)) {
      out.push(clean);
    }
  }
  return out;
}

function parseFormats(head) {
  const block = first(head, /<formats>([\s\S]*?)<\/formats>/);
  if (!block) return [];
  const rawTokens = [
    ...every(block, /<format\b[^>]*?\bname="([^"]+)"/g),
    ...every(block, /<description>([^<]+)<\/description>/g),
  ];
  const out = [];
  for (const token of rawTokens) {
    const mapped = FORMAT_MAP.get(token.trim().toLowerCase());
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
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
  const master = xml.match(/<master_id is_main_release="(true|false)">(\d+)<\/master_id>/);
  const year = Number(first(xml, /<released>(\d{4})/));
  const rawCountry = decodeEntities(first(head, /<country>([^<]+)<\/country>/) ?? '').trim();
  const country = rawCountry && rawCountry.toLowerCase() !== 'unknown' ? rawCountry : null;
  const extra = parseExtraArtists(first(head, /<extraartists>([\s\S]*?)<\/extraartists>/));
  const videos = [...xml.matchAll(/<video\b[^>]*\bsrc="([^"]+)"[^>]*>([\s\S]*?)<\/video>/g)]
    .map((m) => ({ url: decodeEntities(m[1]), title: decodeEntities(first(m[2], /<title>([^<]*)<\/title>/) ?? '') }))
    .map((video) => ({ ...video, videoId: youtubeIdFromUrl(video.url) })).filter((video) => video.videoId);
  return {
    id: Number(first(xml, /<release id="(\d+)"/)),
    artists: credits(first(head, /<artists>([\s\S]*?)<\/artists>/)),
    title: decodeEntities(first(head, /<title>([^<]*)<\/title>/) ?? ''),
    genres: every(xml, /<genre>([^<]*)<\/genre>/g),
    styles: every(xml, /<style>([^<]*)<\/style>/g),
    year: year >= 1900 ? year : null,
    country,
    labels: parseLabels(head),
    formats: parseFormats(head),
    instruments: extra.instruments,
    credits: extra.credits,
    masterId: master ? Number(master[2]) : null,
    mainRelease: master?.[1] === 'true',
    // Index tracks nest sub-tracks, so split at each opening tag instead of pairing tags.
    tracks: tracklist.split('<track>').slice(1).map((part) => {
      const trackExtra = parseExtraArtists(first(part, /<extraartists>([\s\S]*?)<\/extraartists>/));
      return {
        title: decodeEntities(first(part, /<title>([^<]*)<\/title>/) ?? ''),
        length: seconds(first(part, /<duration>([^<]*)<\/duration>/)),
        artists: credits(first(part, /<artists>([\s\S]*?)<\/artists>/)),
        instruments: trackExtra.instruments,
        credits: trackExtra.credits,
      };
    }),
    videos,
    videoIds: videos.map((video) => video.videoId),
  };
}

/** "4:45" or "1:02:03" -> seconds; anything else -> null. */
export function seconds(duration) {
  if (!/^\d{1,3}(:\d{2}){1,2}$/.test(duration ?? '')) return null;
  return duration.split(':').reduce((total, part) => total * 60 + Number(part), 0) || null;
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
  const byRelease = new Map(); // Discogs release or master linked to the song (a channel's upload says which record it is)
  const byMaster = new Map();
  const tallies = new Map(); // primary artist key -> Discogs artist id -> styles of their releases
  const link = (map, id, key) => { if (id) map.set(Number(id), (map.get(Number(id)) ?? new Set()).add(key)); };

  for (const play of plays) {
    const key = songKey(play);
    if (songs.has(key)) continue;
    // "T.I., Chris Brown" credits both; "The Brothers & Sisters" is one name.
    const parts = String(play.artist).split(/,\s+|\s+(?:feat\.?|ft\.?|featuring)\s+/i);
    const primary = artistKey(parts[0]);
    const names = new Set([play.artist, ...parts].map(artistKey).filter((name) => name && !PLACEHOLDER_ARTISTS.has(name)));
    songs.set(key, { play, videos: new Map(), titles: titleKeys(play.title), primary, names, groups: new Map(), artistIds: new Set() });
    for (const name of names) {
      if (!byArtist.has(name)) byArtist.set(name, new Set());
      byArtist.get(name).add(key);
    }
    if (play.youtube?.videoId) byVideo.set(play.youtube.videoId, key);
    link(byRelease, play.ids?.discogsRelease, key);
    link(byMaster, play.ids?.discogsMaster, key);
    if (names.has(primary)) tallies.set(primary, tallies.get(primary) ?? new Map());
  }

  const keyed = (list) => list.flatMap((credit) => credit.names.map((name) => ({ id: credit.id, key: artistKey(name) })));

  return {
    wants(xml) {
      if (byRelease.has(Number(first(xml, /<release id="(\d+)"/)))) return true;
      if (byMaster.size && byMaster.has(Number(first(xml, /<master_id[^>]*>(\d+)<\/master_id>/)))) return true;
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
            // Keep video hints from track-matched releases, not artist-only
            // guesses. The actual YouTube title/channel are verified later.
            for (const video of release.videos ?? []) {
              if (song.videos.size >= 10 || !candidateMatch(song.play, { title: video.title, channel: song.play.artist }).acceptable) continue;
              if (!song.videos.has(video.videoId)) song.videos.set(video.videoId, { ...video,
                source: 'discogs', sourceUrl: `https://www.discogs.com/release/${release.id}` });
            }
            // A compilation's year, label, country and format are not the song's.
            const own = releaseArtists.some((artist) => artist.key === key);
            if (!song.groups.has(group)) {
              song.groups.set(group, {
                ...found,
                own,
                year: own ? release.year : null,
                country: own ? (release.country ?? null) : null,
                labels: own ? (release.labels ?? []) : [],
                formats: own ? (release.formats ?? []) : [],
                instruments: [...new Set([...(own ? (release.instruments ?? []) : []), ...(track.instruments ?? [])])],
                credits: [...new Set([...(own ? (release.credits ?? []) : []), ...(track.credits ?? [])])],
                length: track.length,
                via: 'track',
              });
            }
          }
        }
      }

      // The record a song's upload links: trusted as its own release. Its
      // tracklist confirms the track, and spells its artist and title.
      const linked = new Set([...(byRelease.get(release.id) ?? []), ...(release.masterId ? byMaster.get(release.masterId) ?? [] : [])]);
      for (const songId of linked) {
        const song = songs.get(songId);
        const track = release.tracks.find((t) => [...song.titles].some((title) => titleKeys(t.title).has(title)));
        const names = (track?.artists.length ? track.artists : release.artists).map((a) => cleanDisambiguation(a.names[0]));
        song.groups.set(`link${release.id}`, {
          ...found,
          own: true,
          via: 'link',
          main: release.mainRelease || byRelease.get(release.id)?.has(songId) || false,
          compilation: releaseArtists.some((artist) => artist.key === VARIOUS),
          year: release.year,
          country: release.country ?? null,
          labels: release.labels ?? [],
          formats: release.formats ?? [],
          instruments: [...new Set([...(release.instruments ?? []), ...(track?.instruments ?? [])])],
          credits: [...new Set([...(release.credits ?? []), ...(track?.credits ?? [])])],
          length: track?.length ?? null,
          album: release.title || null,
          ...(track ? { artist: names.filter((name) => artistKey(name) !== VARIOUS).join(', ') || null, title: track.title } : {}),
        });
      }

      for (const videoId of release.videoIds) {
        const song = songs.get(byVideo.get(videoId));
        const own = Boolean(song) && releaseArtists.some((artist) => song.names.has(artist.key));
        if (song && !song.groups.has(group)) {
          song.groups.set(group, {
            ...found,
            own,
            country: own ? (release.country ?? null) : null,
            labels: own ? (release.labels ?? []) : [],
            formats: own ? (release.formats ?? []) : [],
            instruments: own ? (release.instruments ?? []) : [],
            credits: own ? (release.credits ?? []) : [],
            via: 'video',
          });
        }
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
        const linked = matched.filter((group) => group.via === 'link');
        const groups = linked.length ? linked : matched.some((group) => group.own) ? matched.filter((group) => group.own) : matched;
        // For a linked master, the main release names the record; else the earliest.
        const record = linked.length ? [...linked].sort((a, b) => (b.main - a.main) || ((a.year ?? 9999) - (b.year ?? 9999)))[0] : null;
        if (groups.length) {
          const styles = new Map(), genres = new Map(), labels = new Map(), countries = new Map();
          const formats = new Map(), instruments = new Map(), creditNames = new Map();
          for (const group of groups) {
            count(styles, group.styles);
            count(genres, group.genres);
            count(labels, group.labels ?? []);
            if (group.country) count(countries, [group.country]);
            count(formats, group.formats ?? []);
            count(instruments, group.instruments ?? []);
            count(creditNames, group.credits ?? []);
          }
          const years = groups.map((group) => group.year).filter(Boolean);
          const lengths = groups.map((group) => group.length).filter(Boolean).sort((a, b) => a - b);
          const topLabel = top(labels, 1)[0] ?? null;
          const topCountry = top(countries, 1)[0] ?? null;
          const topFormats = top(formats, MAX_FORMATS);
          const topInstruments = top(instruments, MAX_INSTRUMENTS);
          const topCredits = top(creditNames, MAX_CREDITS);
          out[key] = {
            genres: top(genres, MAX_GENRES),
            styles: top(styles, MAX_STYLES),
            year: years.length ? Math.min(...years) : null,
            // The middle of the listed lengths: edits and extended mixes pull both ways.
            length: lengths.length ? lengths[Math.floor((lengths.length - 1) / 2)] : null,
            ...(topLabel ? { label: topLabel } : {}),
            ...(topCountry ? { country: topCountry } : {}),
            ...(topFormats.length ? { formats: topFormats } : {}),
            ...(topInstruments.length ? { instruments: topInstruments } : {}),
            ...(topCredits.length ? { credits: topCredits } : {}),
            ...(record?.album ? { album: record.album } : {}),
            ...(record?.labels?.length ? { label: record.labels[0] } : {}),
            ...(record?.title ? { artistName: linked.find((g) => g.artist)?.artist ?? null, trackTitle: record.title } : {}),
            source: linked.length ? 'link' : groups.some((group) => group.via === 'track') ? 'track' : 'video',
            // Only compilations list it: their styles describe the whole record.
            ...((record ? record.compilation : !groups.some((group) => group.own)) ? { compilation: true } : {}),
            releases: groups.map((group) => group.releaseId).slice(0, 5),
            ...(song.videos.size ? { youtubeCandidates: [...song.videos.values()] } : {}),
          };
          continue;
        }
        const byId = tallies.get(song.primary) ?? new Map();
        const ids = [...byId.keys()];
        const known = ids.filter((id) => confirmed.get(song.primary)?.has(id));
        const id = ids.length === 1 ? ids[0] : known.length === 1 ? known[0] : null;
        const tally = id == null ? null : byId.get(id);
        out[key] = tally
          ? { genres: top(tally.genres, MAX_GENRES), styles: top(tally.styles, MAX_STYLES), year: null, length: null, source: 'artist', releases: [] }
          : { genres: [], styles: [], year: null, length: null, source: null, releases: [] };
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
