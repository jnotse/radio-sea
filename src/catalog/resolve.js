// Entity resolution: merge the same release arriving from different catalog
// sources into one unified record.

import { canonicalTitle, canonicalArtist, titleSimilarity, artistSimilarity, normalizeText } from './text.js';
import { youtubeIdFromUrl } from './youtube-link.js';

const MERGE_THRESHOLD = 0.72;

function yearProximity(a, b) {
  if (a == null || b == null) return 0.5; // unknown: neutral
  const diff = Math.abs(a - b);
  return Math.max(0, 1 - diff / 5);
}

function titleScore(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na && na === nb) return 1;
  // "Bypass" vs "Bypass EP": one is the other plus a suffix.
  if (na && nb && (na.startsWith(nb) || nb.startsWith(na))) return 0.95;
  return titleSimilarity(a, b);
}

/** Match score in [0, 1] for "same release?". */
export function matchScore(a, b) {
  let score = 0.5 * titleScore(a.title, b.title) + 0.35 * artistSimilarity(a.artist, b.artist) + 0.15 * yearProximity(a.year, b.year);
  // Volumes/issue numbers are decisive: "Spiritual Jazz 3" is not volume 10.
  const digitsA = (String(a.title).match(/\d+/g) ?? []).join(',');
  const digitsB = (String(b.title).match(/\d+/g) ?? []).join(',');
  if (digitsA && digitsB && digitsA !== digitsB) score = Math.min(score, 0.6);
  return score;
}

function pushUnique(list, values) {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    if (!list.some((existing) => normalizeText(existing) === normalized)) list.push(value);
  }
}

function mergeInto(base, incoming) {
  pushUnique(base.artists, incoming.artists);
  pushUnique(base.tags.genres, incoming.tags.genres);
  pushUnique(base.tags.styles, incoming.tags.styles);
  pushUnique(base.tags.descriptors, incoming.tags.descriptors);
  base.label ??= incoming.label;
  base.country ??= incoming.country;
  base.year ??= incoming.year;
  base.format ??= incoming.format;
  if (incoming.views != null) {
    base.views = base.views != null ? Math.min(base.views, incoming.views) : incoming.views;
  }
  base.rating = Math.max(base.rating ?? 0, incoming.rating ?? 0) || null;
  for (const track of incoming.tracks) {
    const existing = base.tracks.find(
      (t) => normalizeText(t.title) === normalizeText(track.title),
    );
    if (!existing) {
      base.tracks.push(track);
    } else {
      for (const [k, v] of Object.entries(track)) {
        if (existing[k] == null && v != null) existing[k] = v;
      }
    }
  }
  Object.assign(base.urls, incoming.urls);
  for (const play of incoming.radioPlays) {
    if (!base.radioPlays.some((p) => p.station === play.station && p.sourceUrl === play.sourceUrl && p.date === play.date)) {
      base.radioPlays.push(play);
    }
  }
  for (const source of incoming.sources) {
    if (!base.sources.some((s) => s.source === source.source && s.sourceId === source.sourceId)) {
      base.sources.push(source);
    }
  }
  base.mergedCount += 1;
}

/**
 * @param {Array} rawReleases RawRelease[] from any adapters
 * @returns unified catalogue: { releases: [{ id, name, artist, styles, tags, ... }], index }
 */
export function mergeCatalogue(rawReleases) {
  const releases = [];

  for (const raw of rawReleases) {
    const record = {
      id: '',
      title: raw.title,
      name: raw.title,
      artist: raw.artist,
      artists: [...(raw.artists ?? [])],
      label: raw.label ?? null,
      year: raw.year ?? null,
      country: raw.country ?? null,
      format: raw.format ?? null,
      rating: raw.rating ?? null,
      ...(raw.views != null ? { views: raw.views } : {}),
      tags: {
        genres: [...(raw.tags?.genres ?? [])],
        styles: [...(raw.tags?.styles ?? [])],
        descriptors: [...(raw.tags?.descriptors ?? [])],
      },
      tracks: (raw.tracks ?? []).map((t) => ({ ...t })),
      urls: { ...(raw.urls ?? {}) },
      radioPlays: (raw.radioPlays ?? (raw.station ? [{
        station: raw.station,
        show: raw.show ?? '',
        date: raw.date ?? null,
        sourceUrl: raw.sourceUrl ?? null,
        ...(raw.position != null ? { position: raw.position } : {}),
      }] : [])).map((p) => ({ ...p })),
      sources: [{ source: raw.source, sourceId: raw.sourceId }],
      mergedCount: 1,
    };

    let best = null;
    let bestScore = 0;
    for (const candidate of releases) {
      const score = matchScore(record, candidate);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    if (best && bestScore >= MERGE_THRESHOLD) {
      mergeInto(best, record);
    } else {
      releases.push(record);
    }
  }

  releases.forEach((release, i) => {
    release.id = `rel-${String(i + 1).padStart(3, '0')}`;
    // Preserve radio provenance, including ALL stations when plays merge.
    release.stations = [...new Set(release.radioPlays.map((p) => p.station))];
    Object.assign(release, release.radioPlays[0] ?? {});
    // Derive this from the surviving URL so ID and link cannot drift apart.
    release.youtubeId = youtubeIdFromUrl(release.urls.youtube);
    // `styles` is what the mapping layer treats as its primary tag axis, so the
    // union of genre/style/descriptor vocabulary lives there as well.
    release.styles = [...new Set([
      ...release.tags.genres,
      ...release.tags.styles,
    ])];
    release.tags.all = [...new Set([
      ...release.tags.genres,
      ...release.tags.styles,
      ...release.tags.descriptors,
    ])];
  });

  return { releases, index: new Map(releases.map((r) => [r.id, r])) };
}

export function crossSourceReleases(catalogue) {
  return catalogue.releases.filter((r) => new Set(r.sources.map((s) => s.source)).size > 1);
}
