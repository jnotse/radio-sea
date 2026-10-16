# Radio Sea

A map for wandering through music that real people played on independent radio.

Radio Sea collects the tracklists of shows on stations like NTS and The Lot
Radio, plus picks from Radiooooo, finds each song on YouTube, and lays
everything out as a sea of islands. Songs that belong together share an
island, and dotted routes lead to related songs on other islands. Pick a
square, press play, and follow wherever it takes you.

It has a little retro skin: a Game Boy–style screen and a Winamp-style player.

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
git add data demo && git commit -m "Add more music" && git push
```

Stations only describe whole shows ("this set is jazz, drum & bass, reggae"),
not single songs. So songs are grouped by their own genres once they have
been looked up; until then they stay grouped with the show they were played
on, and the island is named after that show.

## Tests

```sh
npm test               # unit tests
npm run test:browser   # browser tests (Playwright)
```
