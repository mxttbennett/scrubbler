import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, runMigrations, schema } from '../../src/db/index.js';
import { LibraryMirror } from '../../src/library/mirror.js';

function db() {
  const d = createDb(':memory:');
  runMigrations(d);
  return d;
}

interface Entry {
  name: string;
  artist: string;
  playcount?: string;
}

/** Pages a flat list the way Last.fm does, so pagination is exercised rather than assumed. */
function fakeApi(opts: {
  albums?: Entry[];
  tracks?: Entry[];
  perPage?: number;
  trackNames?: Record<string, string[] | Error>;
}) {
  const perPage = opts.perPage ?? 1000;
  const calls: string[] = [];

  const page = <T>(all: T[], p: number) => {
    const totalPages = Math.max(1, Math.ceil(all.length / perPage));
    return {
      items: all.slice((p - 1) * perPage, p * perPage),
      attr: { user: 'u', page: String(p), perPage: String(perPage), totalPages: String(totalPages), total: String(all.length) },
    };
  };

  return {
    calls,
    api: {
      getTopAlbums: (_u: string, p = 1) => {
        calls.push(`albums:${p}`);
        const { items, attr } = page(opts.albums ?? [], p);
        return Promise.resolve({
          topalbums: {
            album: items.map((a) => ({ name: a.name, playcount: a.playcount ?? '0', artist: { name: a.artist, url: '' } })),
            '@attr': attr,
          },
        });
      },
      getTopTracks: (_u: string, p = 1) => {
        calls.push(`tracks:${p}`);
        const { items, attr } = page(opts.tracks ?? [], p);
        return Promise.resolve({
          toptracks: {
            track: items.map((t) => ({ name: t.name, playcount: t.playcount ?? '0', artist: { name: t.artist, url: '' } })),
            '@attr': attr,
          },
        });
      },
      albumTrackNames: (artist: string, album: string) => {
        calls.push(`getinfo:${artist}/${album}`);
        const found = opts.trackNames?.[`${artist}/${album}`];
        if (found instanceof Error) return Promise.reject(found);
        return Promise.resolve(found ?? []);
      },
    } as never,
  };
}

const USER = 'dankjankem';

describe('LibraryMirror.enumerate', () => {
  it('records every album and track with its playcount', async () => {
    const d = db();
    const { api } = fakeApi({
      albums: [{ name: 'Spiderland', artist: 'Slint', playcount: '42' }],
      tracks: [{ name: 'Breadcrumb Trail', artist: 'Slint', playcount: '7' }],
    });

    const stats = await new LibraryMirror({ db: d, api, username: USER }).enumerate();

    expect(stats).toMatchObject({ albums: 1, tracks: 1, unmapped: 1 });
    const rows = d.select().from(schema.library).all();
    expect(rows.find((r) => r.kind === 'album')!.playcount).toBe(42);
    expect(rows.find((r) => r.kind === 'track')!.playcount).toBe(7);
  });

  it('pages until totalPages rather than stopping at the first page', async () => {
    const d = db();
    const tracks = Array.from({ length: 5 }, (_, i) => ({ name: `t${i}`, artist: 'A' }));
    const { api, calls } = fakeApi({ tracks, perPage: 2 });

    await new LibraryMirror({ db: d, api, username: USER }).enumerate();

    expect(calls.filter((c) => c.startsWith('tracks:'))).toEqual(['tracks:1', 'tracks:2', 'tracks:3']);
    expect(d.select().from(schema.library).all()).toHaveLength(5);
  });

  it('is idempotent — a second pass updates in place instead of duplicating', async () => {
    const d = db();
    const { api } = fakeApi({ tracks: [{ name: 'Nosferatu Man', artist: 'Slint', playcount: '3' }] });
    const mirror = new LibraryMirror({ db: d, api, username: USER });

    await mirror.enumerate();
    await mirror.enumerate();

    expect(d.select().from(schema.library).all()).toHaveLength(1);
  });

  it('does not clear an album mapping a later enumeration pass re-sees', async () => {
    const d = db();
    const { api } = fakeApi({
      albums: [{ name: 'Spiderland', artist: 'Slint' }],
      tracks: [{ name: 'Good Morning, Captain', artist: 'Slint' }],
      trackNames: { 'Slint/Spiderland': ['Good Morning, Captain'] },
    });
    const mirror = new LibraryMirror({ db: d, api, username: USER });

    await mirror.enumerate();
    await mirror.crawlAlbums();
    await mirror.enumerate();

    const track = d.select().from(schema.library).all().find((r) => r.kind === 'track')!;
    expect(track.albumTitle).toBe('Spiderland');
    expect(track.albumSource).toBe('api');
  });
});

describe('LibraryMirror.crawlAlbums', () => {
  it('maps tracks onto their album and stamps the source', async () => {
    const d = db();
    const { api } = fakeApi({
      albums: [{ name: 'Spiderland', artist: 'Slint' }],
      tracks: [
        { name: 'Breadcrumb Trail', artist: 'Slint' },
        { name: 'Washer', artist: 'Slint' },
      ],
      trackNames: { 'Slint/Spiderland': ['Breadcrumb Trail', 'Washer'] },
    });
    const mirror = new LibraryMirror({ db: d, api, username: USER });
    await mirror.enumerate();

    const result = await mirror.crawlAlbums();

    expect(result).toEqual({ mapped: 1, failed: 0 });
    const tracks = d.select().from(schema.library).all().filter((r) => r.kind === 'track');
    expect(tracks.every((t) => t.albumTitle === 'Spiderland' && t.albumArtist === 'Slint')).toBe(true);
    expect(mirror.stats()).toMatchObject({ mapped: 2, unmapped: 0 });
  });

  it('matches case-insensitively, because the two endpoints disagree on casing', async () => {
    const d = db();
    const { api } = fakeApi({
      albums: [{ name: 'Spiderland', artist: 'Slint' }],
      tracks: [{ name: 'breadcrumb trail', artist: 'Slint' }],
      trackNames: { 'Slint/Spiderland': ['Breadcrumb Trail'] },
    });
    const mirror = new LibraryMirror({ db: d, api, username: USER });
    await mirror.enumerate();

    await mirror.crawlAlbums();

    expect(d.select().from(schema.library).all().find((r) => r.kind === 'track')!.albumTitle).toBe(
      'Spiderland',
    );
  });

  it('leaves a failed album retriable rather than marking it mapped', async () => {
    const d = db();
    const { api } = fakeApi({
      albums: [{ name: 'Spiderland', artist: 'Slint' }],
      trackNames: { 'Slint/Spiderland': new Error('HTTP 500 from Last.fm') },
    });
    const mirror = new LibraryMirror({ db: d, api, username: USER });
    await mirror.enumerate();

    expect(await mirror.crawlAlbums()).toEqual({ mapped: 0, failed: 1 });

    const album = d.select().from(schema.library).all()[0]!;
    expect(album.mappedAt).toBeNull();
    expect(album.mapAttempts).toBe(1);
    expect(album.mapError).toMatch(/HTTP 500/);
  });

  it('gives up on an album after three failures', async () => {
    const d = db();
    const { api, calls } = fakeApi({
      albums: [{ name: 'Spiderland', artist: 'Slint' }],
      trackNames: { 'Slint/Spiderland': new Error('nope') },
    });
    const mirror = new LibraryMirror({ db: d, api, username: USER });
    await mirror.enumerate();

    for (let i = 0; i < 5; i++) await mirror.crawlAlbums();

    expect(calls.filter((c) => c.startsWith('getinfo:'))).toHaveLength(3);
    expect(mirror.stats().failed).toBe(1);
  });

  it('treats an album with no tracks as mapped, not failed', async () => {
    const d = db();
    const { api } = fakeApi({ albums: [{ name: 'Untitled', artist: 'Nobody' }] });
    const mirror = new LibraryMirror({ db: d, api, username: USER });
    await mirror.enumerate();

    expect(await mirror.crawlAlbums()).toEqual({ mapped: 1, failed: 0 });
    expect(d.select().from(schema.library).all()[0]!.mappedAt).not.toBeNull();
  });

  it('resumes where it stopped instead of re-fetching mapped albums', async () => {
    const d = db();
    const { api, calls } = fakeApi({
      albums: [
        { name: 'A', artist: 'X' },
        { name: 'B', artist: 'X' },
      ],
      trackNames: { 'X/A': [], 'X/B': [] },
    });
    const mirror = new LibraryMirror({ db: d, api, username: USER });
    await mirror.enumerate();

    await mirror.crawlAlbums({ limit: 1 });
    await mirror.crawlAlbums({ limit: 1 });
    await mirror.crawlAlbums({ limit: 1 });

    expect(calls.filter((c) => c.startsWith('getinfo:'))).toEqual(['getinfo:X/A', 'getinfo:X/B']);
  });

  it('yields to the signal between albums', async () => {
    const d = db();
    const { api, calls } = fakeApi({
      albums: [
        { name: 'A', artist: 'X' },
        { name: 'B', artist: 'X' },
      ],
      trackNames: { 'X/A': [], 'X/B': [] },
    });
    const mirror = new LibraryMirror({ db: d, api, username: USER });
    await mirror.enumerate();

    await mirror.crawlAlbums({ signal: () => true });

    expect(calls.filter((c) => c.startsWith('getinfo:'))).toEqual([]);
  });

  it('round-trips unicode and titles carrying a plus sign', async () => {
    const d = db();
    const { api } = fakeApi({
      albums: [{ name: 'Café + Bar', artist: 'Sigur Rós' }],
      tracks: [{ name: 'Hoppípolla', artist: 'Sigur Rós' }],
      trackNames: { 'Sigur Rós/Café + Bar': ['Hoppípolla'] },
    });
    const mirror = new LibraryMirror({ db: d, api, username: USER });
    await mirror.enumerate();

    await mirror.crawlAlbums();

    const track = d
      .select()
      .from(schema.library)
      .where(eq(schema.library.kind, 'track'))
      .all()[0]!;
    expect(track.title).toBe('Hoppípolla');
    expect(track.albumTitle).toBe('Café + Bar');
  });
});
