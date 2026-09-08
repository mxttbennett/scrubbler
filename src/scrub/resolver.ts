import { LibraryPages, albumLibraryPath, extractAggregateLinks, extractFormAction, extractScrobbleRows, pageCount, trackLibraryPath } from '../lastfm/pages.js';
import { cleanTitle } from '../rules/engine.js';
import type { GroupName } from '../rules/markers.js';
import { type Candidate, type PlannedEdit, type ScrobbleRow, rowTuple, tupleKey } from './types.js';

const MAX_RECURSION = 2;

export interface SkipRecord {
  candidate: Candidate;
  reason: string;
}

export interface ResolveResult {
  edits: PlannedEdit[];
  skips: SkipRecord[];
}

export class Resolver {
  constructor(
    private readonly pages: LibraryPages,
    private readonly username: string,
    private readonly enabled: ReadonlySet<GroupName>,
  ) {}

  /**
   * Merges every candidate into at most one edit per (track, artist, album, album artist) tuple.
   * Two POSTs against one tuple cannot both land — the first rewrites the tuple the second selects
   * on — so track and album cleanups for the same tuple must share a request.
   */
  async resolve(candidates: Candidate[]): Promise<ResolveResult> {
    const byTuple = new Map<string, PlannedEdit>();
    const skips: SkipRecord[] = [];
    const seenPaths = new Set<string>();

    for (const candidate of candidates) {
      const path =
        candidate.kind === 'track'
          ? trackLibraryPath(this.username, candidate.artist, candidate.title)
          : albumLibraryPath(this.username, candidate.artist, candidate.title);

      if (seenPaths.has(path)) continue;
      seenPaths.add(path);

      const rows = await this.collectRows(path, MAX_RECURSION);
      if (rows.length === 0) {
        skips.push({ candidate, reason: 'no scrobble rows found on library page' });
        continue;
      }

      for (const { row, action, refererPath } of rows) {
        this.fold(byTuple, row, action, refererPath);
      }
    }

    return { edits: [...byTuple.values()], skips };
  }

  private fold(
    byTuple: Map<string, PlannedEdit>,
    row: ScrobbleRow,
    action: string,
    refererPath: string,
  ): void {
    const original = rowTuple(row);
    const key = tupleKey(original);
    if (byTuple.has(key)) return;

    // Always re-derive from the authoritative page value; the API's copy can be stale.
    const track = cleanTitle(row.track_name, 'track', this.enabled);
    const album =
      row.album_name === '' ? null : cleanTitle(row.album_name, 'album', this.enabled);
    if (!track && !album) return;

    const groups = [...new Set([...(track?.groups ?? []), ...(album?.groups ?? [])])].sort();
    byTuple.set(key, {
      original,
      next: {
        ...original,
        track_name: track?.clean ?? original.track_name,
        album_name: album?.clean ?? original.album_name,
      },
      timestamp: row.timestamp,
      csrfToken: row.csrfmiddlewaretoken,
      action,
      refererPath,
      groups,
    });
  }

  private async collectRows(
    path: string,
    depth: number,
  ): Promise<{ row: ScrobbleRow; action: string; refererPath: string }[]> {
    const out: { row: ScrobbleRow; action: string; refererPath: string }[] = [];
    const first = await this.pages.fetch(path);
    if (first === '') return out;

    const total = pageCount(first);
    const htmls = [first];
    for (let page = 2; page <= total; page++) {
      htmls.push(await this.pages.fetch(`${path}?page=${page}`));
    }

    for (const html of htmls) {
      if (html === '') continue;
      const action = extractFormAction(html);
      const rows = extractScrobbleRows(html);
      if (action !== undefined && rows.length > 0) {
        for (const row of rows) out.push({ row, action, refererPath: path });
        continue;
      }
      if (depth <= 0) continue;
      for (const link of extractAggregateLinks(html)) {
        const nested = link.startsWith('http') ? new URL(link).pathname : link;
        out.push(...(await this.collectRows(withNoRedirect(nested), depth - 1)));
      }
    }
    return out;
  }
}

export function withNoRedirect(path: string): string {
  if (path.includes('/library/music/+noredirect/')) return path;
  return path.replace('/library/music/', '/library/music/+noredirect/');
}
