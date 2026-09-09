import { and, eq, gte, sql } from 'drizzle-orm';
import type { LastfmApi } from '../lastfm/api.js';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import { cleanTitle } from '../rules/engine.js';
import type { CustomRuleLookup } from '../rules/customRules.js';
import { type ShadowHit, shadowVerdicts } from '../rules/shadow.js';
import type { GroupName } from '../rules/markers.js';
import type { Candidate } from './types.js';

export interface SweepResult {
  candidates: Candidate[];
  /** Newest scrobble seen, for the cursor. Undefined for a full sweep. */
  newestUts?: number;
}

export class Planner {
  constructor(
    private readonly api: LastfmApi,
    private readonly username: string,
    private readonly enabled: ReadonlySet<GroupName>,
    private readonly db?: Db,
    private readonly deadAfterAttempts = 3,
    /** Consulted during discovery too: a rule the planner cannot see nominates no candidate. */
    private readonly overrides?: CustomRuleLookup,
    /**
     * Called for every entity examined, with what a *disabled* experimental rule would have done.
     * Synchronous and never awaited: discovery must not be slowed or failed by reporting.
     */
    private readonly onShadow?: (hit: ShadowHit) => void,
  ) {}

  private shadow(kind: 'track' | 'album', artist: string, title: string): void {
    if (this.onShadow === undefined) return;
    for (const v of shadowVerdicts(title, kind, this.enabled, this.override(artist))) {
      this.onShadow({ ...v, kind, artist, title });
    }
  }

  private override(artist: string): { artist: string; lookup: CustomRuleLookup } | undefined {
    return this.overrides === undefined ? undefined : { artist, lookup: this.overrides };
  }

  /** Entities already learned to be pointless, so they stop costing a paced page fetch. */
  private isDead(c: Candidate): boolean {
    if (this.db === undefined) return false;
    const row = this.db
      .select()
      .from(schema.deadCandidates)
      .where(
        and(
          eq(schema.deadCandidates.kind, c.kind),
          eq(schema.deadCandidates.artist, c.artist),
          eq(schema.deadCandidates.title, c.title),
          gte(schema.deadCandidates.attempts, this.deadAfterAttempts),
        ),
      )
      .get();
    return row !== undefined;
  }

  /** A user decision, unlike isDead: only /scrub unignore may lift it. */
  private isIgnored(c: Candidate): boolean {
    if (this.db === undefined) return false;
    return (
      this.db
        .select()
        .from(schema.ignored)
        .where(
          and(
            eq(schema.ignored.kind, c.kind),
            eq(schema.ignored.artist, c.artist),
            eq(schema.ignored.title, c.title),
          ),
        )
        .get() !== undefined
    );
  }

  /** Public so the ignore path can be asserted end to end without a network sweep. */
  filterLive(candidates: Candidate[]): Candidate[] {
    return candidates.filter((c) => !this.isDead(c) && !this.isIgnored(c));
  }

  /** Only examines scrobbles newer than the cursor; cheap enough to run every few minutes. */
  async sweepIncremental(
    fromUts: number,
    onProgress?: (seen: number, hits: number) => void,
  ): Promise<SweepResult> {
    const seenKeys = new Set<string>();
    const candidates: Candidate[] = [];
    let seen = 0;
    let newestUts = fromUts;

    for await (const s of this.api.iterateRecentTracks(this.username, fromUts)) {
      seen++;
      if (s.uts > newestUts) newestUts = s.uts;

      const push = (c: Candidate) => {
        const key = `${c.kind}\u0000${c.artist}\u0000${c.title}`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        candidates.push(c);
      };

      if (s.album !== '' && cleanTitle(s.album, 'album', this.enabled, this.override(s.artist))) {
        // artist here is the TRACK artist; the resolver reads the real album artist off the page.
        push({ kind: 'album', artist: s.artist, title: s.album });
      }
      if (cleanTitle(s.track, 'track', this.enabled, this.override(s.artist))) {
        push({ kind: 'track', artist: s.artist, title: s.track });
      }
      // Tracks only: an album shadowed here would be filed under the track artist and would not
      // match the row the full sweep records for the same album.
      this.shadow('track', s.artist, s.track);
      if (seen % 200 === 0) onProgress?.(seen, candidates.length);
    }

    onProgress?.(seen, candidates.length);
    return { candidates: this.filterLive(byKind(candidates)), newestUts };
  }

  async sweep(
    onProgress?: (seen: number, hits: number) => void,
    /** Already nominated by the library-wide cluster scan; ordered in rather than appended. */
    clustered: readonly Candidate[] = [],
  ): Promise<Candidate[]> {
    const candidates: Candidate[] = [...clustered];
    let seen = 0;

    for await (const album of this.api.iterateTopAlbums(this.username)) {
      seen++;
      if (cleanTitle(album.name, 'album', this.enabled, this.override(album.artist))) {
        candidates.push({ kind: 'album', artist: album.artist, title: album.name });
      }
      this.shadow('album', album.artist, album.name);
      if (seen % 1000 === 0) onProgress?.(seen, candidates.length);
    }

    for await (const track of this.api.iterateTopTracks(this.username)) {
      seen++;
      if (cleanTitle(track.name, 'track', this.enabled, this.override(track.artist))) {
        candidates.push({ kind: 'track', artist: track.artist, title: track.name });
      }
      this.shadow('track', track.artist, track.name);
      if (seen % 1000 === 0) onProgress?.(seen, candidates.length);
    }

    onProgress?.(seen, candidates.length);
    return this.filterLive(byKind(candidates));
  }

  /** Records that a candidate resolved to nothing, so repeated emptiness stops costing a fetch. */
  recordDead(c: Candidate, reason: string): void {
    if (this.db === undefined) return;
    const now = new Date();
    this.db
      .insert(schema.deadCandidates)
      .values({ kind: c.kind, artist: c.artist, title: c.title, reason, lastTriedAt: now })
      .onConflictDoUpdate({
        target: [schema.deadCandidates.kind, schema.deadCandidates.artist, schema.deadCandidates.title],
        set: { attempts: sql`${schema.deadCandidates.attempts} + 1`, reason, lastTriedAt: now },
      })
      .run();
  }

  /** A candidate that resolves after all is no longer dead. */
  clearDead(c: Candidate): void {
    if (this.db === undefined) return;
    this.db
      .delete(schema.deadCandidates)
      .where(
        and(
          eq(schema.deadCandidates.kind, c.kind),
          eq(schema.deadCandidates.artist, c.artist),
          eq(schema.deadCandidates.title, c.title),
        ),
      )
      .run();
  }
}

/**
 * Artists, then albums, then tracks. An artist rename changes a field every later tuple carries, and
 * an album rename changes one the track edits carry — resolve them the other way round and the
 * `*_original` tuple the second write selects on has already been rewritten by the first, so it
 * silently no-ops. `test/scrub/albumFirst.test.ts` fails if this order changes.
 */
function byKind(candidates: readonly Candidate[]): Candidate[] {
  return [
    ...candidates.filter((c) => c.kind === 'artist'),
    ...candidates.filter((c) => c.kind === 'album'),
    ...candidates.filter((c) => c.kind === 'track'),
  ];
}
