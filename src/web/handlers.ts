import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type { LibraryMirror, MirrorStats } from '../library/mirror.js';
import { RuleRejected, type CustomRules } from '../rules/customRules.js';
import type { GroupName } from '../rules/markers.js';
import type { Approvals } from '../scrub/approvals.js';
import { type BulkItem, isCasingOnly, orderBulkItems } from './bulk.js';

export interface RowsQuery {
  status?: string | undefined;
  kind?: string | undefined;
  q?: string | undefined;
  artist?: string | undefined;
  album?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface GridRow {
  libraryId: number | null;
  ledgerId: number | null;
  approvalId: number | null;
  kind: 'track' | 'album';
  artist: string;
  title: string;
  albumTitle: string | null;
  albumArtist: string | null;
  albumSource: string | null;
  playcount: number;
  status: string | null;
  groups: string | null;
}

export interface WebState {
  phase: string;
  paused: boolean;
  candidatesDone: number;
  candidatesTotal: number;
  lastFullSweepAt: number | null;
  dryRun: boolean;
  enabledRules: string[];
  gatedRules: string[];
  mirror: MirrorStats;
  /** In-process, because a refresh is not a sweep and must not overload `sweep_state.phase`. */
  refresh: RefreshStatus;
}

export interface RefreshStatus {
  running: boolean;
  kind: 'track' | 'album' | null;
  done: number;
  total: number;
  startedAt: number | null;
  error: string | null;
}

export interface HandlerDeps {
  db: Db;
  approvals: Approvals;
  customRules: CustomRules;
  mirror: LibraryMirror;
  applyNow: (candidate: { kind: 'track' | 'album'; artist: string; title: string }) => Promise<string>;
  applyBulk: (items: BulkItem[]) => Promise<{ applied: number; detail: string }>;
  dryRun: boolean;
  enabledRules: ReadonlySet<GroupName>;
  gatedRules: ReadonlySet<GroupName>;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_LIMIT = 500;

export class Handlers {
  private refresh: RefreshStatus = {
    running: false,
    kind: null,
    done: 0,
    total: 0,
    startedAt: null,
    error: null,
  };

  constructor(private readonly deps: HandlerDeps) {}

  /**
   * The grid is the mirror LEFT JOINed onto the ledger, so an entity the engine never nominated
   * appears beside one it corrected. A pending approval is joined separately because an approval id
   * is a third id space — `Approvals.approve` takes it and nothing else.
   */
  rows(query: RowsQuery): { rows: GridRow[]; total: number } {
    const limit = Math.min(query.limit ?? 200, MAX_LIMIT);
    const offset = Math.max(query.offset ?? 0, 0);

    const filters = [];
    if (query.kind === 'track' || query.kind === 'album') {
      filters.push(sql`l.kind = ${query.kind}`);
    }
    if (query.artist !== undefined && query.artist !== '') {
      filters.push(sql`lower(l.artist) = lower(${query.artist})`);
    }
    if (query.album !== undefined && query.album !== '') {
      filters.push(sql`lower(coalesce(l.album_title, '')) = lower(${query.album})`);
    }
    if (query.q !== undefined && query.q !== '') {
      filters.push(sql`(l.title LIKE ${'%' + query.q + '%'} OR l.artist LIKE ${'%' + query.q + '%'})`);
    }
    if (query.status !== undefined && query.status !== '') {
      filters.push(
        query.status === 'untouched' ? sql`e.status IS NULL` : sql`e.status = ${query.status}`,
      );
    }
    const where = filters.length === 0 ? sql`1 = 1` : sql.join(filters, sql` AND `);

    const from = sql`
      FROM library l
      LEFT JOIN applied_edits e ON e.status IS NOT NULL AND (
        (l.kind = 'track' AND e.kind = 'track'
           AND lower(e.track_name_original) = lower(l.title)
           AND lower(e.artist_name_original) = lower(l.artist))
        OR
        (l.kind = 'album' AND e.kind = 'album'
           AND lower(e.album_name_original) = lower(l.title)
           AND lower(e.album_artist_name_original) = lower(l.artist))
      )
      LEFT JOIN approval_edits ae ON ae.applied_edit_id = e.id
      LEFT JOIN approvals a ON a.id = ae.approval_id AND a.status = 'pending'
      WHERE ${where}
    `;

    const total = this.deps.db.get<{ n: number }>(sql`SELECT count(*) AS n ${from}`)?.n ?? 0;
    const rows = this.deps.db.all<GridRow>(sql`
      SELECT l.id AS libraryId, e.id AS ledgerId, a.id AS approvalId, l.kind, l.artist, l.title,
             l.album_title AS albumTitle, l.album_artist AS albumArtist,
             l.album_source AS albumSource, l.playcount, e.status, e.groups
      ${from}
      ORDER BY l.playcount DESC, l.artist, l.title
      LIMIT ${limit} OFFSET ${offset}
    `);

    return { rows, total };
  }

  albumTracks(artist: string, album: string): GridRow[] {
    return this.rows({ artist, album, kind: 'track', limit: MAX_LIMIT }).rows;
  }

  async approve(approvalId: number, userId: string): Promise<{ outcome: string; detail: string }> {
    const result = await this.deps.approvals.approve(approvalId, userId);
    return { outcome: result.outcome, detail: result.detail };
  }

  async ignore(approvalId: number, userId: string): Promise<{ outcome: string; detail: string }> {
    const result = await this.deps.approvals.ignore(approvalId, userId);
    return { outcome: result.outcome, detail: result.detail };
  }

  /** A real write, so it refuses while paused — the same guard the slash command applies. */
  async retry(libraryId: number): Promise<{ text: string }> {
    this.refuseWhilePaused();
    const row = this.deps.db
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, libraryId))
      .get();
    if (row === undefined) throw new HttpError(404, `no library row ${libraryId}`);
    return { text: await this.deps.applyNow({ kind: row.kind, artist: row.artist, title: row.title }) };
  }

  async bulk(items: BulkItem[]): Promise<{ applied: number; detail: string; refused: BulkItem[] }> {
    this.refuseWhilePaused();
    if (items.length === 0) throw new HttpError(400, 'no items');
    const refused = items.filter(isCasingOnly);
    const usable = orderBulkItems(items.filter((i) => !isCasingOnly(i)));
    if (usable.length === 0) return { applied: 0, detail: 'every item was casing-only', refused };
    const result = await this.deps.applyBulk(usable);
    return { ...result, refused };
  }

  listRules(): (typeof schema.customRules.$inferSelect)[] {
    return this.deps.db.select().from(schema.customRules).all();
  }

  addRule(rule: { kind: 'track' | 'album'; artist: string; from: string; to: string }): { id: number } {
    try {
      const added = this.deps.customRules.add({
        kind: rule.kind,
        artist: rule.artist,
        fromTitle: rule.from,
        toTitle: rule.to,
        createdBy: 'web',
      });
      return { id: added.id };
    } catch (error) {
      if (error instanceof RuleRejected) throw new HttpError(422, error.message);
      throw error;
    }
  }

  state(): WebState {
    const sweep = this.deps.db
      .select()
      .from(schema.sweepState)
      .where(eq(schema.sweepState.id, 1))
      .get();
    return {
      phase: sweep?.phase ?? 'idle',
      paused: sweep?.paused ?? false,
      candidatesDone: sweep?.candidatesDone ?? 0,
      candidatesTotal: sweep?.candidatesTotal ?? 0,
      lastFullSweepAt: sweep?.lastFullSweepAt?.getTime() ?? null,
      dryRun: this.deps.dryRun,
      enabledRules: [...this.deps.enabledRules],
      gatedRules: [...this.deps.gatedRules],
      mirror: this.deps.mirror.stats(),
      refresh: this.refresh,
    };
  }

  setPaused(paused: boolean): { paused: boolean } {
    this.deps.db
      .insert(schema.sweepState)
      .values({ id: 1, paused })
      .onConflictDoUpdate({ target: schema.sweepState.id, set: { paused } })
      .run();
    return { paused };
  }

  shadowCounts(): { rule: string; unreported: number; total: number }[] {
    return this.deps.db.all(sql`
      SELECT rule, sum(reported_at IS NULL) AS unreported, count(*) AS total
      FROM shadow_hits GROUP BY rule ORDER BY total DESC
    `);
  }

  /** Returns immediately; the grid watches `/api/state` rather than holding a request open. */
  startRefresh(): RefreshStatus {
    if (this.refresh.running) return this.refresh;
    this.refresh = { running: true, kind: null, done: 0, total: 0, startedAt: Date.now(), error: null };
    void this.deps.mirror
      .enumerate((p) => {
        this.refresh = { ...this.refresh, ...p };
      })
      .then(() => {
        this.refresh = { ...this.refresh, running: false };
      })
      .catch((error: unknown) => {
        this.refresh = {
          ...this.refresh,
          running: false,
          error: error instanceof Error ? error.message : String(error),
        };
      });
    return this.refresh;
  }

  private refuseWhilePaused(): void {
    const state = this.deps.db
      .select()
      .from(schema.sweepState)
      .where(eq(schema.sweepState.id, 1))
      .get();
    if (state?.paused === true) {
      throw new HttpError(409, 'the service is paused; resume it before applying an edit');
    }
  }
}
