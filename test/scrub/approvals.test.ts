import { describe, expect, it } from 'vitest';
import { createDb, runMigrations, schema } from '../../src/db/index.js';
import { Approvals } from '../../src/scrub/approvals.js';
import { Executor } from '../../src/scrub/executor.js';
import { Planner } from '../../src/scrub/planner.js';
import { toAlbumGroup, toGroup, type PlannedEdit } from '../../src/scrub/types.js';
import type { PlannedAlbumEdit } from '../../src/lastfm/albumEditor.js';
import type { DiscordEmbed } from '../../src/report/discord.js';
import type { ProposalButton, ProposalTransport } from '../../src/report/proposals.js';
import type { Correction, Reporter } from '../../src/report/reporter.js';

const silent: Reporter = {
  corrections: async () => {},
  group: async () => {},
  summary: async () => {},
  report: async () => {},
  shadow: async () => {},
};

function db() {
  const d = createDb(':memory:');
  runMigrations(d);
  return d;
}

/** Records what was posted and can be told to fail, which is the contract that matters here. */
function fakeTransport(opts: { failPosts?: boolean } = {}) {
  const posts: { embed: DiscordEmbed; buttons: ProposalButton[] }[] = [];
  const edits: { messageId: string; embed: DiscordEmbed }[] = [];
  let next = 1;
  const transport: ProposalTransport = {
    enabled: true,
    channelId: 'chan',
    postProposal: async (embed, buttons) => {
      if (opts.failPosts === true) throw new Error('discord 403');
      posts.push({ embed, buttons });
      return { messageId: `m${next++}` };
    },
    editMessage: async (messageId, embed) => void edits.push({ messageId, embed }),
  };
  return { transport, posts, edits };
}

function trackEdit(track: string): PlannedEdit {
  const original = {
    track_name: track,
    artist_name: 'The Replacements',
    album_name: 'Let It Be (Deluxe Edition)',
    album_artist_name: 'The Replacements',
  };
  return {
    original,
    next: { ...original, album_name: 'Let It Be' },
    csrfToken: 'stale-token',
    timestamp: '1772659220',
    action: '/user/u/library/edit-track?edited-variation=library-track-scrobble',
    refererPath: `/user/u/library/music/+noredirect/The+Replacements/_/${track}`,
    groups: ['edition'],
  };
}

function albumEdit(): PlannedAlbumEdit {
  return {
    artist: 'Nirvana',
    from: 'In Utero (Deluxe Edition)',
    to: 'In Utero',
    csrfToken: 'stale-token',
    action: '/library/edit-album?edited-variation=library-album-scrobble',
    refererPath: '/user/u/library/music/+noredirect/Nirvana/In+Utero+%28Deluxe+Edition%29',
    groups: ['edition'],
  };
}

interface Harness {
  applied: string[];
  tokens: number;
}

function harness(
  opts: { failPosts?: boolean; token?: string | undefined; ttlHours?: number } = {},
) {
  const d = db();
  const state: Harness = { applied: [], tokens: 0 };
  const executor = new Executor(
    d,
    { apply: async (e: PlannedEdit) => {
        state.applied.push(`track ${e.original.track_name} (${e.csrfToken})`);
        return 'verified';
      } } as never,
    { apply: async (e: PlannedAlbumEdit) => {
        state.applied.push(`album ${e.from} (${e.csrfToken})`);
        return 'verified';
      } } as never,
    silent,
    { dryRun: false, maxEditsPerRun: 100, writeDelayMs: 0, digestEvery: 1 },
  );
  const t = fakeTransport({ ...(opts.failPosts === undefined ? {} : { failPosts: opts.failPosts }) });
  const approvals = new Approvals({
    db: d,
    executor,
    proposals: t.transport,
    freshToken: async () => {
      state.tokens++;
      return 'token' in opts ? opts.token : 'fresh-token';
    },
    ttlHours: opts.ttlHours ?? 168,
    log: () => {},
  });
  return { d, executor, approvals, state, ...t };
}

const OWNER = '1234';

describe('Approvals.propose', () => {
  it('marks the edits awaiting_approval and links them to the row', async () => {
    const h = harness();
    const result = await h.approvals.propose(
      toGroup('The Replacements', ['Bastards of Young', 'Left of the Dial'].map(trackEdit)),
    );

    expect(result).toBe('proposed');
    const edits = h.d.select().from(schema.appliedEdits).all();
    expect(edits).toHaveLength(2);
    for (const row of edits) expect(row.status).toBe('awaiting_approval');

    const approval = h.d.select().from(schema.approvals).all();
    expect(approval).toHaveLength(1);
    expect(approval[0]!.status).toBe('pending');
    expect(approval[0]!.messageId).toBe('m1');
    expect(approval[0]!.itemCount).toBe(2);
    expect(h.d.select().from(schema.approvalEdits).all()).toHaveLength(2);
  });

  it('leaves nothing awaiting approval when the post fails', async () => {
    const h = harness({ failPosts: true });
    const result = await h.approvals.propose(
      toGroup('The Replacements', [trackEdit('Bastards of Young')]),
    );

    expect(result).toBe('post-failed');
    expect(h.d.select().from(schema.approvals).all()).toHaveLength(0);
    expect(h.d.select().from(schema.approvalEdits).all()).toHaveLength(0);
    // Still `planned`, so a later sweep proposes it again rather than stranding it.
    expect(h.d.select().from(schema.appliedEdits).all()[0]!.status).toBe('planned');
  });

  it('does not re-propose a group that is already pending', async () => {
    const h = harness();
    const group = toGroup('The Replacements', [trackEdit('Bastards of Young')]);
    await h.approvals.propose(group);

    expect(await h.approvals.propose(group)).toBe('duplicate');
    expect(h.posts).toHaveLength(1);
    expect(h.d.select().from(schema.approvals).all()).toHaveLength(1);
  });

  it('offers Apply and Never buttons carrying the row id', async () => {
    const h = harness();
    await h.approvals.propose(toGroup('The Replacements', [trackEdit('Bastards of Young')]));
    const id = h.d.select().from(schema.approvals).all()[0]!.id;

    expect(h.posts[0]!.buttons.map((b) => b.customId)).toEqual([`approve:${id}`, `ignore:${id}`]);
  });
});

describe('Approvals.approve', () => {
  it('applies with a fresh token, never the one stored at proposal time', async () => {
    const h = harness();
    await h.approvals.propose(toGroup('The Replacements', [trackEdit('Bastards of Young')]));
    const id = h.d.select().from(schema.approvals).all()[0]!.id;

    const result = await h.approvals.approve(id, OWNER);

    expect(result.outcome).toBe('approved');
    expect(h.state.applied).toEqual(['track Bastards of Young (fresh-token)']);
    expect(h.state.tokens).toBe(1);
    expect(h.d.select().from(schema.appliedEdits).all()[0]!.status).toBe('verified');
  });

  it('applies an album proposal through the album path', async () => {
    const h = harness();
    await h.approvals.propose(toAlbumGroup(albumEdit()));
    const id = h.d.select().from(schema.approvals).all()[0]!.id;

    await h.approvals.approve(id, OWNER);

    expect(h.state.applied).toEqual(['album In Utero (Deluxe Edition) (fresh-token)']);
  });

  it('does not apply twice when clicked again inside the apply window', async () => {
    const h = harness();
    await h.approvals.propose(toGroup('The Replacements', [trackEdit('Bastards of Young')]));
    const id = h.d.select().from(schema.approvals).all()[0]!.id;

    const [first, second] = await Promise.all([
      h.approvals.approve(id, OWNER),
      h.approvals.approve(id, OWNER),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(['already-decided', 'approved']);
    expect(h.state.applied).toHaveLength(1);
  });

  it('stays pending when no token can be got, rather than losing the decision', async () => {
    const h = harness({ token: undefined });
    await h.approvals.propose(toGroup('The Replacements', [trackEdit('Bastards of Young')]));
    const id = h.d.select().from(schema.approvals).all()[0]!.id;

    const result = await h.approvals.approve(id, OWNER);

    expect(result.outcome).toBe('stale');
    expect(h.d.select().from(schema.approvals).all()[0]!.status).toBe('pending');
    expect(h.state.applied).toHaveLength(0);
  });

  it('skips a member whose entity changed since the proposal, rather than a silent no-op write', async () => {
    const d = db();
    const state = { applied: [] as string[] };
    const executor = new Executor(
      d,
      { apply: async (e: PlannedEdit) => {
          state.applied.push(e.original.track_name);
          return 'verified';
        } } as never,
      {} as never,
      silent,
      { dryRun: false, maxEditsPerRun: 100, writeDelayMs: 0, digestEvery: 1 },
    );
    const t = fakeTransport();
    const approvals = new Approvals({
      db: d,
      executor,
      proposals: t.transport,
      freshToken: async () => 'fresh-token',
      stillThere: async (item) =>
        item.kind === 'track' && item.edit.original.track_name !== 'Left of the Dial',
      ttlHours: 168,
      log: () => {},
    });

    await approvals.propose(
      toGroup('The Replacements', ['Bastards of Young', 'Left of the Dial'].map(trackEdit)),
    );
    const id = d.select().from(schema.approvals).all()[0]!.id;
    const result = await approvals.approve(id, OWNER);

    expect(state.applied).toEqual(['Bastards of Young']);
    expect(result.detail).toContain('1 changed since the proposal');
    const rows = d.select().from(schema.appliedEdits).all();
    const skipped = rows.find((r) => r.trackNameOriginal === 'Left of the Dial')!;
    expect(skipped.status).toBe('skipped');
    expect(skipped.lastError).toBe('changed before approval');
  });

  it('reports a decision on an id that no longer exists', async () => {
    const h = harness();
    expect((await h.approvals.approve(9999, OWNER)).outcome).toBe('gone');
  });
});

describe('Approvals.ignore', () => {
  it('writes the ignored entity and the planner then filters it', async () => {
    const h = harness();
    await h.approvals.propose(toGroup('The Replacements', [trackEdit('Bastards of Young')]));
    const id = h.d.select().from(schema.approvals).all()[0]!.id;

    await h.approvals.ignore(id, OWNER);

    expect(h.d.select().from(schema.appliedEdits).all()[0]!.status).toBe('ignored');
    const ignored = h.d.select().from(schema.ignored).all();
    expect(ignored).toHaveLength(1);
    expect(ignored[0]!.artist).toBe('The Replacements');
    expect(ignored[0]!.title).toBe('Bastards of Young');

    const planner = new Planner({} as never, 'u', new Set(['edition']), h.d, 3);
    const kept = planner.filterLive([
      { kind: 'track', artist: 'The Replacements', title: 'Bastards of Young' },
      { kind: 'track', artist: 'The Replacements', title: 'Left of the Dial' },
    ]);
    expect(kept.map((c) => c.title)).toEqual(['Left of the Dial']);
  });

  it('records an album rejection against the album, not a track', async () => {
    const h = harness();
    await h.approvals.propose(toAlbumGroup(albumEdit()));
    const id = h.d.select().from(schema.approvals).all()[0]!.id;

    await h.approvals.ignore(id, OWNER);

    const ignored = h.d.select().from(schema.ignored).all();
    expect(ignored[0]!.kind).toBe('album');
    expect(ignored[0]!.artist).toBe('Nirvana');
    expect(ignored[0]!.title).toBe('In Utero (Deluxe Edition)');
  });
});

describe('Approvals.carryOver — the blocker', () => {
  it('proposes carried planned rows and writes none of them', async () => {
    const h = harness();
    h.executor.checkpoint(trackEdit('Bastards of Young'));
    h.executor.checkpoint(trackEdit('Left of the Dial'));
    h.executor.checkpointAlbum(albumEdit());

    const result = await h.approvals.carryOver();

    expect(result.proposed).toBe(3);
    expect(h.state.applied).toEqual([]);
    for (const row of h.d.select().from(schema.appliedEdits).all()) {
      expect(row.status).toBe('awaiting_approval');
    }
  });

  it('never marks an awaiting_approval row planned again on a second carry-over', async () => {
    const h = harness();
    h.executor.checkpoint(trackEdit('Bastards of Young'));
    await h.approvals.carryOver();

    const second = await h.approvals.carryOver();

    expect(second.proposed).toBe(0);
    expect(h.state.applied).toEqual([]);
    expect(h.posts).toHaveLength(1);
  });
});

describe('Approvals.expire', () => {
  it('marks a stale proposal expired and returns its edits to planned, not ignored', async () => {
    const h = harness({ ttlHours: 1 });
    await h.approvals.propose(toGroup('The Replacements', [trackEdit('Bastards of Young')]));

    const expired = await h.approvals.expire(new Date(Date.now() + 2 * 3600_000));

    expect(expired).toBe(1);
    expect(h.d.select().from(schema.approvals).all()[0]!.status).toBe('expired');
    // Re-proposable: an unread week must not silently discard the work.
    expect(h.d.select().from(schema.appliedEdits).all()[0]!.status).toBe('planned');
    expect(h.d.select().from(schema.ignored).all()).toHaveLength(0);
  });

  it('leaves a fresh proposal alone', async () => {
    const h = harness({ ttlHours: 168 });
    await h.approvals.propose(toGroup('The Replacements', [trackEdit('Bastards of Young')]));

    expect(await h.approvals.expire()).toBe(0);
    expect(h.d.select().from(schema.approvals).all()[0]!.status).toBe('pending');
  });
});

describe('Approvals.drainOnModeOff', () => {
  it('applies pending proposals by the normal path and marks them superseded', async () => {
    const h = harness();
    await h.approvals.propose(toGroup('The Replacements', [trackEdit('Bastards of Young')]));

    const drained = await h.approvals.drainOnModeOff();

    expect(drained).toBe(1);
    expect(h.state.applied).toEqual(['track Bastards of Young (fresh-token)']);
    expect(h.d.select().from(schema.approvals).all()[0]!.status).toBe('superseded');
    // The card is retired, so no dead buttons are left behind.
    expect(h.edits.map((e) => e.embed.title)).toEqual(['Applied by the unattended sweep']);
  });

  it('does nothing when there is nothing pending', async () => {
    const h = harness();
    expect(await h.approvals.drainOnModeOff()).toBe(0);
    expect(h.state.tokens).toBe(0);
  });
});

describe('Approvals.supersede', () => {
  it('retires a pending approval whose tuple the sweep already wrote', async () => {
    const h = harness();
    await h.approvals.propose(toGroup('The Replacements', [trackEdit('Bastards of Young')]));
    const editId = h.d.select().from(schema.appliedEdits).all()[0]!.id;

    expect(await h.approvals.supersede([editId])).toBe(1);
    expect(h.d.select().from(schema.approvals).all()[0]!.status).toBe('superseded');
  });
});

describe('reported corrections', () => {
  it('does not double-report an approved edit as a loose correction', async () => {
    const seen: Correction[][] = [];
    const d = db();
    const executor = new Executor(
      d,
      { apply: async () => 'verified' } as never,
      {} as never,
      {
        corrections: async (items: Correction[]) => void seen.push(items),
        group: async () => {},
        summary: async () => {},
        report: async () => {},
        shadow: async () => {},
      },
      { dryRun: false, maxEditsPerRun: 100, writeDelayMs: 0, digestEvery: 1 },
    );
    const t = fakeTransport();
    const approvals = new Approvals({
      db: d,
      executor,
      proposals: t.transport,
      freshToken: async () => 'fresh-token',
      ttlHours: 168,
      log: () => {},
    });

    await approvals.propose(toGroup('The Replacements', [trackEdit('Bastards of Young')]));
    const id = d.select().from(schema.approvals).all()[0]!.id;
    await approvals.approve(id, OWNER);

    expect(seen.flat()).toHaveLength(1);
    expect(seen.flat()[0]!.outcome).toBe('verified');
  });
});
