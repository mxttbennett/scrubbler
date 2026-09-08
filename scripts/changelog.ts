// CI-only: reads CHANGELOG.md so a GitHub release can take its notes from it. Lives outside src/
// so it never lands in dist/ — nothing at runtime reads the changelog.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export interface ChangelogEntry {
  version: string;
  date: string | null;
  lines: string[];
}

const HEADING = /^##\s*\[?(\d+\.\d+\.\d+)\]?\s*[-–—]?\s*(\S+)?/;

/** Scans `## [x.y.z] - date` headings; preserves file order, which is authored newest-first. */
export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;

  for (const raw of markdown.split('\n')) {
    if (raw.startsWith('## ') || raw.startsWith('##\t')) {
      const match = HEADING.exec(raw);
      current = match === null ? null : { version: match[1]!, date: match[2] ?? null, lines: [] };
      if (current !== null) entries.push(current);
      continue;
    }
    if (current === null) continue;
    const line = raw.trim();
    if (line.length === 0) continue;
    // A wrapped bullet continues the one above it, so an entry survives the 100-column margin.
    if (!line.startsWith('-') && current.lines.length > 0) {
      current.lines[current.lines.length - 1] += ` ${line}`;
    } else {
      current.lines.push(line);
    }
  }

  return entries;
}

/** The bullet block for one version, or null when that version has no entry. */
export function sectionFor(markdown: string, version: string): string | null {
  const entry = parseChangelog(markdown).find((e) => e.version === version);
  return entry === undefined ? null : entry.lines.join('\n');
}

function main(): void {
  const version = process.argv[2];
  if (version === undefined) return;
  let markdown: string;
  try {
    markdown = readFileSync('CHANGELOG.md', 'utf8');
  } catch {
    return;
  }
  const section = sectionFor(markdown, version);
  if (section !== null) process.stdout.write(`${section}\n`);
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) main();
