import 'dotenv/config';
import { z } from 'zod';
import {
  ALL_GROUPS,
  DEFAULT_ENABLED,
  type GroupName,
  MARKER_GROUPS,
  isGroupName,
} from '../rules/markers.js';

// Last.fm answers any Mozilla/5.0-prefixed User-Agent with 406, so identify honestly.
const DEFAULT_USER_AGENT =
  'scrubbler/0.1.0 (+https://github.com/mxttbennett/scrubbler)';

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
  enabledGroups: Set<GroupName>;
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
    if (MARKER_GROUPS[name].experimental !== expectExperimental) {
      const belongs = expectExperimental ? 'RULES_ENABLED' : 'RULES_EXPERIMENTAL_ENABLED';
      throw new Error(`Group "${name}" belongs in ${belongs}, not ${label}`);
    }
  }

  return names as GroupName[];
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
  if (approvalMode) {
    // A proposal nobody can see or click is worse than no approval gate at all.
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
      throw new Error(`APPROVAL_MODE=true requires ${missing.join(', ')}`);
    }
  }

  const enabledGroups = new Set<GroupName>([
    ...parseGroups(e.RULES_ENABLED, 'RULES_ENABLED', false),
    ...parseGroups(e.RULES_EXPERIMENTAL_ENABLED, 'RULES_EXPERIMENTAL_ENABLED', true),
  ]);

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
    enabledGroups,
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
  };
}
