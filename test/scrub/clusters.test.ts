import { describe, expect, it } from 'vitest';
import type { LastfmApi } from '../../src/lastfm/api.js';
import { findClusters } from '../../src/scrub/clusters.js';

interface Row {
  name: string;
  artist: string;
  plays: number;
}

function api(rows: { artists?: Row[]; albums?: Row[]; tracks?: Row[] }): LastfmApi {
  const attr = { '@attr': { totalPages: '1' } };
  return {
    getTopArtists: async () => ({
      topartists: {
        artist: (rows.artists ?? []).map((r) => ({ name: r.name, playcount: String(r.plays) })),
        ...attr,
      },
    }),
    getTopAlbums: async () => ({
      topalbums: {
        album: (rows.albums ?? []).map((r) => ({
          name: r.name,
          playcount: String(r.plays),
          artist: { name: r.artist, url: '' },
        })),
        ...attr,
      },
    }),
    getTopTracks: async () => ({
      toptracks: {
        track: (rows.tracks ?? []).map((r) => ({
          name: r.name,
          playcount: String(r.plays),
          artist: { name: r.artist, url: '' },
        })),
        ...attr,
      },
    }),
  } as unknown as LastfmApi;
}

const CARTI = 'Playboi Carti';

describe('findClusters — only a proven twin is nominated', () => {
  it('nominates the variant that differs from the folded winner, and only that one', async () => {
    const { candidates } = await findClusters(
      api({
        tracks: [
          { name: "Choppa Won't Miss", artist: CARTI, plays: 36 },
          { name: 'Choppa Won’t Miss', artist: CARTI, plays: 2 },
        ],
      }),
      'u',
    );

    expect(candidates).toEqual([{ kind: 'track', artist: CARTI, title: 'Choppa Won’t Miss' }]);
  });

  /** A lone curly title has no twin, so folding it would be an unasked-for rewrite. */
  it('leaves a title with no differently-punctuated twin alone', async () => {
    const { candidates } = await findClusters(
      api({ tracks: [{ name: 'Negative Space (1981–2014)', artist: 'Dolphins', plays: 5 }] }),
      'u',
    );
    expect(candidates).toEqual([]);
  });

  /** The winner itself is rewritten when it is the curly one: the target is the *folded* winner. */
  it('rewrites the most-played variant when it is the one carrying the odd punctuation', async () => {
    const { candidates, lookup } = await findClusters(
      api({
        tracks: [
          { name: 'Because I’m Me', artist: 'The Avalanches', plays: 10 },
          { name: "Because I'm Me", artist: 'The Avalanches', plays: 3 },
        ],
      }),
      'u',
    );

    expect(candidates.map((c) => c.title)).toEqual(['Because I’m Me']);
    expect(lookup('track', 'The Avalanches', 'Because I’m Me')).toBe("Because I'm Me");
  });

  /** 9 of 31 real clusters differ by case too; the target carries the winner's whole string. */
  it('takes casing from the winner, not from the fold', async () => {
    const { lookup } = await findClusters(
      api({
        tracks: [
          { name: "She's Like Heroin to Me", artist: 'The Gun Club', plays: 36 },
          { name: 'She’s Like Heroin To Me', artist: 'The Gun Club', plays: 9 },
        ],
      }),
      'u',
    );
    expect(lookup('track', 'The Gun Club', 'She’s Like Heroin To Me')).toBe(
      "She's Like Heroin to Me",
    );
  });

  it('clusters an invisible whitespace twin', async () => {
    const { candidates } = await findClusters(
      api({
        albums: [
          { name: 'viagr aboys', artist: 'Viagra Boys', plays: 59 },
          { name: 'viagr  aboys', artist: 'Viagra Boys', plays: 7 },
        ],
      }),
      'u',
    );
    expect(candidates.map((c) => c.title)).toEqual(['viagr  aboys']);
  });

  /** Two artists can own the same song name; electing across them rewrites one into the other. */
  it('never clusters the same title across different artists', async () => {
    const { candidates } = await findClusters(
      api({
        tracks: [
          { name: "Don't Stop", artist: 'Fleetwood Mac', plays: 40 },
          { name: 'Don’t Stop', artist: 'The Rolling Stones', plays: 2 },
        ],
      }),
      'u',
    );
    expect(candidates).toEqual([]);
  });

  /**
   * The artist cluster owns an artist rename, and doing it there fixes every track by that artist
   * at once. Nominating the track as well would propose the same correction twice.
   */
  it('leaves a track whose only difference is its artist spelling to the artist cluster', async () => {
    const { candidates } = await findClusters(
      api({
        tracks: [
          { name: '[untitled #1]', artist: "Kassel Jaeger & Jim O'Rourke", plays: 6 },
          { name: '[untitled #1]', artist: 'Kassel Jaeger & Jim O’Rourke', plays: 1 },
        ],
      }),
      'u',
    );
    expect(candidates).toEqual([]);
  });
});

describe('findClusters — artists and ordering', () => {
  it('nominates an artist under its own kind, carrying the name in both fields', async () => {
    const { candidates, lookup } = await findClusters(
      api({
        artists: [
          { name: "Jim O'Rourke", artist: '', plays: 476 },
          { name: 'Jim O’Rourke', artist: '', plays: 1 },
        ],
      }),
      'u',
    );

    expect(candidates).toEqual([{ kind: 'artist', artist: 'Jim O’Rourke', title: 'Jim O’Rourke' }]);
    expect(lookup('artist', 'Jim O’Rourke', 'Jim O’Rourke')).toBe("Jim O'Rourke");
  });

  /**
   * An artist rename changes a field every later tuple carries, and an album rename changes one the
   * track edits carry — so the emission order is load-bearing exactly as it is for the marker sweep.
   */
  it('emits every artist before any album, and every album before any track', async () => {
    const { candidates } = await findClusters(
      api({
        artists: [
          { name: "Jim O'Rourke", artist: '', plays: 476 },
          { name: 'Jim O’Rourke', artist: '', plays: 1 },
        ],
        albums: [
          { name: "Apple O'", artist: 'Deerhoof', plays: 20 },
          { name: 'Apple O’', artist: 'Deerhoof', plays: 2 },
        ],
        tracks: [
          { name: "You Don't Know", artist: 'Drexciya', plays: 4 },
          { name: 'You Don’t Know', artist: 'Drexciya', plays: 2 },
        ],
      }),
      'u',
    );

    expect(candidates.map((c) => c.kind)).toEqual(['artist', 'album', 'track']);
  });

  it('returns no target for an entity outside every cluster', async () => {
    const { lookup } = await findClusters(api({ tracks: [] }), 'u');
    expect(lookup('track', 'Nobody', 'Nothing')).toBeUndefined();
  });
});
