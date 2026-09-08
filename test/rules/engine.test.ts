import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_GROUPS, type GroupName } from '../../src/rules/markers.js';
import { cleanTitle } from '../../src/rules/engine.js';

const DEFAULT_ON = new Set<GroupName>(['remaster', 'edition', 'bonus']);
const EVERYTHING = new Set<GroupName>(ALL_GROUPS);

interface Corpus {
  albums: { name: string; artist: string; playcount: number }[];
  tracks: { name: string; artist: string; playcount: number }[];
}

function corpus(): Corpus {
  const path = join(import.meta.dirname, '..', 'fixtures', 'lfm-title-corpus.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Corpus;
}

describe('cleanTitle — precision (must never touch)', () => {
  const mustSurviveAlbums = [
    "1989 (Taylor's Version)",
    'Purple Rain (Original Motion Picture Soundtrack)',
    'The Harder They Come (Original Soundtrack)',
    'Chrono Trigger (Original Game Soundtrack)',
    'Fabric 01 (DJ Mix)',
    'Trainspotting (Music from the Motion Picture)',
    'Twin Peaks (Music from the Original TV Series)',
  ];

  it.each(mustSurviveAlbums)('leaves album %s alone', (title) => {
    expect(cleanTitle(title, 'album', EVERYTHING)).toBeNull();
  });

  const mustSurviveTracks = [
    'Sister Ray - Live in Rotterdam 1984',
    'Debaser - BBC Mark Goodier Session',
    'Head On - BBC John Peel Session 1990',
    'Autobahn - Lowtec Extendend Mix',
    'Cripple Creek - Unfinished Outtake',
    'Windowlicker - Original Mix',
    'Shine On You Crazy Diamond - Pt. II',
    'Karn Evil 9 (Reprise)',
    'Sunset (Interlude)',
    'Space Oddity (Intro)',
    'Voodoo Ray (Ambient Dub)',
    'Cowgirl (75 MPH Mix)',
    'So What (January 1963)',
    'She Said She Said - 2022 Mix',
    'Yellow Submarine - 2022 Mix',
    'Tomorrow Never Knows - Mono Mix Remaster',
    'Tomorrow Never Knows - take 1',
    'Big Day Coming - Second Version',
    'Song - Alternate Version',
    'Song - Acoustic Version',
    'Song - Instrumental',
  ];

  it.each(mustSurviveTracks)('leaves track %s alone', (title) => {
    expect(cleanTitle(title, 'track', EVERYTHING)).toBeNull();
  });

  it('never strips a marker that is not the whole trailing segment', () => {
    expect(cleanTitle('Song (Live in Tokyo)', 'track', EVERYTHING)).toBeNull();
    expect(cleanTitle('Song (Remastered at Abbey Road)', 'track', EVERYTHING)).toBeNull();
    expect(cleanTitle('Album (Deluxe Edition Sampler)', 'album', EVERYTHING)).toBeNull();
  });
});

describe('cleanTitle — recall (must strip)', () => {
  const albums: [string, string][] = [
    ["Unknown Pleasures (Collector's Edition)", 'Unknown Pleasures'],
    ['Beat Down Babylon (Expanded Version)', 'Beat Down Babylon'],
    ['Whistle Stop (Remastered 2014)', 'Whistle Stop'],
    ['Houses Of The Holy (Remaster)', 'Houses Of The Holy'],
    ['Damned Damned Damned (Bonus Tracks Version)', 'Damned Damned Damned'],
    ['Nevermind (Deluxe Edition)', 'Nevermind'],
    ['Rumours (Super Deluxe)', 'Rumours'],
    ['Blue Lines (2012 Remaster)', 'Blue Lines'],
    ['Loveless (Special Edition)', 'Loveless'],
    ['Innervisions (40th Anniversary Deluxe Edition)', 'Innervisions'],
    ['Marquee Moon (Expanded & Remastered)', 'Marquee Moon'],
    ['Kid A (Japanese Edition)', 'Kid A'],
    ['Pet Sounds (Reissue)', 'Pet Sounds'],
  ];

  it.each(albums)('strips album %s -> %s', (input, expected) => {
    expect(cleanTitle(input, 'album', DEFAULT_ON)?.clean).toBe(expected);
  });

  const tracks: [string, string][] = [
    ['Silver Springs - 2004 Remaster', 'Silver Springs'],
    ['Isolation - 2020 Digital Master', 'Isolation'],
    ['Poor Moon - Bonus Track', 'Poor Moon'],
    ['Street Fighting Man - 50th Anniversary Edition', 'Street Fighting Man'],
    ['Paranoid Android (Remastered)', 'Paranoid Android'],
    ['Tomorrow Never Knows - 2009 Digital Remaster', 'Tomorrow Never Knows'],
    ['WAP (Explicit)', 'WAP'],
  ];

  it.each(tracks)('strips track %s -> %s', (input, expected) => {
    expect(cleanTitle(input, 'track', DEFAULT_ON)?.clean).toBe(expected);
  });

  it('reports which groups fired', () => {
    expect(cleanTitle('Nevermind (Deluxe Edition)', 'album', DEFAULT_ON)?.groups).toEqual([
      'edition',
    ]);
  });
});

describe('cleanTitle — field scoping', () => {
  it('applies edition markers to both fields, since releases label tracks that way too', () => {
    expect(cleanTitle('Some Song (Deluxe Edition)', 'track', EVERYTHING)?.clean).toBe('Some Song');
    expect(cleanTitle('Some Album (Deluxe Edition)', 'album', EVERYTHING)?.clean).toBe(
      'Some Album',
    );
  });

  it('does not apply ep-single to track titles', () => {
    expect(cleanTitle('Old Town Road - Single', 'track', EVERYTHING)).toBeNull();
    expect(cleanTitle('Old Town Road - Single', 'album', EVERYTHING)?.clean).toBe('Old Town Road');
  });
});

describe('cleanTitle — group toggles', () => {
  it('leaves "album version" alone by default, since it names which recording it is', () => {
    expect(cleanTitle('Teen Age Riot (album version)', 'track', DEFAULT_ON)).toBeNull();
    expect(cleanTitle('Teen Age Riot (album version)', 'track', new Set(['version']))?.clean).toBe(
      'Teen Age Riot',
    );
  });

  it('strips an anniversary edition from a track title via the edition group, not bonus', () => {
    const noBonus = new Set<GroupName>(['remaster', 'edition']);
    expect(
      cleanTitle('Street Fighting Man - 50th Anniversary Edition', 'track', noBonus)?.clean,
    ).toBe('Street Fighting Man');
  });

  it('leaves experimental markers alone by default', () => {
    expect(cleanTitle('all apologies - live', 'track', DEFAULT_ON)).toBeNull();
    expect(cleanTitle('Midnight City - EP', 'album', DEFAULT_ON)).toBeNull();
    expect(cleanTitle('Mamushi (feat. Yuki Chiba)', 'track', DEFAULT_ON)).toBeNull();
    expect(cleanTitle('Gemini IIV (Radio Edit)', 'track', DEFAULT_ON)).toBeNull();
    expect(cleanTitle('The Dock Of The Bay (Mono)', 'album', DEFAULT_ON)).toBeNull();
  });

  it('strips them when their group is enabled', () => {
    expect(cleanTitle('all apologies - live', 'track', new Set(['live-track']))?.clean).toBe(
      'all apologies',
    );
    expect(cleanTitle('Midnight City - EP', 'album', new Set(['ep-single']))?.clean).toBe(
      'Midnight City',
    );
    expect(cleanTitle('Gemini IIV (Radio Edit)', 'track', new Set(['version']))?.clean).toBe(
      'Gemini IIV',
    );
  });

  it('separates feat-album from feat-track so the safe half can be enabled alone', () => {
    const albumOnly = new Set<GroupName>(['feat-album']);
    expect(cleanTitle('iSpy (Feat. Lil Yachty)', 'album', albumOnly)?.clean).toBe('iSpy');
    expect(cleanTitle('NO HANDS (feat. Z-Trip)', 'track', albumOnly)).toBeNull();
    expect(cleanTitle('NO HANDS (feat. Z-Trip)', 'track', new Set(['feat-track']))?.clean).toBe(
      'NO HANDS',
    );
  });
});

describe('cleanTitle — guards', () => {
  it('returns null for a casing-only result', () => {
    expect(cleanTitle('Remastered', 'track', DEFAULT_ON)).toBeNull();
  });

  it('returns null when the remainder would be empty', () => {
    expect(cleanTitle(' - Remastered', 'track', DEFAULT_ON)).toBeNull();
    expect(cleanTitle('X (Remastered)', 'track', DEFAULT_ON)).toBeNull();
  });

  it('requires an alphanumeric in the remainder', () => {
    expect(cleanTitle('!!! (Remastered)', 'track', DEFAULT_ON)).toBeNull();
  });

  it('requires the closing bracket to be the final character', () => {
    expect(cleanTitle('Song (Remastered) bonus', 'track', DEFAULT_ON)).toBeNull();
    expect(cleanTitle('Song [Remastered', 'track', DEFAULT_ON)).toBeNull();
  });

  it('collapses compound tails in multiple passes', () => {
    const r = cleanTitle('Song - Remastered 2011 (Bonus Track)', 'track', DEFAULT_ON);
    expect(r?.clean).toBe('Song');
    expect(r?.passes).toBe(2);
    expect(r?.groups).toEqual(['bonus', 'remaster']);
  });

  it('caps at 3 passes', () => {
    const r = cleanTitle(
      'Song (Remastered) (Remastered) (Remastered) (Remastered)',
      'track',
      DEFAULT_ON,
    );
    expect(r?.passes).toBe(3);
    expect(r?.clean).toBe('Song (Remastered)');
  });

  it('strips a dangling year left behind by a marker, but never a bare year alone', () => {
    expect(cleanTitle('Hand of Doom - 2012 - Remaster', 'track', DEFAULT_ON)?.clean).toBe(
      'Hand of Doom',
    );
    expect(cleanTitle('Song - 1975 - Remastered', 'track', DEFAULT_ON)?.clean).toBe('Song');
    expect(cleanTitle('Song - 2012', 'track', DEFAULT_ON)).toBeNull();
    expect(cleanTitle('Live at Leeds - 1970', 'album', DEFAULT_ON)).toBeNull();
  });

  it('never breaks a year range, which is real title content', () => {
    expect(cleanTitle('The Beatles 1967 - 1970 (Remastered)', 'album', DEFAULT_ON)?.clean).toBe(
      'The Beatles 1967 - 1970',
    );
    expect(
      cleanTitle('Please: Further Listening 1984 - 1986 (2018 Remaster)', 'album', DEFAULT_ON)
        ?.clean,
    ).toBe('Please: Further Listening 1984 - 1986');
  });

  it('does not split surrogate pairs', () => {
    expect(cleanTitle('Song 🎵 (Remastered)', 'track', DEFAULT_ON)?.clean).toBe('Song 🎵');
    expect(cleanTitle('🎵 (Remastered)', 'track', DEFAULT_ON)).toBeNull();
  });

  it('handles brackets as well as parens', () => {
    expect(cleanTitle('Song [Remastered]', 'track', DEFAULT_ON)?.clean).toBe('Song');
  });

  it('is case insensitive on the marker itself', () => {
    expect(cleanTitle('Song (REMASTERED)', 'track', DEFAULT_ON)?.clean).toBe('Song');
    expect(cleanTitle('Album (deluxe edition)', 'album', DEFAULT_ON)?.clean).toBe('Album');
  });
});

describe('cleanTitle — real library corpus', () => {
  const { albums, tracks } = corpus();

  it('fires on a small, stable fraction of real albums', () => {
    const hits = albums.filter((a) => cleanTitle(a.name, 'album', DEFAULT_ON) !== null);
    expect(hits.length).toBeGreaterThan(250);
    expect(hits.length).toBeLessThan(400);
  });

  it('fires on a small, stable fraction of real tracks', () => {
    const hits = tracks.filter((t) => cleanTitle(t.name, 'track', DEFAULT_ON) !== null);
    expect(hits.length).toBeGreaterThan(20);
    expect(hits.length).toBeLessThan(120);
  });

  it('never produces an empty or whitespace-only clean title', () => {
    for (const { name } of [...albums, ...tracks]) {
      for (const field of ['album', 'track'] as const) {
        const clean = cleanTitle(name, field, EVERYTHING)?.clean;
        if (clean !== undefined) expect(clean.trim()).not.toBe('');
      }
    }
  });

  it('never produces a casing-only change', () => {
    for (const { name } of [...albums, ...tracks]) {
      for (const field of ['album', 'track'] as const) {
        const clean = cleanTitle(name, field, EVERYTHING)?.clean;
        if (clean !== undefined) expect(clean.toLowerCase()).not.toBe(name.toLowerCase());
      }
    }
  });

  it('matches a recorded verdict for every default-on album hit', () => {
    const verdict = albums
      .map((a) => [a.name, cleanTitle(a.name, 'album', DEFAULT_ON)?.clean] as const)
      .filter((row): row is readonly [string, string] => row[1] !== undefined)
      .sort((x, y) => x[0].localeCompare(y[0]))
      .map(([from, to]) => `${from}  ->  ${to}`);
    expect(verdict).toMatchSnapshot();
  });

  it('matches a recorded verdict for every default-on track hit', () => {
    const verdict = tracks
      .map((t) => [t.name, cleanTitle(t.name, 'track', DEFAULT_ON)?.clean] as const)
      .filter((row): row is readonly [string, string] => row[1] !== undefined)
      .sort((x, y) => x[0].localeCompare(y[0]))
      .map(([from, to]) => `${from}  ->  ${to}`);
    expect(verdict).toMatchSnapshot();
  });
});

describe('live is track-only, and off by default', () => {
  const TRACK_ONLY = new Set<GroupName>(['live-track']);

  it('does nothing at all unless explicitly enabled', () => {
    expect(cleanTitle('all apologies - live', 'track', DEFAULT_ON)).toBeNull();
    expect(cleanTitle('Stop Making Sense (Live)', 'album', DEFAULT_ON)).toBeNull();
  });

  it('strips a bare Live from a track once enabled', () => {
    expect(cleanTitle('all apologies - live', 'track', TRACK_ONLY)?.clean).toBe('all apologies');
    expect(cleanTitle('White Light/White Heat - Live', 'track', TRACK_ONLY)?.clean).toBe(
      'White Light/White Heat',
    );
  });

  it('never touches an album title, even when enabled', () => {
    expect(cleanTitle('Stop Making Sense (Live)', 'album', TRACK_ONLY)).toBeNull();
    expect(cleanTitle('Yessongs (Live)', 'album', TRACK_ONLY)).toBeNull();
  });

  it('never touches a segment that merely starts with Live', () => {
    for (const [title, field] of [
      ['The King of Limbs: Live from the Basement', 'album'],
      ['Live at Leeds', 'album'],
      ['Live Through This', 'album'],
      ['Song (Live in Tokyo)', 'track'],
      ['Sister Ray - Live in Rotterdam 1984', 'track'],
      ['Song - Live at the Apollo', 'track'],
    ] as [string, 'album' | 'track'][]) {
      expect(cleanTitle(title, field, TRACK_ONLY)).toBeNull();
    }
  });
});

describe('a dash inside brackets is not a tail', () => {
  it('reaches the real title through a nested marker', () => {
    // Splitting at the dash would leave "Remaster]", which matches nothing and stalls the pass.
    expect(
      cleanTitle('The Wall [2011 - Remaster] (2011 Remastered Version)', 'album', DEFAULT_ON)
        ?.clean,
    ).toBe('The Wall');
    expect(cleanTitle('The Wall [2011 - Remaster]', 'album', DEFAULT_ON)?.clean).toBe('The Wall');
  });

  it('still refuses a dash tail that is genuinely part of the title', () => {
    expect(cleanTitle('The Beatles 1967 - 1970', 'album', DEFAULT_ON)).toBeNull();
    expect(cleanTitle('The Bootleg Series Vol.1 - The Quine Tapes', 'album', DEFAULT_ON)).toBeNull();
    expect(cleanTitle('Shine On You Crazy Diamond - Pt. II', 'track', DEFAULT_ON)).toBeNull();
  });
});

describe('remaster word orders', () => {
  const STRIPPED: [string, 'album' | 'track'][] = [
    ['Pink Flag (2006 Remastered Version)', 'album'],
    ['The Name of This Band Is Talking Heads (Expanded 2004 Remaster)', 'album'],
    ['Ride the Lightning (Deluxe Remaster)', 'album'],
    ['Mother Juno (Deluxe Remastered 2023)', 'album'],
    ['The Game (Deluxe Remastered Version)', 'album'],
    ['Suicide (2019 - Remaster)', 'album'],
    ['Rids the World (Hd Remaster)', 'album'],
    ['Album (2019 Digital Remaster)', 'album'],
    ['Album (Super Deluxe 1999 Remastered Version)', 'album'],
    ['Brazil - 2006 Remastered Version', 'track'],
    // "Digital Master" has no "re" and was covered by the old hand-written list.
    ['Disorder - 2019 Digital Master', 'track'],
    ['Colony - 2020 Digital Master', 'track'],
    ['Album (Digital Master)', 'album'],
  ];

  it.each(STRIPPED)('strips %s', (title, field) => {
    expect(cleanTitle(title, field, DEFAULT_ON)).not.toBeNull();
  });

  const KEPT: [string, 'album' | 'track'][] = [
    // A bare "Master" is a real title word, so it is only ever matched behind a qualifier.
    ['Master of Puppets', 'album'],
    ['Album (Master)', 'album'],
    ['Album - Master', 'album'],
    ['Remaster', 'album'],
    ['Remastered Hits', 'album'],
    ['Album (Expanded Reissue Sampler)', 'album'],
    ['Song (Remastered at Abbey Road)', 'track'],
  ];

  it.each(KEPT)('leaves %s alone', (title, field) => {
    expect(cleanTitle(title, field, DEFAULT_ON)).toBeNull();
  });
});
