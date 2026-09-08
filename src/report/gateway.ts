import { Client, GatewayIntentBits, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction, Interaction } from 'discord.js';
import { COMMAND_DEFINITION, COMMAND_NAME, type Commands } from './commands.js';
import { parseCustomId } from './proposals.js';

export interface DecisionHandler {
  approve(approvalId: number, userId: string): Promise<{ outcome: string; detail: string }>;
  ignore(approvalId: number, userId: string): Promise<{ outcome: string; detail: string }>;
  approveAll(userId: string): Promise<{ approved: number; failed: number }>;
}

export interface GatewayDeps {
  botToken: string;
  ownerId: string;
  guildId?: string;
  commands?: Commands;
  decisions: DecisionHandler;
  /** Reached even when Discord is unreachable, which is the point of alerting through it. */
  alert: (error: unknown, context: string) => Promise<void>;
  alertAfterMinutes: number;
  log?: (msg: string) => void;
  clientFactory?: () => Client;
  now?: () => number;
}

export const NOT_OWNER = 'These controls belong to the account that runs this service.';
export const UNKNOWN_ID = 'That proposal is no longer in the ledger.';

/**
 * Deliberately separate from the REST sender: this holds a websocket, which is a supervised
 * resource with its own failure mode, while the sender is fire-and-forget.
 */
export class Gateway {
  private client: Client | undefined;
  private lastConnectedAt: number;
  private healthTimer: NodeJS.Timeout | undefined;
  private alerted = false;
  private connected = false;

  constructor(private readonly deps: GatewayDeps) {
    this.lastConnectedAt = this.now();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(msg: string): void {
    (this.deps.log ?? ((m: string) => console.log(m)))(msg);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<Client> {
    const client =
      this.deps.clientFactory?.() ?? new Client({ intents: [GatewayIntentBits.Guilds] });
    this.client = client;

    client.on('ready', () => {
      this.markConnected('ready');
    });
    client.on('shardResume', () => {
      this.markConnected('resumed');
    });
    client.on('shardDisconnect', () => {
      this.connected = false;
      this.log('discord gateway: disconnected');
    });
    client.on('error', (error) => {
      this.log(`discord gateway: ${String(error)}`);
    });
    client.on('interactionCreate', (interaction: Interaction) => {
      void this.onInteraction(interaction);
    });

    await client.login(this.deps.botToken);
    await this.registerCommands(client);
    this.startHealthWatch();
    return client;
  }

  private markConnected(why: string): void {
    this.connected = true;
    this.lastConnectedAt = this.now();
    this.alerted = false;
    this.log(`discord gateway: ${why}`);
  }

  /** The REST sender swallows failures by design, so a dead gateway has no other way to surface. */
  private startHealthWatch(): void {
    const windowMs = this.deps.alertAfterMinutes * 60_000;
    if (windowMs <= 0) return;
    this.healthTimer = setInterval(() => {
      void this.checkHealth();
    }, Math.min(windowMs, 60_000));
    this.healthTimer.unref?.();
  }

  async checkHealth(): Promise<void> {
    const windowMs = this.deps.alertAfterMinutes * 60_000;
    const down = this.now() - this.lastConnectedAt;
    if (this.connected || down < windowMs || this.alerted) return;
    this.alerted = true;
    await this.deps.alert(
      new Error(`gateway has been disconnected for ${Math.round(down / 60_000)} minutes`),
      'discord gateway',
    );
  }

  /** Guild-scoped: global registration takes up to an hour to propagate. */
  private async registerCommands(client: Client): Promise<void> {
    const { guildId, commands } = this.deps;
    if (commands === undefined || guildId === undefined) return;
    try {
      const guild = await client.guilds.fetch(guildId);
      await guild.commands.set([COMMAND_DEFINITION]);
      this.log(`registered /${COMMAND_NAME} in guild ${guildId}`);
    } catch (error) {
      this.log(`could not register commands: ${String(error)}`);
    }
  }

  async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      await this.onCommand(interaction);
      return;
    }
    if (!interaction.isButton()) return;
    const parsed = parseCustomId(interaction.customId);
    if (parsed === undefined) return;

    if (interaction.user.id !== this.deps.ownerId) {
      await interaction.reply({ content: NOT_OWNER, flags: MessageFlags.Ephemeral });
      return;
    }

    // The ack budget is 3 seconds; applying an edit is a write plus a ~17s verification read.
    await interaction.deferUpdate();

    const { decisions } = this.deps;
    try {
      if (parsed.action === 'approve-all') {
        const result = await decisions.approveAll(interaction.user.id);
        await interaction.followUp({
          content: `Applied ${result.approved}, failed ${result.failed}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const result =
        parsed.action === 'approve'
          ? await decisions.approve(parsed.id, interaction.user.id)
          : await decisions.ignore(parsed.id, interaction.user.id);
      if (result.outcome === 'gone') {
        await interaction.followUp({ content: UNKNOWN_ID, flags: MessageFlags.Ephemeral });
        return;
      }
      this.log(`approval ${parsed.id}: ${result.outcome} — ${result.detail}`);
    } catch (error) {
      this.log(`approval ${parsed.id} failed: ${String(error)}`);
      await interaction
        .followUp({ content: `That failed: ${String(error)}`, flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
    }
  }

  private async onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { commands, ownerId } = this.deps;
    if (commands === undefined || interaction.commandName !== COMMAND_NAME) return;
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: NOT_OWNER, flags: MessageFlags.Ephemeral });
      return;
    }

    const sub = interaction.options.getSubcommand(false);
    if (sub === null) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const args: Record<string, string | number> = {};
    for (const option of interaction.options.data[0]?.options ?? []) {
      if (typeof option.value === 'string' || typeof option.value === 'number') {
        args[option.name] = option.value;
      }
    }

    try {
      const reply = commands.handle(sub, args);
      await interaction.editReply({
        content: reply.text.slice(0, 1900),
        ...(reply.confirm === undefined
          ? {}
          : {
              components: [
                {
                  type: 1,
                  components: [
                    {
                      type: 2,
                      style: 4,
                      label: reply.confirm.label,
                      custom_id: reply.confirm.customId,
                    },
                  ],
                },
              ] as never,
            }),
      });
    } catch (error) {
      this.log(`/${COMMAND_NAME} ${sub} failed: ${String(error)}`);
      await interaction.editReply({ content: `That failed: ${String(error)}` }).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    if (this.healthTimer !== undefined) clearInterval(this.healthTimer);
    await this.client?.destroy();
    this.connected = false;
  }
}
