import { cleanTitle } from '../rules/engine.js';
import { DEFAULT_ENABLED, type GroupName } from '../rules/markers.js';

export interface MusicTrack {
  persistentId: string;
  name: string | null;
  album: string | null;
  artist: string | null;
  albumArtist: string | null;
}

export const PERSISTENT_ID_PATTERN = /^[0-9a-f]+$/iu;

export interface MusicChange {
  persistentId: string;
  field: 'name' | 'album';
  original: string;
  new: string;
}

export interface MusicPlan {
  changes: MusicChange[];
  albums: { artist: string; original: string; new: string; persistentIds: string[] }[];
  names: { artist: string; change: MusicChange }[];
  skips: { persistentId: string; field: MusicChange['field'] }[];
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export function planMusic(tracks: MusicTrack[]): MusicPlan {
  const enabled = new Set<GroupName>(DEFAULT_ENABLED);
  const plan: MusicPlan = { changes: [], albums: [], names: [], skips: [] };
  const albums = new Map<string, MusicPlan['albums'][number]>();
  for (const track of [...tracks].sort((a, b) => compare(a.persistentId, b.persistentId))) {
    const artist = track.artist?.trim() ? track.artist : '(unknown artist)';
    const effectiveArtist = track.albumArtist?.trim() ? track.albumArtist : track.artist?.trim() ? track.artist : null;
    for (const field of ['name', 'album'] as const) {
      const original = track[field];
      if (original === null || original === '') {
        plan.skips.push({ persistentId: track.persistentId, field });
        continue;
      }
      const result = cleanTitle(original, field === 'name' ? 'track' : 'album', enabled);
      if (result === null) continue;
      const change: MusicChange = { persistentId: track.persistentId, field, original, new: result.clean };
      plan.changes.push(change);
      if (field === 'name') plan.names.push({ artist, change });
      else {
        const key = JSON.stringify([effectiveArtist ?? '', original]);
        let group = albums.get(key);
        if (!group) {
          group = { artist: effectiveArtist ?? '(unknown artist)', original, new: result.clean, persistentIds: [] };
          albums.set(key, group);
        }
        group.persistentIds.push(track.persistentId);
      }
    }
  }
  plan.changes.sort((a, b) => compare(a.persistentId, b.persistentId) || compare(a.field, b.field));
  plan.albums = [...albums.entries()].sort(([a], [b]) => compare(a, b)).map(([, group]) => group);
  plan.names.sort((a, b) => compare(a.artist, b.artist) || compare(a.change.persistentId, b.change.persistentId));
  return plan;
}

export function displayValue(value: string): string {
  return JSON.stringify(value).slice(1, -1).replace(/[\u007f-\u009f\u2028\u2029]/gu, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function formatPreview(plan: MusicPlan): string {
  const lines = plan.albums.map((group) => `album ${displayValue(group.artist)}: ${displayValue(group.original)} -> ${displayValue(group.new)} (${new Set(group.persistentIds).size} tracks)`);
  for (const { artist, change } of plan.names) {
    lines.push(`name ${displayValue(artist)} [${change.persistentId}]: ${displayValue(change.original)} -> ${displayValue(change.new)}`);
  }
  for (const skip of plan.skips) lines.push(`skip [${skip.persistentId}] ${skip.field}: missing metadata`);
  lines.push(`${new Set(plan.changes.map((change) => change.persistentId)).size} tracks; ${plan.changes.length} field changes; ${plan.skips.length} missing fields`);
  return lines.join('\n');
}
