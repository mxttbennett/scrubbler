import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import {
  ALL_GROUPS,
  type GroupName,
  type Tier,
  isGroupName,
  isTier,
} from './markers.js';

export class TierRejected extends Error {}

export interface TierStoreOptions {
  approvalMode: boolean;
  discordConfigured: boolean;
  explicitTiers?: Partial<Record<GroupName, Tier>>;
  log?: (msg: string) => void;
}

export class TierStore {
  private readonly envTiers: Record<GroupName, Tier>;
  private readonly explicitTiers: Partial<Record<GroupName, Tier>>;
  private overrides = new Map<GroupName, Tier>();
  private effectiveCache: Readonly<Record<GroupName, Tier>> | undefined;
  private enabledCache: ReadonlySet<GroupName> | undefined;
  private gatedCache: ReadonlySet<GroupName> | undefined;

  constructor(
    private readonly db: Db,
    envTiers: Record<GroupName, Tier>,
    private readonly opts: TierStoreOptions,
  ) {
    this.envTiers = { ...envTiers };
    this.explicitTiers = { ...(opts.explicitTiers ?? {}) };
    this.reload();
  }

  effective(): Readonly<Record<GroupName, Tier>> {
    if (this.effectiveCache !== undefined) return this.effectiveCache;
    const tiers = { ...this.envTiers };
    for (const [group, tier] of this.overrides) tiers[group] = tier;
    if (this.opts.approvalMode) {
      for (const group of ALL_GROUPS) if (tiers[group] === 'auto') tiers[group] = 'gated';
    }
    this.effectiveCache = Object.freeze(tiers);
    return this.effectiveCache;
  }

  enabled(): ReadonlySet<GroupName> {
    if (this.enabledCache !== undefined) return this.enabledCache;
    this.enabledCache = readonlySet(ALL_GROUPS.filter((group) => this.effective()[group] !== 'off'));
    return this.enabledCache;
  }

  gated(): ReadonlySet<GroupName> {
    if (this.gatedCache !== undefined) return this.gatedCache;
    this.gatedCache = readonlySet(ALL_GROUPS.filter((group) => this.effective()[group] === 'gated'));
    return this.gatedCache;
  }

  set(group: GroupName, tier: Tier): void {
    if (!isGroupName(group)) throw new TierRejected(`Unknown rule group: ${String(group)}`);
    if (!isTier(tier)) throw new TierRejected(`Unknown tier: ${String(tier)}`);
    if (tier === 'gated' && !this.opts.discordConfigured) {
      throw new TierRejected('Gated rules require Discord to be configured.');
    }

    this.db
      .insert(schema.ruleTiers)
      .values({ group, tier, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.ruleTiers.group,
        set: { tier, updatedAt: new Date() },
      })
      .run();
    this.reload();
  }

  reset(group: GroupName): void {
    if (!isGroupName(group)) throw new TierRejected(`Unknown rule group: ${String(group)}`);
    this.db.delete(schema.ruleTiers).where(eq(schema.ruleTiers.group, group)).run();
    this.reload();
  }

  sourceOf(group: GroupName): 'override' | 'env' | 'default' {
    if (this.overrides.has(group)) return 'override';
    return this.explicitTiers[group] === undefined ? 'default' : 'env';
  }

  private reload(): void {
    const next = new Map<GroupName, Tier>();
    for (const row of this.db.select().from(schema.ruleTiers).all()) {
      if (!isGroupName(row.group) || !isTier(row.tier)) {
        this.log(`ignored unknown rule_tiers row: ${row.group}`);
        continue;
      }
      next.set(row.group, row.tier);
    }
    this.overrides = next;
    this.effectiveCache = undefined;
    this.enabledCache = undefined;
    this.gatedCache = undefined;
  }

  private log(msg: string): void {
    (this.opts.log ?? ((m: string) => console.warn(m)))(msg);
  }
}

function readonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  const backing = new Set(values);
  const out: ReadonlySet<T> = Object.freeze({
    get size() {
      return backing.size;
    },
    has: (value: T) => backing.has(value),
    forEach: (callback: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown) => {
      backing.forEach((value) => callback.call(thisArg, value, value, out));
    },
    entries: () => backing.entries(),
    keys: () => backing.keys(),
    values: () => backing.values(),
    [Symbol.iterator]: () => backing[Symbol.iterator](),
  } as ReadonlySet<T>);
  return out;
}
