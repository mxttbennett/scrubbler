import { RateLimiter } from '../lastfm/rateLimiter.js';

const API = 'https://discord.com/api/v10';
const DESCRIPTION_LIMIT = 4000;

export const COLOR = {
  dryRun: 0x6b6167,
  applied: 0x1f6a7a,
  failed: 0xc4161c,
  warn: 0x8a5a12,
  done: 0x2e7d4f,
} as const;

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  color: number;
  description?: string;
  fields?: DiscordEmbedField[];
  footer?: { text: string };
  thumbnail?: { url: string };
}

export interface DiscordOptions {
  botToken: string | undefined;
  channelId: string | undefined;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /** Discord allows ~5 messages per 5s per channel; this keeps one-per-correction under it. */
  minIntervalMs?: number;
}

/**
 * Posts over the REST API with no gateway connection, so there is no websocket to supervise — at
 * the cost of the bot showing as offline in the member list.
 */
export class Discord {
  private readonly botToken: string | undefined;
  private readonly channelId: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly limiter: RateLimiter;

  constructor(opts: DiscordOptions) {
    this.botToken = opts.botToken;
    this.channelId = opts.channelId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? ((m) => console.log(m));
    this.limiter = new RateLimiter(opts.minIntervalMs ?? 1200, { sleep: this.sleep });
  }

  get enabled(): boolean {
    return this.botToken !== undefined && this.channelId !== undefined;
  }

  /** Best effort: a reporting failure must never interrupt or fail a sweep. */
  async send(embed: DiscordEmbed): Promise<void> {
    if (!this.enabled) return;
    const body = JSON.stringify({ embeds: [clampEmbed(embed)] });

    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.limiter.acquire();
      try {
        const res = await this.fetchImpl(`${API}/channels/${this.channelId!}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bot ${this.botToken!}`,
            'Content-Type': 'application/json',
          },
          body,
        });
        if (res.ok) {
          await res.body?.cancel();
          return;
        }
        if (res.status === 429) {
          const retry = await res
            .json()
            .then((j: unknown) => (j as { retry_after?: number }).retry_after ?? 1)
            .catch(() => 1);
          await this.sleep(Math.ceil(retry * 1000) + 250);
          continue;
        }
        const text = await res.text().catch(() => '');
        this.log(`discord: ${res.status} ${text.slice(0, 200)}`);
        return;
      } catch (error) {
        this.log(`discord: ${String(error)}`);
        await this.sleep(1000 * attempt);
      }
    }
  }
}

export function clampEmbed(embed: DiscordEmbed): DiscordEmbed {
  const out: DiscordEmbed = { title: embed.title.slice(0, 256), color: embed.color };
  if (embed.description !== undefined) {
    out.description = embed.description.slice(0, DESCRIPTION_LIMIT);
  }
  if (embed.fields !== undefined) {
    out.fields = embed.fields.slice(0, 25).map((f) => ({
      name: f.name.slice(0, 256),
      value: f.value.slice(0, 1024),
      ...(f.inline === undefined ? {} : { inline: f.inline }),
    }));
  }
  if (embed.footer !== undefined) out.footer = { text: embed.footer.text.slice(0, 2048) };
  if (embed.thumbnail !== undefined) out.thumbnail = embed.thumbnail;
  return out;
}

/** Fits as many whole lines as possible into one fenced block. */
export function fenceLines(lines: string[], limit = DESCRIPTION_LIMIT - 12): string {
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > limit) {
      kept.push(`… ${lines.length - kept.length} more`);
      break;
    }
    kept.push(line);
    size += line.length + 1;
  }
  return '```\n' + kept.join('\n') + '\n```';
}
