// Deterministic fixture catalogue: 6 styles x 6 releases, each style with its
// own bpm/key/country/era profile so the sea layout has real structure.

import { fnv1aHash } from './fnv1a.js';
import { mulberry32 } from './rng.js';

const STYLE_PROFILES = [
  { style: 'techno', related: 'detroit techno', bpm: [125, 140], keys: ['Am', 'Fm', 'Cm', 'Gm'], countries: ['Germany', 'United States', 'United Kingdom'], years: [1990, 2015] },
  { style: 'ambient', related: 'drone', bpm: [60, 95], keys: ['C', 'G', 'D', 'F'], countries: ['Japan', 'United Kingdom', 'France'], years: [1980, 2020] },
  { style: 'disco', related: 'boogie', bpm: [105, 125], keys: ['Dm', 'Gm', 'Bb', 'Am'], countries: ['United States', 'Italy', 'France'], years: [1976, 1988] },
  { style: 'jazz', related: 'spiritual jazz', bpm: [85, 140], keys: ['Eb', 'Bb', 'F', 'Ab'], countries: ['United States', 'France', 'Japan'], years: [1965, 1995] },
  { style: 'dub', related: 'roots reggae', bpm: [70, 100], keys: ['Gm', 'Dm', 'Cm', 'F'], countries: ['Jamaica', 'United Kingdom', 'Germany'], years: [1975, 2010] },
  { style: 'folk', related: 'psych folk', bpm: [80, 120], keys: ['D', 'A', 'E', 'G'], countries: ['France', 'United States', 'Greece'], years: [1970, 2005] },
];

const FORMATS = ['Vinyl', 'Cassette', 'CD'];
const ADJECTIVES = ['silent', 'golden', 'hidden', 'endless', 'coral', 'northern', 'velvet', 'iron', 'pale', 'wild'];
const NOUNS = ['harbour', 'signal', 'current', 'garden', 'machine', 'island', 'ritual', 'compass', 'echo', 'horizon'];

export function buildFixture() {
  const rand = mulberry32(fnv1aHash('fixture'));
  const releases = [];
  const artists = new Map();
  const labels = new Map();

  STYLE_PROFILES.forEach((profile, profileIndex) => {
    for (let i = 0; i < 6; i += 1) {
      const id = `rel-${String(releases.length + 1).padStart(3, '0')}`;
      const artistId = `art-${profileIndex + 1}-${(i % 3) + 1}`;
      const labelId = `lab-${profileIndex + 1}`;
      artists.set(artistId, artistId);
      labels.set(labelId, labelId);

      const year = Math.round(profile.years[0] + ((profile.years[1] - profile.years[0]) * i) / 5);
      const bpm = Math.round(profile.bpm[0] + rand() * (profile.bpm[1] - profile.bpm[0]));
      const key = profile.keys[i % profile.keys.length];
      const country = profile.countries[i % profile.countries.length];
      const name = `${ADJECTIVES[Math.floor(rand() * ADJECTIVES.length)]} ${NOUNS[Math.floor(rand() * NOUNS.length)]}`;

      const tracks = [];
      const trackCount = 3 + Math.floor(rand() * 3);
      for (let t = 0; t < trackCount; t += 1) {
        tracks.push({
          id: `${id}-t${t + 1}`,
          name: `${name} ${t + 1}`,
          bpm: bpm + Math.round((rand() - 0.5) * 8),
          key: t === 0 ? key : profile.keys[(i + t) % profile.keys.length],
        });
      }

      releases.push({
        id,
        name,
        artistId,
        artist: `artist ${artistId.slice(4)}`,
        artists: [`artist ${artistId.slice(4)}`],
        labelId,
        sellerId: `sel-${(i % 4) + 1}`,
        styles: [profile.style, profile.related],
        country,
        year,
        format: FORMATS[i % FORMATS.length],
        tracks,
      });
    }
  });

  const users = Array.from({ length: 8 }, (_, i) => ({ id: `usr-${i + 1}`, username: `sailor${i + 1}` }));

  // Gems: users gem mostly within one style (their "taste"), a few cross-style.
  const gems = [];
  users.forEach((user, ui) => {
    const homeStyle = STYLE_PROFILES[ui % STYLE_PROFILES.length].style;
    releases
      .filter((r) => r.styles.includes(homeStyle))
      .slice(0, 4)
      .forEach((r) => gems.push({ userId: user.id, releaseId: r.id, trackId: r.tracks[0].id }));
    const stray = releases[Math.floor(rand() * releases.length)];
    gems.push({ userId: user.id, releaseId: stray.id, trackId: stray.tracks[0].id });
  });

  return { releases, users, gems };
}
