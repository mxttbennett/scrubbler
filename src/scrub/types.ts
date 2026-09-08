import type { GroupName } from '../rules/markers.js';

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
  groups: GroupName[];
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
