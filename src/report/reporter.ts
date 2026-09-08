import { COLOR, Discord, fenceLines } from './discord.js';

export interface RunTotals {
  applied: number;
  verified: number;
  unverified: number;
  failed: number;
  planned: number;
}

export interface Reporter {
  digest(lines: string[], totals: RunTotals, dryRun: boolean): Promise<void>;
  summary(headline: string, lines: string[], totals: RunTotals): Promise<void>;
  report(error: unknown, context: string): Promise<void>;
}

export class ConsoleAndDiscordReporter implements Reporter {
  constructor(
    private readonly discord: Discord,
    private readonly log: (msg: string) => void = (m) => console.log(m),
    private readonly logError: (msg: string) => void = (m) => console.error(m),
  ) {}

  async digest(lines: string[], totals: RunTotals, dryRun: boolean): Promise<void> {
    for (const line of lines) this.log(`  ${line}`);
    await this.discord.send({
      title: dryRun
        ? `Would correct ${lines.length} — dry run`
        : `Corrected ${lines.length}`,
      color: dryRun ? COLOR.dryRun : COLOR.applied,
      description: fenceLines(lines),
      footer: { text: progressText(totals, dryRun) },
    });
  }

  async summary(headline: string, lines: string[], totals: RunTotals): Promise<void> {
    this.log(headline);
    for (const line of lines) this.log(line);
    await this.discord.send({
      title: headline,
      color: totals.failed > 0 ? COLOR.failed : COLOR.done,
      ...(lines.length > 0 ? { description: fenceLines(lines) } : {}),
      fields: [
        { name: 'Tuples', value: String(totals.planned), inline: true },
        { name: 'Applied', value: String(totals.applied), inline: true },
        { name: 'Verified', value: String(totals.verified), inline: true },
        { name: 'Unverified', value: String(totals.unverified), inline: true },
        { name: 'Failed', value: String(totals.failed), inline: true },
      ],
    });
  }

  async report(error: unknown, context: string): Promise<void> {
    const detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    this.logError(`[${context}] ${detail}`);
    await this.discord.send({
      title: `Failed: ${context}`,
      color: COLOR.failed,
      description: '```\n' + detail.slice(0, 1500) + '\n```',
    });
  }
}

function progressText(t: RunTotals, dryRun: boolean): string {
  if (dryRun) return `${t.planned} tuples planned so far · nothing written`;
  return `${t.applied} applied · ${t.verified} verified · ${t.unverified} unverified · ${t.failed} failed`;
}
