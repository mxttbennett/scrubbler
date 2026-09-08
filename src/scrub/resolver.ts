import { type PlannedAlbumEdit, extractAlbumForm } from '../lastfm/albumEditor.js';
import { LibraryPages, albumLibraryPath, extractAggregateLinks, extractAlbumTrackNames, extractFormAction, extractScrobbleRows, pageCount, trackLibraryPath } from '../lastfm/pages.js';
import { cleanTitle } from '../rules/engine.js';
import type { CustomRuleLookup } from '../rules/customRules.js';
import type { GroupName } from '../rules/markers.js';
import {
  type Candidate,
  type EditGroup,
  type PlannedEdit,
  type ScrobbleRow,
  rowTuple,
  toAlbumGroup,
  toGroup,
  tupleKey,
} from './types.js';

const MAX_RECURSION = 2;

export interface SkipRecord {
  candidate: Candidate;
  reason: string;
}

export interface ResolveHooks {
  /** Checked between candidates so a shutdown does not sit through a paced page fetch. */
  shouldStop?: () => boolean;
  onEdit?: (edit: PlannedEdit) => Promise<void>;
  onAlbumEdit?: (edit: PlannedAlbumEdit) => Promise<void>;
  /**
   * Takes precedence over onEdit and onAlbumEdit, which apply immediately: registering both would
   * write a candidate's tuples before its proposal existed.
   */
  onGroup?: (group: EditGroup) => Promise<void>;
  onProgress?: (done: number, total: number, edits: number, candidate: Candidate) => void;
}

export interface ResolveResult {
  edits: PlannedEdit[];
  albumEdits: PlannedAlbumEdit[];
  skips: SkipRecord[];
}

export class Resolver {
  constructor(
    private readonly pages: LibraryPages,
    private readonly username: string,
    private readonly enabled: ReadonlySet<GroupName>,
    /** The same lookup the planner uses: consulted here too, or the edit would read as already clean. */
    private readonly overrides?: CustomRuleLookup,
  ) {}

  private override(artist: string): { artist: string; lookup: CustomRuleLookup } | undefined {
    return this.overrides === undefined ? undefined : { artist, lookup: this.overrides };
  }

  /**
   * Merges every candidate into at most one edit per (track, artist, album, album artist) tuple.
   * Two POSTs against one tuple cannot both land — the first rewrites the tuple the second selects
   * on — so track and album cleanups for the same tuple must share a request.
   */
  async resolve(candidates: Candidate[], hooks: ResolveHooks = {}): Promise<ResolveResult> {
    const { onEdit, onAlbumEdit, onGroup, onProgress, shouldStop } = hooks;
    const byTuple = new Map<string, PlannedEdit>();
    const albumEdits: PlannedAlbumEdit[] = [];
    const skips: SkipRecord[] = [];
    const seenPaths = new Set<string>();

    let done = 0;
    for (const candidate of candidates) {
      if (shouldStop?.()) break;
      done++;
      const path =
        candidate.kind === 'track'
          ? trackLibraryPath(this.username, candidate.artist, candidate.title)
          : albumLibraryPath(this.username, candidate.artist, candidate.title);

      if (seenPaths.has(path)) {
        onProgress?.(done, candidates.length, byTuple.size, candidate);
        continue;
      }
      seenPaths.add(path);

      if (candidate.kind === 'album') {
        const resolved = await this.resolveAlbum(candidate, path);
        if (resolved.edit) {
          albumEdits.push(resolved.edit);
          if (onGroup) await onGroup(toAlbumGroup(resolved.edit));
          else if (onAlbumEdit) await onAlbumEdit(resolved.edit);
        } else {
          skips.push({ candidate, reason: resolved.reason });
        }
        onProgress?.(done, candidates.length, byTuple.size + albumEdits.length, candidate);
        continue;
      }

      const rows = await this.collectRows(path, MAX_RECURSION);
      if (rows.length === 0) {
        skips.push({ candidate, reason: 'no scrobble rows found on library page' });
        onProgress?.(done, candidates.length, byTuple.size, candidate);
        continue;
      }

      // Candidate-local, not byTuple: that map is run-wide and would regroup every earlier edit.
      const found: PlannedEdit[] = [];
      for (const { row, action, refererPath } of rows) {
        const added = this.fold(byTuple, row, action, refererPath);
        if (!added) continue;
        found.push(added);
        // fold() produces the complete change for a tuple from one row, so writing here cannot
        // leave a second, partial edit for the same tuple to collide with later.
        if (!onGroup && onEdit) await onEdit(added);
      }
      if (onGroup && found.length > 0) await onGroup(toGroup(candidate.artist, found));
      onProgress?.(done, candidates.length, byTuple.size, candidate);
    }

    return { edits: [...byTuple.values()], albumEdits, skips };
  }

  /**
   * One request renames a whole album, so this never recurses into track pages. Tracks whose own
   * titles carry a marker are found separately by the track sweep.
   */
  private async resolveAlbum(
    candidate: Candidate,
    path: string,
  ): Promise<{ edit?: PlannedAlbumEdit; reason: string }> {
    const html = await this.pages.fetch(path);
    // An empty fetch means the album is gone — usually because a prior run already renamed it.
    if (html === '') return { reason: 'album no longer in library under that title' };

    const form = extractAlbumForm(html);
    if (!form) return { reason: 'album page has no edit form (markup may have changed)' };

    // Re-derive from the page's own value; the API's copy can be stale.
    const cleaned = cleanTitle(
      form.album_name,
      'album',
      this.enabled,
      this.override(form.album_artist_name),
    );
    if (!cleaned) return { reason: 'album title is already clean on the library page' };

    // Free: the same HTML the edit form came from lists the tracks scrobbled under this name.
    const trackNames = extractAlbumTrackNames(html);
    const edit: PlannedAlbumEdit = {
      artist: form.album_artist_name,
      from: form.album_name,
      to: cleaned.clean,
      csrfToken: form.csrfmiddlewaretoken,
      action: form.action,
      refererPath: path,
      groups: cleaned.groups,
      ...(trackNames.length === 0 ? {} : { trackNames }),
    };
    return { edit, reason: '' };
  }

  private fold(
    byTuple: Map<string, PlannedEdit>,
    row: ScrobbleRow,
    action: string,
    refererPath: string,
  ): PlannedEdit | undefined {
    const original = rowTuple(row);
    const key = tupleKey(original);
    if (byTuple.has(key)) return undefined;

    // Always re-derive from the authoritative page value; the API's copy can be stale.
    const track = cleanTitle(row.track_name, 'track', this.enabled, this.override(row.artist_name));
    const album =
      row.album_name === ''
        ? null
        : cleanTitle(
            row.album_name,
            'album',
            this.enabled,
            this.override(row.album_artist_name || row.artist_name),
          );
    if (!track && !album) return undefined;

    const groups = [...new Set([...(track?.groups ?? []), ...(album?.groups ?? [])])].sort();
    const edit: PlannedEdit = {
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
    };
    byTuple.set(key, edit);
    return edit;
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
