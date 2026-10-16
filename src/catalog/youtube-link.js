// Shared with the browser: accept only actual YouTube hosts and 11-char IDs.
export function youtubeIdFromUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    let id;
    if (host === 'youtu.be') id = url.pathname.split('/')[1];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
      id = url.pathname === '/watch' ? url.searchParams.get('v') :
        /^\/(embed|shorts)\//.test(url.pathname) ? url.pathname.split('/')[2] : null;
    }
    return /^[\w-]{11}$/.test(id ?? '') ? id : null;
  } catch {
    return null;
  }
}
