import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { createDb, runMigrations } from '../../src/db/index.js';
import { TierStore } from '../../src/rules/tierStore.js';
import { Planner } from '../../src/scrub/planner.js';
import { ScrubWorker } from '../../src/scrub/worker.js';
import { toGroup, type PlannedEdit } from '../../src/scrub/types.js';

const ENV = {
  LASTFM_USERNAME: 'u',
  LASTFM_PASSWORD: 'p',
  LASTFM_API_KEY: 'k',
  DISCORD_BOT_TOKEN: 'b',
  DISCORD_CHANNEL_ID: 'c',
  DISCORD_OWNER_ID: 'o',
  DISCORD_GUILD_ID: 'g',
};

function fakeApi(tracks: { track: string; artist: string }[]) {
  return {
    iterateRecentTracks: async function* () {
      yield* tracks.map((track, i) => ({ ...track, album: '', uts: 100 + i }));
    },
    iterateTopAlbums: async function* () {},
    iterateTopTracks: async function* () {},
  } as never;
}

function trackEdit(groups: PlannedEdit['groups']): PlannedEdit {
  const original = {
    track_name: 'Song (Live)',
    artist_name: 'Artist',
    album_name: 'Album',
    album_artist_name: 'Artist',
  };
  return {
    original,
    next: { ...original, track_name: 'Song - Live' },
    csrfToken: 'tok',
    timestamp: '123',
    action: '/edit',
    refererPath: '/user/u/library/music/+noredirect/Artist/_/Song',
    groups,
  };
}

function response(html: string) {
  return { status: 200, text: async () => html, body: { cancel: async () => {} } };
}

describe('tier liveness', () => {
  it('lets a long-lived planner see a rule turned on without reconstruction', async () => {
    const d = createDb(':memory:');
    runMigrations(d);
    const config = loadConfig({ ...ENV, RULES: 'live-track:off' });
    const tiers = new TierStore(d, config.tiers, {
      approvalMode: false,
      discordConfigured: true,
      explicitTiers: config.explicitTiers,
    });
    const planner = new Planner(
      fakeApi([{ track: 'Song (Live)', artist: 'Artist' }]),
      'u',
      () => tiers.enabled(),
    );

    expect((await planner.sweepIncremental(0)).candidates).toEqual([]);

    tiers.set('live-track', 'auto');

    expect((await planner.sweepIncremental(0)).candidates).toEqual([
      { kind: 'track', artist: 'Artist', title: 'Song (Live)' },
    ]);
  });

  it('does not write or propose a tuple whose group is turned off after the cycle began', async () => {
    const d = createDb(':memory:');
    runMigrations(d);
    const config = loadConfig({ ...ENV, RULES: 'live-track:gated' });
    const tiers = new TierStore(d, config.tiers, {
      approvalMode: false,
      discordConfigured: true,
      explicitTiers: config.explicitTiers,
    });
    const events: string[] = [];
    const group = toGroup('Artist', [trackEdit(['live-track'])]);

    const worker = new ScrubWorker({
      config,
      db: d,
      session: {
        ensureSession: async () => {},
        request: async () => response(''),
        freshCsrfToken: async () => 'fresh',
      } as never,
      planner: { sweep: async () => [{ kind: 'track', artist: 'Artist', title: 'Song (Live)' }] } as never,
      resolver: {
        resolve: async (_candidates: unknown, hooks: { onGroup?: (group: unknown) => Promise<void>; onProgress?: (...args: never[]) => void }) => {
          tiers.set('live-track', 'off');
          await hooks.onGroup?.(group);
          hooks.onProgress?.(...([1, 1, 1, { kind: 'track', artist: 'Artist', title: 'Song (Live)' }] as never[]));
          return { edits: [], albumEdits: [], skips: [] };
        },
      } as never,
      editor: { apply: async () => { events.push('apply'); return 'verified'; } } as never,
      albumEditor: {} as never,
      reporter: {
        corrections: async () => {},
        group: async () => {},
        summary: async () => {},
        report: async () => {},
        shadow: async () => {},
      },
      albumArt: async () => undefined,
      approvals: {
        expire: async () => 0,
        carryOver: async () => ({ proposed: 0, duplicate: 0, failed: 0 }),
        drainOnTierChange: async () => ({ applied: 0, retired: 0, kept: 0 }),
        propose: async () => {
          events.push('propose');
          return 'proposed';
        },
      } as never,
      tiers: () => tiers.effective(),
      enabledGroups: () => tiers.enabled(),
      gatedGroups: () => tiers.gated(),
      sleep: async () => {},
    });

    await worker.runOnce();

    expect(events).toEqual([]);
  });

  it('runs the punctuation scan only when the group is enabled at cycle time', async () => {
    const run = async (punctuation: 'auto' | 'off') => {
      const d = createDb(':memory:');
      runMigrations(d);
      const config = loadConfig({ ...ENV, RULES: `punctuation:${punctuation}` });
      const tiers = new TierStore(d, config.tiers, {
        approvalMode: false,
        discordConfigured: true,
        explicitTiers: config.explicitTiers,
      });
      let scans = 0;
      const worker = new ScrubWorker({
        config,
        db: d,
        session: {
          ensureSession: async () => {},
          request: async () => response(''),
          freshCsrfToken: async () => 'fresh',
        } as never,
        planner: { sweep: async () => [] } as never,
        resolver: { resolve: async () => ({ edits: [], albumEdits: [], skips: [] }) } as never,
        editor: {} as never,
        albumEditor: {} as never,
        reporter: {
          corrections: async () => {},
          group: async () => {},
          summary: async () => {},
          report: async () => {},
          shadow: async () => {},
        },
        albumArt: async () => undefined,
        approvals: {
          expire: async () => 0,
          carryOver: async () => ({ proposed: 0, duplicate: 0, failed: 0 }),
          drainOnTierChange: async () => ({ applied: 0, retired: 0, kept: 0 }),
        } as never,
        tiers: () => tiers.effective(),
        enabledGroups: () => tiers.enabled(),
        gatedGroups: () => tiers.gated(),
        findClusters: async () => {
          scans++;
          return { candidates: [], lookup: () => undefined };
        },
        sleep: async () => {},
      });

      await worker.runOnce();
      return scans;
    };

    expect(await run('off')).toBe(0);
    expect(await run('auto')).toBe(1);
  });
});
