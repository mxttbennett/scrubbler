import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface LibraryTrack {
  /** Music.app's stable per-track id; the only thing a write is addressed by. */
  persistentId: string;
  artist: string;
  name: string;
  favorited: boolean;
}

/** The seam: everything above this talks to Music.app only through these two calls. */
export interface MusicLibrary {
  tracks(): Promise<LibraryTrack[]>;
  favorite(persistentIds: readonly string[]): Promise<number>;
}

/**
 * Newer Music.app exposes `favorited`; older ones only `loved`. The two are the same flag, so
 * probe once and use whichever exists rather than hard-coding a version.
 *
 * Properties are fetched as whole columns (`tracks.name()`), one Apple Event per property. Asking a
 * track at a time is one event per track per property, which takes minutes on a large library.
 */
const READ_SCRIPT = `
function run() {
  const music = Application('Music');
  const tracks = music.libraryPlaylists[0].tracks;
  const names = tracks.name();
  const artists = tracks.artist();
  const ids = tracks.persistentID();
  let flags;
  try { flags = tracks.favorited(); } catch (e) { flags = tracks.loved(); }
  return JSON.stringify(ids.map((id, i) => [id, artists[i], names[i], flags[i] === true]));
}`;

const WRITE_SCRIPT = `
function run(argv) {
  const music = Application('Music');
  const tracks = music.libraryPlaylists[0].tracks;
  let done = 0;
  for (const id of argv) {
    const matches = tracks.whose({ persistentID: id })();
    if (matches.length === 0) continue;
    const track = matches[0];
    try { track.favorited = true; } catch (e) { track.loved = true; }
    done++;
  }
  return String(done);
}`;

export type Exec = (file: string, args: string[]) => Promise<{ stdout: string }>;

export interface OsascriptOptions {
  exec?: Exec;
  /** JXA over a large library is slow but finite; this only stops a hung Music.app. */
  timeoutMs?: number;
}

export class MusicAppError extends Error {}

export class OsascriptLibrary implements MusicLibrary {
  private readonly exec: Exec;
  private readonly injected: boolean;

  constructor(opts: OsascriptOptions = {}) {
    this.injected = opts.exec !== undefined;
    const timeout = opts.timeoutMs ?? 300_000;
    this.exec =
      opts.exec ??
      (async (file, args) => {
        const { stdout } = await run(file, args, { timeout, maxBuffer: 256 * 1024 * 1024 });
        return { stdout };
      });
  }

  async tracks(): Promise<LibraryTrack[]> {
    const stdout = await this.script(READ_SCRIPT, []);
    let rows: unknown;
    try {
      rows = JSON.parse(stdout);
    } catch {
      throw new MusicAppError(`Music.app returned something other than JSON: ${stdout.slice(0, 120)}`);
    }
    if (!Array.isArray(rows)) throw new MusicAppError('Music.app returned an unexpected shape');
    return rows.map((r: unknown[]) => ({
      persistentId: String(r[0]),
      artist: typeof r[1] === 'string' ? r[1] : '',
      name: typeof r[2] === 'string' ? r[2] : '',
      favorited: r[3] === true,
    }));
  }

  /** Ids go in as argv rather than into the source, so a title can never become script text. */
  async favorite(persistentIds: readonly string[]): Promise<number> {
    if (persistentIds.length === 0) return 0;
    const stdout = await this.script(WRITE_SCRIPT, [...persistentIds]);
    return Number.parseInt(stdout.trim(), 10) || 0;
  }

  private async script(source: string, args: string[]): Promise<string> {
    if (!this.injected && process.platform !== 'darwin') {
      throw new MusicAppError('Apple Music sync needs macOS');
    }
    try {
      const { stdout } = await this.exec('osascript', ['-l', 'JavaScript', '-e', source, ...args]);
      return stdout;
    } catch (cause) {
      throw new MusicAppError(`osascript failed: ${String(cause)}`);
    }
  }
}
