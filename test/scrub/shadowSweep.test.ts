import { describe, expect, it } from 'vitest';
import { Planner } from '../../src/scrub/planner.js';
import { DEFAULT_ENABLED, type GroupName } from '../../src/rules/markers.js';
import type { ShadowHit } from '../../src/rules/shadow.js';

const ENABLED = new Set<GroupName>(DEFAULT_ENABLED);

function fakeApi(
  albums: { name: string; artist: string }[] = [],
  tracks: { name: string; artist: string }[] = [],
  scrobbles: { artist: string; track: string; album: string; uts: number }[] = [],
) {
  return {
    iterateTopAlbums: async function* () {
      yield* albums;
    },
    iterateTopTracks: async function* () {
      yield* tracks;
    },
    iterateRecentTracks: async function* () {
      yield* scrobbles;
    },
  } as never;
}

function collect() {
  const hits: ShadowHit[] = [];
  return { hits, onShadow: (h: ShadowHit) => void hits.push(h) };
}

describe('shadow hits during discovery', () => {
  it('reports an entity it does NOT nominate as a candidate', async () => {
    const { hits, onShadow } = collect();
    const planner = new Planner(
      fakeApi([], [{ name: 'all apologies (Live)', artist: 'Nirvana' }]),
      'u',
      ENABLED,
      undefined,
      3,
      undefined,
      onShadow,
    );

    const candidates = await planner.sweep();

    // The two are different questions: nothing enabled would touch this, so it is not a candidate.
    expect(candidates).toEqual([]);
    expect(hits).toEqual([
      {
        rule: 'live-track',
        kind: 'track',
        artist: 'Nirvana',
        title: 'all apologies (Live)',
        wouldBe: 'all apologies - Live',
      },
    ]);
  });

  it('reports nothing for a candidate a stable rule already handles', async () => {
    const { hits, onShadow } = collect();
    const planner = new Planner(
      fakeApi([{ name: 'Rumours (Deluxe Edition)', artist: 'Fleetwood Mac' }]),
      'u',
      ENABLED,
      undefined,
      3,
      undefined,
      onShadow,
    );

    expect(await planner.sweep()).toHaveLength(1);
    expect(hits).toEqual([]);
  });

  it('shadows albums on the full sweep', async () => {
    const { hits, onShadow } = collect();
    const planner = new Planner(
      // ep-single is album-only and disabled, so this is an album hit and not a candidate.
      fakeApi([{ name: 'Midnight City - EP', artist: 'M83' }]),
      'u',
      ENABLED,
      undefined,
      3,
      undefined,
      onShadow,
    );

    const candidates = await planner.sweep();

    expect(candidates).toEqual([]);
    expect(hits).toEqual([
      {
        rule: 'ep-single',
        kind: 'album',
        artist: 'M83',
        title: 'Midnight City - EP',
        wouldBe: 'Midnight City',
      },
    ]);
  });

  /**
   * The incremental path has only the TRACK artist for an album (planner.ts says so in its own
   * comment), so an album shadowed there would not match the row the full sweep writes.
   */
  it('never shadows an album from the incremental sweep', async () => {
    const { hits, onShadow } = collect();
    const planner = new Planner(
      fakeApi(
        [],
        [],
        [{ artist: 'Yes', track: 'Roundabout', album: 'Yessongs (Live)', uts: 100 }],
      ),
      'u',
      ENABLED,
      undefined,
      3,
      undefined,
      onShadow,
    );

    await planner.sweepIncremental(0);

    expect(hits.filter((h) => h.kind === 'album')).toEqual([]);
  });

  it('does shadow tracks from the incremental sweep', async () => {
    const { hits, onShadow } = collect();
    const planner = new Planner(
      fakeApi(
        [],
        [],
        [{ artist: 'Nirvana', track: 'all apologies (Live)', album: 'Unplugged', uts: 100 }],
      ),
      'u',
      ENABLED,
      undefined,
      3,
      undefined,
      onShadow,
    );

    await planner.sweepIncremental(0);

    expect(hits.map((h) => h.title)).toEqual(['all apologies (Live)']);
  });

  it('stays silent when no hook is registered, so shadow mode off costs nothing', async () => {
    const planner = new Planner(
      fakeApi([], [{ name: 'all apologies (Live)', artist: 'Nirvana' }]),
      'u',
      ENABLED,
      undefined,
      3,
    );

    await expect(planner.sweep()).resolves.toEqual([]);
  });
});
