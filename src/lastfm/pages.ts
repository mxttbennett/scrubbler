import { RateLimiter } from './rateLimiter.js';
import type { Session } from './session.js';
import type { ScrobbleRow } from '../scrub/types.js';

const MAX_ATTEMPTS = 6;
const THROTTLED_BACKOFF_MS = 120_000;

export interface PagesOptions {
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /** Spacing between library page fetches; the web pages throttle far sooner than the API. */
  minIntervalMs?: number;
}

/** Last.fm soft-throttles with HTTP 200 and an HTML page, so status alone cannot detect it. */
export function isThrottled(html: string): boolean {
  return (
    html.includes('You&#8217;re requesting too many pages') ||
    html.includes('You’re requesting too many pages') ||
    /<title[^>]*>\s*Page not available/.test(html)
  );
}

/** Last.fm URLs use `+` for spaces rather than %20. */
export function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

export function trackLibraryPath(user: string, artist: string, track: string): string {
  // +noredirect stops Last.fm canonicalising the artist/track, which would target the wrong rows.
  return `/user/${user}/library/music/+noredirect/${encodePathSegment(artist)}/_/${encodePathSegment(track)}`;
}

export function albumLibraryPath(user: string, artist: string, album: string): string {
  // Without +noredirect Last.fm 301s to a lowercased album name, and a casing-only difference
  // makes the *_original tuple stop matching.
  return `/user/${user}/library/music/+noredirect/${encodePathSegment(artist)}/${encodePathSegment(album)}`;
}

export function hasRealChartlist(html: string): boolean {
  return /<table[^>]*class="[^"]*\bchartlist\b(?![^"]*chartlist__placeholder)[^"]*"/.test(html);
}

/** The placeholder skeleton is the only "still loading" signal; without it the page is settled. */
export function isSettledEmpty(html: string): boolean {
  return html !== '' && !html.includes('chartlist__placeholder') && !hasRealChartlist(html);
}

export function pageCount(html: string): number {
  const list = /<ul[^>]*class="[^"]*pagination-list[^"]*"[^>]*>([\s\S]*?)<\/ul>/.exec(html);
  if (!list) return 1;
  const items = [...list[1]!.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) =>
    m[1]!.replace(/<[^>]+>/g, '').trim(),
  );
  // The last item is the "Next" control, so the highest page number is the one before it.
  for (const text of items.slice(0, -1).reverse()) {
    const n = Number.parseInt(text, 10);
    if (Number.isInteger(n)) return n;
  }
  return 1;
}

export function extractScrobbleRows(html: string): ScrobbleRow[] {
  const rows: ScrobbleRow[] = [];
  for (const form of html.matchAll(/<form[^>]*data-edit-scrobble[^>]*>([\s\S]*?)<\/form>/g)) {
    const fields: Record<string, string> = {};
    for (const input of form[1]!.matchAll(/name=['"]([^'"]+)['"]\s+value=['"]([^'"]*)['"]/g)) {
      fields[input[1]!] = decodeEntities(input[2]!);
    }
    const row = fields as unknown as ScrobbleRow;
    if (row.csrfmiddlewaretoken && row.track_name && row.artist_name && row.timestamp) {
      rows.push({
        csrfmiddlewaretoken: row.csrfmiddlewaretoken,
        artist_name: row.artist_name,
        track_name: row.track_name,
        album_name: row.album_name ?? '',
        album_artist_name: row.album_artist_name ?? '',
        timestamp: row.timestamp,
      });
    }
  }
  return rows;
}

export function extractFormAction(html: string): string | undefined {
  const form = /<form[^>]*data-edit-scrobble[^>]*>/.exec(html);
  if (!form) return undefined;
  const action = /action="([^"]+)"/.exec(form[0]);
  return action?.[1] === undefined ? undefined : decodeEntities(action[1]);
}

/** Links to a nested library page; their presence means the row is an aggregate, not a scrobble. */
export function extractAggregateLinks(html: string): string[] {
  const links = new Set<string>();
  for (const m of html.matchAll(
    /<a[^>]*class="[^"]*chartlist-count-bar-link[^"]*"[^>]*href="([^"]+)"/g,
  )) {
    links.add(decodeEntities(m[1]!));
  }
  for (const m of html.matchAll(
    /<a[^>]*href="([^"]+)"[^>]*class="[^"]*chartlist-count-bar-link[^"]*"/g,
  )) {
    links.add(decodeEntities(m[1]!));
  }
  return [...links];
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export class LibraryPages {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly limiter: RateLimiter;

  constructor(
    private readonly session: Session,
    opts: PagesOptions = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? ((m) => console.log(m));
    this.limiter = new RateLimiter(opts.minIntervalMs ?? 15_000, { sleep: this.sleep });
  }

  private throttledUntil = 0;

  /** True once Last.fm has soft-throttled us, so a sweep can stop rather than dig deeper. */
  get isBackingOff(): boolean {
    return Date.now() < this.throttledUntil;
  }

  /** A 200 carrying only the placeholder skeleton is a failure, not an empty library page. */
  async fetch(path: string): Promise<string> {
    let backoffMs = 1000;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.limiter.acquire();
      const res = await this.session.request(path);
      const retryAfter = Number(res.headers.get('retry-after'));
      const html = res.status === 200 ? await res.text() : (await res.body?.cancel(), '');

      if (res.status === 200 && hasRealChartlist(html)) return html;
      // A redirect is a definitive answer, and a settled page with no chartlist is really empty.
      if (res.status >= 300 && res.status < 400) return '';
      if (res.status === 200 && !isThrottled(html) && isSettledEmpty(html)) return '';

      const throttled = res.status === 429 || isThrottled(html);
      if (throttled) this.throttledUntil = Date.now() + THROTTLED_BACKOFF_MS;
      if (attempt === MAX_ATTEMPTS) return throttled ? '' : html;

      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : throttled
            ? THROTTLED_BACKOFF_MS
            : backoffMs;
      this.log(
        `retrying ${path} (${throttled ? 'throttled by Last.fm' : `status ${res.status}`}, attempt ${attempt}) in ${wait}ms`,
      );
      await this.sleep(wait);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
    return '';
  }
}
