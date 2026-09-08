// Raw Last.fm JSON shapes, limited to the fields this service consumes. Numeric values arrive as
// strings. `albumartist` is absent from every user.* response, which is why edits are resolved by
// scraping the library page rather than from the API.

export interface PagedAttr {
  user: string;
  page: string;
  perPage: string;
  totalPages: string;
  total: string;
}

export interface TopAlbum {
  name: string;
  playcount: string;
  artist: { name: string; url: string; mbid?: string };
}

export interface TopAlbums {
  topalbums: { album: TopAlbum[]; '@attr': PagedAttr };
}

export interface TopTrack {
  name: string;
  playcount: string;
  artist: { name: string; url: string; mbid?: string };
}

export interface TopTracks {
  toptracks: { track: TopTrack[]; '@attr': PagedAttr };
}

export function toInt(value: string | number | undefined): number {
  if (value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}
