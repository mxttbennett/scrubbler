import { describe, expect, it } from 'vitest';
import { createDb, runMigrations, schema } from '../../src/db/index.js';
import { CustomRules, RuleRejected } from '../../src/rules/customRules.js';

function store() {
  const d = createDb(':memory:');
  runMigrations(d);
  return { d, rules: new CustomRules(d) };
}

const RULE = {
  kind: 'album' as const,
  artist: 'Pavement',
  fromTitle: 'Wowee Zowee: Sordid Sentinels Edition',
  toTitle: 'Wowee Zowee',
};

describe('CustomRules', () => {
  it('round-trips add, list and remove', () => {
    const { rules } = store();
    rules.add(RULE);

    expect(rules.list()).toHaveLength(1);
    expect(rules.list()[0]!.toTitle).toBe('Wowee Zowee');

    expect(rules.remove('album', 'Pavement', RULE.fromTitle)).toBe(true);
    expect(rules.list()).toHaveLength(0);
  });

  it('reports a removal that matched nothing, rather than claiming success', () => {
    const { rules } = store();
    expect(rules.remove('album', 'Nobody', 'Nothing')).toBe(false);
  });

  it('updates in place rather than duplicating the same entity', () => {
    const { rules } = store();
    rules.add(RULE);
    rules.add({ ...RULE, toTitle: 'Wowee Zowee (1995)' });

    expect(rules.list()).toHaveLength(1);
    expect(rules.list()[0]!.toTitle).toBe('Wowee Zowee (1995)');
  });

  it('keeps rules for the same title by different artists apart', () => {
    const { rules } = store();
    rules.add({ kind: 'album', artist: 'Nirvana', fromTitle: 'Bleach', toTitle: 'Bleach [1989]' });
    rules.add({ kind: 'album', artist: 'Soundgarden', fromTitle: 'Bleach', toTitle: 'Bleach [1988]' });

    expect(rules.list()).toHaveLength(2);
    expect(rules.lookup('album', 'Nirvana', 'Bleach')).toBe('Bleach [1989]');
    expect(rules.lookup('album', 'Soundgarden', 'Bleach')).toBe('Bleach [1988]');
  });

  it('rejects a replacement that could never land', () => {
    const { rules } = store();

    expect(() => rules.add({ ...RULE, toTitle: '' })).toThrow(RuleRejected);
    expect(() => rules.add({ ...RULE, toTitle: '   ' })).toThrow(/cannot be empty/);
    // Last.fm silently rejects casing-only edits, so such a rule is inert by construction.
    expect(() => rules.add({ ...RULE, toTitle: RULE.fromTitle.toUpperCase() })).toThrow(
      /only in casing/,
    );
    expect(() => rules.add({ ...RULE, artist: ' ' })).toThrow(/artist is required/);
    expect(() => rules.add({ ...RULE, fromTitle: '' })).toThrow(/current title is required/);
  });

  it('sees a rule added after its first read, so a sweep needs no restart', () => {
    const { rules } = store();
    expect(rules.lookup('album', 'Pavement', RULE.fromTitle)).toBeUndefined();

    rules.add(RULE);

    expect(rules.lookup('album', 'Pavement', RULE.fromTitle)).toBe('Wowee Zowee');
  });

  it('stops matching once removed', () => {
    const { rules } = store();
    rules.add(RULE);
    rules.remove('album', 'Pavement', RULE.fromTitle);

    expect(rules.lookup('album', 'Pavement', RULE.fromTitle)).toBeUndefined();
  });

  it('counts an application and stamps when it happened', () => {
    const { rules } = store();
    rules.add(RULE);

    rules.recordApplied('album', 'Pavement', RULE.fromTitle);
    rules.recordApplied('album', 'Pavement', RULE.fromTitle);

    const row = rules.list()[0]!;
    expect(row.timesApplied).toBe(2);
    expect(row.lastAppliedAt).toBeInstanceOf(Date);
  });

  it('ignores a recorded application for a title with no rule', () => {
    const { rules } = store();
    rules.add(RULE);

    rules.recordApplied('album', 'Someone Else', 'Another Title');

    expect(rules.list()[0]!.timesApplied).toBe(0);
  });

  it('trims what it stores, so a stray space cannot make a second rule', () => {
    const { d, rules } = store();
    rules.add({ ...RULE, artist: '  Pavement  ', fromTitle: `  ${RULE.fromTitle}  ` });

    const row = d.select().from(schema.customRules).all()[0]!;
    expect(row.artist).toBe('Pavement');
    expect(row.fromTitle).toBe(RULE.fromTitle);
  });
});
