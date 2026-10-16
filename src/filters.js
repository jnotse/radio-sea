// Catalogue filters and their query fields:
//
//   styles_in / styles_in_or / styles_not_in
//   country_in / country_not_in      (with Discogs-style country alias expansion)
//   year_greater_than / year_less_than   (STRICT bounds; the UI sends range-1 / range+1)
//   format_in
//   key_in                            (musical key of a track)
//   bpm_min / bpm_max                 (any track of the release may satisfy it)
//   condition_in / condition_in_or    (the "landscapes" reaction filter)
//
// plus the UI-state -> query builder and active-filter counting.

// Common country aliases in catalogue metadata.
export const COUNTRY_ALIASES = {
  UK: 'United Kingdom',
  'Great Britain': 'United Kingdom',
  US: 'United States',
  USA: 'United States',
  'United States of America': 'United States',
  Holland: 'Netherlands',
  Deutschland: 'Germany',
  France: 'France',
};

const REVERSE_INDEX = new Map();
for (const [alias, canonical] of Object.entries(COUNTRY_ALIASES)) {
  const list = REVERSE_INDEX.get(canonical) ?? [];
  list.push(alias);
  REVERSE_INDEX.set(canonical, list);
}

export function normalizeCountry(name) {
  return COUNTRY_ALIASES[name] ?? name;
}

export function expandCountry(name) {
  const canonical = normalizeCountry(name);
  const aliases = REVERSE_INDEX.get(canonical);
  return aliases ? [canonical, ...aliases] : [canonical];
}

export function expandCountries(names) {
  return [...new Set(names.flatMap(expandCountry))];
}

// --- matching -------------------------------------------------------------

function hasAllStyles(release, styles) {
  return styles.every((s) => release.styles.includes(s));
}

function hasAnyStyle(release, styles) {
  return styles.some((s) => release.styles.includes(s));
}

function countryMatches(release, names) {
  // Query lists are alias-expanded; comparing on normalised name is equivalent
  // and much simpler.
  const target = normalizeCountry(release.country);
  return names.some((n) => normalizeCountry(n) === target);
}

function bpmMatches(release, filters) {
  if (filters.bpm_min == null && filters.bpm_max == null) return true;
  const min = filters.bpm_min ?? -Infinity;
  const max = filters.bpm_max ?? Infinity;
  return release.tracks.some((t) => t.bpm >= min && t.bpm <= max);
}

function conditionsOf(release, reactionRegistry) {
  return reactionRegistry ? reactionRegistry.conditionsFor(release.id) : release.conditions ?? [];
}

export function releaseMatchesFilters(release, filters = {}, reactionRegistry = null) {
  const f = filters;

  if (f.styles_in && !hasAllStyles(release, f.styles_in)) return false;
  if (f.styles_in_or && !hasAnyStyle(release, f.styles_in_or)) return false;
  if (f.styles_not_in && hasAnyStyle(release, f.styles_not_in)) return false;

  if (f.country_in && !countryMatches(release, f.country_in)) return false;
  if (f.country_not_in && countryMatches(release, f.country_not_in)) return false;

  if (f.year_greater_than != null && !(release.year > f.year_greater_than)) return false;
  if (f.year_less_than != null && !(release.year < f.year_less_than)) return false;

  if (f.format_in && !f.format_in.includes(release.format)) return false;

  if (f.key_in && !release.tracks.some((t) => f.key_in.includes(t.key))) return false;

  if (!bpmMatches(release, f)) return false;

  const conditions = conditionsOf(release, reactionRegistry);
  if (f.condition_in && !f.condition_in.every((c) => conditions.includes(c))) return false;
  if (f.condition_in_or && !f.condition_in_or.some((c) => conditions.includes(c))) return false;

  return true;
}

// --- UI state -> query ---------------------------------------------------

// UI state shape:
// {
//   genres, excludedGenres, countries, excludedCountries,
//   yearRange: [min, max] | null,
//   formats, keys,
//   bpmRange: [min, max] | null,
//   landscapes, landscapesMode: 'all' | 'any',
// }
export function buildMusicMapFilterQuery(state) {
  const query = {};

  if (state.genres.length > 0) {
    if (state.genresMode === 'any') query.styles_in_or = [...state.genres];
    else query.styles_in = [...state.genres];
  }
  if (state.excludedGenres.length > 0) query.styles_not_in = [...state.excludedGenres];

  if (state.countries.length > 0) query.country_in = expandCountries(state.countries);
  if (state.excludedCountries.length > 0) query.country_not_in = expandCountries(state.excludedCountries);

  if (state.yearRange) {
    query.year_greater_than = state.yearRange[0] - 1;
    query.year_less_than = state.yearRange[1] + 1;
  }

  if (state.landscapes.length > 0) {
    if (state.landscapesMode === 'any') query.condition_in_or = [...state.landscapes];
    else query.condition_in = [...state.landscapes];
  }

  if (state.formats.length > 0) query.format_in = [...state.formats];
  if (state.keys.length > 0) query.key_in = [...state.keys];
  if (state.bpmRange) {
    query.bpm_min = state.bpmRange[0];
    query.bpm_max = state.bpmRange[1];
  }

  return Object.keys(query).length > 0 ? query : undefined;
}

export function countActiveFilters(state) {
  let count = 0;
  count += state.genres.length;
  count += state.excludedGenres.length;
  count += state.countries.length;
  count += state.excludedCountries.length;
  if (state.yearRange !== null) count += 1;
  count += state.formats.length;
  count += state.keys.length;
  count += state.landscapes.length;
  if (state.bpmRange !== null) count += 1;
  return count;
}

export const EMPTY_FILTER_STATE = {
  genres: [],
  genresMode: 'all',
  excludedGenres: [],
  countries: [],
  excludedCountries: [],
  yearRange: null,
  formats: [],
  keys: [],
  bpmRange: null,
  landscapes: [],
  landscapesMode: 'all',
};
