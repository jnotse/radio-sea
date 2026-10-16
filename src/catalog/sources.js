// Catalog source adapters. Each parser maps one source format into RawRelease:
//
//   {
//     source, sourceId, title, artist, artists[], label, year, country, format,
//     tags: { genres[], styles[], descriptors[] },
//     tracks: [{ title, duration, bpm, key }],
//     urls: {}
//   }
//
// Discogs and RateYourMusic arrive as CSV exports (both sites let users export
// their collections); YouTube arrives as JSON (Data API-ish); MusicBrainz is
// fetched live (keyless public API).

import { normalizeText } from './text.js';

// --- tiny CSV parser (handles quoted fields) -------------------------------

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

function headerIndex(header) {
  const map = new Map();
  header.forEach((name, i) => map.set(normalizeText(name), i));
  return (names) => {
    for (const name of names) {
      const i = map.get(normalizeText(name));
      if (i != null) return i;
    }
    return -1;
  };
}

function splitList(value) {
  return String(value ?? '')
    .split(/[,;/|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function yearOf(value) {
  const match = String(value ?? '').match(/\d{4}/);
  return match ? Number(match[0]) : null;
}

// --- Discogs collection export --------------------------------------------
// Columns: Catalog#, Artist, Title, Label, Format, Rating, Year / Released,
//          Release ID, Collection ID, Folder, Date Added, Date Changed.
export function parseDiscogsCsv(csvText) {
  const rows = parseCsv(csvText);
  const [header, ...body] = rows;
  const col = headerIndex(header);
  const iArtist = col(['artist']);
  const iTitle = col(['title']);
  const iLabel = col(['label']);
  const iFormat = col(['format']);
  const iYear = col(['year', 'year / released', 'released']);
  const iReleaseId = col(['release id', 'release_id']);
  const iRating = col(['rating']);

  return body.map((row) => ({
    source: 'discogs',
    sourceId: iReleaseId >= 0 ? row[iReleaseId] : null,
    title: row[iTitle] ?? '',
    artist: row[iArtist] ?? '',
    artists: splitList(row[iArtist]),
    label: iLabel >= 0 ? row[iLabel] : null,
    year: iYear >= 0 ? yearOf(row[iYear]) : null,
    country: null,
    format: iFormat >= 0 ? row[iFormat] : null,
    rating: iRating >= 0 ? Number(row[iRating]) || null : null,
    tags: { genres: [], styles: splitList(row[iFormat]), descriptors: [] },
    tracks: [],
    urls: {},
  }));
}

// --- RateYourMusic export -------------------------------------------------
// Expected columns: Artist, Title, Year, Rating, Genres, Descriptors,
//                   Label, Format, Country.
export function parseRymCsv(csvText) {
  const rows = parseCsv(csvText);
  const [header, ...body] = rows;
  const col = headerIndex(header);
  const iArtist = col(['artist']);
  const iTitle = col(['title', 'release', 'album']);
  const iYear = col(['year', 'date']);
  const iRating = col(['rating']);
  const iGenres = col(['genres', 'genre']);
  const iDescriptors = col(['descriptors', 'descriptor']);
  const iLabel = col(['label']);
  const iFormat = col(['format']);
  const iCountry = col(['country']);

  return body.map((row) => ({
    source: 'rym',
    sourceId: `${row[iArtist]}|${row[iTitle]}|${row[iYear]}`,
    title: row[iTitle] ?? '',
    artist: row[iArtist] ?? '',
    artists: splitList(row[iArtist]),
    label: iLabel >= 0 ? row[iLabel] : null,
    year: iYear >= 0 ? yearOf(row[iYear]) : null,
    country: iCountry >= 0 ? row[iCountry] : null,
    format: iFormat >= 0 ? row[iFormat] : null,
    rating: iRating >= 0 ? Number(row[iRating]) || null : null,
    tags: {
      genres: splitList(row[iGenres]),
      styles: [],
      descriptors: iDescriptors >= 0 ? splitList(row[iDescriptors]) : [],
    },
    tracks: [],
    urls: {},
  }));
}

// --- YouTube JSON ---------------------------------------------------------
// [{ videoId, title, channel, durationSeconds, tags[], description }]
// Title heuristics: "Artist - Title" / "Artist – Title".
export function parseYoutubeJson(json) {
  const items = typeof json === 'string' ? JSON.parse(json) : json;
  return items.map((video) => {
    const match = String(video.title ?? '').split(/\s+[-–—]\s+/);
    const artist = match.length > 1 ? match[0] : video.channel ?? '';
    const title = match.length > 1 ? match.slice(1).join(' - ') : video.title;
    return {
      source: 'youtube',
      sourceId: video.videoId ?? null,
      title,
      artist,
      artists: [artist].filter(Boolean),
      label: video.channel ?? null,
      year: video.publishedAt ? yearOf(video.publishedAt) : null,
      country: null,
      format: 'Digital',
      rating: null,
      tags: { genres: [], styles: [], descriptors: video.tags ?? [] },
      tracks: video.durationSeconds
        ? [{ title, duration: video.durationSeconds, bpm: null, key: null }]
        : [],
      urls: video.videoId ? { youtube: `https://www.youtube.com/watch?v=${video.videoId}` } : {},
    };
  });
}

// --- MusicBrainz (live, keyless) ------------------------------------------

const MB_ROOT = 'https://musicbrainz.org/ws/2';
const MB_HEADERS = { 'User-Agent': 'radio-sea/0.1 (research)' };

export function parseMusicbrainzRelease(mb, { sourceId = mb.id ?? null } = {}) {
  const artistCredit = (mb['artist-credit'] ?? []).map((a) => a.name ?? a.artist?.name).filter(Boolean);
  const tags = (mb.tags ?? []).map((t) => t.name).filter(Boolean);
  const relations = mb.relations ?? [];
  const producers = relations.filter((r) => r.type === 'producer').map((r) => r.artist?.name).filter(Boolean);

  return {
    source: 'musicbrainz',
    sourceId,
    title: mb.title ?? '',
    artist: artistCredit[0] ?? '',
    artists: artistCredit,
    label: mb['label-info']?.[0]?.label?.name ?? null,
    year: mb.date ? yearOf(mb.date) : null,
    country: mb.country ?? null,
    format: mb.media?.[0]?.format ?? null,
    rating: null,
    tags: { genres: tags, styles: [], descriptors: producers.map((p) => `produced by ${p}`) },
    tracks: (mb.media ?? []).flatMap((medium) =>
      (medium.tracks ?? []).map((t) => ({
        title: t.title ?? t.recording?.title ?? '',
        duration: t.length ? Math.round(t.length / 1000) : null,
        bpm: t.recording?.tags?.find((tag) => tag.name.startsWith('bpm:'))?.name.slice(4) ?? null,
        key: null,
      })),
    ),
    urls: mb.id ? { musicbrainz: `https://musicbrainz.org/release/${mb.id}` } : {},
  };
}

// --- iTunes Search (live, keyless) ----------------------------------------

export function parseItunesAlbum(album, tracks = []) {
  return {
    source: 'itunes',
    sourceId: album.collectionId != null ? String(album.collectionId) : null,
    title: album.collectionName ?? '',
    artist: album.artistName ?? '',
    artists: [album.artistName].filter(Boolean),
    label: album.collectionName ?? null,
    year: album.releaseDate ? yearOf(album.releaseDate) : null,
    country: null,
    format: 'Digital',
    rating: null,
    tags: { genres: [album.primaryGenreName].filter(Boolean), styles: [], descriptors: [] },
    tracks: tracks.map((track) => ({
      title: track.trackName ?? '',
      duration: track.trackTimeMillis ? Math.round(track.trackTimeMillis / 1000) : null,
      bpm: null,
      key: null,
    })),
    urls: album.collectionViewUrl ? { itunes: album.collectionViewUrl } : {},
  };
}

export async function fetchItunes({ query, limit = 6, fetchImpl = fetch } = {}) {
  const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=album&limit=${limit}`;
  const searchRes = await fetchImpl(searchUrl);
  if (!searchRes.ok) throw new Error(`itunes search failed: ${searchRes.status}`);
  const search = await searchRes.json();

  const releases = [];
  for (const album of search.results ?? []) {
    let tracks = [];
    if (album.collectionId != null) {
      const lookupUrl = `https://itunes.apple.com/lookup?id=${album.collectionId}&entity=song&limit=50`;
      const lookupRes = await fetchImpl(lookupUrl);
      if (lookupRes.ok) {
        const lookup = await lookupRes.json();
        tracks = (lookup.results ?? []).filter((r) => r.wrapperType === 'track');
      }
    }
    releases.push(parseItunesAlbum(album, tracks));
  }
  return releases;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Live scan: search releases by query, then fetch details (tags, credits).
 * Respects MusicBrainz rate limits (~1 request/second) and retries politely on
 * 503 ("web server busy").
 */
export async function fetchMusicbrainz({ query, limit = 10, fetchImpl = fetch, delayMs = 1100, retries = 3 } = {}) {
  const get = async (url) => {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const res = await fetchImpl(url, { headers: MB_HEADERS });
      if (res.status !== 503) return res;
      await sleep(delayMs * (attempt + 1) * 2);
    }
    return fetchImpl(url, { headers: MB_HEADERS });
  };

  const searchUrl = `${MB_ROOT}/release/?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`;
  const searchRes = await get(searchUrl);
  if (!searchRes.ok) throw new Error(`musicbrainz search failed: ${searchRes.status}`);
  const search = await searchRes.json();

  const releases = [];
  for (const hit of search.releases ?? []) {
    await sleep(delayMs);
    const detailUrl = `${MB_ROOT}/release/${hit.id}?inc=tags+artist-credits+labels+recordings+work-rels+artist-rels&fmt=json`;
    const detailRes = await get(detailUrl);
    if (!detailRes.ok) continue;
    releases.push(parseMusicbrainzRelease(await detailRes.json()));
  }
  return releases;
}
