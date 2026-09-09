import { describe, expect, it } from 'vitest';
import { createDb, runMigrations, schema } from '../../src/db/index.js';
import { TierRejected, TierStore } from '../../src/rules/tierStore.js';
import { DEFAULT_TIERS, type GroupName, type Tier } from '../../src/rules/markers.js';

function store(
  envTiers: Partial<Record<GroupName, Tier>> = {},
  opts: { approvalMode?: boolean; discordConfigured?: boolean; warnings?: string[] } = {},
) {
  const d = createDb(':memory:');
  runMigrations(d);
  const warnings = opts.warnings ?? [];
  const tiers = { ...DEFAULT_TIERS, ...envTiers };
  return {
    d,
    warnings,
    tiers: new TierStore(d, tiers, {
      approvalMode: opts.approvalMode ?? false,
      discordConfigured: opts.discordConfigured ?? true,
      explicitTiers: envTiers,
      log: (msg) => warnings.push(msg),
    }),
  };
}

describe('TierStore', () => {
  it('resolves default, env override, database override and reset in that order', () => {
    const { tiers } = store({ 'live-track': 'gated' });

    expect(tiers.effective()['live-track']).toBe('gated');
    expect(tiers.sourceOf('live-track')).toBe('env');
    expect(tiers.sourceOf('remaster')).toBe('default');

    tiers.set('live-track', 'off');

    expect(tiers.effective()['live-track']).toBe('off');
    expect(tiers.sourceOf('live-track')).toBe('override');

    tiers.reset('live-track');

    expect(tiers.effective()['live-track']).toBe('gated');
    expect(tiers.sourceOf('live-track')).toBe('env');
  });

  it('coerces auto to gated after the database overlay when approval mode is on', () => {
    const { tiers } = store({ 'live-track': 'auto' }, { approvalMode: true });

    tiers.set('edition', 'auto');
    tiers.set('bonus', 'off');

    expect(tiers.effective()['live-track']).toBe('gated');
    expect(tiers.effective().edition).toBe('gated');
    expect(tiers.effective().bonus).toBe('off');
  });

  it('returns immutable snapshots and invalidates cached sets on write', () => {
    const { tiers } = store();
    const before = tiers.enabled();

    expect(Object.isFrozen(tiers.effective())).toBe(true);
    expect(Object.isFrozen(before)).toBe(true);
    expect(before.has('live-track')).toBe(false);

    tiers.set('live-track', 'auto');

    expect(before.has('live-track')).toBe(false);
    expect(tiers.enabled().has('live-track')).toBe(true);
    expect(tiers.gated().has('live-track')).toBe(false);
  });

  it('refuses a gated override when Discord is not configured', () => {
    const { tiers } = store({}, { discordConfigured: false });

    expect(() => tiers.set('live-track', 'gated')).toThrow(TierRejected);
    expect(tiers.effective()['live-track']).toBe('off');
  });

  it('ignores stale database rows that are no longer group names', () => {
    const { d, warnings, tiers } = store({}, { warnings: [] });
    d.insert(schema.ruleTiers)
      .values({ group: 'retired-rule', tier: 'auto', updatedAt: new Date() })
      .run();

    const reloaded = new TierStore(d, DEFAULT_TIERS, {
      approvalMode: false,
      discordConfigured: true,
      explicitTiers: {},
      log: (msg) => warnings.push(msg),
    });

    expect(reloaded.effective()).toEqual(tiers.effective());
    expect(warnings.join('\n')).toContain('retired-rule');
  });
});
