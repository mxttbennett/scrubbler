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

export interface RecentTrack {
  name: string;
  artist: { '#text': string; mbid?: string };
  album: { '#text': string; mbid?: string };
  date?: { uts: string; '#text': string };
}

export interface RecentTracks {
  recenttracks: { track: RecentTrack[]; '@attr': PagedAttr };
}

export interface LastfmImage {
  size: 'small' | 'medium' | 'large' | 'extralarge' | 'mega' | '';
  '#text': string;
}

export interface AlbumInfo {
  album?: {
    name: string;
    artist: string;
    image?: LastfmImage[];
    /** Present only when the request names a username; a string, like every numeric API field. */
    userplaycount?: string | number;
    tracks?: { track?: { name: string }[] | { name: string } };
  };
}

export interface TrackInfo {
  track?: {
    name: string;
    /** Present only when the request names a username; a string, like every numeric API field. */
    userplaycount?: string | number;
  };
}

/** What one album.getinfo call yields: art, the release track list, and the user's play count. */
export interface AlbumDetails {
  imageUrl: string | undefined;
  trackNames: string[];
  scrobbles: number | undefined;
}

const SIZE_PREFERENCE = ['extralarge', 'large', 'medium'] as const;

/** Largest available art, or undefined — obscure releases legitimately have none. */
export function bestImageUrl(images: LastfmImage[] | undefined): string | undefined {
  if (images === undefined) return undefined;
  for (const size of SIZE_PREFERENCE) {
    const hit = images.find((i) => i.size === size && i['#text'] !== '');
    if (hit) return hit['#text'];
  }
  return undefined;
}
