import { describe, expect, it } from 'vitest';
import { formatPreview, planMusic, type MusicTrack } from '../../src/music/planner.js';

const track = (overrides: Partial<MusicTrack> = {}): MusicTrack => ({
  persistentId: '01', name: 'Song (Remastered)', album: 'Record (Deluxe Edition)',
  artist: 'Artist', albumArtist: null, ...overrides,
});

describe('Music planning', () => {
  it('plans both fields and every album member while counting unique tracks', () => {
    // Arrange
    const tracks = [track(), track({ persistentId: '02', name: 'Clean' })];
    // Act
    const plan = planMusic(tracks);
    // Assert
    expect(plan.changes).toEqual([
      { persistentId: '01', field: 'album', original: 'Record (Deluxe Edition)', new: 'Record' },
      { persistentId: '01', field: 'name', original: 'Song (Remastered)', new: 'Song' },
      { persistentId: '02', field: 'album', original: 'Record (Deluxe Edition)', new: 'Record' },
    ]);
    expect(plan.albums).toEqual([{ artist: 'Artist', original: 'Record (Deluxe Edition)', new: 'Record', persistentIds: ['01', '02'] }]);
    expect(formatPreview(plan)).toContain('album Artist: Record (Deluxe Edition) -> Record (2 tracks)');
    expect(formatPreview(plan)).toContain('name Artist [01]: Song (Remastered) -> Song');
    expect(formatPreview(plan)).toContain('2 tracks; 3 field changes');
  });

  it.each([
    { artist: 'Singer', albumArtist: 'Compilation', want: 'Compilation' },
    { artist: 'Singer', albumArtist: '  ', want: 'Singer' },
    { artist: null, albumArtist: null, want: '(unknown artist)' },
    { artist: ' ', albumArtist: '', want: '(unknown artist)' },
  ])('groups albums using artist fallback $want', ({ artist, albumArtist, want }) => {
    // Arrange
    const tracks = [track({ artist, albumArtist })];
    // Act
    const plan = planMusic(tracks);
    // Assert
    expect(plan.albums[0]?.artist).toBe(want);
    expect(plan.changes).toHaveLength(2);
  });

  it('keeps artists, exact casing, delimiter characters, and converging source albums separate', () => {
    // Arrange
    const tracks = [
      track({ persistentId: '01', artist: 'A|B', album: 'CD (Remastered)' }),
      track({ persistentId: '02', artist: 'A', album: 'B|C (Remastered)' }),
      track({ persistentId: '03', artist: 'a', album: 'B|C (Remastered)' }),
      track({ persistentId: '04', artist: 'A', album: 'B|C (Deluxe Edition)' }),
      track({ persistentId: '05', artist: 'A', album: 'b|C (Remastered)' }),
    ];
    // Act
    const plan = planMusic(tracks);
    // Assert
    expect(plan.albums).toHaveLength(5);
    expect(plan.albums.filter((a) => a.new === 'B|C')).toHaveLength(3);
    expect(formatPreview(planMusic([...tracks].reverse()))).toBe(formatPreview(plan));
  });

  it('cleans compilation album members under one album artist', () => {
    // Arrange
    const tracks = [track({ artist: 'One', albumArtist: 'Various' }), track({ persistentId: '02', artist: 'Two', albumArtist: 'Various' })];
    // Act
    const plan = planMusic(tracks);
    // Assert
    expect(plan.albums).toHaveLength(1);
    expect(plan.albums[0]?.persistentIds).toEqual(['01', '02']);
  });

  it.each([null, ''])('skips absent fields %j while cleaning the other field', (missing) => {
    // Arrange
    const tracks = [track({ name: missing }), track({ persistentId: '02', album: missing })];
    // Act
    const plan = planMusic(tracks);
    // Assert
    expect(plan.changes).toHaveLength(2);
    expect(plan.skips).toEqual([{ persistentId: '01', field: 'name' }, { persistentId: '02', field: 'album' }]);
    expect(formatPreview(plan)).toContain('skip [01] name: missing metadata');
  });

  it('keeps nonempty whitespace-only titles intact without treating them as missing', () => {
    // Arrange
    const tracks = [track({ name: ' ', album: '\t' })];
    // Act
    const plan = planMusic(tracks);
    // Assert
    expect(plan.changes).toEqual([]);
    expect(plan.skips).toEqual([]);
  });

  it.each([
    ['Song (Live)', 'Song (Live)'], ['Song (Live in Rotterdam 1984)', 'Song (Live in Rotterdam 1984)'],
    ["Song (Taylor's Version)", "Song (Taylor's Version)"], ['Song (feat. Guest)', 'Song (feat. Guest)'],
    ['Song - Radio Edit', 'Song - Radio Edit'], ['Song (Mono Remastered)', 'Song - Mono'],
    ['Song (Stereo Remastered)', 'Song - Stereo'],
  ])('preserves default-off markers and qualifiers in %s', (name, want) => {
    // Arrange
    const tracks = [track({ name, album: null })];
    // Act
    const plan = planMusic(tracks);
    // Assert
    expect(plan.changes.find((c) => c.field === 'name')?.new ?? name).toBe(want);
  });

  it('preserves exact originals and escapes controls only in display', () => {
    // Arrange
    const name = '  Song\n"quoted"\t\u0000 (Remastered)';
    // Act
    const plan = planMusic([track({ name, artist: 'A\rB' })]);
    // Assert
    expect(plan.changes.find((c) => c.field === 'name')?.original).toBe(name);
    expect(formatPreview(plan)).toContain('A\\rB');
    expect(formatPreview(plan)).toContain('Song\\n');
    expect(formatPreview(plan)).toContain('\\u0000');
  });

  it.each([
    ['Song (Remastered)', 0],
    ['Song - Remaster - Remaster - Remaster - Remaster', 1],
  ])('retains the deliberate three-pass cap on rerun of %s', (name, remaining) => {
    // Arrange
    const source = track({ name, album: 'Clean' });
    // Act
    const first = planMusic([source]);
    const second = planMusic([track({ name: first.changes[0]!.new, album: 'Clean' })]);
    // Assert
    expect(first.changes).toHaveLength(1);
    expect(second.changes).toHaveLength(remaining);
    if (remaining) expect(first.changes[0]?.new).toBe('Song - Remaster');
  });

  it.each([{ tracks: [] }, { tracks: [track({ name: 'Clean', album: 'Clean' })] }])('returns zero changes for clean or empty input', ({ tracks }) => {
    // Arrange
    const source = tracks;
    // Act
    const plan = planMusic(source);
    // Assert
    expect(plan.changes).toEqual([]);
    expect(formatPreview(plan)).toContain('0 tracks; 0 field changes');
  });
});
