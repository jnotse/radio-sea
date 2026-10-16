// A bounded import of metadata returned by Radiooooo's public shuffle player.
// This is NOT a database dump or a downloader: no private/premium endpoints,
// authentication, stream URLs, audio, artwork or listening reports are used.
const ENDPOINT = 'https://app.radiooooo.com/play/random';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseRadioooooTrack(track) {
  if (!track || typeof track.artist !== 'string' || typeof track.title !== 'string' ||
      !track.artist.trim() || !track.title.trim()) return null;
  const year = Number(track.year);
  const releaseYear = Number.isInteger(year) && year >= 1800 && year <= new Date().getFullYear() + 1 ? year : null;
  const decade = Number(track.decade);
  const country = typeof track.country === 'string' ? track.country : null;
  const mood = typeof track.mood === 'string' ? track.mood.toLowerCase() : null;
  return {
    station: 'radiooooo',
    show: [country, Number.isInteger(decade) && decade >= 1800 ? `${decade}s` : null].filter(Boolean).join(' / ') || 'Public shuffle',
    date: null, // This is a curated selection, not a broadcast timestamp.
    artist: track.artist.trim(), title: track.title.trim(),
    releaseYear, country,
    label: typeof track.label === 'string' ? track.label : null,
    album: typeof track.album === 'string' ? track.album : null,
    ids: { radiooooo: typeof track._id === 'string' ? track._id : null },
    sourceUrl: 'https://app.radiooooo.com/',
    tags: [mood ? `mood:${mood}` : null, Number.isInteger(decade) && decade >= 1800 ? `decade:${decade}s` : null].filter(Boolean),
  };
}

export async function fetchRadioooooPlays({ samples = 16, fetchImpl = fetch, delayMs = 2000 } = {}) {
  if (!Number.isInteger(samples) || samples < 1 || samples > 30) throw new Error('Radiooooo sample count must be between 1 and 30.');
  const result = [], seen = new Set();
  for (let i = 0; i < samples; i++) {
    if (i && delayMs > 0) await wait(delayMs);
    const res = await fetchImpl(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'random', moods: ['SLOW', 'FAST'], priority: 'auto' }),
      signal: AbortSignal.timeout(20000) });
    // Stop on auth challenges or throttling; never try to bypass them.
    if (!res.ok) throw new Error(`Radiooooo public player unavailable (${res.status}). No access workarounds attempted.`);
    const data = await res.json();
    if (data.error) throw new Error(`Radiooooo public player: ${data.error}`);
    const play = parseRadioooooTrack(data);
    if (!play) continue;
    const key = JSON.stringify([play.artist.toLowerCase(), play.title.toLowerCase()]);
    if (!seen.has(key)) { seen.add(key); result.push(play); }
  }
  return result;
}
