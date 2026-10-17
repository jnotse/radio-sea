# Radio Sea

A map for wandering through music that real people played on independent radio.

Radio Sea collects the tracklists of shows on stations like NTS and The Lot
Radio, plus picks from Radiooooo, finds each song on YouTube, and lays
everything out as a Patagonian steppe seen from above. Songs that sound alike
grow together as groves of bushes (lenga forests, calafate and neneo
thickets), with the Andes, glacial lakes and rivers in the open ground and
trails leading to related groves. Press a square to play it; when a song ends
the music wanders on to the nearest song you haven't heard, so you can leave
it running.

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
npm run catalog:genres    # look up each song's own genres on MusicBrainz
npm run catalog:deezer    # tempo (BPM), length and loudness from Deezer
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

Stations only describe whole shows ("this set is jazz, drum & bass, reggae"),
not single songs. So songs are grouped by their own genres once they have
been looked up; a song without any stays with the show it was played on, and
its grove is named after that show.

## Tests

```sh
npm test                       # unit tests
npx playwright install webkit  # once, for the phone (Safari engine) tests
npm run test:browser           # desktop and phone browser tests
```
