import 'dotenv/config';
import { z } from 'zod';
import { LastfmApi } from '../lastfm/api.js';
import { OsascriptLibrary } from './appleMusic.js';
import { LovedSync, SyncState } from './lovedSync.js';

/**
 * Standalone on purpose: Music.app is scriptable only on a Mac, and scrubbler's worker usually runs
 * elsewhere. This needs the read-only API key and nothing else, so it shares no config with it.
 */
const env = z
  .object({
    LASTFM_USERNAME: z.string().min(1),
    LASTFM_API_KEY: z.string().min(1),
    DRY_RUN: z.string().default('true'),
    APPLE_SYNC_STATE_PATH: z.string().default('.data/apple-sync.json'),
  })
  .parse(process.env);

const dryRun = !['false', '0', 'no', 'off'].includes(env.DRY_RUN.trim().toLowerCase());
const api = new LastfmApi(env.LASTFM_API_KEY, { username: env.LASTFM_USERNAME });
const sync = new LovedSync(new OsascriptLibrary(), new SyncState(env.APPLE_SYNC_STATE_PATH), { dryRun });

const r = await sync.run(api.iterateLovedTracks(env.LASTFM_USERNAME));
const verb = dryRun ? 'would favorite' : 'favorited';
console.log(
  `apple-sync${dryRun ? ' (dry run)' : ''}: ${r.loved} loved | ${verb} ${r.favorited.length}` +
    ` | already done ${r.alreadyDone} | not in library ${r.notInLibrary.length}`,
);
for (const t of r.favorited) console.log(`  + ${t.artist} — ${t.name}`);
for (const t of r.notInLibrary) console.log(`  ? ${t.artist} — ${t.name}`);
