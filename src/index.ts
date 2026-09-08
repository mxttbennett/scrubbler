import { loadConfig } from './core/config.js';
import { createDb, runMigrations } from './db/index.js';
import { LastfmApi } from './lastfm/api.js';
import { AlbumEditor } from './lastfm/albumEditor.js';
import { Editor } from './lastfm/editor.js';
import { LibraryPages } from './lastfm/pages.js';
import { Session, sessionStatePath } from './lastfm/session.js';
import { Discord } from './report/discord.js';
import { ConsoleAndDiscordReporter } from './report/reporter.js';
import { Planner } from './scrub/planner.js';
import { Resolver } from './scrub/resolver.js';
import { ScrubWorker } from './scrub/worker.js';

async function main() {
  const config = loadConfig();
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
  const planner = new Planner(api, config.username, config.enabledGroups);
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

  const worker = new ScrubWorker(
    config,
    db,
    session,
    planner,
    resolver,
    editor,
    albumEditor,
    reporter,
  );

  console.log(
    `scrubbler starting | user ${config.username} | dryRun ${String(config.dryRun)}` +
      ` | groups ${[...config.enabledGroups].sort().join(',')}` +
      ` | discord ${discord.enabled ? 'on' : 'off'}`,
  );

  if (process.argv.includes('--once')) {
    await worker.runOnce();
    return;
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
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  console.error('fatal startup error:', error);
  process.exit(1);
});
