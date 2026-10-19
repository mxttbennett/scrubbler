import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PERSISTENT_ID_PATTERN, type MusicTrack } from './planner.js';

export type ScriptRunner = (script: string, args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

export const runScript: ScriptRunner = async (script, args) => {
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, ...args], {
    timeout: 120_000,
    maxBuffer: 128 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
};

export const READER_SCRIPT = `
(function () {
  var tracks = Application('Music').libraryPlaylists[0].tracks;
  var ids = tracks.persistentID();
  var names = tracks.name();
  var albums = tracks.album();
  var artists = tracks.artist();
  var albumArtists = tracks.albumArtist();
  if ([names, albums, artists, albumArtists].some(function (values) { return values.length !== ids.length; })) {
    throw new Error('Music collection property lengths differ');
  }
  return JSON.stringify(ids.map(function (id, i) {
    return {
      persistentId: id,
      name: names[i] == null ? null : names[i],
      album: albums[i] == null ? null : albums[i],
      artist: artists[i] == null ? null : artists[i],
      albumArtist: albumArtists[i] == null ? null : albumArtists[i]
    };
  }));
}())
`;

export const WRITER_SCRIPT = `
function run(argv) {
  var batch = JSON.parse(argv[0]);
  var tracks = Application('Music').libraryPlaylists[0].tracks;
  var results = [];
  batch.forEach(function (entry) {
    var track;
    var resolutionError = '';
    try {
      var matches = tracks.whose({ persistentID: entry.persistentId })();
      if (matches.length !== 1) {
        resolutionError = matches.length === 0 ? 'Missing persistent ID' : 'Nonunique persistent ID';
      } else track = matches[0];
    } catch (error) {
      resolutionError = String(error);
    }
    entry.changes.forEach(function (change) {
      var result = { persistentId: entry.persistentId, field: change.field, status: 'failed', diagnostic: '' };
      if (resolutionError) result.diagnostic = resolutionError;
      else {
        try {
          var current = track[change.field]();
          if (current === change.new) result.status = 'already-target';
          else if (current !== change.original) {
            result.status = 'conflict';
            result.diagnostic = 'Current value differs from recorded original';
          } else {
            track[change.field] = change.new;
            if (track[change.field]() === change.new) result.status = 'applied';
            else result.diagnostic = 'Read-back mismatch';
          }
        } catch (error) {
          result.diagnostic = String(error);
        }
      }
      results.push(result);
    });
  });
  return JSON.stringify(results);
}
`;

export async function discoverMusic(runner: ScriptRunner = runScript): Promise<MusicTrack[]> {
  const value: unknown = JSON.parse(await runner(READER_SCRIPT, []));
  if (!Array.isArray(value)) throw new Error('Music discovery must return an array');
  const ids = new Set<string>();
  return value.map((record: unknown) => {
    if (record === null || typeof record !== 'object') throw new Error('Invalid Music track');
    const row = record as Record<string, unknown>;
    if (typeof row.persistentId !== 'string' || !PERSISTENT_ID_PATTERN.test(row.persistentId)) {
      throw new Error('Invalid Music persistent ID');
    }
    const identity = row.persistentId.toUpperCase();
    if (ids.has(identity)) throw new Error(`Duplicate Music persistent ID: ${row.persistentId}`);
    ids.add(identity);
    for (const field of ['name', 'album', 'artist', 'albumArtist']) {
      if (row[field] !== null && typeof row[field] !== 'string') throw new Error(`Invalid Music ${field}`);
    }
    return row as unknown as MusicTrack;
  });
}
