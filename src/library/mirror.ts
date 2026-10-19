import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type { LastfmApi } from '../lastfm/api.js';
import { toInt } from '../lastfm/types.js';

/** Last.fm's documented maximum for the user.get* list endpoints. */
const ENUMERATE_LIMIT = 1000;

/** After this many failed album.getinfo attempts a row stops being retried. */
const MAX_MAP_ATTEMPTS = 3;

export interface MirrorStats {
  albums: number;
  tracks: number;
  mapped: number;
  unmapped: number;
  failed: number;
}

export interface MirrorProgress {
  kind: 'track' | 'album';
  done: number;
  total: number;
}

export interface MirrorDeps {
  db: Db;
  api: Pick<LastfmApi, 'getTopAlbums' | 'getTopTracks' | 'albumTrackNames'>;
  username: string;
  log?: (message: string) => void;
}

export interface CrawlOptions {
  /** Albums to map in this slice. A crawl is resumable, so a small slice is not a partial failure. */
  limit?: number;
  /** Checked between albums, so an idle-window crawl yields promptly when a sweep is due. */
  signal?: () => boolean;
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Every entity in the library, mirrored from the JSON API so the grid can offer a track the engine
 * has no opinion about. Deliberately has no `LibraryPages` dependency: the pages are 60× more
 * expensive and are the one resource Last.fm actively throttles, so enumeration must never touch
 * them.
 */
export class LibraryMirror {
  constructor(private readonly deps: MirrorDeps) {}

  async enumerate(onProgress?: (p: MirrorProgress) => void): Promise<MirrorStats> {
    await this.enumerateAlbums(onProgress);
    await this.enumerateTracks(onProgress);
    return this.stats();
  }

  private async enumerateAlbums(onProgress?: (p: MirrorProgress) => void): Promise<void> {
    let page = 1;
    let total = 0;
    let done = 0;
    for (;;) {
      const data = await this.deps.api.getTopAlbums(this.deps.username, page, ENUMERATE_LIMIT);
      const attr = data.topalbums['@attr'];
      total = toInt(attr.total);
      for (const album of data.topalbums.album) {
        this.upsert({
          kind: 'album',
          artist: album.artist.name,
          title: album.name,
          playcount: toInt(album.playcount),
        });
        done++;
      }
      onProgress?.({ kind: 'album', done, total });
      if (page >= toInt(attr.totalPages)) break;
      page++;
    }
  }

  private async enumerateTracks(onProgress?: (p: MirrorProgress) => void): Promise<void> {
    let page = 1;
    let total = 0;
    let done = 0;
    for (;;) {
      const data = await this.deps.api.getTopTracks(this.deps.username, page, ENUMERATE_LIMIT);
      const attr = data.toptracks['@attr'];
      total = toInt(attr.total);
      for (const track of data.toptracks.track) {
        this.upsert({
          kind: 'track',
          artist: track.artist.name,
          title: track.name,
          playcount: toInt(track.playcount),
        });
        done++;
      }
      onProgress?.({ kind: 'track', done, total });
      if (page >= toInt(attr.totalPages)) break;
      page++;
    }
  }

  /** Playcount and last-seen move on every pass; the album mapping is left to the crawl. */
  private upsert(row: { kind: 'track' | 'album'; artist: string; title: string; playcount: number }): void {
    const seen = { playcount: row.playcount, lastSeenAt: new Date() };
    this.deps.db
      .insert(schema.library)
      .values({ ...row, ...seen })
      .onConflictDoUpdate({
        target: [schema.library.kind, schema.library.artist, schema.library.title],
        set: seen,
      })
      .run();
  }

  /**
   * Maps tracks to albums from `album.getinfo`. The API's release track list is not the user's
   * scrobbled one, so a bonus or uncatalogued track stays unmapped — it remains listed and
   * individually editable, and only album *grouping* is affected.
   */
  async crawlAlbums(opts: CrawlOptions = {}): Promise<{ mapped: number; failed: number }> {
    const albums = this.deps.db
      .select()
      .from(schema.library)
      .where(
        and(
          eq(schema.library.kind, 'album'),
          isNull(schema.library.mappedAt),
          lt(schema.library.mapAttempts, MAX_MAP_ATTEMPTS),
        ),
      )
      .limit(opts.limit ?? 50)
      .all();

    let mapped = 0;
    let failed = 0;
    for (const album of albums) {
      if (opts.signal?.() === true) break;
      try {
        const names = await this.deps.api.albumTrackNames(album.artist, album.title);
        this.applyMapping(album.artist, album.title, names);
        this.deps.db
          .update(schema.library)
          .set({ mappedAt: new Date(), mapError: null })
          .where(eq(schema.library.id, album.id))
          .run();
        mapped++;
      } catch (error) {
        this.deps.db
          .update(schema.library)
          .set({
            mapAttempts: album.mapAttempts + 1,
            mapError: error instanceof Error ? error.message : String(error),
          })
          .where(eq(schema.library.id, album.id))
          .run();
        failed++;
      }
    }
    return { mapped, failed };
  }

  /** Case-insensitive on title because Last.fm's own casing differs between the two endpoints. */
  private applyMapping(albumArtist: string, albumTitle: string, trackNames: string[]): void {
    for (const name of trackNames) {
      this.deps.db
        .update(schema.library)
        .set({ albumTitle, albumArtist, albumSource: 'api' })
        .where(
          and(
            eq(schema.library.kind, 'track'),
            eq(sql`lower(trim(${schema.library.artist}))`, lower(albumArtist)),
            eq(sql`lower(trim(${schema.library.title}))`, lower(name)),
          ),
        )
        .run();
    }
  }

  stats(): MirrorStats {
    const rows = this.deps.db.select().from(schema.library).all();
    const tracks = rows.filter((r) => r.kind === 'track');
    return {
      albums: rows.length - tracks.length,
      tracks: tracks.length,
      mapped: tracks.filter((r) => r.albumTitle !== null).length,
      unmapped: tracks.filter((r) => r.albumTitle === null).length,
      failed: rows.filter((r) => r.mapAttempts >= MAX_MAP_ATTEMPTS).length,
    };
  }
}
