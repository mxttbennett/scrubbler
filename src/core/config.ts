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
  'scrobble-scrubber/0.1.0 (+https://github.com/mxttbennett/scrobble-scrubber)';

const envSchema = z.object({
  LASTFM_USERNAME: z.string().min(1),
  LASTFM_PASSWORD: z.string().min(1),
  LASTFM_API_KEY: z.string().min(1),
  DB_PATH: z.string().default('.data/scrobble-scrubber.sqlite'),
  DISCORD_WEBHOOK_URL: z.string().optional(),
  DRY_RUN: z.string().default('true'),
  RULES_ENABLED: z.string().default(DEFAULT_ENABLED.join(',')),
  RULES_EXPERIMENTAL_ENABLED: z.string().default(''),
  SWEEP_INTERVAL_MS: z.string().default('21600000'),
  MAX_EDITS_PER_RUN: z.string().default('250'),
  WRITE_DELAY_MS: z.string().default('3000'),
  PAGE_DELAY_MS: z.string().default('15000'),
  VERIFY_EDITS: z.string().default('true'),
  VERIFY_DELAY_MS: z.string().default('2000'),
  VERIFY_ATTEMPTS: z.string().default('3'),
  USER_AGENT: z.string().default(DEFAULT_USER_AGENT),
});

export interface Config {
  username: string;
  password: string;
  apiKey: string;
  dbPath: string;
  discordWebhookUrl: string | undefined;
  dryRun: boolean;
  enabledGroups: Set<GroupName>;
  sweepIntervalMs: number;
  maxEditsPerRun: number;
  writeDelayMs: number;
  pageDelayMs: number;
  verifyEdits: boolean;
  verifyDelayMs: number;
  verifyAttempts: number;
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

  const enabledGroups = new Set<GroupName>([
    ...parseGroups(e.RULES_ENABLED, 'RULES_ENABLED', false),
    ...parseGroups(e.RULES_EXPERIMENTAL_ENABLED, 'RULES_EXPERIMENTAL_ENABLED', true),
  ]);

  return {
    username: e.LASTFM_USERNAME,
    password: e.LASTFM_PASSWORD,
    apiKey: e.LASTFM_API_KEY,
    dbPath: e.DB_PATH,
    discordWebhookUrl: e.DISCORD_WEBHOOK_URL,
    dryRun: parseBool(e.DRY_RUN, 'DRY_RUN'),
    enabledGroups,
    sweepIntervalMs: parsePositiveInt(e.SWEEP_INTERVAL_MS, 'SWEEP_INTERVAL_MS'),
    maxEditsPerRun: parsePositiveInt(e.MAX_EDITS_PER_RUN, 'MAX_EDITS_PER_RUN'),
    writeDelayMs: parsePositiveInt(e.WRITE_DELAY_MS, 'WRITE_DELAY_MS'),
    pageDelayMs: parsePositiveInt(e.PAGE_DELAY_MS, 'PAGE_DELAY_MS'),
    verifyEdits: parseBool(e.VERIFY_EDITS, 'VERIFY_EDITS'),
    verifyDelayMs: parsePositiveInt(e.VERIFY_DELAY_MS, 'VERIFY_DELAY_MS'),
    verifyAttempts: parsePositiveInt(e.VERIFY_ATTEMPTS, 'VERIFY_ATTEMPTS'),
    userAgent: e.USER_AGENT,
  };
}
