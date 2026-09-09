import 'dotenv/config';
import { z } from 'zod';
import { readPackageVersion } from './version.js';
import {
  ALL_GROUPS,
  DEFAULT_ENABLED,
  DEFAULT_TIERS,
  type Tier,
  isTier,
  type GroupName,
  MARKER_GROUPS,
  isGroupName,
} from '../rules/markers.js';

// Last.fm answers any Mozilla/5.0-prefixed User-Agent with 406, so identify honestly.
const DEFAULT_USER_AGENT = `scrubbler/${readPackageVersion()} (+https://github.com/mxttbennett/scrubbler)`;

const envSchema = z.object({
  LASTFM_USERNAME: z.string().min(1),
  LASTFM_PASSWORD: z.string().min(1),
  LASTFM_API_KEY: z.string().min(1),
  DB_PATH: z.string().default('.data/scrubbler.sqlite'),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_CHANNEL_ID: z.string().optional(),
  DISCORD_OWNER_ID: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  APPROVAL_MODE: z.string().default('false'),
  APPROVAL_TTL_HOURS: z.string().default('168'),
  GATEWAY_ALERT_MINUTES: z.string().default('15'),
  SHADOW_MODE: z.string().default('false'),
  SHADOW_MAX_PER_SWEEP: z.string().default('50'),
  DIGEST_EVERY: z.string().default('1'),
  DRY_RUN: z.string().default('true'),
  RULES: z.string().default(''),
  RULES_ENABLED: z.string().default(DEFAULT_ENABLED.join(',')),
  RULES_EXPERIMENTAL_ENABLED: z.string().default(''),
  SWEEP_INTERVAL_MS: z.string().default('21600000'),
  FULL_SWEEP_INTERVAL_MS: z.string().default('604800000'),
  DEAD_CANDIDATE_ATTEMPTS: z.string().default('3'),
  MAX_EDITS_PER_RUN: z.string().default('2000'),
  WRITE_DELAY_MS: z.string().default('3000'),
  PAGE_DELAY_MS: z.string().default('15000'),
  PAGE_DELAY_JITTER_MS: z.string().default('5000'),
  VERIFY_EDITS: z.string().default('true'),
  VERIFY_DELAY_MS: z.string().default('2000'),
  VERIFY_ATTEMPTS: z.string().default('3'),
  SHUTDOWN_GRACE_MS: z.string().default('60000'),
  WEB_ENABLED: z.string().default('false'),
  WEB_PORT: z.string().default('8787'),
  USER_AGENT: z.string().default(DEFAULT_USER_AGENT),
});

export interface Config {
  username: string;
  password: string;
  apiKey: string;
  dbPath: string;
  discordBotToken: string | undefined;
  discordChannelId: string | undefined;
  discordOwnerId: string | undefined;
  discordGuildId: string | undefined;
  /** Read once at startup: the worker never re-reads it, so switching modes needs a restart. */
  approvalMode: boolean;
  approvalTtlHours: number;
  gatewayAlertMinutes: number;
  /** Off by default, like DRY_RUN and APPROVAL_MODE: it changes what the channel shows. */
  shadowMode: boolean;
  /** 0 records without posting, which is a legitimate record-only mode rather than an error. */
  shadowMaxPerSweep: number;
  digestEvery: number;
  dryRun: boolean;
  /** Every group's tier. `enabledGroups` and `gatedGroups` are views of this. */
  tiers: Record<GroupName, Tier>;
  explicitTiers: Partial<Record<GroupName, Tier>>;
  /** auto ∪ gated — what the rule engine may fire. */
  enabledGroups: Set<GroupName>;
  /** Firing, but a candidate must be approved in Discord before it is written. */
  gatedGroups: Set<GroupName>;
  /** Deprecation notices for the caller to log; empty when the new config surface is used. */
  configWarnings: string[];
  sweepIntervalMs: number;
  fullSweepIntervalMs: number;
  deadCandidateAttempts: number;
  maxEditsPerRun: number;
  writeDelayMs: number;
  pageDelayMs: number;
  pageDelayJitterMs: number;
  verifyEdits: boolean;
  verifyDelayMs: number;
  verifyAttempts: number;
  shutdownGraceMs: number;
  userAgent: string;
  /** Off by default: it opens a local port and mirrors the library. */
  webEnabled: boolean;
  webPort: number;
}

function parseGroups(raw: string, label: string, expectExperimental: boolean): GroupName[] {
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

  for (const name of names) {
    if (!isGroupName(name)) {
      throw new Error(`Invalid ${label} entry: "${name}" (known groups: ${ALL_GROUPS.join(', ')})`);
    }
    if ((MARKER_GROUPS[name].defaultTier === 'off') !== expectExperimental) {
      const belongs = expectExperimental ? 'RULES_ENABLED' : 'RULES_EXPERIMENTAL_ENABLED';
      throw new Error(`Group "${name}" belongs in ${belongs}, not ${label}`);
    }
  }

  return names as GroupName[];
}

/** `group:tier` pairs. A group left unnamed keeps its default tier, so a partial RULES is legal. */
function parseTiers(raw: string): Partial<Record<GroupName, Tier>> {
  const out: Partial<Record<GroupName, Tier>> = {};
  for (const entry of raw.split(',').map((v) => v.trim())) {
    if (entry === '') continue;
    const split = entry.indexOf(':');
    if (split === -1) throw new Error(`Invalid RULES entry: "${entry}" (want group:tier)`);
    const name = entry.slice(0, split).trim();
    const tier = entry.slice(split + 1).trim();
    if (!isGroupName(name)) {
      throw new Error(`Invalid RULES entry: "${name}" (known groups: ${ALL_GROUPS.join(', ')})`);
    }
    if (!isTier(tier)) {
      throw new Error(`Invalid RULES tier for "${name}": "${tier}" (want auto, gated or off)`);
    }
    out[name] = tier;
  }
  return out;
}

/**
 * Presence is read from the raw env, never the parsed object: the legacy vars carry schema defaults,
 * so `parsed.data.RULES_ENABLED` is never empty and cannot answer "did the operator set this?".
 */
function legacyKeysIn(env: NodeJS.ProcessEnv): string[] {
  return (['RULES_ENABLED', 'RULES_EXPERIMENTAL_ENABLED'] as const).filter(
    (k) => env[k] !== undefined,
  );
}

function parseBool(raw: string, label: string): boolean {
  const value = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new Error(`Invalid ${label}: "${raw}" (want true or false)`);
}

function parsePositiveInt(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: "${raw}" (want a non-negative integer)`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;

  const approvalMode = parseBool(e.APPROVAL_MODE, 'APPROVAL_MODE');

  const configWarnings: string[] = [];
  const legacy = legacyKeysIn(env);
  const rulesSet = e.RULES.trim() !== '';
  if (rulesSet && legacy.length > 0) {
    throw new Error(`RULES cannot be combined with ${legacy.join(' or ')}; remove the older setting`);
  }

  let tiers: Record<GroupName, Tier>;
  let explicitTiers: Partial<Record<GroupName, Tier>> = {};
  if (rulesSet) {
    explicitTiers = parseTiers(e.RULES);
    tiers = { ...DEFAULT_TIERS, ...explicitTiers };
  } else if (legacy.length > 0) {
    const enabled = new Set<GroupName>([
      ...parseGroups(e.RULES_ENABLED, 'RULES_ENABLED', false),
      ...parseGroups(e.RULES_EXPERIMENTAL_ENABLED, 'RULES_EXPERIMENTAL_ENABLED', true),
    ]);
    tiers = Object.fromEntries(
      ALL_GROUPS.map((g) => [g, enabled.has(g) ? 'auto' : 'off']),
    ) as Record<GroupName, Tier>;
    configWarnings.push(
      `${legacy.join(' and ')} ${legacy.length === 1 ? 'is' : 'are'} deprecated; ` +
        `use RULES=${[...enabled].map((g) => `${g}:auto`).join(',') || 'group:tier'}`,
    );
  } else {
    tiers = { ...DEFAULT_TIERS };
  }

  // APPROVAL_MODE is kept as sugar for "supervise everything", so its behaviour is unchanged and
  // there is one rule for how the two settings interact instead of two switches to reconcile.
  if (approvalMode) {
    for (const g of ALL_GROUPS) if (tiers[g] === 'auto') tiers[g] = 'gated';
  }

  const enabledGroups = new Set<GroupName>(ALL_GROUPS.filter((g) => tiers[g] !== 'off'));
  const gatedGroups = new Set<GroupName>(ALL_GROUPS.filter((g) => tiers[g] === 'gated'));

  // A proposal nobody can see or click is worse than no approval gate at all. Any gated group needs
  // the full Discord set, not just the legacy global — a gated tier creates cards on its own.
  if (gatedGroups.size > 0) {
    const missing = (
      [
        ['DISCORD_BOT_TOKEN', e.DISCORD_BOT_TOKEN],
        ['DISCORD_CHANNEL_ID', e.DISCORD_CHANNEL_ID],
        ['DISCORD_OWNER_ID', e.DISCORD_OWNER_ID],
        ['DISCORD_GUILD_ID', e.DISCORD_GUILD_ID],
      ] as const
    )
      .filter(([, value]) => value === undefined || value.trim() === '')
      .map(([name]) => name);
    if (missing.length > 0) {
      const cause = approvalMode ? 'APPROVAL_MODE=true' : `A gated rule (${[...gatedGroups].join(', ')})`;
      throw new Error(`${cause} requires ${missing.join(', ')}`);
    }
  }

  return {
    username: e.LASTFM_USERNAME,
    password: e.LASTFM_PASSWORD,
    apiKey: e.LASTFM_API_KEY,
    dbPath: e.DB_PATH,
    discordBotToken: e.DISCORD_BOT_TOKEN,
    discordChannelId: e.DISCORD_CHANNEL_ID,
    discordOwnerId: e.DISCORD_OWNER_ID,
    discordGuildId: e.DISCORD_GUILD_ID,
    approvalMode,
    approvalTtlHours: parsePositiveInt(e.APPROVAL_TTL_HOURS, 'APPROVAL_TTL_HOURS'),
    gatewayAlertMinutes: parsePositiveInt(e.GATEWAY_ALERT_MINUTES, 'GATEWAY_ALERT_MINUTES'),
    shadowMode: parseBool(e.SHADOW_MODE, 'SHADOW_MODE'),
    shadowMaxPerSweep: parsePositiveInt(e.SHADOW_MAX_PER_SWEEP, 'SHADOW_MAX_PER_SWEEP'),
    digestEvery: parsePositiveInt(e.DIGEST_EVERY, 'DIGEST_EVERY'),
    dryRun: parseBool(e.DRY_RUN, 'DRY_RUN'),
    tiers,
    explicitTiers,
    enabledGroups,
    gatedGroups,
    configWarnings,
    sweepIntervalMs: parsePositiveInt(e.SWEEP_INTERVAL_MS, 'SWEEP_INTERVAL_MS'),
    fullSweepIntervalMs: parsePositiveInt(e.FULL_SWEEP_INTERVAL_MS, 'FULL_SWEEP_INTERVAL_MS'),
    deadCandidateAttempts: parsePositiveInt(e.DEAD_CANDIDATE_ATTEMPTS, 'DEAD_CANDIDATE_ATTEMPTS'),
    maxEditsPerRun: parsePositiveInt(e.MAX_EDITS_PER_RUN, 'MAX_EDITS_PER_RUN'),
    writeDelayMs: parsePositiveInt(e.WRITE_DELAY_MS, 'WRITE_DELAY_MS'),
    pageDelayMs: parsePositiveInt(e.PAGE_DELAY_MS, 'PAGE_DELAY_MS'),
    pageDelayJitterMs: parsePositiveInt(e.PAGE_DELAY_JITTER_MS, 'PAGE_DELAY_JITTER_MS'),
    verifyEdits: parseBool(e.VERIFY_EDITS, 'VERIFY_EDITS'),
    verifyDelayMs: parsePositiveInt(e.VERIFY_DELAY_MS, 'VERIFY_DELAY_MS'),
    verifyAttempts: parsePositiveInt(e.VERIFY_ATTEMPTS, 'VERIFY_ATTEMPTS'),
    shutdownGraceMs: parsePositiveInt(e.SHUTDOWN_GRACE_MS, 'SHUTDOWN_GRACE_MS'),
    userAgent: e.USER_AGENT,
    webEnabled: parseBool(e.WEB_ENABLED, 'WEB_ENABLED'),
    webPort: parsePositiveInt(e.WEB_PORT, 'WEB_PORT'),
  };
}
