import { describe, expect, it } from 'vitest';
import { ConsoleAndDiscordReporter, libraryLinks } from '../../src/report/reporter.js';
import { COLOR, type DiscordEmbed } from '../../src/report/discord.js';

function spy(withLinks = true) {
  const sent: DiscordEmbed[] = [];
  const logs: string[] = [];
  const reporter = new ConsoleAndDiscordReporter(
    { send: async (e: DiscordEmbed) => void sent.push(e) } as never,
    (m) => void logs.push(m),
    () => {},
    withLinks ? libraryLinks('dankjankem') : undefined,
  );
  return { sent, logs, reporter };
}

const HIT = {
  rule: 'live-track',
  kind: 'track' as const,
  artist: 'Nirvana',
  title: 'all apologies - live',
  wouldBe: 'all apologies',
};

describe('Reporter.shadow', () => {
  it('uses the shadow colour, which is not warn', async () => {
    const { sent, reporter } = spy();
    await reporter.shadow(HIT, 0);

    expect(sent[0]!.color).toBe(COLOR.shadow);
    expect(sent[0]!.color).not.toBe(COLOR.warn);
    expect(sent[0]!.color).not.toBe(COLOR.applied);
  });

  it('names the rule in the title, so the card is self-explaining', async () => {
    const { sent, reporter } = spy();
    await reporter.shadow(HIT, 0);

    expect(sent[0]!.title).toBe('Would correct — live-track');
  });

  it('says plainly that nothing was changed', async () => {
    const { sent, reporter } = spy();
    await reporter.shadow(HIT, 0);

    expect(sent[0]!.footer?.text).toContain('nothing was changed');
    expect(sent[0]!.footer?.text).not.toContain('more recorded');
  });

  it('points at the command when more are waiting, rather than implying this is all', async () => {
    const { sent, reporter } = spy();
    await reporter.shadow(HIT, 137);

    expect(sent[0]!.footer?.text).toContain('137 more recorded');
    expect(sent[0]!.footer?.text).toContain('/scrub shadow');
  });

  it('shows the current title and what it would become', async () => {
    const { sent, reporter } = spy();
    await reporter.shadow(HIT, 0);

    const value = sent[0]!.fields?.find((f) => f.name === 'track name')?.value ?? '';
    expect(value).toContain('all apologies \\- live');
    expect(value).toContain('**all apologies**');
  });

  it('links the CURRENT title, unlike a correction: nothing moved', async () => {
    const { sent, reporter } = spy();
    await reporter.shadow(HIT, 0);

    const value = sent[0]!.fields?.find((f) => f.name === 'track name')?.value ?? '';
    expect(value).toContain('/_/all+apologies+-+live)');
  });

  it('says how to turn the rule on', async () => {
    const { sent, reporter } = spy();
    await reporter.shadow(HIT, 0);

    expect(sent[0]!.fields?.find((f) => f.name === 'rule')?.value).toContain(
      'RULES',
    );
  });

  it('marks the console line as an observation, not a correction', async () => {
    const { logs, reporter } = spy();
    await reporter.shadow(HIT, 0);

    expect(logs[0]).toContain('would correct');
    expect(logs[0]).toContain('[live-track]');
  });

  it('renders an album hit with the album field name', async () => {
    const { sent, reporter } = spy();
    await reporter.shadow(
      { rule: 'ep-single', kind: 'album', artist: 'M83', title: 'Midnight City - EP', wouldBe: 'Midnight City' },
      0,
    );

    expect(sent[0]!.fields?.[0]?.name).toBe('album name');
    expect(sent[0]!.fields?.[0]?.value).toContain('/library/music/M83/Midnight+City+-+EP)');
  });
});
