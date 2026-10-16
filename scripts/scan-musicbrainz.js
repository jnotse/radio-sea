// Live catalog scan: pull real releases from public, keyless APIs, merge them
// into one catalogue, map the sea, and show what the engine says.
//
//   node scripts/scan-musicbrainz.js                    # auto backend, two queries
//   node scripts/scan-musicbrainz.js "dub techno" "spiritual jazz"
//   node scripts/scan-musicbrainz.js --backend itunes "afrobeat"
//
// Backends: musicbrainz (rich tags/credits, rate-limited) and itunes
// (reliable, genre + tracklists). Auto tries musicbrainz, falls back to itunes.
// Results are written to data/scanned.json.

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchMusicbrainz, fetchItunes } from '../src/catalog/sources.js';
import { mergeCatalogue, crossSourceReleases } from '../src/catalog/resolve.js';
import { RadioSeaDiscovery } from '../src/engine.js';

const args = process.argv.slice(2);
let backend = 'auto';
if (args[0] === '--backend') {
  backend = args[1];
  args.splice(0, 2);
}
const queries = args.length > 0 ? args : ['dub techno', 'spiritual jazz'];

async function scanQuery(query) {
  if (backend === 'itunes') return { backend: 'itunes', rows: await fetchItunes({ query }) };
  try {
    return { backend: 'musicbrainz', rows: await fetchMusicbrainz({ query, limit: 6 }) };
  } catch (error) {
    if (backend === 'musicbrainz') throw error;
    console.log(`  musicbrainz unavailable (${error.message}), falling back to itunes`);
    return { backend: 'itunes', rows: await fetchItunes({ query }) };
  }
}

async function main() {
  const raws = [];
  const usedBackends = new Set();
  for (const query of queries) {
    console.log(`scanning "${query}" ...`);
    const { backend: used, rows } = await scanQuery(query);
    usedBackends.add(used);
    console.log(`  ${rows.length} releases via ${used}`);
    raws.push(...rows);
  }

  const catalogue = mergeCatalogue(raws);
  console.log(`\ncatalogue: ${catalogue.releases.length} unique releases from ${raws.length} raw rows`);
  console.log(`cross-source matches: ${crossSourceReleases(catalogue).length}`);

  const engine = new RadioSeaDiscovery({ releases: catalogue.releases, seed: 'scan' });

  console.log(`\nislands (${engine.islands.length}):`);
  for (const island of engine.islands) {
    const names = island.memberIds
      .map((id) => catalogue.index.get(id))
      .slice(0, 3)
      .map((r) => `${r.artist} - ${r.name}`)
      .join(' | ');
    console.log(`  [${island.name}] ${island.memberIds.length} releases @ ${island.centre.x}~${island.centre.y}`);
    console.log(`      ${names}`);
  }

  const deepest = [...engine.depths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log('\ndeepest cuts:');
  for (const [id, depth] of deepest) {
    const release = catalogue.index.get(id);
    console.log(`  ${depth}  ${release.artist} - ${release.name} (${release.year ?? '?'})`);
  }

  const routes = engine.tradeRoutes({ minScore: 0.15 }).slice(0, 5);
  console.log('\ntop trade routes (auto navigation suggestions):');
  for (const route of routes) {
    const from = catalogue.index.get(route.from);
    const to = catalogue.index.get(route.to);
    console.log(`  ${route.score}  ${from.name}  ~>  ${to.name}`);
    console.log(`      why: ${engine.explain(route.from, route.to).reasons.join('; ')}`);
  }

  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, 'scanned.json');
  await writeFile(
    outFile,
    JSON.stringify(
      {
        scannedAt: new Date().toISOString(),
        queries,
        backends: [...usedBackends],
        releases: catalogue.releases,
        placements: Object.fromEntries(engine.placements),
        islands: engine.islands,
        tradeRoutes: routes,
      },
      null,
      2,
    ),
  );
  console.log(`\nsaved to ${outFile}`);
}

main().catch((error) => {
  console.error('scan failed:', error.message);
  process.exitCode = 1;
});
