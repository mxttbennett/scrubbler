import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseChangelog, sectionFor } from '../../scripts/changelog.js';

const SAMPLE = `# Changelog

Preamble prose that belongs to no entry.

## [1.2.0] - 2026-09-08

- Added a thing.
- A bullet long enough that the author wrapped it
  onto a second line.

## [1.1.1] - 2026-09-01

- Fixed a thing.

## 1.0.0

- First.
`;

describe('parseChangelog', () => {
  it('keeps file order, which is authored newest-first', () => {
    expect(parseChangelog(SAMPLE).map((e) => e.version)).toEqual(['1.2.0', '1.1.1', '1.0.0']);
  });

  it('reads the date when there is one, and copes with a bare heading', () => {
    const [first, , bare] = parseChangelog(SAMPLE);
    expect(first?.date).toBe('2026-09-08');
    expect(bare?.version).toBe('1.0.0');
    expect(bare?.date).toBeNull();
  });

  /** The repo wraps at 100 columns, so a bullet's continuation must not become its own bullet. */
  it('joins a wrapped bullet back onto the one above it', () => {
    const lines = parseChangelog(SAMPLE)[0]?.lines ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('- A bullet long enough that the author wrapped it onto a second line.');
  });

  it('drops prose that precedes the first entry', () => {
    expect(parseChangelog(SAMPLE).flatMap((e) => e.lines).join('\n')).not.toContain('Preamble');
  });

  it('treats a non-version heading as the end of an entry', () => {
    const entries = parseChangelog('## [1.0.0] - x\n\n- Kept.\n\n## Notes\n\n- Dropped.\n');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.lines).toEqual(['- Kept.']);
  });

  it('finds nothing in an empty file rather than throwing', () => {
    expect(parseChangelog('')).toEqual([]);
  });
});

describe('sectionFor', () => {
  it('returns just that version’s bullets', () => {
    expect(sectionFor(SAMPLE, '1.1.1')).toBe('- Fixed a thing.');
  });

  it('returns null for a version with no entry, which the release step warns on', () => {
    expect(sectionFor(SAMPLE, '9.9.9')).toBeNull();
  });
});

/** The release workflow takes its notes from these, so a missing entry is a broken release. */
describe('the real CHANGELOG.md', () => {
  const root = join(import.meta.dirname, '..', '..');
  const markdown = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string })
    .version;

  it('has an entry for the version in package.json', () => {
    expect(sectionFor(markdown, version)).not.toBeNull();
  });

  it('leads with that version, since entries are newest-first', () => {
    expect(parseChangelog(markdown)[0]?.version).toBe(version);
  });

  it('gives every entry at least one bullet', () => {
    for (const entry of parseChangelog(markdown)) expect(entry.lines.length).toBeGreaterThan(0);
  });
});
