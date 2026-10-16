// The Lot Radio adapter.
//
// Category pages (https://www.thelotradio.com/shows/special-guests) embed their
// episode catalogue as JSON inside the Next.js flight payloads
// (self.__next_f.push([1,"..."])). Episodes carry full tracklists with
// {title, artist, timestamp}, per-episode genres, and show metadata.

/** Extract every JSON object containing a `tracklist` array from a page. */
export function parseLotRadioShowPage(html, { station = 'lotradio' } = {}) {
  const episodes = [];

  const pushPattern = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let push;
  while ((push = pushPattern.exec(html)) !== null) {
    let text;
    try {
      text = JSON.parse(push[1]);
    } catch {
      continue;
    }

    // Walk objects in the payload; keep the ones that look like episodes.
    for (const object of extractJsonObjects(text, 'tracklist')) {
      let episode;
      try {
        episode = JSON.parse(object);
      } catch {
        continue;
      }
      if (!Array.isArray(episode.tracklist) || episode.tracklist.length === 0) continue;
      episodes.push(episode);
    }
  }

  const plays = [];
  for (const episode of episodes) {
    const showName = episode.show?.name ?? '';
    const genres = (episode.genres?.items ?? []).map((g) => g.name).filter(Boolean);
    const date = episode.date ? String(episode.date).slice(0, 10) : null;
    for (const track of episode.tracklist) {
      if (!track?.title) continue;
      plays.push({
        station,
        // Guest sets share one category ("Special Guests"); the episode title
        // names the guest.
        show: [showName, episode.title].filter((part, i, all) => part && all.indexOf(part) === i).join(': '),
        date,
        artist: track.artist ?? '',
        title: track.title,
        ids: {},
        sourceUrl: `https://www.thelotradio.com/shows/${episode.show?.slug ?? ''}/${episode.slug ?? ''}`,
        showGenres: genres,
      });
    }
  }
  return plays;
}

/**
 * Balanced-brace scan for JSON objects whose text contains `marker`.
 * (The payload mixes JSON islands with JS references, so we cannot parse the
 * whole string at once.)
 */
function extractJsonObjects(text, marker) {
  const objects = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          if (candidate.includes(`"${marker}"`)) objects.push(candidate);
          break;
        }
      }
    }
  }
  return objects;
}

export async function fetchLotRadioPlays({
  categories = ['special-guests'],
  fetchImpl = fetch,
} = {}) {
  const plays = [];
  const errors = [];
  for (const category of categories) {
    try {
      const res = await fetchImpl(`https://www.thelotradio.com/shows/${category}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });
      if (!res.ok) throw new Error(`lot radio page failed: ${res.status}`);
      plays.push(...parseLotRadioShowPage(await res.text()));
    } catch (error) {
      errors.push({ category, message: error.message });
    }
  }
  return { plays, errors };
}
