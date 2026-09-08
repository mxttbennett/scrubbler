// Lives outside src/ so it never lands in dist/. Prints what a sweep would change, API-only:
// no scraping, no writes, so it is safe to run any time.
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/core/config.js';
import { LastfmApi } from '../src/lastfm/api.js';
import { cleanTitle } from '../src/rules/engine.js';
import type { GroupName } from '../src/rules/markers.js';

interface Row {
  kind: 'album' | 'track';
  artist: string;
  from: string;
  to: string;
  groups: GroupName[];
}

const cfg = loadConfig();
const api = new LastfmApi(cfg.apiKey);
const rows: Row[] = [];

let seen = 0;
for await (const a of api.iterateTopAlbums(cfg.username)) {
  seen++;
  const r = cleanTitle(a.name, 'album', cfg.enabledGroups);
  if (r) rows.push({ kind: 'album', artist: a.artist, from: a.name, to: r.clean, groups: r.groups });
  if (seen % 2000 === 0) process.stderr.write(`  albums: ${seen}\n`);
}
const albumCount = rows.length;

seen = 0;
for await (const t of api.iterateTopTracks(cfg.username)) {
  seen++;
  const r = cleanTitle(t.name, 'track', cfg.enabledGroups);
  if (r) rows.push({ kind: 'track', artist: t.artist, from: t.name, to: r.clean, groups: r.groups });
  if (seen % 5000 === 0) process.stderr.write(`  tracks: ${seen}\n`);
}

rows.sort((x, y) => x.kind.localeCompare(y.kind) || x.artist.localeCompare(y.artist) || x.from.localeCompare(y.from));

const byGroup = new Map<string, number>();
for (const r of rows) for (const g of r.groups) byGroup.set(g, (byGroup.get(g) ?? 0) + 1);

writeFileSync('/tmp/sweep-report.json', JSON.stringify({ rows, albumCount, trackCount: rows.length - albumCount }, null, 1));

const lines: string[] = [];
lines.push(`# scrobble-scrubber planned changes`);
lines.push(`# user ${cfg.username} | groups ${[...cfg.enabledGroups].sort().join(',')}`);
lines.push(`# ${albumCount} albums + ${rows.length - albumCount} tracks = ${rows.length} entities`);
lines.push(`# by group: ${[...byGroup].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g}=${n}`).join(' ')}`);
for (const kind of ['album', 'track'] as const) {
  lines.push('', `## ${kind.toUpperCase()}S`, '');
  for (const r of rows.filter((x) => x.kind === kind)) {
    lines.push(`${r.artist}\n    ${r.from}\n -> ${r.to}    [${r.groups.join(',')}]`);
  }
}
writeFileSync('/tmp/sweep-report.txt', lines.join('\n'));
console.log(lines.slice(0, 4).join('\n'));
console.log(`\nwrote /tmp/sweep-report.txt and /tmp/sweep-report.json`);
