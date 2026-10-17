// Every record a YouTube channel has uploaded, as songs on the map. They are
// the channel's own videos, so no search is needed. Record channels title
// their uploads "artist - title (year)" and usually link the record's Discogs
// page in the description; the Discogs import then matches that record
// exactly. Listing a channel needs the YouTube Data API (YOUTUBE_API_KEY).

import { videoUrl } from './youtube.js';

const API = 'https://www.googleapis.com/youtube/v3';
export const UNKNOWN_ARTIST = 'Unknown artist';

/** "laura b - oo oo oo (2010)" → { artist, title, year, decade }; "(198x)" is a decade. */
export function parseUploadTitle(text) {
  let rest = String(text ?? '').replace(/\s+/g, ' ').trim();
  let year = null, decade = null;
  const dated = /\s*[([]((?:19|20)\d)(\d|x)[)\]]$/i.exec(rest);
  if (dated) {
    if (/x/i.test(dated[2])) decade = `${dated[1]}0s`;
    else year = Number(dated[1] + dated[2]);
    rest = rest.slice(0, dated.index).trim();
  }
  // "artist - title", also written "artist- title"; a hyphen inside a word never splits.
  const split = /\s*[-–—]\s+/.exec(rest);
  if (!split || !split.index) return { artist: UNKNOWN_ARTIST, title: rest, year, decade };
  return { artist: rest.slice(0, split.index).trim(), title: rest.slice(split.index + split[0].length).trim(), year, decade };
}

/**
 * The label the uploader names on the first line, and the Discogs record linked
 * below it. A link named "Various-…" is a compilation.
 */
export function parseUploadDescription(text) {
  const description = String(text ?? '');
  const firstLine = description.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  const label = firstLine.length <= 60 && !/https?:|www\.|discogs|bandcamp|\bbuy\b|unreleased/i.test(firstLine) &&
    !/^not on label$/i.test(firstLine) ? firstLine || null : null;
  const link = /discogs\.com\/(?:[a-z]{2}\/)?(?:([^/\s]+)\/)?(release|master)\/(\d+)(-\S*)?/i.exec(description);
  if (!link) return { label, discogs: null };
  const various = /^-?Various-/i.test(link[4] ?? link[1] ?? '');
  return { label, discogs: { [link[2].toLowerCase()]: Number(link[3]), ...(various ? { compilation: true } : {}) } };
}

/** A channel upload as a resolved song: its own video is the match. */
export function uploadToPlay(video, station, checkedAt = new Date().toISOString()) {
  const { artist, title, year, decade } = parseUploadTitle(video.snippet?.title);
  const { label, discogs } = parseUploadDescription(video.snippet?.description);
  return {
    station: station.id,
    show: null,
    date: video.snippet?.publishedAt ?? null,
    sourceUrl: videoUrl(video.id),
    artist,
    title,
    ...(year ? { releaseYear: year } : {}),
    ...(label ? { labelHint: label } : {}),
    ...(discogs?.compilation ? { compilation: true } : {}),
    tags: decade ? [`decade:${decade}`] : [],
    ids: { ...(discogs?.release ? { discogsRelease: discogs.release } : {}), ...(discogs?.master ? { discogsMaster: discogs.master } : {}) },
    youtube: { videoId: video.id, url: videoUrl(video.id), title: video.snippet?.title ?? '', channel: video.snippet?.channelTitle ?? '',
      via: 'channel', confirmed: true, matchScore: 1, checkedAt },
  };
}

/** Every upload of @handle that can be played embedded: { channel, videos }. */
export async function fetchChannelUploads({ handle, apiKey, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('Listing a channel needs a YouTube Data API key in YOUTUBE_API_KEY');
  const get = async (path, params) => {
    const query = new URLSearchParams(Object.entries({ ...params, key: apiKey }).filter(([, v]) => v != null));
    const res = await fetchImpl(`${API}/${path}?${query}`, { signal: AbortSignal.timeout(30000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`The YouTube Data API refused the request (${body.error?.message ?? res.status})`);
    return body;
  };
  const channel = (await get('channels', { part: 'snippet,contentDetails', forHandle: handle })).items?.[0];
  if (!channel) throw new Error(`There is no YouTube channel @${handle}`);
  const ids = [];
  let pageToken = null;
  do {
    const page = await get('playlistItems', { part: 'contentDetails', maxResults: 50,
      playlistId: channel.contentDetails.relatedPlaylists.uploads, pageToken });
    ids.push(...(page.items ?? []).map((item) => item.contentDetails.videoId));
    pageToken = page.nextPageToken ?? null;
  } while (pageToken);
  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const page = await get('videos', { part: 'snippet,status', id: ids.slice(i, i + 50).join(','), maxResults: 50 });
    videos.push(...(page.items ?? []));
  }
  // Deleted and private videos drop out of the answer; the map only keeps ones it can play.
  return { channel: { id: channel.id, title: channel.snippet?.title ?? handle },
    videos: videos.filter((video) => video.status?.embeddable !== false && video.status?.privacyStatus !== 'private') };
}
