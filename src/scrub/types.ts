import type { PlannedAlbumEdit } from '../lastfm/albumEditor.js';
import type { RuleTag } from '../rules/markers.js';

export interface Candidate {
  kind: 'track' | 'album';
  artist: string;
  title: string;
}

/** The six fields a library row's form[data-edit-scrobble] carries. */
export interface ScrobbleRow {
  csrfmiddlewaretoken: string;
  artist_name: string;
  track_name: string;
  album_name: string;
  album_artist_name: string;
  timestamp: string;
}

export interface Tuple {
  track_name: string;
  artist_name: string;
  album_name: string;
  album_artist_name: string;
}

export interface PlannedEdit {
  original: Tuple;
  next: Tuple;
  timestamp: string;
  csrfToken: string;
  action: string;
  refererPath: string;
  groups: RuleTag[];
}

export function tupleKey(t: Tuple): string {
  return JSON.stringify([t.track_name, t.artist_name, t.album_name, t.album_artist_name]);
}

export function rowTuple(row: ScrobbleRow): Tuple {
  return {
    track_name: row.track_name,
    artist_name: row.artist_name,
    album_name: row.album_name,
    album_artist_name: row.album_artist_name,
  };
}

export function changedFields(edit: PlannedEdit): (keyof Tuple)[] {
  return (Object.keys(edit.original) as (keyof Tuple)[]).filter(
    (k) => edit.original[k] !== edit.next[k],
  );
}

export interface SharedChange {
  field: keyof Tuple;
  from: string;
  to: string;
}

/**
 * One candidate's worth of change, so an approval decides a whole album at once rather than per
 * track. An album rename is a one-member group, which keeps a proposal the same shape either way.
 */
export type EditGroup =
  | {
      kind: 'track';
      artist: string;
      edits: PlannedEdit[];
      /** Set only when every edit changes exactly one field, identically. */
      shared: SharedChange | undefined;
    }
  | { kind: 'album'; artist: string; album: PlannedAlbumEdit; shared: SharedChange };

/**
 * Requires exactly one changed field per edit: fold() can clean track and album together, so a group
 * sharing an album change while some rows also rename a track must not be presented as one clean
 * suffix removal.
 */
export function detectShared(edits: PlannedEdit[]): SharedChange | undefined {
  if (edits.length === 0) return undefined;
  let candidate: SharedChange | undefined;
  for (const edit of edits) {
    const fields = changedFields(edit);
    if (fields.length !== 1) return undefined;
    const field = fields[0]!;
    const change = { field, from: edit.original[field], to: edit.next[field] };
    if (candidate === undefined) {
      candidate = change;
      continue;
    }
    if (
      candidate.field !== change.field ||
      candidate.from !== change.from ||
      candidate.to !== change.to
    ) {
      return undefined;
    }
  }
  return candidate;
}

export function toGroup(artist: string, edits: PlannedEdit[]): EditGroup {
  return { kind: 'track', artist, edits, shared: detectShared(edits) };
}

export function toAlbumGroup(album: PlannedAlbumEdit): EditGroup {
  return {
    kind: 'album',
    artist: album.artist,
    album,
    shared: { field: 'album_name', from: album.from, to: album.to },
  };
}
