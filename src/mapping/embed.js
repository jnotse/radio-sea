// Feature space and similarity for mapped catalogues.
//
// Signals combined per release pair:
//   tags    TF-IDF cosine over sound tags, plus context tags (see tags.js)
//   credits shared artists, and shared labels when both are known
//   era     proximity in years, when both are known (linear over 25 years)
//   audio   bpm closeness and key distance (when both sides have data)
//   place   same country, when both are known (mild)
//
// Weights are deliberately tag-heavy: genres and styles are the strongest
// signal we get. A field one side lacks is left out rather than counted as a
// mismatch, so sparse radio records are not pushed apart by what nobody knows.

import { keyDistance } from '../layout.js';
import { isBroadGenre, isContextTag, isGenreTag } from './tags.js';
import { audioSimilarity } from '../catalog/audio-features.js';

export function buildTagVocabulary(releases) {
  const docFrequency = new Map();
  for (const release of releases) {
    for (const tag of new Set(release.tags?.all ?? release.styles ?? [])) {
      docFrequency.set(tag, (docFrequency.get(tag) ?? 0) + 1);
    }
  }
  return docFrequency;
}

// `documents` is how many releases the vocabulary was built from: a tag on
// every release weighs almost nothing, a rare style weighs most. `weigh` can
// scale a tag further, given all the release's tags.
export function tagVector(release, vocabulary, { mode = 'all', documents = vocabulary.size, isContext = isContextTag, weigh = () => 1 } = {}) {
  const vector = new Map();
  const tags = release.tags?.all ?? release.styles ?? [];
  for (const tag of tags) {
    const context = isContext(tag);
    if (mode === 'sound' && context) continue;
    if (mode === 'context' && !context) continue;
    const df = vocabulary.get(tag);
    if (!df) continue;
    const idf = Math.log((documents + 1) / (df + 0.5));
    vector.set(tag, (vector.get(tag) ?? 0) + weigh(tag, tags) * idf);
  }
  return vector;
}

export function cosine(vecA, vecB) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [, value] of vecA) normA += value * value;
  for (const [tag, value] of vecB) {
    normB += value * value;
    if (vecA.has(tag)) dot += value * vecA.get(tag);
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function meanBpm(release) {
  // An unknown tempo is null, and Number(null) would read as 0 BPM.
  const bpms = (release.tracks ?? []).filter((t) => t.bpm != null && t.bpm !== '').map((t) => Number(t.bpm)).filter((b) => Number.isFinite(b));
  return bpms.length ? bpms.reduce((a, b) => a + b, 0) / bpms.length : null;
}

function firstKey(release) {
  return (release.tracks ?? []).map((t) => t.key).find(Boolean) ?? null;
}

function extractAudioProfile(release) {
  const track = (release.tracks ?? [])[0] ?? {};
  const extra = release.audio ?? track.audio ?? {};
  return {
    bpm: meanBpm(release) ?? extra.bpm ?? null,
    key: firstKey(release) ?? extra.key ?? null,
    mode: track.mode ?? extra.mode ?? null,
    chroma: track.chroma ?? extra.chroma ?? null,
    brightness: track.brightness ?? extra.brightness ?? null,
    pulseClarity: track.pulseClarity ?? extra.pulseClarity ?? null,
    bandEnergy: track.bandEnergy ?? extra.bandEnergy ?? null,
    spectralFlatness: track.spectralFlatness ?? extra.spectralFlatness ?? null,
    dynamicRange: track.dynamicRange ?? extra.dynamicRange ?? null,
  };
}

/**
 * Co-play proximity in [0, 1] when two tracks were played within 4 positions
 * of each other in the same radio episode; null otherwise.
 */
export function coplayProximity(a, b) {
  const playsA = a.radioPlays ?? (a.station ? [a] : []);
  const playsB = b.radioPlays ?? (b.station ? [b] : []);
  let bestGap = Infinity;
  for (const pa of playsA) {
    if (pa.position == null) continue;
    for (const pb of playsB) {
      if (pb.position == null) continue;
      const sameEpisode = (pa.sourceUrl && pb.sourceUrl && pa.sourceUrl === pb.sourceUrl)
        || (pa.station && pa.station === pb.station && pa.show && pa.show === pb.show && pa.date && pa.date === pb.date);
      if (!sameEpisode) continue;
      const gap = Math.abs(pa.position - pb.position);
      if (gap > 0 && gap < bestGap) bestGap = gap;
    }
  }
  if (bestGap > 4) return null;
  return (5 - bestGap) / 4; // gap 1 -> 1.0, gap 2 -> 0.75, gap 3 -> 0.5, gap 4 -> 0.25
}

function overlap(listA = [], listB = []) {
  const clean = (list) => list.filter((x) => x != null && x !== '').map((x) => String(x).toLowerCase());
  const setA = new Set(clean(listA));
  const setB = new Set(clean(listB));
  if (setA.size === 0 || setB.size === 0) return 0;
  for (const item of setA) if (setB.has(item)) return 1;
  return 0;
}

const WEIGHTS = { tags: 3.0, artist: 0.9, label: 0.35, era: 1.0, country: 0.6, audio: 0.8, coplay: 0.5 };

/**
 * Returns a similarity function sim(a, b) in [0, 1] plus the vocabulary for
 * introspection. Options: `weights` overrides signal weights; `isContext` and
 * `weigh` shape the tag vectors; `trust(release)` in [0, 1] says how far a
 * release's tags describe it (the pair's tag score counts that much).
 */
export function buildSimilarity(releases, { richSignals = true, weights = {}, isContext = isContextTag, weigh, trust = () => 1 } = {}) {
  const pairCache = new Map();
  const w = { ...WEIGHTS, ...weights };
  const vocabulary = buildTagVocabulary(releases);
  const documents = releases.length;
  const vectors = (mode) => new Map(releases.map((r) => [r.id, tagVector(r, vocabulary, { mode, documents, isContext, weigh })]));
  const soundVectors = vectors('sound');
  const contextVectors = vectors('context');

  return function similarity(a, b) {
    if (a.id === b.id) return 1;
    const pair = a.id < b.id ? `${a.id}\0${b.id}` : `${b.id}\0${a.id}`;
    if (pairCache.has(pair)) return pairCache.get(pair);

    // When both tracks have sound tags, those decide the geography and context
    // is only a weak tie: two records from one show may still be worlds apart.
    // Without them, context is all we know: the tracks were played together,
    // or on shows described alike.
    const soundA = soundVectors.get(a.id) ?? new Map();
    const soundB = soundVectors.get(b.id) ?? new Map();
    const contextScore = cosine(contextVectors.get(a.id) ?? new Map(), contextVectors.get(b.id) ?? new Map());
    const tagScore = soundA.size && soundB.size
      ? 0.9 * cosine(soundA, soundB) + 0.1 * contextScore
      : contextScore;
    const artistScore = overlap(a.artists ?? [a.artist], b.artists ?? [b.artist]);

    const bpmA = meanBpm(a);
    const bpmB = meanBpm(b);
    const bpmScore = bpmA != null && bpmB != null ? Math.max(0, 1 - Math.abs(bpmA - bpmB) / 60) : null;
    const keyScore =
      firstKey(a) && firstKey(b) ? 1 - keyDistance(firstKey(a), firstKey(b)) : null;
    const baseAudioScore =
      bpmScore != null && keyScore != null
        ? (bpmScore + keyScore) / 2
        : bpmScore ?? keyScore;
    const richAudioScore = richSignals ? audioSimilarity(extractAudioProfile(a), extractAudioProfile(b)) : null;
    const audioScore = richAudioScore != null && baseAudioScore != null
      ? 0.5 * baseAudioScore + 0.5 * richAudioScore
      : richAudioScore ?? baseAudioScore;
    const coplayScore = richSignals ? coplayProximity(a, b) : null;

    const parts = [
      [w.tags, tagScore * Math.min(trust(a), trust(b))],
      [w.artist, artistScore],
    ];
    if (a.label && b.label) parts.push([w.label, overlap([a.label], [b.label])]);
    if (a.year != null && b.year != null) parts.push([w.era, Math.max(0, 1 - Math.abs(a.year - b.year) / 25)]);
    if (a.country && b.country) parts.push([w.country, a.country === b.country ? 1 : 0]);
    if (audioScore != null) parts.push([w.audio, audioScore]);
    if (coplayScore != null) parts.push([w.coplay, coplayScore]);

    let weightSum = 0;
    let total = 0;
    for (const [weight, score] of parts) {
      weightSum += weight;
      total += weight * score;
    }
    const score = total / weightSum;
    pairCache.set(pair, score);
    return score;
  };
}

// The 2D map has its own stable feature space. Genres/styles define groves;
// era/mood tags and radio context only help place songs whose genres are
// unknown, and the year and country of two songs are a weak tie. Context most
// of the catalogue shares (one big channel's uploads) places nothing. A broad
// genre counts for little next to a style ("rock" alone would join new wave,
// krautrock and city pop), and a compilation's styles, which describe the
// whole record, count for less than a song's own.
// Extra descriptors, uploader channels, spectral audio features and co-play
// sequence remain available to discovery and TDA without rearranging this map.
export function buildMapSimilarity(releases) {
  const tagsOf = (release) => release.tags?.all ?? release.styles ?? [];
  const common = [...buildTagVocabulary(releases)].filter(([tag, count]) => !isGenreTag(tag) && count * 2 > releases.length).map(([tag]) => tag);
  const mapReleases = releases.map((release) => ({
    ...release,
    tags: { all: tagsOf(release).filter((tag) => (isGenreTag(tag) || /^(mood|decade|station|show|show-genre):/.test(tag)) && !common.includes(tag)) },
  }));
  const compilations = new Set(releases.filter((release) => tagsOf(release).includes('format:compilation')).map((release) => release.id));
  const specific = (tag) => isGenreTag(tag) && !isBroadGenre(tag);
  return buildSimilarity(mapReleases, {
    richSignals: false,
    weights: { era: 0.35, country: 0.2 },
    isContext: (tag) => !isGenreTag(tag),
    weigh: (tag, tags) => (isBroadGenre(tag) && tags.some(specific) ? 0.35 : 1),
    trust: (release) => (compilations.has(release.id) ? 0.6 : 1),
  });
}
