import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { ALL_GROUPS } from '../../src/rules/markers.js';

const BASE = {
  LASTFM_USERNAME: 'u',
  LASTFM_PASSWORD: 'p',
  LASTFM_API_KEY: 'k',
};

const DISCORD = {
  DISCORD_BOT_TOKEN: 't',
  DISCORD_CHANNEL_ID: 'c',
  DISCORD_OWNER_ID: 'o',
  DISCORD_GUILD_ID: 'g',
};

describe('RULES tiers', () => {
  it('reads each tier, and leaves unnamed groups on their default', () => {
    const c = loadConfig({ ...BASE, ...DISCORD, RULES: 'remaster:auto,live-album:gated,edition:off' });

    expect(c.tiers['remaster']).toBe('auto');
    expect(c.tiers['live-album']).toBe('gated');
    expect(c.tiers['edition']).toBe('off');
    expect(c.tiers['bonus']).toBe('auto');
    expect(c.tiers['feat-track']).toBe('off');
  });

  /** enabledGroups is what the engine fires; gated must be in it or a gated rule nominates nothing. */
  it('puts gated groups in enabledGroups as well as gatedGroups', () => {
    const c = loadConfig({ ...BASE, ...DISCORD, RULES: 'live-album:gated' });

    expect(c.enabledGroups.has('live-album')).toBe(true);
    expect(c.gatedGroups.has('live-album')).toBe(true);
    expect(c.enabledGroups.has('remaster')).toBe(true);
    expect(c.gatedGroups.has('remaster')).toBe(false);
  });

  it('leaves an off group out of both', () => {
    const c = loadConfig({ ...BASE, RULES: 'remaster:off' });
    expect(c.enabledGroups.has('remaster')).toBe(false);
    expect(c.gatedGroups.has('remaster')).toBe(false);
  });

  it('names the unknown group and the known ones', () => {
    expect(() => loadConfig({ ...BASE, RULES: 'remastr:auto' })).toThrow(
      /Invalid RULES entry: "remastr" \(known groups: /,
    );
  });

  it('names the bad tier and the legal ones', () => {
    expect(() => loadConfig({ ...BASE, RULES: 'remaster:sometimes' })).toThrow(
      /Invalid RULES tier for "remaster": "sometimes" \(want auto, gated or off\)/,
    );
  });

  it('rejects an entry with no tier at all', () => {
    expect(() => loadConfig({ ...BASE, RULES: 'remaster' })).toThrow(/want group:tier/);
  });

  it('tolerates whitespace and a trailing comma', () => {
    const c = loadConfig({ ...BASE, RULES: ' remaster : off , bonus:off ,' });
    expect(c.tiers['remaster']).toBe('off');
    expect(c.tiers['bonus']).toBe('off');
  });

  it('defaults every group when RULES and the legacy vars are all absent', () => {
    const c = loadConfig(BASE);
    expect([...c.enabledGroups].sort()).toEqual(['bonus', 'edition', 'remaster']);
    expect(c.gatedGroups.size).toBe(0);
    expect(c.configWarnings).toEqual([]);
  });
});

describe('RULES and the deprecated two-list vars', () => {
  /**
   * The legacy vars carry schema defaults, so presence has to be read from the raw env — otherwise
   * every RULES startup would see RULES_ENABLED set and refuse.
   */
  it('does not mistake a schema default for an operator setting', () => {
    const c = loadConfig({ ...BASE, RULES: 'remaster:off' });
    expect(c.tiers['remaster']).toBe('off');
  });

  it('refuses RULES alongside either legacy var', () => {
    expect(() =>
      loadConfig({ ...BASE, RULES: 'remaster:auto', RULES_ENABLED: 'remaster' }),
    ).toThrow(/RULES cannot be combined with RULES_ENABLED/);
    expect(() =>
      loadConfig({ ...BASE, RULES: 'remaster:auto', RULES_EXPERIMENTAL_ENABLED: 'live-album' }),
    ).toThrow(/RULES cannot be combined with RULES_EXPERIMENTAL_ENABLED/);
  });

  it('derives auto tiers from the legacy pair and warns', () => {
    const c = loadConfig({
      ...BASE,
      RULES_ENABLED: 'remaster,edition',
      RULES_EXPERIMENTAL_ENABLED: 'live-album',
    });

    expect(c.tiers['remaster']).toBe('auto');
    expect(c.tiers['edition']).toBe('auto');
    expect(c.tiers['live-album']).toBe('auto');
    expect(c.tiers['bonus']).toBe('off');
    expect(c.gatedGroups.size).toBe(0);
    expect(c.configWarnings.join(' ')).toMatch(/deprecated/);
  });

  /** The live box sets only these two, so its behaviour must be identical after the upgrade. */
  it('reproduces the deployed config exactly', () => {
    const c = loadConfig({
      ...BASE,
      RULES_ENABLED: 'remaster,edition,bonus',
      RULES_EXPERIMENTAL_ENABLED: 'live-album',
    });

    expect([...c.enabledGroups].sort()).toEqual(['bonus', 'edition', 'live-album', 'remaster']);
    expect(c.gatedGroups.size).toBe(0);
  });
});

describe('APPROVAL_MODE as sugar for supervising everything', () => {
  it('promotes every auto group to gated', () => {
    const c = loadConfig({ ...BASE, ...DISCORD, APPROVAL_MODE: 'true', RULES: 'live-album:off' });

    for (const g of ALL_GROUPS) expect(c.tiers[g]).not.toBe('auto');
    expect(c.gatedGroups.has('remaster')).toBe(true);
    expect(c.tiers['live-album']).toBe('off');
  });

  it('leaves off groups off', () => {
    const c = loadConfig({ ...BASE, ...DISCORD, APPROVAL_MODE: 'true' });
    expect(c.gatedGroups.has('feat-track')).toBe(false);
    expect(c.enabledGroups.has('feat-track')).toBe(false);
  });
});

describe('a gated rule needs somewhere to post its card', () => {
  it('refuses to start when a gated tier has no Discord config', () => {
    expect(() => loadConfig({ ...BASE, RULES: 'live-album:gated' })).toThrow(
      /A gated rule \(live-album\) requires DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, DISCORD_OWNER_ID, DISCORD_GUILD_ID/,
    );
  });

  it('still blames APPROVAL_MODE when that is what gated them', () => {
    expect(() => loadConfig({ ...BASE, APPROVAL_MODE: 'true' })).toThrow(
      /APPROVAL_MODE=true requires DISCORD_BOT_TOKEN/,
    );
  });

  it('asks for nothing when every rule is auto or off', () => {
    expect(() => loadConfig({ ...BASE, RULES: 'remaster:auto,edition:off' })).not.toThrow();
  });
});
