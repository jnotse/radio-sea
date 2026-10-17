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

## Tests

```sh
npm test                       # unit tests
npx playwright install webkit  # once, for the phone (Safari engine) tests
npm run test:browser           # desktop and phone browser tests
```
