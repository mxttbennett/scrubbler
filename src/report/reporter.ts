const CHUNK = 1900;

export class Reporter {
  constructor(
    private readonly webhookUrl: string | undefined,
    private readonly log: (msg: string) => void = (m) => console.error(m),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async report(error: unknown, context: string): Promise<void> {
    await this.post(this.format(error, context));
  }

  async summary(lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    const text = lines.join('\n');
    console.log(text);
    await this.post(text);
  }

  private async post(text: string): Promise<void> {
    if (this.webhookUrl === undefined) return;
    try {
      for (let i = 0; i < text.length; i += CHUNK) {
        await this.fetchImpl(this.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: '```\n' + text.slice(i, i + CHUNK) + '\n```' }),
        });
      }
    } catch {
      // reporting must never take the service down
    }
  }

  private format(error: unknown, context: string): string {
    if (error instanceof Error) {
      this.log(`[${context}] ${error.stack ?? error.message}`);
      return `[${context}] ${error.message}`;
    }
    this.log(`[${context}] ${String(error)}`);
    return `[${context}] ${String(error)}`;
  }
}
