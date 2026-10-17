# G-digs

A map for wandering through music that real people played on independent radio.

G-digs collects the tracklists of shows on stations like NTS and The Lot
Radio, plus picks from Radiooooo, finds each song on YouTube, and lays
everything out as a Patagonian steppe seen from above. Songs that sound alike
grow together as groves of bushes (lenga forests, calafate and neneo
thickets), with the Andes, glacial lakes and rivers in the open ground and
trails leading to related groves. Press a square to play it; when a song ends
the music wanders on to the nearest song you haven't heard, so you can leave
it running.

Guano, a guanaco drawn from a souvenir plush made in Magallanes, Chile, walks
the map with you. He trots over to each song as it starts, dances to upbeat
ones, closes his eyes and nods along to calm ones, and lies down when the music
is paused.

It's drawn as pixel art in the colours of Torres del Paine at sunset. On
phones, the Map / Player / Explore buttons at the bottom jump between
sections; drag to pan and pinch to zoom.

**Live site:** https://jnotse.github.io/radio-sea/

## Run it on your computer

```sh
npm install
npm start
```

Then open http://127.0.0.1:4173. Opening `demo/index.html` directly won't play
videos, because YouTube needs the page served over HTTP.

## Add more music

The site shows a saved snapshot. To refresh it, rebuild on your computer and
push to `main`; GitHub Pages republishes automatically.

```sh
npm run catalog:extend    # add new songs from the saved radio tracklists
npm run catalog:radiooooo # Radiooooo picks: one per country and decade not yet sampled
npm run catalog:genres    # look up each song's own genres on MusicBrainz
npm run catalog:deezer    # tempo (BPM), length and loudness from Deezer
npm run catalog:youtube   # length, album and label from YouTube's video details
git add data demo && git commit -m "Add more music" && git push
```

For finer genres and release years, match the songs against Discogs' free
monthly catalog dump. Copy the link of the latest `…_releases.xml.gz` file
from https://data.discogs.com/ and stream it in; it's about 10 GB, so this
takes a while but never stores it:

```sh
curl -sL "<releases file link>" | npm run catalog:discogs -- -
```

Already downloaded? `npm run catalog:discogs -- discogs_YYYYMMDD_releases.xml.gz`.
The dump matcher covers pending songs too, and preserves track-matched YouTube
links for the next import.

### YouTube matching without unnecessary searches

Imports first discover YouTube links from MusicBrainz recording/release
relationships and Discogs releases. These are candidates, not proof: each
video's actual YouTube title and artist/channel must match before admission.
Only songs still unresolved then need a YouTube search. No import downloads
or plays audio/video.

Set `YOUTUBE_API_KEY` to use the official Data API. Known IDs are checked in
batches of up to 50 (`videos.list`), without a `search.list` call. Without a
key, known links are checked individually with oEmbed and the fallback uses
YouTube search pages, which can be blocked.

```sh
npm run catalog:extend -- --max 26 --search-budget 20 --no-wait
# Explicitly revisit old negative lookups (including possible historical blocks):
npm run catalog:extend -- --max 40 --retry-unmatched --no-wait
```

`--search-budget` defaults to 100 actual search calls per Pacific day, saved
before each call in `data/resolved-plays.json`; restarting doesn't reset it.
API and web counts are separate, and this is a local safeguard, not a live
reading of Google's project quota. Multiple query variants and retries each
count. Known-link verification uses no search budget and can continue after
the search budget/quota is exhausted. Video checks are cached for 30 days;
catalogue link facts live in `data/catalogue-links.json`, and per-song lookup
statuses distinguish verified, no-match and pending.

HTTP 403/429, bot checks, unreadable responses and outages leave songs pending,
never permanently excluded as missing. `--no-wait` stops promptly on such
failures; otherwise the importer backs off. Run again later to resume. An
explicit `--retry-unmatched` can revisit legacy exclusions without deleting
accepted songs. Embedding metadata is not a guarantee of playback in every
region or browser.

### Record channels on YouTube

Every record a YouTube channel has uploaded can join the map, such as
[floor length skirt(s)](https://www.youtube.com/@floorlengthskirts). Their
uploads are titled "artist - title (year)" and link the record's Discogs page,
so each song is matched to exactly that record by the next Discogs import:

```sh
YOUTUBE_API_KEY=… node scripts/build-demo.js --channel floorlengthskirts
npm run catalog:discogs -- discogs_YYYYMMDD_releases.xml.gz
```

A new channel is added to `RADIO_STATIONS` in `src/catalog/radio.js` (kind
`youtube`) first. Rerunning `--channel` only adds uploads that are new.

### Guano's facts from Wikipedia

While a song plays, Guano now and then tells you something about its artist
or genre, taken from the opening of the Wikipedia article. They are looked
up with [Wikipedia-API](https://pypi.org/project/Wikipedia-API/), so this one
step needs Python:

```sh
pip install -r requirements.txt
npm run catalog:wiki      # on Windows: python scripts/wiki_facts.py, then npm run build-demo:reuse
git add data demo && git commit -m "Facts for Guano" && git push
```

An artist's article is only used when it is clearly theirs: the full name as
its title, or an article that names one of their songs, albums or labels. Run
it from your own internet connection: Wikipedia refuses scripts from
cloud servers. Lookups are saved, so a rerun only asks about new genres and
artists (`python3 scripts/wiki_facts.py --retry-missing` asks again about
those that found nothing). The facts are Wikipedia text under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); the site
links each one to its article.

`catalog:youtube` reads only the details YouTube publishes about each video,
never the audio or video. With a free YouTube Data API key in
`YOUTUBE_API_KEY` it takes a few seconds; without one it reads the video
pages one every 15 seconds and pauses whenever YouTube asks it to slow down.

Stations only describe whole shows ("this set is jazz, drum & bass, reggae"),
not single songs. So songs are grouped by their own genres once they have
been looked up; a song without any stays with the show it was played on.
A grove is named after the genre at least half its songs share, or after
its two commonest genres when it's a mix. Only a grove where most songs
have no genres yet is named after the show they were played on.

The 2D steppe has its own genre-led clustering and layout, retaining era,
mood and radio context for songs without genres. Instruments,
credits, formats, uploader channels, co-play sequence and spectral audio
descriptors can inform discovery and the 3D topology without moving its
groves. Switching views preserves each map's pan and zoom.

## Tests

```sh
npm test                       # unit tests
npx playwright install webkit  # once, for the phone (Safari engine) tests
npm run test:browser           # desktop and phone browser tests
npm run test:wiki              # the Wikipedia lookups (needs Python)
```
