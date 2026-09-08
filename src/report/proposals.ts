import { type DiscordEmbed, clampEmbed } from './discord.js';

const API = 'https://discord.com/api/v10';

export interface ProposalButton {
  customId: string;
  label: string;
  /** 1 primary, 2 secondary, 3 success, 4 danger — Discord's button style ids. */
  style: 1 | 2 | 3 | 4;
  disabled?: boolean;
}

export interface ProposalTransport {
  postProposal(embed: DiscordEmbed, buttons: ProposalButton[]): Promise<{ messageId: string }>;
  editMessage(messageId: string, embed: DiscordEmbed, buttons: ProposalButton[]): Promise<void>;
  readonly enabled: boolean;
  readonly channelId: string | undefined;
}

export interface ProposalsOptions {
  botToken: string | undefined;
  channelId: string | undefined;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class ProposalPostFailed extends Error {}

export function approveId(approvalId: number): string {
  return `approve:${approvalId}`;
}

export function ignoreId(approvalId: number): string {
  return `ignore:${approvalId}`;
}

export function stripId(approvalId: number): string {
  return `strip:${approvalId}`;
}

export function parseCustomId(
  customId: string,
): { action: 'approve' | 'ignore' | 'strip' | 'approve-all'; id: number } | undefined {
  const [action, raw] = customId.split(':');
  if (
    action !== 'approve' &&
    action !== 'ignore' &&
    action !== 'strip' &&
    action !== 'approve-all'
  ) {
    return undefined;
  }
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 0) return undefined;
  return { action, id };
}

/**
 * Deliberately not part of `Discord`: that sender swallows every failure so a report can never fail
 * a sweep, and a proposal needs the exact opposite — a silent failure here would leave an approval
 * row nobody can ever act on.
 */
export class Proposals implements ProposalTransport {
  private readonly botToken: string | undefined;
  readonly channelId: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ProposalsOptions) {
    this.botToken = opts.botToken;
    this.channelId = opts.channelId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get enabled(): boolean {
    return this.botToken !== undefined && this.channelId !== undefined;
  }

  async postProposal(
    embed: DiscordEmbed,
    buttons: ProposalButton[],
  ): Promise<{ messageId: string }> {
    if (!this.enabled) throw new ProposalPostFailed('discord is not configured');
    const body = JSON.stringify({
      embeds: [clampEmbed(embed)],
      components: componentsFor(buttons),
    });
    const json = await this.request(`${API}/channels/${this.channelId!}/messages`, 'POST', body);
    const id = (json as { id?: string }).id;
    if (typeof id !== 'string' || id === '') {
      throw new ProposalPostFailed('discord accepted the post but returned no message id');
    }
    return { messageId: id };
  }

  async editMessage(
    messageId: string,
    embed: DiscordEmbed,
    buttons: ProposalButton[],
  ): Promise<void> {
    if (!this.enabled) throw new ProposalPostFailed('discord is not configured');
    const body = JSON.stringify({
      embeds: [clampEmbed(embed)],
      components: componentsFor(buttons),
    });
    await this.request(`${API}/channels/${this.channelId!}/messages/${messageId}`, 'PATCH', body);
  }

  private async request(url: string, method: string, body: string): Promise<unknown> {
    let last = 'no attempt made';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bot ${this.botToken!}`,
            'Content-Type': 'application/json',
          },
          body,
        });
        if (res.ok) return await res.json().catch(() => ({}));
        if (res.status === 429) {
          const retry = await res
            .json()
            .then((j: unknown) => (j as { retry_after?: number }).retry_after ?? 1)
            .catch(() => 1);
          last = 'rate limited';
          await this.sleep(Math.ceil(retry * 1000) + 250);
          continue;
        }
        // 4xx other than 429 will not improve on retry: a bad channel or a revoked token.
        if (res.status < 500) {
          throw new ProposalPostFailed(
            `discord ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`,
          );
        }
        last = `discord ${res.status}`;
      } catch (error) {
        if (error instanceof ProposalPostFailed) throw error;
        last = String(error);
      }
      await this.sleep(1000 * attempt);
    }
    throw new ProposalPostFailed(`${method} ${url} failed after 3 attempts: ${last}`);
  }
}

function componentsFor(buttons: ProposalButton[]) {
  if (buttons.length === 0) return [];
  return [
    {
      type: 1,
      components: buttons.slice(0, 5).map((b) => ({
        type: 2,
        style: b.style,
        label: b.label.slice(0, 80),
        custom_id: b.customId,
        ...(b.disabled === true ? { disabled: true } : {}),
      })),
    },
  ];
}
