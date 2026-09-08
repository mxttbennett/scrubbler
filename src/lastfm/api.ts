import { LastfmError } from './errors.js';
import { RateLimiter } from './rateLimiter.js';
import {
  type AlbumDetails,
  type AlbumInfo,
  type ScrobbledTrack,
  type TrackInfo,
  type RecentTracks,
  type TopAlbums,
  type TopTracks,
  bestImageUrl,
  toInt,
} from './types.js';

export interface LastfmApiOptions {
  /** Needed for userplaycount, which album.getinfo omits unless the request names a user. */
  username?: string;
  baseUrl?: string;
  /** minimum spacing between requests; default 250ms (~4 req/s) */
  minIntervalMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const PAGE_SIZE = 200;

export class LastfmApi {
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly limiter: RateLimiter;
  private readonly username: string | undefined;

  constructor(
    private readonly apiKey: string,
    opts: LastfmApiOptions = {},
  ) {
    this.baseUrl = opts.baseUrl ?? 'https://ws.audioscrobbler.com/2.0/';
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.limiter = new RateLimiter(opts.minIntervalMs ?? 250, { sleep: this.sleep });
    this.username = opts.username;
  }

  private async request<T>(method: string, params: Record<string, string>): Promise<T> {
    let attempt = 0;
    for (;;) {
      attempt++;
      await this.limiter.acquire();
      let error: LastfmError;
      try {
        const url = new URL(this.baseUrl);
        url.searchParams.set('method', method);
        url.searchParams.set('api_key', this.apiKey);
        url.searchParams.set('format', 'json');
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

        const res = await this.fetchImpl(url);
        const body: unknown = await res.json().catch(() => undefined);
        const apiError =
          typeof body === 'object' && body !== null && 'error' in body
            ? (body as { error: number; message?: string })
            : undefined;

        if (!apiError && res.ok && body !== undefined) return body as T;
        error = apiError
          ? new LastfmError(apiError.error, apiError.message ?? 'Unknown Last.fm error', method)
          : new LastfmError(8, `HTTP ${res.status} from Last.fm`, method);
      } catch (cause) {
        error = new LastfmError(8, `Network error calling Last.fm: ${String(cause)}`, method);
      }

      if (!error.retryable || attempt > this.maxRetries) throw error;
      await this.sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
    }
  }

  getTopAlbums(user: string, page = 1, limit = PAGE_SIZE): Promise<TopAlbums> {
    return this.request('user.gettopalbums', {
      user,
      period: 'overall',
      limit: String(limit),
      page: String(page),
    });
  }

  getTopTracks(user: string, page = 1, limit = PAGE_SIZE): Promise<TopTracks> {
    return this.request('user.gettoptracks', {
      user,
      period: 'overall',
      limit: String(limit),
      page: String(page),
    });
  }

  private readonly albumCache = new Map<string, AlbumDetails>();

  private static readonly NO_DETAILS: AlbumDetails = {
    imageUrl: undefined,
    trackNames: [],
    scrobbles: undefined,
  };

  /**
   * One album.getinfo carries the art, the release track list and the user's play count, so the
   * report can name what a whole-album rename covered — the album's own library page renders its
   * track list client-side and has none of it. Cached per run so an album's many tracks cost one
   * lookup, and silent on failure because none of this may fail a correction.
   */
  async albumDetails(artist: string, album: string): Promise<AlbumDetails> {
    if (album === '' || artist === '') return LastfmApi.NO_DETAILS;
    const key = `${artist}\u0000${album}`;
    const cached = this.albumCache.get(key);
    if (cached !== undefined) return cached;

    let details = LastfmApi.NO_DETAILS;
    try {
      // username is what makes userplaycount appear at all.
      const data = await this.request<AlbumInfo>('album.getinfo', {
        artist,
        album,
        ...(this.username === undefined ? {} : { username: this.username }),
      });
      const raw = data.album?.tracks?.track;
      const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      const plays = Number(data.album?.userplaycount ?? NaN);
      details = {
        imageUrl: bestImageUrl(data.album?.image),
        trackNames: list.map((t) => t.name).filter((n) => n !== ''),
        scrobbles: Number.isFinite(plays) ? plays : undefined,
      };
    } catch {
      details = LastfmApi.NO_DETAILS;
    }
    this.albumCache.set(key, details);
    return details;
  }

  /**
   * Which of an album's tracks the user has actually played. album.getinfo returns the whole release
   * track list with no per-track counts, so a card built from it names songs a rename never touched;
   * track.getinfo with a username is the only source for the count. One request per track, capped,
   * and only ever called for a rename that already landed.
   *
   * The count is the track's total across every album it appears on, not just this one — Last.fm
   * exposes no album-scoped per-track figure.
   */
  async scrobbledTracks(
    artist: string,
    trackNames: readonly string[],
    limit = 30,
  ): Promise<ScrobbledTrack[]> {
    const out: ScrobbledTrack[] = [];
    for (const name of trackNames.slice(0, limit)) {
      try {
        const data = await this.request<TrackInfo>('track.getinfo', {
          artist,
          track: name,
          ...(this.username === undefined ? {} : { username: this.username }),
        });
        const plays = Number(data.track?.userplaycount ?? 0);
        if (Number.isFinite(plays) && plays > 0) out.push({ name, plays });
      } catch {
        // A single unknown track must not cost the whole list.
      }
    }
    return out;
  }

  /** Art for the POST-edit album name — the point is to show what it will be. */
  async albumArt(artist: string, album: string): Promise<string | undefined> {
    return (await this.albumDetails(artist, album)).imageUrl;
  }

  getRecentTracks(user: string, fromUts: number, page = 1, limit = PAGE_SIZE): Promise<RecentTracks> {
    return this.request('user.getrecenttracks', {
      user,
      from: String(fromUts),
      limit: String(limit),
      page: String(page),
    });
  }

  /**
   * Yields scrobbles newer than `fromUts`. `album.#text` is the album title but there is no
   * albumartist field at all, so a caller must resolve the album artist from the library page.
   */
  async *iterateRecentTracks(
    user: string,
    fromUts: number,
  ): AsyncGenerator<{ track: string; artist: string; album: string; uts: number }> {
    let page = 1;
    let totalPages = 1;
    do {
      const data = await this.getRecentTracks(user, fromUts, page);
      totalPages = toInt(data.recenttracks['@attr'].totalPages);
      for (const t of data.recenttracks.track) {
        // A now-playing row has no date and is not yet a scrobble.
        if (t.date === undefined) continue;
        yield {
          track: t.name,
          artist: t.artist['#text'],
          album: t.album['#text'],
          uts: toInt(t.date.uts),
        };
      }
      page++;
    } while (page <= totalPages);
  }

  async *iterateTopAlbums(user: string): AsyncGenerator<{ name: string; artist: string }> {
    let page = 1;
    let totalPages = 1;
    do {
      const data = await this.getTopAlbums(user, page);
      totalPages = toInt(data.topalbums['@attr'].totalPages);
      for (const album of data.topalbums.album) {
        yield { name: album.name, artist: album.artist.name };
      }
      page++;
    } while (page <= totalPages);
  }

  async *iterateTopTracks(user: string): AsyncGenerator<{ name: string; artist: string }> {
    let page = 1;
    let totalPages = 1;
    do {
      const data = await this.getTopTracks(user, page);
      totalPages = toInt(data.toptracks['@attr'].totalPages);
      for (const track of data.toptracks.track) {
        yield { name: track.name, artist: track.artist.name };
      }
      page++;
    } while (page <= totalPages);
  }
}
