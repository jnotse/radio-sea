# Radio sea discovery prototype

Scan catalogues and radio tracklists, merge identities, match songs to YouTube,
and arrange them on a navigable map using metadata-based similarity and clustering.

## Open the demo

From this `discovery` folder:

```sh
npm install
npm start
```

Open **http://127.0.0.1:4173**. Keep the terminal running.
The server binds to loopback only and serves the `demo/` folder, not your files.

**Do not double-click the HTML for embedded playback.** YouTube requires an HTTP
origin/referrer. File mode shows a notice and retains working external watch
links, but disables embedded playback.

- Select a square or a track in the list, then press **Play this track**.
- Drag the map, scroll to zoom, or use + / − / sail home.
- Search artists/titles/shows; filter by station or tags. Clear filters to reset.
- Neighbours explain shared metadata. Trade routes connect different islands.
- Watch on YouTube is always available if embedding is blocked, slow, or restricted.
- On phones, use the fixed **Map / Library / Player** shortcuts to move between
  sections. Drag with one finger to pan the map; pinch or use + / − to zoom.
  Controls are touch-sized, and the layout fits portrait and landscape screens.
- The POSITION slider seeks in one-second steps. Drag its handle or use arrow
  keys. The JUMP TO box accepts seconds (`83`, `83s`), `mm:ss` (`1:23`), or
  `hh:mm:ss`. It stays disabled until YouTube provides the track's duration.

## GitHub Pages hosting

The app is configured for **https://jnotse.github.io/radio-sea/**.

`.github/workflows/deploy-pages.yml` runs unit tests and browser tests on every
push to `main`, then publishes the **`demo/` folder only**. Deployment can also be
started manually from the repository's Actions tab. GitHub Pages serves the site
over HTTPS; no local computer or Node server needs to stay running.

Pages hosts the saved catalogue and browser player, not a scraping server. To
publish changes (including new tracks), rebuild locally and push:

```sh
npm run catalog:extend -- --max 160
git add .
git commit -m "Expand radio catalogue"
git push
```

The extension command looks up previously unprocessed songs in the cached radio
tracklists. It keeps accepted tracks, samples multiple shows, and checkpoints
progress. No YouTube keys or GitHub tokens are embedded in the website.

### Retro skin

The map uses a four-shade Game Boy-inspired LCD palette and pixel-dithered islands.
Beveled charcoal panels, a green readout, playlist numbering and metal transport
buttons borrow from classic Winamp. The pixel font is bundled locally under the
SIL Open Font License (`demo/fonts/OFL.txt`). No external font service is needed.

Previous/next, play/pause/stop and volume are functional. The clock reads the
YouTube player's playback time. Animated bars are a decorative playing indicator,
not an audio-frequency analysis; animation stops when paused and respects reduced
motion settings.

The saved snapshot contains **179 tracks**, including **13 Radiooooo public-player
selections** alongside NTS and The Lot Radio. Current counts are shown in the
library and source filters.
Worldwide FM has zero imported tracks and its filter is disabled. Tags come from
radio-show metadata, not audio analysis: tracks from one show can therefore have
the same tags. Do not interpret the map as a measured acoustic embedding.

## Tests

```sh
npm test               # deterministic unit/contract tests
npx playwright install webkit  # one-time install for Safari-engine checks
npm run test:browser   # desktop and mobile Playwright tests
```

Local browser tests use installed Chrome plus Playwright's WebKit for phone
checks; GitHub Actions installs Chromium and WebKit (see `playwright.config.js`).
They mock the external YouTube API so network failures cannot make UI tests pass/fail at random.
They check complete data records, filters, search, selection, pan/zoom/hover,
player configuration/error fallback, file-mode notice, and phone layout.
Live playback is a separate network-dependent check; oEmbed success alone does
not guarantee playback in every region or permit embedding.

## Rebuild data

```sh
npm run build-demo -- --max 56 --episodes 10   # scan live stations and resolve videos
npm run build-demo:reuse                     # remap from saved resolution, no network
npm run build-demo -- --repair --max 56       # re-check cached songs via live search/oEmbed
npm run catalog:extend -- --max 160           # add new matches without replacing existing tracks
npm run catalog:radiooooo -- --max 16         # bounded public-player metadata sample + YouTube checks
node scripts/scan-musicbrainz.js             # optional general-catalogue scan
npm run demo                                # older fixture walkthrough in the terminal
```

`data/resolved-plays.json` caches radio provenance and video matches;
`demo/sea-data.json` and `demo/sea-data.js` are generated from it. Rebuilding
preserves station, show, broadcast date, show URL, and YouTube ID through merging,
including multiple station appearances of one song. Broadcast date is NOT used
as release year. The builder rejects incomplete demo records.

YouTube search hits are candidates, not validation. The resolver parses individual
video renderers, checks artist/title (including non-Latin names and version
numbers), and requires successful oEmbed metadata that also agrees. Unrelated
hits, dead links, throttled checks and network failures are excluded, not labelled
verified. Matching is still heuristic; exclusions can include available songs.
No audio is downloaded. Playback stays in the YouTube player or watch page.

## Sources and modules

| Source | Implementation / limitation |
|---|---|
| NTS | Schedule + episode tracklists; identifiers, genre and mood tags |
| The Lot Radio | Published category-page episode data with tracklists/genres |
| Worldwide FM | Mixcloud sections when provided; recent snapshot returned no tracks |
| Radiooooo | Small, rate-limited samples from its public shuffle player; actual year/country/mood and attribution, then strict YouTube matching |
| Discogs / RYM | CSV import adapters, not general-purpose website crawlers |
| YouTube | JSON import + public search/oEmbed resolver (page structure can change) |
| MusicBrainz / iTunes | Optional live metadata search adapters |

- `src/catalog/`: adapters, entity resolution and YouTube validation.
- `src/mapping/`: weighted tag/credit/era/audio-feature similarity, agglomerative
  islands, 2D layout, depth and cross-island routes. Sparse metadata limits quality;
  BPM/key are used only when supplied, not inferred from YouTube audio.
- `src/filters.js`, `pickers.js`: faceted discovery and related/similar/radio picks.
- `src/reactions.js`, `navigation.js`, `shuffle.js`: reactions, human links, shuffle.
- `demo/`: canvas viewer and YouTube playback, without a frontend build step.
- `scripts/serve-demo.js`: localhost HTTP server required for the player.

This remains a small-catalogue prototype. Clustering is not designed to handle an
entire commercial catalogue at once, and candidate relevance is not a guarantee
of exact recording/version identity.

The Radiooooo adapter does not copy its entire database, stream or download its
audio, import artwork, or access premium/private catalogues. It requests at most
30 public shuffle selections per run and stops on access challenges or throttling.
For a complete Radiooooo catalogue, obtain an authorized export or agreement from
them rather than treating this sampler as a database mirror.
