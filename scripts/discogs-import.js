// Import genres, styles and release years for our songs from a Discogs
// releases dump (https://data.discogs.com/, free to reuse under CC0).
//
//   npm run catalog:discogs -- discogs_YYYYMMDD_releases.xml.gz
//   curl -sL <releases dump URL> | npm run catalog:discogs -- -
//   npm run catalog:discogs -- <dump> --limit 100000   # trial run, saves nothing
//
// The dump is streamed, never stored or loaded whole. Results go to
// data/discogs-matches.json, then the map is rebuilt from the caches.

import { createReadStream } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDiscogsMatcher, scanDiscogsDump } from '../src/catalog/discogs-dump.js';
import { songKey } from '../src/catalog/extend.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [source, ...options] = process.argv.slice(2);
const limitAt = options.indexOf('--limit');
const limit = limitAt >= 0 ? Number(options[limitAt + 1]) : Infinity;
if (!source || !(limit > 0)) {
  console.error('usage: npm run catalog:discogs -- <releases dump .xml.gz, or - for stdin> [--limit N]');
  process.exit(1);
}

const cached = JSON.parse(await readFile(join(root, 'data', 'resolved-plays.json'), 'utf8'));
// Pending songs need catalogue links before their first YouTube search too.
const plays = [...(cached.resolved ?? []), ...(cached.plays ?? [])];
const matcher = createDiscogsMatcher(plays);
const started = Date.now();
console.log(`Scanning ${source === '-' ? 'standard input' : source} for ${new Set(plays.map(songKey)).size} songs (including pending)…`);
const { scanned } = await scanDiscogsDump(source === '-' ? process.stdin : createReadStream(source), matcher, {
  limit,
  onProgress: ({ scanned: n }) => console.log(`  ${n.toLocaleString('en')} releases (${Math.round((Date.now() - started) / 1000)}s)`),
});

const songs = matcher.results();
const tally = (source) => Object.values(songs).filter((song) => song.source === source).length;
console.log(`Scanned ${scanned.toLocaleString('en')} releases: ${tally('track')} songs found in tracklists, ` +
  `${tally('video')} by YouTube video, ${tally('artist')} by artist only, ${tally(null)} not found.`);

if (limit !== Infinity) {
  console.log('Trial run (--limit): nothing saved.');
} else {
  const file = join(root, 'data', 'discogs-matches.json');
  const payload = { dump: source === '-' ? null : basename(source), scannedAt: new Date().toISOString(), releasesScanned: scanned, songs };
  await writeFile(`${file}.next`, JSON.stringify(payload, null, 1));
  await rename(`${file}.next`, file);
  console.log('Saved data/discogs-matches.json. Rebuilding the map…');
  const build = spawnSync(process.execPath, [join(root, 'scripts', 'build-demo.js'), '--reuse'], { stdio: 'inherit' });
  process.exitCode = build.status ?? 1;
}
