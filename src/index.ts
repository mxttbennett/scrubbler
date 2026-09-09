import { loadConfig } from './core/config.js';
import { readPackageVersion } from './core/version.js';
import { AlreadyRunningError, acquireLock, lockPath } from './core/lock.js';
import { WriteLock } from './core/writeLock.js';
import { createDb, runMigrations, schema } from './db/index.js';
import { LastfmApi } from './lastfm/api.js';
import { AlbumEditor } from './lastfm/albumEditor.js';
import { Editor } from './lastfm/editor.js';
import { LibraryPages } from './lastfm/pages.js';
import { Session, sessionStatePath } from './lastfm/session.js';
import { Commands } from './report/commands.js';
import { ConfigPanel } from './report/configPanel.js';
import { Discord } from './report/discord.js';
import { Gateway } from './report/gateway.js';
import { Proposals } from './report/proposals.js';
import { ConsoleAndDiscordReporter, libraryLinks } from './report/reporter.js';
import { Approvals } from './scrub/approvals.js';
import { Executor } from './scrub/executor.js';
import { LibraryMirror } from './library/mirror.js';
import { Handlers } from './web/handlers.js';
import { WebServer } from './web/server.js';
import { type BulkItem, candidatesFor, ephemeralLookup } from './web/bulk.js';
import { CustomRules } from './rules/customRules.js';
import { ShadowStore } from './scrub/shadowStore.js';
import { Planner } from './scrub/planner.js';
import { Resolver } from './scrub/resolver.js';
import { ScrubWorker } from './scrub/worker.js';
import { findClusters } from './scrub/clusters.js';
import { TierStore } from './rules/tierStore.js';
import { ALL_GROUPS } from './rules/markers.js';

async function main() {
  const config = loadConfig();
  const releaseLock = acquireLock(lockPath(config.dbPath));
  const db = createDb(config.dbPath);
  runMigrations(db);

  const discord = new Discord({
    botToken: config.discordBotToken,
    channelId: config.discordChannelId,
  });
  const reporter = new ConsoleAndDiscordReporter(
    discord,
    undefined,
    undefined,
    libraryLinks(config.username),
  );
  const session = new Session(
    { username: config.username, password: config.password, userAgent: config.userAgent },
    { statePath: sessionStatePath(config.dbPath) },
  );
  const pages = new LibraryPages(session, {
    minIntervalMs: config.pageDelayMs,
    jitterMs: config.pageDelayJitterMs,
  });
  const api = new LastfmApi(config.apiKey, { username: config.username });
  const mirror = new LibraryMirror({ db, api, username: config.username, log: (m) => { console.log(m); } });
  const customRules = new CustomRules(db);
  const shadowStore = new ShadowStore(db);
  const discordConfigured =
    config.discordBotToken !== undefined &&
    config.discordChannelId !== undefined &&
    config.discordOwnerId !== undefined &&
    config.discordGuildId !== undefined;
  const tierStore = new TierStore(db, config.tiers, {
    approvalMode: config.approvalMode,
    discordConfigured,
    explicitTiers: config.explicitTiers,
  });
  const planner = new Planner(
    api,
    config.username,
    () => tierStore.enabled(),
    db,
    config.deadCandidateAttempts,
    customRules.lookup,
    config.shadowMode ? (hit) => void shadowStore.record(hit) : undefined,
  );
  const resolver = new Resolver(pages, config.username, () => tierStore.enabled(), customRules.lookup);
  const editor = new Editor(session, pages, {
    verify: config.verifyEdits,
    verifyDelayMs: config.verifyDelayMs,
    verifyAttempts: config.verifyAttempts,
  });

  const albumEditor = new AlbumEditor(session, pages, config.username, {
    verify: config.verifyEdits,
    verifyDelayMs: config.verifyDelayMs,
    verifyAttempts: config.verifyAttempts,
  });

  const albumArt = (artist: string, album: string) => api.albumArt(artist, album);
  const albumDetails = (artist: string, album: string) => api.albumDetails(artist, album);
  const trackScrobbles = (artist: string, track: string) => api.trackScrobbles(artist, track);

  // One per process, shared by every executor: the worker, an approval click and a slash command
  // are otherwise three unordered writers against the same account.
  const writeLock = new WriteLock();

  const proposals = new Proposals({
    botToken: config.discordBotToken,
    channelId: config.discordChannelId,
  });

  // Its own Executor: the worker builds a fresh one per cycle, and a decision can arrive between
  // cycles when there is no cycle-scoped one to reach for.
  const approvals = new Approvals({
    db,
    executor: new Executor(db, editor, albumEditor, reporter, {
      dryRun: config.dryRun,
      maxEditsPerRun: config.maxEditsPerRun,
      writeDelayMs: config.writeDelayMs,
      digestEvery: config.digestEvery,
      albumArt,
      albumDetails,
      trackScrobbles,
      writeLock,
    }),
    proposals,
    freshToken: () => session.freshCsrfToken(`/user/${config.username}/library`),
    links: libraryLinks(config.username),
    stillThere: async (item) => {
      const { gone } = await pages.fetchOutcome(item.edit.refererPath);
      return !gone;
    },
    albumArt,
    ttlHours: config.approvalTtlHours,
    enabledGroups: () => tierStore.enabled(),
    tiers: () => tierStore.effective(),
    overrides: customRules.lookup,
  });
  const configPanel = new ConfigPanel({ db, tiers: tierStore, approvalMode: config.approvalMode });

  let shuttingDown = false;
  const worker = new ScrubWorker({
    config,
    db,
    session,
    planner,
    resolver,
    editor,
    albumEditor,
    reporter,
    albumArt,
    albumDetails,
    trackScrobbles,
    approvals,
    tiers: () => tierStore.effective(),
    enabledGroups: () => tierStore.enabled(),
    gatedGroups: () => tierStore.gated(),
    ...(config.shadowMode ? { shadowStore } : {}),
    findClusters: () => findClusters(api, config.username),
    // Only when the grid is on: a deployment without it should not pay for the mirror.
    ...(config.webEnabled
      ? {
          onIdle: async () => {
            const { mapped, failed } = await mirror.crawlAlbums({
              limit: 200,
              signal: () => shuttingDown,
            });
            if (mapped + failed > 0) {
              console.log(`mirror: mapped ${String(mapped)} album(s), ${String(failed)} failed`);
            }
          },
        }
      : {}),
    writeLock,
  });

  for (const warning of config.configWarnings) console.warn(`config: ${warning}`);

  console.log(
      `scrubbler ${readPackageVersion()} starting | user ${config.username}` +
      ` | dryRun ${String(config.dryRun)}` +
      ` | groups ${[...tierStore.enabled()].sort().join(',')}` +
      (tierStore.gated().size > 0 ? ` | gated ${[...tierStore.gated()].sort().join(',')}` : '') +
      ` | overrides ${ALL_GROUPS.filter((g) => tierStore.sourceOf(g) === 'override').sort().join(',') || 'none'}` +
      ` | discord ${discord.enabled ? 'on' : 'off'}` +
      ` | mode ${tierStore.gated().size > 0 ? 'approval' : 'unattended'}`,
  );

  // Reset flags: the slash-command equivalents arrive with the gateway client.
  if (process.argv.includes('--resweep')) {
    db.update(schema.sweepState).set({ lastScrobbleUts: null, lastFullSweepAt: null }).run();
    console.log('cursor cleared — the next cycle will sweep the whole library');
    releaseLock();
    return;
  }
  if (process.argv.includes('--retry-dead')) {
    const before = db.select().from(schema.deadCandidates).all().length;
    db.delete(schema.deadCandidates).run();
    console.log(`cleared ${before} dead candidate(s) — they will be tried again`);
    releaseLock();
    return;
  }

  if (process.argv.includes('--once')) {
    await worker.runOnce();
    releaseLock();
    return;
  }

  /**
   * Resolves and writes one named entity through the ordinary resolver and executor, so the ledger
   * row, dedupe, back-off, verification, album art and the automatic-edit rule all behave exactly as
   * they do for a catalogue match. Shares the write lock, so it queues behind the worker.
   */
  const applyOneEntity = async (rule: {
    kind: 'track' | 'album';
    artist: string;
    fromTitle: string;
  }): Promise<string> => {
    const executor = new Executor(db, editor, albumEditor, reporter, {
      dryRun: config.dryRun,
      maxEditsPerRun: config.maxEditsPerRun,
      writeDelayMs: config.writeDelayMs,
      digestEvery: config.digestEvery,
      albumArt,
      albumDetails,
      trackScrobbles,
      writeLock,
      onApplied: (tags, entity) => {
        if (tags.includes('custom')) customRules.recordApplied(entity.kind, entity.artist, entity.title);
      },
    });

    const candidate = { kind: rule.kind, artist: rule.artist, title: rule.fromTitle };
    const { skips } = await resolver.resolve([candidate], {
      onGroup: async (group) => {
          await executor.applyGroup(group, new Set());
        },
    });
    if (skips.length > 0) return `Not applied yet: ${skips[0]!.reason}`;

    const s = executor.streamedSummary;
    if (s.applied === 0 && s.skippedByLedger > 0) return 'Already corrected earlier.';
    if (s.applied === 0) return 'Nothing to change — the library page already reads as clean.';
    if (s.failed > 0) return `Applied ${s.applied}, failed ${s.failed}.`;
    return `Applied now: ${s.applied} write(s), ${s.verified} verified.`;
  };

  // Not gated on approval mode: status, stats, pause and the reset commands are just as useful
  // unattended, and tying the whole surface to the gate left an unattended deploy with no commands.
  const { discordBotToken, discordOwnerId, discordGuildId } = config;

  /**
   * One request's worth of hand-typed replacements. The overrides live only for this call, so
   * `custom_rules` is untouched unless the caller asked to save one, and the resolver re-derives the
   * real tuple from the live page exactly as it does for a catalogue match.
   */
  const applyBulk = async (items: BulkItem[]): Promise<{ applied: number; detail: string }> => {
    const executor = new Executor(db, editor, albumEditor, reporter, {
      dryRun: config.dryRun,
      maxEditsPerRun: config.maxEditsPerRun,
      writeDelayMs: config.writeDelayMs,
      digestEvery: config.digestEvery,
      albumArt,
      albumDetails,
      trackScrobbles,
      writeLock,
    });
    const scoped = new Resolver(
      pages,
      config.username,
      () => tierStore.enabled(),
      ephemeralLookup(items, customRules.lookup),
      'manual',
    );
    const { skips } = await scoped.resolve(candidatesFor(items), {
      onGroup: async (group) => {
        await executor.applyGroup(group, new Set());
      },
    });
    const s = executor.streamedSummary;
    const parts = [`applied ${String(s.applied)}`];
    if (s.verified > 0) parts.push(`${String(s.verified)} verified`);
    if (s.failed > 0) parts.push(`${String(s.failed)} failed`);
    if (skips.length > 0) parts.push(`${String(skips.length)} skipped`);
    return { applied: s.applied, detail: parts.join(', ') };
  };

  // In approval mode this must come before the worker: a proposal posted before the client is
  // listening has live buttons nothing would answer.
  let gateway: Gateway | undefined;
  if (
    discordBotToken !== undefined &&
    discordOwnerId !== undefined &&
    discordGuildId !== undefined
  ) {
    gateway = new Gateway({
      botToken: discordBotToken,
      ownerId: discordOwnerId,
      guildId: discordGuildId,
      commands: new Commands({
        db,
        approvals,
        customRules,
        applyNow: (rule) => applyOneEntity(rule),
        gatedRules: () => tierStore.gated(),
        dryRun: config.dryRun,
        shadowStore,
        shadowMode: config.shadowMode,
        enabledRules: () => tierStore.enabled(),
        configPanel,
        channelId: config.discordChannelId,
        guildId: config.discordGuildId,
      }),
      decisions: approvals,
      configPanel,
      alert: (error, context) => reporter.report(error, context),
      alertAfterMinutes: config.gatewayAlertMinutes,
    });
    await gateway.start();
  }

  worker.start();

  let web: WebServer | undefined;
  if (config.webEnabled) {
    const handlers = new Handlers({
      db,
      approvals,
      customRules,
      mirror,
      applyNow: (candidate) =>
        applyOneEntity({ kind: candidate.kind, artist: candidate.artist, fromTitle: candidate.title }),
      applyBulk,
      dryRun: config.dryRun,
      enabledRules: () => tierStore.enabled(),
      gatedRules: () => tierStore.gated(),
    });
    web = new WebServer({ port: config.webPort, handlers, log: (m) => { console.log(m); } });
    await web.listen();
  }

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('shutting down: finishing the in-flight edit');
    const timedOut = new Promise<boolean>((r) =>
      setTimeout(() => r(false), config.shutdownGraceMs),
    );
    // The grid is a writer too, so its in-flight request drains before the lock is released.
    const drainedAll = Promise.all([worker.stop(), web?.close()]).then(() => true);
    const clean = await Promise.race([drainedAll, timedOut]);
    console.log(clean ? 'drained cleanly' : 'drain timed out; exiting anyway');
    await gateway?.stop();
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  if (error instanceof AlreadyRunningError) {
    console.error(error.message);
    process.exit(0); // not a failure; systemd must not restart-loop on it
  }
  console.error('fatal startup error:', error);
  process.exit(1);
});
