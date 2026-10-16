// Feature space and similarity for mapped catalogues.
//
// Signals combined per release pair:
//   tags    TF-IDF cosine over the union of genres / styles / descriptors
//   credits shared artists (0.5 weight) and shared labels (0.175)
//   era     proximity in years (exponential decay over 25 years)
//   audio   bpm closeness and key distance (when both sides have data)
//   place   same country (mild)
//
// Weights are deliberately tag-heavy: catalog vocabularies (RYM genres and
// descriptors especially) are the strongest signal we get from scanned data.

import { keyDistance } from '../layout.js';

const PROVENANCE_PREFIX = /^(station|show):/;

function isProvenance(tag) {
  return PROVENANCE_PREFIX.test(tag);
}

export function buildTagVocabulary(releases) {
  const docFrequency = new Map();
  for (const release of releases) {
    for (const tag of new Set(release.tags?.all ?? release.styles ?? [])) {
      docFrequency.set(tag, (docFrequency.get(tag) ?? 0) + 1);
    }
  }
  return docFrequency;
}

export function tagVector(release, vocabulary, { mode = 'all' } = {}) {
  const vector = new Map();
  const tags = release.tags?.all ?? release.styles ?? [];
  for (const tag of tags) {
    const provenance = isProvenance(tag);
    if (mode === 'sound' && provenance) continue;
    if (mode === 'provenance' && !provenance) continue;
    const df = vocabulary.get(tag);
    if (!df) continue;
    const idf = Math.log((vocabulary.size + 1) / (df + 0.5));
    vector.set(tag, (vector.get(tag) ?? 0) + 1 * idf);
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
  const bpms = (release.tracks ?? []).map((t) => Number(t.bpm)).filter((b) => Number.isFinite(b));
  return bpms.length ? bpms.reduce((a, b) => a + b, 0) / bpms.length : null;
}

function firstKey(release) {
  return (release.tracks ?? []).map((t) => t.key).find(Boolean) ?? null;
}

function overlap(listA = [], listB = []) {
  const clean = (list) => list.filter((x) => x != null && x !== '').map((x) => String(x).toLowerCase());
  const setA = new Set(clean(listA));
  const setB = new Set(clean(listB));
  if (setA.size === 0 || setB.size === 0) return 0;
  for (const item of setA) if (setB.has(item)) return 1;
  return 0;
}

/**
 * Returns a similarity function sim(a, b) in [0, 1] plus the vocabulary for
 * introspection.
 */
export function buildSimilarity(releases) {
  const pairCache = new Map();
  const vocabulary = buildTagVocabulary(releases);
  const soundVectors = new Map(releases.map((r) => [r.id, tagVector(r, vocabulary, { mode: 'sound' })]));
  const provenanceVectors = new Map(releases.map((r) => [r.id, tagVector(r, vocabulary, { mode: 'provenance' })]));

  return function similarity(a, b) {
    if (a.id === b.id) return 1;
    const pair = a.id < b.id ? `${a.id}\0${b.id}` : `${b.id}\0${a.id}`;
    if (pairCache.has(pair)) return pairCache.get(pair);

    // Sound tags (genres, moods, descriptors) decide the geography. Provenance
    // (station, show) is only a weak tie: two records from one show may still
    // be worlds apart.
    const soundScore = cosine(soundVectors.get(a.id) ?? new Map(), soundVectors.get(b.id) ?? new Map());
    const provenanceScore = cosine(
      provenanceVectors.get(a.id) ?? new Map(),
      provenanceVectors.get(b.id) ?? new Map(),
    );
    const tagScore = 0.75 * soundScore + 0.25 * provenanceScore;
    const artistScore = overlap(a.artists ?? [a.artist], b.artists ?? [b.artist]);
    const labelScore = overlap([a.label], [b.label]);

    const yearA = a.year;
    const yearB = b.year;
    const eraScore =
      yearA != null && yearB != null ? Math.max(0, 1 - Math.abs(yearA - yearB) / 25) : 0.3;

    const bpmA = meanBpm(a);
    const bpmB = meanBpm(b);
    const bpmScore = bpmA != null && bpmB != null ? Math.max(0, 1 - Math.abs(bpmA - bpmB) / 60) : null;
    const keyScore =
      firstKey(a) && firstKey(b) ? 1 - keyDistance(firstKey(a), firstKey(b)) : null;
    const audioScore =
      bpmScore != null && keyScore != null
        ? (bpmScore + keyScore) / 2
        : bpmScore ?? keyScore;

    const countryScore = a.country && b.country && a.country === b.country ? 1 : 0;

    const parts = [
      [3.0, tagScore],
      [0.9, artistScore],
      [0.35, labelScore],
      [1.0, eraScore],
      [0.6, countryScore],
    ];
    if (audioScore != null) parts.push([0.8, audioScore]);

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
