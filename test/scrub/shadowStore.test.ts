import { describe, expect, it } from 'vitest';
import { createDb, runMigrations, schema } from '../../src/db/index.js';
import { ShadowStore } from '../../src/scrub/shadowStore.js';
import type { ShadowHit } from '../../src/rules/shadow.js';

function store() {
  const d = createDb(':memory:');
  runMigrations(d);
  return { d, store: new ShadowStore(d) };
}

const HIT: ShadowHit = {
  rule: 'live-track',
  kind: 'track',
  artist: 'Nirvana',
  title: 'all apologies - live',
  wouldBe: 'all apologies',
};

describe('ShadowStore.record', () => {
  it('needs reporting the first time and not the second', () => {
    const { store: s } = store();

    expect(s.record(HIT).needsReport).toBe(true);
    s.markReported(s.unreported(10)[0]!.id);

    expect(s.record(HIT).needsReport).toBe(false);
  });

  it('keeps needing a report until one actually happened', () => {
    const { store: s } = store();
    s.record(HIT);

    // No markReported: a send that silently no-opped must not count.
    expect(s.record(HIT).needsReport).toBe(true);
    expect(s.unreported(10)).toHaveLength(1);
  });

  it('re-announces when a refined rule changes the answer', () => {
    const { store: s } = store();
    s.record(HIT);
    s.markReported(s.unreported(10)[0]!.id);

    const changed = s.record({ ...HIT, wouldBe: 'all apologies (live)' });

    expect(changed.needsReport).toBe(true);
    expect(s.unreported(10)).toHaveLength(1);
    expect(s.list()[0]!.wouldBe).toBe('all apologies (live)');
  });

  it('does not duplicate a row for the same rule, kind and title', () => {
    const { store: s } = store();
    s.record(HIT);
    s.record(HIT);
    s.record({ ...HIT, artist: 'A Different Artist' });

    expect(s.list()).toHaveLength(1);
  });

  /**
   * The artist is outside the identity key: sweepIncremental nominates an album under the TRACK
   * artist while sweep() uses the album artist, so including it would record the same album twice.
   */
  it('keeps the artist as display data, not identity', () => {
    const { store: s } = store();
    s.record({ ...HIT, kind: 'album', title: 'Yessongs (Live)', artist: 'Yes' });
    s.record({ ...HIT, kind: 'album', title: 'Yessongs (Live)', artist: 'Jon Anderson' });

    const rows = s.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.artist).toBe('Jon Anderson');
  });

  it('separates the same title under different rules', () => {
    const { store: s } = store();
    s.record(HIT);
    s.record({ ...HIT, rule: 'version', wouldBe: 'something else' });

    expect(s.list()).toHaveLength(2);
    expect(s.list('live-track')).toHaveLength(1);
  });

  it('advances lastSeenAt without re-announcing', () => {
    const { d, store: s } = store();
    s.record(HIT, new Date(1000));
    s.markReported(s.unreported(10)[0]!.id);

    s.record(HIT, new Date(9000));

    const row = d.select().from(schema.shadowHits).all()[0]!;
    expect(row.lastSeenAt?.getTime()).toBe(9000);
    expect(row.reportedAt).not.toBeNull();
  });
});

describe('ShadowStore reading', () => {
  it('returns nothing for a zero or negative limit rather than everything', () => {
    const { store: s } = store();
    s.record(HIT);

    expect(s.unreported(0)).toEqual([]);
    expect(s.unreported(-1)).toEqual([]);
  });

  it('caps the batch and leaves the rest unreported', () => {
    const { store: s } = store();
    for (let i = 0; i < 5; i++) s.record({ ...HIT, title: `track ${i}` });

    const batch = s.unreported(2);

    expect(batch).toHaveLength(2);
    expect(s.countUnreported()).toBe(5);
    for (const b of batch) s.markReported(b.id);
    expect(s.countUnreported()).toBe(3);
  });

  it('counts by rule for the command summary', () => {
    const { store: s } = store();
    s.record(HIT);
    s.record({ ...HIT, title: 'another - live' });
    s.record({ ...HIT, rule: 'version', title: 'x (radio edit)' });

    const counts = new Map(s.countsByRule().map((c) => [c.rule, c.n]));
    expect(counts.get('live-track')).toBe(2);
    expect(counts.get('version')).toBe(1);
  });
});
