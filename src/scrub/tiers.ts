import { type GroupName, type Tier, isGroupName } from '../rules/markers.js';
import { type EditGroup, type PlannedEdit, toGroup } from './types.js';

/**
 * Whether a tuple must be approved before it is written.
 *
 * Any gated tag gates the whole tuple, because the tuple is indivisible: `Resolver.fold` folds a
 * track rename and an album rename into one `next`, and two POSTs against one `*_original` 4-tuple
 * cannot both land. Splitting would auto-apply half of a change the operator asked to review.
 *
 * A tag that is not a group name — `custom`, or a stale string read back through the ledger's
 * unchecked cast — does not gate on its own, so a custom replacement behaves as it always has.
 */
export function isGated(groups: readonly string[], gated: ReadonlySet<GroupName>): boolean {
  return groups.some((g) => isGroupName(g) && gated.has(g));
}

export interface TierSplit {
  off: EditGroup | undefined;
  gated: EditGroup | undefined;
  auto: EditGroup | undefined;
}

/**
 * Splits one candidate's group into the part that needs a decision and the part that does not.
 *
 * Safe because a group's members are distinct tuples — `fold` is keyed by `tupleKey` and dedupes —
 * so `shared` is re-derived per side rather than inherited. An album group holds a single edit and
 * therefore goes one way whole.
 */
export function partitionByTier(group: EditGroup, tiers: Readonly<Record<GroupName, Tier>>): TierSplit {
  if (group.kind === 'album') {
    const tier = tierOf(group.album.groups, tiers);
    return {
      off: tier === 'off' ? group : undefined,
      gated: tier === 'gated' ? group : undefined,
      auto: tier === 'auto' ? group : undefined,
    };
  }

  const offEdits: PlannedEdit[] = [];
  const gatedEdits: PlannedEdit[] = [];
  const autoEdits: PlannedEdit[] = [];
  for (const edit of group.edits) {
    const tier = tierOf(edit.groups, tiers);
    if (tier === 'off') offEdits.push(edit);
    else if (tier === 'gated') gatedEdits.push(edit);
    else autoEdits.push(edit);
  }

  return {
    off: offEdits.length === 0 ? undefined : toGroup(group.artist, offEdits),
    gated: gatedEdits.length === 0 ? undefined : toGroup(group.artist, gatedEdits),
    auto: autoEdits.length === 0 ? undefined : toGroup(group.artist, autoEdits),
  };
}

function tierOf(groups: readonly string[], tiers: Readonly<Record<GroupName, Tier>>): Tier {
  let tier: Tier = 'auto';
  for (const group of groups) {
    if (!isGroupName(group)) continue;
    if (tiers[group] === 'off') return 'off';
    if (tiers[group] === 'gated') tier = 'gated';
  }
  return tier;
}
