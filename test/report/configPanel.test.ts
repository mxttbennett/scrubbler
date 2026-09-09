import { describe, expect, it } from 'vitest';
import { createDb, runMigrations, schema } from '../../src/db/index.js';
import { DEFAULT_TIERS } from '../../src/rules/markers.js';
import { TierStore } from '../../src/rules/tierStore.js';
import {
  ConfigPanel,
  backId,
  parseConfigId,
  pickId,
  renderPanel,
  resetId,
  setId,
} from '../../src/report/configPanel.js';

const state = {
  tiers: { ...DEFAULT_TIERS, 'live-track': 'off', punctuation: 'gated' },
  sourceOf: (group: string) =>
    group === 'live-track' ? 'override' : group === 'punctuation' ? 'env' : 'default',
  paused: false,
  approvalMode: false,
} as const;

describe('config panel ids', () => {
  it('round-trips the ids the renderer issues', () => {
    expect(parseConfigId(pickId())).toEqual({ action: 'pick' });
    expect(parseConfigId(setId('live-track', 'off'))).toEqual({
      action: 'set',
      group: 'live-track',
      tier: 'off',
    });
    expect(parseConfigId(resetId('live-track'))).toEqual({
      action: 'reset',
      group: 'live-track',
    });
    expect(parseConfigId(backId())).toEqual({ action: 'back' });
    expect(parseConfigId('cfg:pause')).toEqual({ action: 'pause' });
    expect(parseConfigId('cfg:resume')).toEqual({ action: 'resume' });
  });

  it('rejects malformed ids', () => {
    expect(parseConfigId('approve:1')).toBeUndefined();
    expect(parseConfigId('cfg:set:not-a-rule:auto')).toBeUndefined();
    expect(parseConfigId('cfg:set:edition:sometimes')).toBeUndefined();
    expect(parseConfigId('cfg:reset')).toBeUndefined();
  });
});

describe('renderPanel', () => {
  it('renders the summary with tier sources and a picker', () => {
    const panel = renderPanel(state);

    expect(panel.content).toContain('Rule configuration');
    expect(panel.content).toContain('paused: no');
    expect(panel.content).toContain('live-track');
    expect(panel.content).toContain('off');
    expect(panel.content).toContain('(override)');
    expect(panel.content).toContain('punctuation');
    expect(panel.content).toContain('(env)');
    expect((panel.components[0] as { components: { type: number }[] }).components[0]?.type).toBe(3);
  });

  it('renders a selected rule with tier buttons, reset, back and pause controls', () => {
    const panel = renderPanel({ ...state, selected: 'live-track' });
    const raw = JSON.stringify(panel.components);

    expect(panel.content).toContain('live-track - currently off (override)');
    expect(raw).toContain(setId('live-track', 'auto'));
    expect(raw).toContain(setId('live-track', 'gated'));
    expect(raw).toContain(setId('live-track', 'off'));
    expect(raw).toContain(resetId('live-track'));
    expect(raw).toContain(backId());
    expect(raw).toContain('cfg:pause');
  });

  it('shows paused state and resume control', () => {
    const panel = renderPanel({ ...state, paused: true, selected: 'edition' });
    const raw = JSON.stringify(panel.components);

    expect(panel.content).toContain('paused: yes');
    expect(raw).toContain('cfg:resume');
  });

  it('states when approval mode is coercing auto to gated', () => {
    const panel = renderPanel({ ...state, approvalMode: true });

    expect(panel.content).toContain('APPROVAL_MODE is forcing auto rules to gated');
  });

  it('asks for confirmation before turning off a group with pending proposals', () => {
    const panel = renderPanel({
      ...state,
      selected: 'live-track',
      confirmOff: { group: 'live-track', pending: 41 },
    });

    expect(panel.content).toContain('live-track has 41 proposal(s) pending');
    expect(JSON.stringify(panel.components)).toContain('cfg:set:live-track:off:confirm');
  });
});

describe('ConfigPanel', () => {
  it('renders confirmation before persisting off for a group with pending proposals', async () => {
    const d = createDb(':memory:');
    runMigrations(d);
    const tiers = new TierStore(d, { ...DEFAULT_TIERS, 'live-track': 'gated' }, {
      approvalMode: false,
      discordConfigured: true,
      explicitTiers: { 'live-track': 'gated' },
    });
    d.insert(schema.approvals)
      .values({
        groupKey: 'k',
        artist: 'Nirvana',
        kind: 'track',
        itemCount: 41,
        status: 'pending',
      })
      .run();
    const panel = new ConfigPanel({ db: d, tiers, approvalMode: false });

    const first = panel.handle(setId('live-track', 'off'));

    expect(first.content).toContain('live-track has 1 proposal(s) pending');
    expect(tiers.effective()['live-track']).toBe('gated');

    panel.handle(setId('live-track', 'off', true));

    expect(tiers.effective()['live-track']).toBe('off');
  });
});
