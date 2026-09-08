import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_GROUPS, type GroupName } from '../../src/rules/markers.js';
import { cleanTitle } from '../../src/rules/engine.js';

const DEFAULT_ON = new Set<GroupName>(['remaster', 'edition', 'bonus']);
const EVERYTHING = new Set<GroupName>(ALL_GROUPS);

interface Corpus {
  albums: { name: string; artist: string }[];
  tracks: { name: string; artist: string }[];
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
    // `live-track` normalizes rather than strips, so its qualified form has its own tests below.
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
    ['Out of the Blue (40th Anniversary Remaster)', 'Out of the Blue'],
    ['Oh, Inverted World (20th Anniversary Remaster)', 'Oh, Inverted World'],
    ['Badmotorfinger (25th Anniversary Remaster)', 'Badmotorfinger'],
    ['The Soft Machine (Remastered And Expanded)', 'The Soft Machine'],
    ['Alchemy (Remastered & Expanded Edition)', 'Alchemy'],
    ['B-2 Unit (2019 Remastering)', 'B-2 Unit'],
    ['Brushfire Fairytales [Remastered (Bonus Version)]', 'Brushfire Fairytales'],
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

  /** `groups` is persisted and reported, so an existing hit must not silently change its tag. */
  it('keeps an ampersand pair on remaster, not edition', () => {
    expect(cleanTitle('Marquee Moon (Expanded & Remastered)', 'album', DEFAULT_ON)?.groups).toEqual(
      ['remaster'],
    );
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

  /**
   * live-track is not in DEFAULT_ON, so the snapshots below would not move for it at all. This is
   * the regression net for normalization: every real live label the rule rewrites, pinned.
   */
  it('matches a recorded verdict for every live-track normalization', () => {
    const enabled = new Set<GroupName>(['live-track']);
    const verdict = tracks
      .map((t) => [t.name, cleanTitle(t.name, 'track', enabled)?.clean] as const)
      .filter((row): row is readonly [string, string] => row[1] !== undefined)
      .sort((x, y) => x[0].localeCompare(y[0]))
      .map(([from, to]) => `${from}  ->  ${to}`);

    expect(verdict).toMatchSnapshot();
  });

  /** The control group: normalizing tracks must not move a single album verdict. */
  it('leaves every album untouched when only live-track is on', () => {
    const enabled = new Set<GroupName>(['live-track']);
    for (const { name } of albums) expect(cleanTitle(name, 'album', enabled)).toBeNull();
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

describe('live is split by field, and both are off by default', () => {
  const TRACK_ONLY = new Set<GroupName>(['live-track']);
  const ALBUM_ONLY = new Set<GroupName>([...DEFAULT_ON, 'live-album']);

  it('reaches a compound that pairs Live with a remaster claim, once enabled', () => {
    // Unreachable without live-album: the remaster half matches but nothing matches a bare "Live".
    expect(cleanTitle("Europe '72 (Live; 2001 Remaster)", 'album', DEFAULT_ON)).toBeNull();
    expect(cleanTitle("Europe '72 (Live; 2001 Remaster)", 'album', ALBUM_ONLY)?.clean).toBe(
      "Europe '72",
    );
  });

  it('strips a bare (Live) from an album whose release only exists live', () => {
    expect(cleanTitle('Yessongs (Live)', 'album', ALBUM_ONLY)?.clean).toBe('Yessongs');
    expect(cleanTitle('Stop Making Sense (Live)', 'album', ALBUM_ONLY)?.clean).toBe(
      'Stop Making Sense',
    );
  });

  it('leaves a live TRACK alone under the album group, since the studio take exists too', () => {
    expect(cleanTitle('all apologies - live', 'track', ALBUM_ONLY)).toBeNull();
    expect(cleanTitle('White Light/White Heat - Live', 'track', ALBUM_ONLY)).toBeNull();
  });

  it('never touches a segment that merely starts with Live, in either group', () => {
    const both = new Set<GroupName>([...DEFAULT_ON, 'live-album', 'live-track']);
    for (const [title, field] of [
      ['The King of Limbs: Live from the Basement', 'album'],
      ['Live at Leeds', 'album'],
      ['Live Through This', 'album'],
      ['Sister Ray - Live in Rotterdam 1984', 'track'],
    ] as [string, 'album' | 'track'][]) {
      expect(cleanTitle(title, field, both)).toBeNull();
    }
  });

  it('does nothing at all unless explicitly enabled', () => {
    expect(cleanTitle('all apologies - live', 'track', DEFAULT_ON)).toBeNull();
    expect(cleanTitle('Stop Making Sense (Live)', 'album', DEFAULT_ON)).toBeNull();
  });

  /**
   * A track's live label is standardised, not deleted: the library already carries both shapes of
   * the same gig ("Sister Ray - Live in Rotterdam 1984" beside "Preaching the Blues (Live in
   * Rotterdam 1984)"), and the dash form is the one nothing touches.
   */
  it('rewrites a bracketed live label into the dash form', () => {
    expect(cleanTitle('Song (Live)', 'track', TRACK_ONLY)?.clean).toBe('Song - Live');
    expect(cleanTitle('Song (Live in Tokyo)', 'track', TRACK_ONLY)?.clean).toBe(
      'Song - Live in Tokyo',
    );
    expect(cleanTitle('Song [Live at Leeds]', 'track', TRACK_ONLY)?.clean).toBe(
      'Song - Live at Leeds',
    );
  });

  it('standardises the marker to `Live` whatever case it arrived in', () => {
    for (const title of ['Song (live)', 'Song (LIVE)', 'Song (Live)']) {
      expect(cleanTitle(title, 'track', TRACK_ONLY)?.clean).toBe('Song - Live');
    }
  });

  /** The qualifier is content: title-casing it would mangle "WCOZ", "BBC" and "5/22/77". */
  it('re-cases only the marker, never the qualifier', () => {
    expect(cleanTitle('Song (live in tokyo)', 'track', TRACK_ONLY)?.clean).toBe(
      'Song - Live in tokyo',
    );
    expect(cleanTitle('Song (Live In Berkeley And Boston)', 'track', TRACK_ONLY)?.clean).toBe(
      'Song - Live In Berkeley And Boston',
    );
  });

  it('reports live-track, not a strip', () => {
    expect(cleanTitle('Song (Live)', 'track', TRACK_ONLY)?.groups).toEqual(['live-track']);
  });

  it('leaves a title that is already the dash form alone', () => {
    for (const title of [
      'Song - Live',
      'Song - Live at the Apollo',
      'Sister Ray - Live in Rotterdam 1984',
      'White Light/White Heat - Live',
    ]) {
      expect(cleanTitle(title, 'track', TRACK_ONLY)).toBeNull();
    }
  });

  /**
   * The one place the marker is left mis-cased: `all apologies - Live` differs from the original
   * only in case, and Last.fm silently rejects such an edit, so there is nothing to send.
   */
  it('cannot re-case an already-dashed live label', () => {
    expect(cleanTitle('all apologies - live', 'track', TRACK_ONLY)).toBeNull();
    expect(cleanTitle('Song - live', 'track', TRACK_ONLY)).toBeNull();
  });

  it('strips an outer marker first, then normalizes, and stops', () => {
    const r = cleanTitle('Song (Live) [Remastered]', 'track', new Set(['live-track', 'remaster']));
    expect(r?.clean).toBe('Song - Live');
    expect(r?.passes).toBe(2);
    expect(r?.groups).toEqual(['live-track', 'remaster']);
  });

  /** The only change came from the remaster, so tagging it live-track would misreport it. */
  it('does not claim live-track when the dash form needed no rewrite', () => {
    const r = cleanTitle('Song - Live [Remastered]', 'track', new Set(['live-track', 'remaster']));
    expect(r?.clean).toBe('Song - Live');
    expect(r?.groups).toEqual(['remaster']);
  });

  /**
   * A knock-on of treating the label as content: it becomes the trailing segment, and the engine
   * only ever examines the trailing segment — so a marker sitting *before* it is out of reach. This
   * used to strip to "Nevermind"; reaching past the live label would be the non-trailing matching
   * the catalogue exists to forbid.
   */
  it('leaves a marker that sits before the live label alone', () => {
    const both = new Set<GroupName>(['live-track', 'edition']);
    expect(cleanTitle('Nevermind (Deluxe Edition) (Live)', 'track', both)?.clean).toBe(
      'Nevermind (Deluxe Edition) - Live',
    );
    expect(cleanTitle('Nevermind (Deluxe Edition) - Live', 'track', both)).toBeNull();
  });

  /** Rewriting this would keep the remaster label the compound rule exists to remove. */
  it('leaves a compound that pairs Live with another marker alone', () => {
    expect(
      cleanTitle('Song (Live; 2001 Remaster)', 'track', new Set(['live-track', 'remaster'])),
    ).toBeNull();
  });

  it('never touches an album title, even when enabled', () => {
    expect(cleanTitle('Stop Making Sense (Live)', 'album', TRACK_ONLY)).toBeNull();
    expect(cleanTitle('Yessongs (Live)', 'album', TRACK_ONLY)).toBeNull();
  });

  it('never touches a title whose Live is not a trailing segment at all', () => {
    for (const [title, field] of [
      ['The King of Limbs: Live from the Basement', 'album'],
      ['Live at Leeds', 'album'],
      ['Live Through This', 'album'],
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

describe('compound segments — every part must be a known marker', () => {
  const STRIPPED: [string, 'album' | 'track'][] = [
    ['Ramones (40th Anniversary Deluxe Edition; 2016 Remaster)', 'album'],
    ["Sinatra's Swingin' Session!!! And More (Remastered / Expanded Edition)", 'album'],
    ['Freedom of Choice (2009 Remaster; Deluxe Edition)', 'album'],
    ['Garbage (20th Anniversary Deluxe Edition/Remastered)', 'album'],
    ['Goat (Remaster / Reissue)', 'album'],
    ['Christmas Portrait (Special Edition/Reissue)', 'album'],
    ['My Generation (50th Anniversary / Super Deluxe)', 'album'],
    // A segment's own trailing tail is a compound too: nested bracket, and dash-joined.
    ['Brushfire Fairytales [Remastered (Bonus Version)]', 'album'],
    ['Album (Deluxe Edition - Remaster)', 'album'],
    ['Album (Remaster - Deluxe)', 'album'],
  ];

  it.each(STRIPPED)('strips %s', (title, field) => {
    expect(cleanTitle(title, field, DEFAULT_ON)).not.toBeNull();
  });

  it('names every rule that fired, not just the first', () => {
    const r = cleanTitle('Ramones (40th Anniversary Deluxe Edition; 2016 Remaster)', 'album', DEFAULT_ON);

    expect(r?.groups).toEqual(['edition', 'remaster']);
  });

  /**
   * One unrecognised part and the whole segment is left alone. This is what keeps the compound rule
   * from degrading into a substring match — the property the entire catalogue depends on.
   */
  const KEPT: [string, 'album' | 'track'][] = [
    ['Album (Deluxe Edition; Live in Tokyo)', 'album'],
    ['Album (Remastered; Taylor\'s Version)', 'album'],
    ["Dick's Picks Vol. 3: Hollywood Sportatorium, Pembroke Pines, FL 5/22/77", 'album'],
    ['AC/DC', 'album'],
    ['Fabric 01 (DJ Mix)', 'album'],
    ["Sweet Bonnie Brown / It's Just Too Much - Live", 'track'],
    ['Blues For Allah / Sand Castles & Glass Camels / Unusual Occurrences In The Desert', 'track'],
    ['White Light/White Heat', 'track'],
    ['Help on the Way / Slipknot!', 'track'],
    // The all-parts rule still governs a nested or dash-joined tail: one unknown part and it stays.
    ['Album (Remastered (at Abbey Road))', 'album'],
    ['Album [Deluxe (Sampler)]', 'album'],
    ['Album (Live in Tokyo - Remaster)', 'album'],
    ['Album (Original Mix - 2011)', 'album'],
    ['Album (Pt. II - Remaster)', 'album'],
    ['Album (Remastered - at Abbey Road)', 'album'],
  ];

  it.each(KEPT)('leaves %s alone', (title, field) => {
    expect(cleanTitle(title, field, DEFAULT_ON)).toBeNull();
  });

  it('refuses a compound with an empty part, so a trailing separator changes nothing', () => {
    expect(cleanTitle('Album (Remastered;)', 'album', DEFAULT_ON)).toBeNull();
    expect(cleanTitle('Album (/Remastered)', 'album', DEFAULT_ON)).toBeNull();
  });

  it('still requires the whole segment, so a marker plus prose is untouched', () => {
    expect(cleanTitle('Album (Remastered at Abbey Road)', 'album', DEFAULT_ON)).toBeNull();
    expect(cleanTitle('Album (Deluxe Edition Sampler)', 'album', DEFAULT_ON)).toBeNull();
  });
});

describe('edition word orders', () => {
  const STRIPPED: [string, 'album' | 'track'][] = [
    ['In Utero (30th Anniversary Super Deluxe)', 'album'],
    ['Hex Enduction Hour (Expanded Deluxe Edition)', 'album'],
    ['Purple Rain (Deluxe Expanded Edition)', 'album'],
    ['Cosmic Thing (30th Anniversary Expanded Edition)', 'album'],
    ["I Should Coco (20th Anniversary Collector's Edition)", 'album'],
    ['Raw Power (50th Anniversary Legacy Edition)', 'album'],
    ['Whatever And Ever Amen (Remastered Edition)', 'album'],
    ['Cave World (Deluxe)', 'album'],
    ['My Generation (50th Anniversary / Super Deluxe)', 'album'],
  ];

  it.each(STRIPPED)('strips %s', (title, field) => {
    expect(cleanTitle(title, field, DEFAULT_ON)).not.toBeNull();
  });

  /**
   * The edition words are common in real album titles, so the whole-segment anchoring is doing all
   * the work here: none of these has a trailing segment for the pattern to be the whole of.
   */
  const KEPT: [string, 'album' | 'track'][] = [
    ['Love Deluxe', 'album'],
    ['Deluxe', 'album'],
    ['Deadringer: Deluxe', 'album'],
    ['Special', 'album'],
    ['The Definitive Collection', 'album'],
    ["1989 (Taylor's Version)", 'album'],
    ['Album (Expanded Reissue Sampler)', 'album'],
    ['Album (2nd Sight)', 'album'],
    ['Saturday Night Fever (The Original Movie Soundtrack)', 'album'],
    ['Shine On You Crazy Diamond - Pt. II', 'track'],
  ];

  it.each(KEPT)('leaves %s alone', (title, field) => {
    expect(cleanTitle(title, field, DEFAULT_ON)).toBeNull();
  });

  it('accepts a bare ordinal so an anniversary stands alone in a compound', () => {
    expect(cleanTitle('Album (45th Anniversary / Super Deluxe)', 'album', DEFAULT_ON)?.clean).toBe(
      'Album',
    );
  });
});

/**
 * The corpus fixture only kept titles that already had a *space-preceded* delimiter, so it contains
 * no `Word(Marker)` at all and the verdict snapshot cannot see this change. These cases are the net.
 */
describe('a delimiter needs no leading space', () => {
  const STRIPPED: [string, string][] = [
    ['Come My Fanatics(Remaster)', 'Come My Fanatics'],
    ['Nevermind(Deluxe Edition)', 'Nevermind'],
    ['Blue Lines(2012 Remaster)', 'Blue Lines'],
    ['Album[Remastered]', 'Album'],
  ];

  it.each(STRIPPED)('strips %s -> %s', (input, expected) => {
    expect(cleanTitle(input, 'album', DEFAULT_ON)?.clean).toBe(expected);
  });

  const KEPT = [
    "(What's the Story) Morning Glory?",
    'Bl(A)ck',
    'R(evolution)',
    'Ph(enomena)',
    'Alive(2007)',
    'Untitled(1)',
    'Album(Remastered at Abbey Road)',
    'Album(Deluxe Edition Sampler)',
    "1989(Taylor's Version)",
    'Karn Evil 9(Reprise)',
    'Sunset(Interlude)',
    'Fabric 01(DJ Mix)',
    'X(Remastered)',
    '!!!(Remastered)',
  ];

  it.each(KEPT)('leaves %s alone in either field', (title) => {
    expect(cleanTitle(title, 'album', EVERYTHING)).toBeNull();
    expect(cleanTitle(title, 'track', EVERYTHING)).toBeNull();
  });

  /** The missing space must not stop a live label being normalized either. */
  it('normalizes a live label that has no space before the bracket', () => {
    expect(cleanTitle('Song(Live in Tokyo)', 'track', new Set(['live-track']))?.clean).toBe(
      'Song - Live in Tokyo',
    );
  });

  /** The one real-library population the bracket half reaches: chained brackets, no marker in either. */
  const SYRO = [
    'minipops 67 [120.2][source field mix]',
    'CIRCLONT6A [141.98][syrobonkus mix]',
    'CIRCLONT14 [152.97][shrymoming mix]',
    'PAPAT4 [155][pineal mix]',
    'syro u473t8+e [141.98][piezoluminescence mix]',
    's950tx16wasr10 [163.97][earth portal mix]',
    'XMAS_EVET10 [120][thanaton3 mix]',
  ];

  it.each(SYRO)('leaves the chained-bracket track %s alone', (title) => {
    expect(cleanTitle(title, 'track', EVERYTHING)).toBeNull();
  });
});

/**
 * Cruft the closed catalogue deliberately declines, because the trailing segment carries genuine
 * content. Asserted so a future widening that reaches them fails here instead of silently editing.
 */
describe('a segment with unnamed words is left alone, however marker-ish', () => {
  const KEPT = [
    'In The Court Of The Crimson King (Expanded & Remastered Original Album Mix)',
    'Odessey and Oracle (Mono Remastered)',
    'Waltz For Debby (Original Jazz Classics Remaster 2010)',
    'Christmas Jollies (Tom Moulton Remix;2022 - Remaster)',
    'Maiden Voyage (Remastered 1999/Rudy Van Gelder Edition)',
  ];

  it.each(KEPT)('leaves %s alone even with every group on', (title) => {
    expect(cleanTitle(title, 'album', EVERYTHING)).toBeNull();
  });
});

describe('a colon can join two markers inside a segment', () => {
  it('strips a bracket whose parts are both markers, and stops at the real subtitle', () => {
    expect(
      cleanTitle("L.A.M.F. (The Lost '77 Mixes) [40th anniversary: remaster]", 'album', DEFAULT_ON)
        ?.clean,
    ).toBe("L.A.M.F. (The Lost '77 Mixes)");
    expect(cleanTitle('Album (40th anniversary: remaster)', 'album', DEFAULT_ON)?.clean).toBe(
      'Album',
    );
  });

  /**
   * The colon rule only applies *inside* an already-split trailing segment, so a colon in the title
   * itself is never reached — there is no ` - `, ` (` or ` [` to split on first.
   */
  const KEPT: [string, 'album' | 'track'][] = [
    ['Deadringer: Deluxe', 'album'],
    ['The King of Limbs: Live from the Basement', 'album'],
    ["Dick's Picks Vol. 3: Hollywood Sportatorium, Pembroke Pines, FL 5/22/77", 'album'],
    ['Album (Remix: Extended)', 'album'],
    ['Album (Live: In Tokyo)', 'album'],
  ];

  it.each(KEPT)('leaves %s alone', (title, field) => {
    expect(cleanTitle(title, field, DEFAULT_ON)).toBeNull();
  });
});
