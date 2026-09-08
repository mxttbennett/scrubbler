import { describe, expect, it } from 'vitest';
import { shadowVerdicts } from '../../src/rules/shadow.js';
import { DEFAULT_ENABLED, type GroupName } from '../../src/rules/markers.js';

const ENABLED = new Set<GroupName>(DEFAULT_ENABLED);

function rules(title: string, field: 'track' | 'album', enabled = ENABLED): string[] {
  return shadowVerdicts(title, field, enabled).map((v) => v.rule);
}

describe('shadowVerdicts', () => {
  it('reports what a disabled rule would have done', () => {
    const v = shadowVerdicts('all apologies (Live)', 'track', ENABLED);

    expect(v).toEqual([{ rule: 'live-track', wouldBe: 'all apologies - Live' }]);
  });

  it('says nothing for a title no rule touches', () => {
    expect(rules('Unknown Pleasures', 'album')).toEqual([]);
    expect(rules('Franklin the Tower', 'track')).toEqual([]);
  });

  /**
   * The diff is against the *enabled* result, not the raw title — otherwise every catalogue hit
   * would also be reported as a shadow hit for every disabled rule.
   */
  it('says nothing when a stable rule already produces the same answer', () => {
    expect(rules('Rumours (Deluxe Edition)', 'album')).toEqual([]);
  });

  it('does report when a disabled rule would go further than the stable one', () => {
    const v = shadowVerdicts('Nevermind (Deluxe Edition) (Live)', 'track', ENABLED);

    // Only the trailing segment is ever examined, so reformatting it leaves the earlier one in
    // place — the live label is content now, and the edition marker is no longer trailing.
    expect(v.map((x) => x.rule)).toContain('live-track');
    expect(v.find((x) => x.rule === 'live-track')?.wouldBe).toBe(
      'Nevermind (Deluxe Edition) - Live',
    );
  });

  it('never reports a rule that does not apply to the field', () => {
    // live-track is track-only; ep-single and feat-album are album-only.
    expect(rules('Yessongs (Live)', 'album')).not.toContain('live-track');
    expect(rules('Midnight City - EP', 'track')).not.toContain('ep-single');
    expect(rules('Mamushi (feat. Yuki Chiba)', 'track')).not.toContain('feat-album');
    expect(rules('Mamushi (feat. Yuki Chiba)', 'track')).toContain('feat-track');
  });

  it('never reports a rule that is already enabled', () => {
    const withLive = new Set<GroupName>([...DEFAULT_ENABLED, 'live-track']);

    expect(rules('all apologies (Live)', 'track', ENABLED)).toContain('live-track');
    expect(rules('all apologies (Live)', 'track', withLive)).not.toContain('live-track');
  });

  it('leaves a title alone when Live is not a bracketed trailing segment', () => {
    for (const [title, field] of [
      ['The King of Limbs: Live from the Basement', 'album'],
      ['Live at Leeds', 'album'],
      ['Sister Ray - Live in Rotterdam 1984', 'track'],
      ['Song - Live at the Apollo', 'track'],
    ] as [string, 'track' | 'album'][]) {
      expect(rules(title, field)).toEqual([]);
    }
  });

  it("gives each verdict that rule's own partial result", () => {
    const v = shadowVerdicts('Song (feat. Someone) (Live)', 'track', ENABLED);
    const byRule = new Map(v.map((x) => [x.rule, x.wouldBe]));

    // Single-rule by construction: each verdict is that rule's own partial result, because
    // cleanTitle can only act on what its enabled set contains.
    expect(byRule.get('live-track')).toBe('Song (feat. Someone) - Live');
    expect([...byRule.keys()]).toContain('live-track');
  });

  it('carries the replacement, not just the rule name', () => {
    const v = shadowVerdicts('Gemini IIV (Radio Edit)', 'track', ENABLED);

    expect(v).toEqual([{ rule: 'version', wouldBe: 'Gemini IIV' }]);
  });

  it('consults a custom override, so a rule cannot claim a title the user renamed', () => {
    const lookup = () => 'Renamed';
    const v = shadowVerdicts('all apologies (Live)', 'track', ENABLED, {
      artist: 'Nirvana',
      lookup,
    });

    // The override already changed it, so live-track adds nothing.
    expect(v).toEqual([]);
  });
});
