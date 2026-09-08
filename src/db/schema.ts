import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

/** One row per distinct (track, artist, album, album artist) tuple ever acted on. */
export const appliedEdits = sqliteTable(
  'applied_edits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    trackNameOriginal: text('track_name_original').notNull(),
    artistNameOriginal: text('artist_name_original').notNull(),
    albumNameOriginal: text('album_name_original').notNull(),
    albumArtistNameOriginal: text('album_artist_name_original').notNull(),
    trackName: text('track_name').notNull(),
    artistName: text('artist_name').notNull(),
    albumName: text('album_name').notNull(),
    albumArtistName: text('album_artist_name').notNull(),
    groups: text('groups').notNull(),
    /** Kept so an interrupted resolution can be resumed without re-scraping every library page. */
    timestamp: text('timestamp'),
    action: text('action'),
    refererPath: text('referer_path'),
    status: text('status', {
      enum: ['applied', 'verified', 'unverified', 'failed', 'skipped', 'planned'],
    }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: createdAt(),
    verifiedAt: integer('verified_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    uniqueIndex('applied_edits_tuple').on(
      t.trackNameOriginal,
      t.artistNameOriginal,
      t.albumNameOriginal,
      t.albumArtistNameOriginal,
    ),
    index('applied_edits_status').on(t.status),
  ],
);

/** Candidates deliberately not acted on, kept so the decision is inspectable later. */
export const skipped = sqliteTable(
  'skipped',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: ['track', 'album'] }).notNull(),
    artist: text('artist').notNull(),
    title: text('title').notNull(),
    reason: text('reason').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('skipped_entity').on(t.kind, t.artist, t.title)],
);

export const sweepState = sqliteTable('sweep_state', {
  id: integer('id').primaryKey(),
  lastFullSweepAt: integer('last_full_sweep_at', { mode: 'timestamp_ms' }),
  lastSweepEditCount: integer('last_sweep_edit_count').notNull().default(0),
  /** Newest scrobble already examined; null forces a full sweep. */
  lastScrobbleUts: integer('last_scrobble_uts'),
});

/**
 * Entities the service has learned are pointless to ask about — an album with no scrobbles under
 * that exact title, say. Distinct from `skipped` (a transient per-pass note) and from a user's
 * ignore decision: this is the service's own memory, and clearing it is safe.
 */
export const deadCandidates = sqliteTable(
  'dead_candidates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: ['track', 'album'] }).notNull(),
    artist: text('artist').notNull(),
    title: text('title').notNull(),
    attempts: integer('attempts').notNull().default(1),
    reason: text('reason').notNull(),
    lastTriedAt: integer('last_tried_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('dead_candidates_entity').on(t.kind, t.artist, t.title)],
);
