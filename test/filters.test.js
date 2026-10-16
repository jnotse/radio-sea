import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMusicMapFilterQuery,
  countActiveFilters,
  EMPTY_FILTER_STATE,
  releaseMatchesFilters,
  normalizeCountry,
  expandCountries,
} from '../src/filters.js';
import { ReactionRegistry } from '../src/reactions.js';

const release = {
  id: 'rel-1',
  name: 'test release',
  styles: ['techno', 'detroit techno'],
  country: 'United Kingdom',
  year: 1994,
  format: 'Vinyl',
  tracks: [
    { id: 't1', name: 'a', bpm: 132, key: 'Am' },
    { id: 't2', name: 'b', bpm: 128, key: 'Fm' },
  ],
};

test('buildMusicMapFilterQuery mirrors the UI-state mapping', () => {
  const query = buildMusicMapFilterQuery({
    ...EMPTY_FILTER_STATE,
    genres: ['techno', 'ambient'],
    countries: ['UK'],
    yearRange: [1980, 1990],
    formats: ['Vinyl'],
    keys: ['Am'],
    bpmRange: [120, 140],
    landscapes: ['banger'],
  });

  assert.deepEqual(query.styles_in, ['techno', 'ambient']);
  assert.deepEqual(query.country_in, ['United Kingdom', 'UK', 'Great Britain']);
  // strict bounds: the client sends range - 1 / range + 1
  assert.equal(query.year_greater_than, 1979);
  assert.equal(query.year_less_than, 1991);
  assert.deepEqual(query.format_in, ['Vinyl']);
  assert.deepEqual(query.key_in, ['Am']);
  assert.equal(query.bpm_min, 120);
  assert.equal(query.bpm_max, 140);
  assert.deepEqual(query.condition_in, ['banger']);
});

test('genresMode any and landscapesMode any switch to the _or variants', () => {
  const query = buildMusicMapFilterQuery({
    ...EMPTY_FILTER_STATE,
    genres: ['techno', 'ambient'],
    genresMode: 'any',
    landscapes: ['banger', 'crab'],
    landscapesMode: 'any',
  });
  assert.deepEqual(query.styles_in_or, ['techno', 'ambient']);
  assert.deepEqual(query.condition_in_or, ['banger', 'crab']);
  assert.equal(query.styles_in, undefined);
});

test('empty filter state yields no query at all', () => {
  assert.equal(buildMusicMapFilterQuery(EMPTY_FILTER_STATE), undefined);
});

test('style matching: all-of vs any-of vs exclusions', () => {
  assert.ok(releaseMatchesFilters(release, { styles_in: ['techno', 'detroit techno'] }));
  assert.ok(!releaseMatchesFilters(release, { styles_in: ['techno', 'ambient'] }));
  assert.ok(releaseMatchesFilters(release, { styles_in_or: ['ambient', 'techno'] }));
  assert.ok(!releaseMatchesFilters(release, { styles_in_or: ['ambient', 'disco'] }));
  assert.ok(!releaseMatchesFilters(release, { styles_not_in: ['techno'] }));
});

test('country aliases normalise before matching', () => {
  assert.equal(normalizeCountry('UK'), 'United Kingdom');
  assert.ok(expandCountries(['UK']).includes('Great Britain'));
  assert.ok(releaseMatchesFilters(release, { country_in: ['UK'] }));
  assert.ok(!releaseMatchesFilters(release, { country_in: ['US'] }));
  assert.ok(releaseMatchesFilters(release, { country_not_in: ['US'] }));
});

test('year bounds are strict, like the API', () => {
  assert.ok(releaseMatchesFilters(release, { year_greater_than: 1993, year_less_than: 1995 }));
  assert.ok(!releaseMatchesFilters(release, { year_greater_than: 1994 })); // not > 1994
  assert.ok(!releaseMatchesFilters(release, { year_less_than: 1994 })); // not < 1994
});

test('format and key filters', () => {
  assert.ok(releaseMatchesFilters(release, { format_in: ['Vinyl', 'CD'] }));
  assert.ok(!releaseMatchesFilters(release, { format_in: ['CD'] }));
  assert.ok(releaseMatchesFilters(release, { key_in: ['Fm'] }));
  assert.ok(!releaseMatchesFilters(release, { key_in: ['C'] }));
});

test('bpm range applies to any track of the release', () => {
  assert.ok(releaseMatchesFilters(release, { bpm_min: 130, bpm_max: 135 })); // t1
  assert.ok(!releaseMatchesFilters(release, { bpm_min: 136, bpm_max: 140 }));
});

test('condition (landscape) filters read the reaction registry', () => {
  const registry = new ReactionRegistry();
  registry.toggle({ userId: 'u1', releaseId: 'rel-1', trackId: 't1', condition: 'banger' });
  registry.toggle({ userId: 'u2', releaseId: 'rel-1', trackId: 't1', condition: 'banger' });
  registry.toggle({ userId: 'u1', releaseId: 'rel-1', trackId: 't2', condition: 'crab' });

  assert.ok(releaseMatchesFilters(release, { condition_in: ['banger', 'crab'] }, registry));
  assert.ok(!releaseMatchesFilters(release, { condition_in: ['banger', 'sunny'] }, registry));
  assert.ok(releaseMatchesFilters(release, { condition_in_or: ['sunny', 'crab'] }, registry));
  assert.ok(!releaseMatchesFilters(release, { condition_in_or: ['sunny'] }, registry));
});

test('countActiveFilters counts dimensions', () => {
  const count = countActiveFilters({
    ...EMPTY_FILTER_STATE,
    genres: ['techno'],
    excludedGenres: ['folk'],
    countries: ['UK'],
    yearRange: [1980, 1990],
    landscapes: ['banger'],
    bpmRange: [120, 140],
  });
  assert.equal(count, 6);
});
