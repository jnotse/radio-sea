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
import { isContextTag } from './tags.js';

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
// every release weighs almost nothing, a rare style weighs most.
export function tagVector(release, vocabulary, { mode = 'all', documents = vocabulary.size } = {}) {
  const vector = new Map();
  const tags = release.tags?.all ?? release.styles ?? [];
  for (const tag of tags) {
    const context = isContextTag(tag);
    if (mode === 'sound' && context) continue;
    if (mode === 'context' && !context) continue;
    const df = vocabulary.get(tag);
    if (!df) continue;
    const idf = Math.log((documents + 1) / (df + 0.5));
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
  // An unknown tempo is null, and Number(null) would read as 0 BPM.
  const bpms = (release.tracks ?? []).filter((t) => t.bpm != null && t.bpm !== '').map((t) => Number(t.bpm)).filter((b) => Number.isFinite(b));
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
  const documents = releases.length;
  const soundVectors = new Map(releases.map((r) => [r.id, tagVector(r, vocabulary, { mode: 'sound', documents })]));
  const contextVectors = new Map(releases.map((r) => [r.id, tagVector(r, vocabulary, { mode: 'context', documents })]));

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
    const audioScore =
      bpmScore != null && keyScore != null
        ? (bpmScore + keyScore) / 2
        : bpmScore ?? keyScore;

    const parts = [
      [3.0, tagScore],
      [0.9, artistScore],
    ];
    if (a.label && b.label) parts.push([0.35, overlap([a.label], [b.label])]);
    if (a.year != null && b.year != null) parts.push([1.0, Math.max(0, 1 - Math.abs(a.year - b.year) / 25)]);
    if (a.country && b.country) parts.push([0.6, a.country === b.country ? 1 : 0]);
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
