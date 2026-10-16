// Text normalization for entity resolution across catalog sources.

export function stripDiacritics(text) {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

export function normalizeText(text) {
  return stripDiacritics(String(text ?? ''))
    .toLowerCase()
    .replace(/\(feat[^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/feat\.?[^,;]*/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function canonicalTitle(title) {
  return normalizeText(title)
    .replace(/^(the|a|an) /, '')
    .replace(/ (ep|lp|single|remaster(ed)?|deluxe edition)$/, '');
}

export function canonicalArtist(artist) {
  return normalizeText(artist)
    .replace(/^(the|a|an) /, '')
    .replace(/ (quartet|trio|ensemble|orchestra|band)$/, '');
}

export function tokens(text) {
  return new Set(normalizeText(text).split(' ').filter((t) => t.length > 1));
}

export function trigramSet(text) {
  const padded = ` ${normalizeText(text)} `;
  const grams = new Set();
  for (let i = 0; i < padded.length - 2; i += 1) grams.add(padded.slice(i, i + 3));
  return grams;
}

export function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  let inter = 0;
  for (const item of setA) if (setB.has(item)) inter += 1;
  return inter / (setA.size + setB.size - inter);
}

export function titleSimilarity(a, b) {
  return jaccard(trigramSet(a), trigramSet(b));
}

export function artistSimilarity(a, b) {
  const setA = tokens(canonicalArtist(a));
  const setB = tokens(canonicalArtist(b));
  return jaccard(setA, setB);
}
