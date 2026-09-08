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
    /** Album rows carry '' for the track fields; the unique index keeps them distinct from tracks. */
    kind: text('kind', { enum: ['track', 'album'] }).notNull().default('track'),
    groups: text('groups').notNull(),
    /** Kept so an interrupted resolution can be resumed without re-scraping every library page. */
    timestamp: text('timestamp'),
    action: text('action'),
    refererPath: text('referer_path'),
    /**
     * JSON array of the tracks an album rename covers, for the same reason `action` and
     * `referer_path` are here: a resume rebuilds the edit from this row, and these live nowhere else
     * — the album page they were read from is gone once the rename lands.
     */
    trackNames: text('track_names'),
    status: text('status', {
      enum: [
        'applied',
        'verified',
        'unverified',
        'failed',
        'skipped',
        'planned',
        'awaiting_approval',
        'ignored',
      ],
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
  /** Live, unlike the mode itself: read at each candidate boundary so /scrub pause needs no restart. */
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
  phase: text('phase', { enum: ['idle', 'sweeping', 'resolving', 'applying'] })
    .notNull()
    .default('idle'),
  candidatesDone: integer('candidates_done').notNull().default(0),
  candidatesTotal: integer('candidates_total').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
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

/**
 * One row per proposed change awaiting a decision. `id` is what a button's custom_id carries, so a
 * row must exist before the message is posted — hence the `pending_post` status, which is never
 * actionable and never blocks a write.
 */
export const approvals = sqliteTable(
  'approvals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** sha256 over kind plus the group's sorted original tuple keys; a changed group is a new key. */
    groupKey: text('group_key').notNull(),
    messageId: text('message_id'),
    channelId: text('channel_id'),
    artist: text('artist').notNull(),
    kind: text('kind', { enum: ['track', 'album'] }).notNull(),
    sharedField: text('shared_field'),
    sharedFrom: text('shared_from'),
    sharedTo: text('shared_to'),
    itemCount: integer('item_count').notNull().default(1),
    status: text('status', {
      enum: ['pending_post', 'pending', 'approved', 'ignored', 'expired', 'superseded'],
    }).notNull(),
    decidedBy: text('decided_by'),
    createdAt: createdAt(),
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    uniqueIndex('approvals_group_key').on(t.groupKey),
    index('approvals_status').on(t.status),
    index('approvals_message').on(t.messageId),
  ],
);

export const approvalEdits = sqliteTable(
  'approval_edits',
  {
    approvalId: integer('approval_id').notNull(),
    appliedEditId: integer('applied_edit_id').notNull(),
  },
  (t) => [uniqueIndex('approval_edits_pair').on(t.approvalId, t.appliedEditId)],
);

/**
 * Entities the user rejected. Deliberately separate from `skipped` (rewritten every pass) and
 * `dead_candidates` (the service's own learned emptiness): only `/scrub unignore` may remove one, so
 * a re-resolution must not be able to overwrite the decision.
 */
export const ignored = sqliteTable(
  'ignored',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: ['track', 'album'] }).notNull(),
    artist: text('artist').notNull(),
    title: text('title').notNull(),
    reason: text('reason').notNull(),
    decidedBy: text('decided_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ignored_entity').on(t.kind, t.artist, t.title)],
);

/**
 * User-supplied replacements the closed marker catalogue cannot express. Artist is required, not
 * optional: every path in the pipeline is artist-addressed, so a title-only rule could be applied
 * to an entity already found but could never be discovered. Every key column is non-null, because
 * SQLite treats repeated NULLs in a unique index as distinct.
 */
export const customRules = sqliteTable(
  'custom_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: ['track', 'album'] }).notNull(),
    artist: text('artist').notNull(),
    fromTitle: text('from_title').notNull(),
    toTitle: text('to_title').notNull(),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    lastAppliedAt: integer('last_applied_at', { mode: 'timestamp_ms' }),
    timesApplied: integer('times_applied').notNull().default(0),
  },
  (t) => [uniqueIndex('custom_rules_entity').on(t.kind, t.artist, t.fromTitle)],
);

/**
 * What a *disabled* experimental rule would have changed, so a rule can be vetted against the real
 * library before it is trusted with it. Not a ledger row: `applied_edits` is unique on the four
 * *_original columns and its statuses all mean a decision was taken, so a shadow hit there would
 * occupy the tuple a later real correction needs.
 *
 * Keyed without the artist on purpose — `sweepIncremental` nominates an album under the TRACK
 * artist while `sweep()` uses the album artist, so including it would record the same album twice.
 */
export const shadowHits = sqliteTable(
  'shadow_hits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** A GroupName, deliberately unconstrained so a new group needs no migration. */
    rule: text('rule').notNull(),
    kind: text('kind', { enum: ['track', 'album'] }).notNull(),
    title: text('title').notNull(),
    wouldBe: text('would_be').notNull(),
    /** Display only, outside the identity key for the reason above. */
    sourceArtist: text('source_artist').notNull(),
    seenAt: createdAt(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
    /** Null until a send actually returned: the REST sender no-ops silently when unconfigured. */
    reportedAt: integer('reported_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    uniqueIndex('shadow_hits_entity').on(t.rule, t.kind, t.title),
    index('shadow_hits_unreported').on(t.reportedAt),
  ],
);

