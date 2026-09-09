import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { readPackageVersion } from '../../src/core/version.js';

const BASE = {
  LASTFM_USERNAME: 'u',
  LASTFM_PASSWORD: 'p',
  LASTFM_API_KEY: 'k',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('defaults to a dry run, so a fresh deploy cannot write', () => {
    expect(loadConfig({ ...BASE }).dryRun).toBe(true);
  });

  it('enables only the non-experimental groups by default', () => {
    const groups = [...loadConfig({ ...BASE }).enabledGroups].sort();
    expect(groups).toEqual(['bonus', 'edition', 'remaster']);
  });

  it('does not send a browser-impersonating User-Agent, which Last.fm answers with 406', () => {
    expect(loadConfig({ ...BASE }).userAgent).not.toMatch(/^Mozilla\/5\.0/);
    expect(loadConfig({ ...BASE }).userAgent).toContain('scrubbler');
  });

  it('names the real package version, so Last.fm logs identify the running build', () => {
    expect(loadConfig({ ...BASE }).userAgent).toContain(`scrubbler/${readPackageVersion()}`);
  });

  it('turns on an experimental group when named', () => {
    const cfg = loadConfig({ ...BASE, RULES_EXPERIMENTAL_ENABLED: 'live-track,ep-single' });
    expect(cfg.enabledGroups.has('live-track')).toBe(true);
    expect(cfg.enabledGroups.has('ep-single')).toBe(true);
  });

  it('rejects an unknown group rather than silently ignoring a typo', () => {
    expect(() => loadConfig({ ...BASE, RULES_ENABLED: 'remaster,remastr' })).toThrow(
      /Invalid RULES_ENABLED entry: "remastr"/,
    );
  });

  it('rejects an experimental group listed in the stable list, and vice versa', () => {
    expect(() => loadConfig({ ...BASE, RULES_ENABLED: 'remaster,live-track' })).toThrow(
      /belongs in RULES_EXPERIMENTAL_ENABLED/,
    );
    expect(() => loadConfig({ ...BASE, RULES_EXPERIMENTAL_ENABLED: 'remaster' })).toThrow(
      /belongs in RULES_ENABLED/,
    );
  });

  it('rejects a missing credential', () => {
    expect(() => loadConfig({ LASTFM_USERNAME: 'u', LASTFM_API_KEY: 'k' })).toThrow(
      /Invalid environment/,
    );
  });

  it('rejects a non-boolean flag instead of coercing it', () => {
    expect(() => loadConfig({ ...BASE, DRY_RUN: 'maybe' })).toThrow(/Invalid DRY_RUN/);
  });

  it('rejects a negative or fractional interval', () => {
    expect(() => loadConfig({ ...BASE, WRITE_DELAY_MS: '-1' })).toThrow(/Invalid WRITE_DELAY_MS/);
    expect(() => loadConfig({ ...BASE, MAX_EDITS_PER_RUN: '1.5' })).toThrow(
      /Invalid MAX_EDITS_PER_RUN/,
    );
  });

  it('accepts the documented boolean spellings', () => {
    expect(loadConfig({ ...BASE, DRY_RUN: 'false' }).dryRun).toBe(false);
    expect(loadConfig({ ...BASE, DRY_RUN: '0' }).dryRun).toBe(false);
    expect(loadConfig({ ...BASE, DRY_RUN: 'ON' }).dryRun).toBe(true);
  });
});

describe('loadConfig — approval mode', () => {
  const DISCORD = {
    DISCORD_BOT_TOKEN: 't',
    DISCORD_CHANNEL_ID: 'c',
    DISCORD_OWNER_ID: 'o',
    DISCORD_GUILD_ID: 'g',
  };

  it('is off unless asked for, so an existing deploy keeps behaving the same', () => {
    expect(loadConfig({ ...BASE }).approvalMode).toBe(false);
  });

  it('turns on with the full discord set', () => {
    const config = loadConfig({ ...BASE, ...DISCORD, APPROVAL_MODE: 'true' });
    expect(config.approvalMode).toBe(true);
    expect(config.discordOwnerId).toBe('o');
    expect(config.discordGuildId).toBe('g');
  });

  it('refuses to start when a proposal could not be clicked', () => {
    expect(() => loadConfig({ ...BASE, APPROVAL_MODE: 'true' })).toThrow(
      /requires DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, DISCORD_OWNER_ID, DISCORD_GUILD_ID/,
    );
  });

  it('names only what is actually missing', () => {
    expect(() =>
      loadConfig({ ...BASE, ...DISCORD, DISCORD_OWNER_ID: '', APPROVAL_MODE: 'true' }),
    ).toThrow(/requires DISCORD_OWNER_ID$/);
  });

  it('does not require the discord set when the mode is off', () => {
    expect(() => loadConfig({ ...BASE, APPROVAL_MODE: 'false' })).not.toThrow();
  });

  it('defaults the expiry to a week and the gateway alert to a quarter hour', () => {
    const config = loadConfig({ ...BASE });
    expect(config.approvalTtlHours).toBe(168);
    expect(config.gatewayAlertMinutes).toBe(15);
  });

  it('names the real groups when an old config still says "live"', () => {
    // The group was split into live-album and live-track; an unchanged .env must fail loudly.
    expect(() => loadConfig({ ...BASE, RULES_EXPERIMENTAL_ENABLED: 'live' })).toThrow(
      /known groups: .*live-track/,
    );
  });

  it('leaves shadow mode off, so updating the code cannot change what the channel shows', () => {
    expect(loadConfig({ ...BASE }).shadowMode).toBe(false);
  });

  it('caps shadow posting per sweep, and treats 0 as record-only rather than an error', () => {
    expect(loadConfig({ ...BASE }).shadowMaxPerSweep).toBe(50);
    expect(loadConfig({ ...BASE, SHADOW_MAX_PER_SWEEP: '0' }).shadowMaxPerSweep).toBe(0);
    expect(loadConfig({ ...BASE, SHADOW_MODE: 'true' }).shadowMode).toBe(true);
  });

  it('rejects a shadow cap that is not a number', () => {
    expect(() => loadConfig({ ...BASE, SHADOW_MAX_PER_SWEEP: 'lots' })).toThrow(
      /Invalid SHADOW_MAX_PER_SWEEP/,
    );
    expect(() => loadConfig({ ...BASE, SHADOW_MODE: 'maybe' })).toThrow(/Invalid SHADOW_MODE/);
  });
});

describe('loadConfig — web grid', () => {
  it('leaves the grid off by default, so an upgrade opens no port', () => {
    const config = loadConfig({ ...BASE });
    expect(config.webEnabled).toBe(false);
    expect(config.webPort).toBe(8787);
  });

  it('accepts every boolean spelling the other flags accept', () => {
    for (const value of ['true', '1', 'yes', 'on']) {
      expect(loadConfig({ ...BASE, WEB_ENABLED: value }).webEnabled).toBe(true);
    }
    for (const value of ['false', '0', 'no', 'off']) {
      expect(loadConfig({ ...BASE, WEB_ENABLED: value }).webEnabled).toBe(false);
    }
  });

  it('refuses a WEB_ENABLED value that is neither', () => {
    expect(() => loadConfig({ ...BASE, WEB_ENABLED: 'maybe' })).toThrow(/WEB_ENABLED/);
  });

  it('takes a port and refuses one that is not a whole positive number', () => {
    expect(loadConfig({ ...BASE, WEB_PORT: '9000' }).webPort).toBe(9000);
    for (const value of ['-1', '80.5', 'http']) {
      expect(() => loadConfig({ ...BASE, WEB_PORT: value })).toThrow(/WEB_PORT/);
    }
  });
});
