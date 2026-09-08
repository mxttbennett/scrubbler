import { loadConfig } from './core/config.js';
import { AlreadyRunningError, acquireLock, lockPath } from './core/lock.js';
import { createDb, runMigrations, schema } from './db/index.js';
import { LastfmApi } from './lastfm/api.js';
import { AlbumEditor } from './lastfm/albumEditor.js';
import { Editor } from './lastfm/editor.js';
import { LibraryPages } from './lastfm/pages.js';
import { Session, sessionStatePath } from './lastfm/session.js';
import { Commands } from './report/commands.js';
import { Discord } from './report/discord.js';
import { Gateway } from './report/gateway.js';
import { Proposals } from './report/proposals.js';
import { ConsoleAndDiscordReporter } from './report/reporter.js';
import { Approvals } from './scrub/approvals.js';
import { Executor } from './scrub/executor.js';
import { Planner } from './scrub/planner.js';
import { Resolver } from './scrub/resolver.js';
import { ScrubWorker } from './scrub/worker.js';

async function main() {
  const config = loadConfig();
  const releaseLock = acquireLock(lockPath(config.dbPath));
  const db = createDb(config.dbPath);
  runMigrations(db);

  const discord = new Discord({
    botToken: config.discordBotToken,
    channelId: config.discordChannelId,
  });
  const reporter = new ConsoleAndDiscordReporter(discord);
  const session = new Session(
    { username: config.username, password: config.password, userAgent: config.userAgent },
    { statePath: sessionStatePath(config.dbPath) },
  );
  const pages = new LibraryPages(session, {
    minIntervalMs: config.pageDelayMs,
    jitterMs: config.pageDelayJitterMs,
  });
  const api = new LastfmApi(config.apiKey);
  const planner = new Planner(
    api,
    config.username,
    config.enabledGroups,
    db,
    config.deadCandidateAttempts,
  );
  const resolver = new Resolver(pages, config.username, config.enabledGroups);
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
    }),
    proposals,
    freshToken: () => session.freshCsrfToken(`/user/${config.username}/library`),
    stillThere: async (item) => {
      const { gone } = await pages.fetchOutcome(item.edit.refererPath);
      return !gone;
    },
    albumArt,
    ttlHours: config.approvalTtlHours,
  });

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
    approvals,
  });

  console.log(
    `scrubbler starting | user ${config.username} | dryRun ${String(config.dryRun)}` +
      ` | groups ${[...config.enabledGroups].sort().join(',')}` +
      ` | discord ${discord.enabled ? 'on' : 'off'}` +
      ` | mode ${config.approvalMode ? 'approval' : 'unattended'}`,
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

  // Gateway first in approval mode: a proposal posted before the client is listening has live
  // buttons nothing would answer.
  let gateway: Gateway | undefined;
  if (config.approvalMode) {
    gateway = new Gateway({
      botToken: config.discordBotToken!,
      ownerId: config.discordOwnerId!,
      guildId: config.discordGuildId!,
      commands: new Commands({
        db,
        approvals,
        approvalMode: config.approvalMode,
        dryRun: config.dryRun,
        channelId: config.discordChannelId,
        guildId: config.discordGuildId,
      }),
      decisions: approvals,
      alert: (error, context) => reporter.report(error, context),
      alertAfterMinutes: config.gatewayAlertMinutes,
    });
    await gateway.start();
  }

  worker.start();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('shutting down: finishing the in-flight edit');
    const drained = worker.stop().then(() => true);
    const timedOut = new Promise<boolean>((r) =>
      setTimeout(() => r(false), config.shutdownGraceMs),
    );
    const clean = await Promise.race([drained, timedOut]);
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
