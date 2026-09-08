import type { LastfmApi } from '../lastfm/api.js';
import { cleanTitle } from '../rules/engine.js';
import type { GroupName } from '../rules/markers.js';
import type { Candidate } from './types.js';

export class Planner {
  constructor(
    private readonly api: LastfmApi,
    private readonly username: string,
    private readonly enabled: ReadonlySet<GroupName>,
  ) {}

  async sweep(onProgress?: (seen: number, hits: number) => void): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    let seen = 0;

    for await (const album of this.api.iterateTopAlbums(this.username)) {
      seen++;
      if (cleanTitle(album.name, 'album', this.enabled)) {
        candidates.push({ kind: 'album', artist: album.artist, title: album.name });
      }
      if (seen % 1000 === 0) onProgress?.(seen, candidates.length);
    }

    for await (const track of this.api.iterateTopTracks(this.username)) {
      seen++;
      if (cleanTitle(track.name, 'track', this.enabled)) {
        candidates.push({ kind: 'track', artist: track.artist, title: track.name });
      }
      if (seen % 1000 === 0) onProgress?.(seen, candidates.length);
    }

    onProgress?.(seen, candidates.length);
    return candidates;
  }
}
