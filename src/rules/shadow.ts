import { cleanTitle, type OverrideLookup } from './engine.js';
import { ALL_GROUPS, type Field, type GroupName, MARKER_GROUPS } from './markers.js';

export interface ShadowVerdict {
  rule: GroupName;
  wouldBe: string;
}

export interface ShadowHit extends ShadowVerdict {
  kind: Field;
  artist: string;
  title: string;
}

/**
 * What each rule that is *off* would do to this title, and nothing else. An `auto` or `gated` rule is
 * excluded by the `enabled` check below — a gated rule already shows its candidates as real cards.
 *
 * The comparison is against the currently-enabled result, not the raw title: most titles are already
 * handled by a stable group, and the only interesting event is an experimental group producing a
 * different answer.
 *
 * Single-rule by construction. `cleanTitle` can only strip what its enabled set contains, so a title
 * needing two disabled groups is reported once per group with that group's own partial result rather
 * than the combined one. Reporting the combination would describe an outcome no single toggle
 * produces.
 */
export function shadowVerdicts(
  title: string,
  field: Field,
  enabled: ReadonlySet<GroupName>,
  override?: { artist: string; lookup: OverrideLookup },
): ShadowVerdict[] {
  const actual = cleanTitle(title, field, enabled, override)?.clean ?? null;
  const out: ShadowVerdict[] = [];

  for (const rule of ALL_GROUPS) {
    if (enabled.has(rule)) continue;
    if (!MARKER_GROUPS[rule].appliesTo.includes(field)) continue;

    const widened = new Set(enabled);
    widened.add(rule);
    const would = cleanTitle(title, field, widened, override)?.clean ?? null;
    if (would !== null && would !== actual) out.push({ rule, wouldBe: would });
  }

  return out;
}
