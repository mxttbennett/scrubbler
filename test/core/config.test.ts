import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';

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

  it('turns on an experimental group when named', () => {
    const cfg = loadConfig({ ...BASE, RULES_EXPERIMENTAL_ENABLED: 'live,ep-single' });
    expect(cfg.enabledGroups.has('live')).toBe(true);
    expect(cfg.enabledGroups.has('ep-single')).toBe(true);
  });

  it('rejects an unknown group rather than silently ignoring a typo', () => {
    expect(() => loadConfig({ ...BASE, RULES_ENABLED: 'remaster,remastr' })).toThrow(
      /Invalid RULES_ENABLED entry: "remastr"/,
    );
  });

  it('rejects an experimental group listed in the stable list, and vice versa', () => {
    expect(() => loadConfig({ ...BASE, RULES_ENABLED: 'remaster,live' })).toThrow(
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
