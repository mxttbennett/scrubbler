export type Field = 'track' | 'album';

export type GroupName =
  | 'remaster'
  | 'edition'
  | 'bonus'
  | 'feat-album'
  | 'feat-track'
  | 'ep-single'
  | 'live-album'
  | 'live-track'
  | 'version'
  | 'mono-stereo';

/**
 * A custom replacement is not a catalogue group: it has no pattern, applies to one artist's title,
 * and must never be nameable in RULES_ENABLED — hence a widened tag rather than a tenth GroupName.
 */
export type RuleTag = GroupName | 'custom';

/**
 * How much supervision a group gets: `auto` applies, `gated` proposes a Discord card first, `off`
 * never fires. Deliberately the operator's choice per group rather than a property of the rule.
 */
export type Tier = 'auto' | 'gated' | 'off';

const TIERS: readonly Tier[] = ['auto', 'gated', 'off'];

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

export interface MarkerGroup {
  appliesTo: readonly Field[];
  /** The tier this group takes when `RULES` does not name it. */
  defaultTier: 'auto' | 'off';
  patterns: readonly RegExp[];
}

const YEAR = String.raw`(?:19|20)\d{2}`;

// The catalogue is deliberately closed: a survey of 8,831 real albums and 8,000 real tracks found
// that most trailing segments are genuine title content (`Pt. II`, `Taylor's Version`, `Live in
// Rotterdam 1984`), so anything matched by shape rather than by name destroys real metadata.
function group(
  appliesTo: readonly Field[],
  defaultTier: 'auto' | 'off',
  sources: readonly string[],
): MarkerGroup {
  return {
    appliesTo,
    defaultTier,
    patterns: sources.map((p) => new RegExp(String.raw`^\s*(?:${p})\s*$`, 'iu')),
  };
}

/**
 * The words a label builds an edition name from. Each is only ever matched as part of a *whole*
 * trailing segment, which is why "Love Deluxe" and the album simply called "Deluxe" are untouched —
 * they have no trailing segment at all.
 */
const EDITION_WORDS = [
  String.raw`(?:super\s+)?deluxe`,
  String.raw`expanded`,
  String.raw`legacy`,
  String.raw`special`,
  String.raw`definitive`,
  String.raw`collector'?s`,
  String.raw`japanese`,
  String.raw`remaster(?:ed|ing)?`,
  String.raw`reissue`,
  String.raw`anniversary`,
] as const;

/** Labels join two edition words with a conjunction as readily as a space: "Remastered & Expanded". */
const EDITION_JOIN = String.raw`(?:\s+|\s*&\s*|\s+and\s+)`;

/**
 * An optional ordinal anniversary, then one or more edition words in any order, then an optional
 * "edition"/"version". Covers "Deluxe", "Expanded Deluxe Edition", "30th Anniversary Super Deluxe"
 * and combinations no label has shipped yet.
 */
function editionOrders(): string {
  const word = `(?:${EDITION_WORDS.join('|')})`;
  // A bare ordinal prefix, so "50th Anniversary" stands alone as one part of a compound.
  const ordinal = String.raw`(?:\d+(?:st|nd|rd|th)\s+)?`;
  return `${ordinal}${word}(?:${EDITION_JOIN}${word})*(?:\\s+(?:edition|version))?`;
}

/** Qualifiers that appear in front of a remaster claim; each is store cruft on its own too. */
const REMASTER_QUALIFIERS = ['digital', 'hd', 'expanded', 'deluxe', 'super deluxe'] as const;

/**
 * Every order of (qualifier?, year?, "remaster(ed)", "version"?) that a label actually ships, with
 * the year before or after the word and a dash or space between. The word "remaster" is mandatory in
 * all of them, so nothing here can match a title that is not claiming to be one.
 */
function remasterOrders(): string[] {
  const WS = String.raw`\s+`;
  const word = String.raw`remaster(?:ed|ing)?`;
  const sep = String.raw`\s*[-–]?\s*`;
  const out = new Set<string>();
  for (const q of ['', ...REMASTER_QUALIFIERS]) {
    // Concatenated, not interpolated: `\s` inside a non-raw template literal collapses to `s`.
    const prefix = q === '' ? '' : q.replace(/ /g, WS) + WS;
    // "Digital Master" has no "re", but a bare "Master" is a real title word (Master of Puppets), so
    // the shorter form is only ever generated behind a qualifier.
    const words = prefix === '' ? [word] : [word, String.raw`master(?:ed)?`];
    for (const w of words) {
      for (const suffix of ['', String.raw`\s+version`]) {
        out.add(`${prefix}${w}${suffix}`);
        out.add(`${prefix}${YEAR}${sep}${w}${suffix}`);
        out.add(`${prefix}${w}${sep}${YEAR}${suffix}`);
        // Year ahead of the qualifier too: "2019 Digital Remaster".
        out.add(`${YEAR}${sep}${prefix}${w}${suffix}`);
      }
    }
  }
  return [...out];
}

export const MARKER_GROUPS: Record<GroupName, MarkerGroup> = {
  // Generated rather than listed: the same three parts recur in every order a label has ever used,
  // and enumerating them by hand kept missing one ("2006 Remastered Version", "Expanded 2004
  // Remaster"). Every combination still requires the literal word "remaster", so this stays a
  // closed catalogue of named cruft and never matches by shape.
  remaster: group(['track', 'album'], 'auto', [
    ...remasterOrders(),
    // Redundant with editionOrders, kept so these stay tagged `remaster`: `groups` is persisted.
    String.raw`expanded\s*&\s*remastered`,
    String.raw`remastered\s*&\s*expanded`,
    String.raw`remastered\s+original\s+album`,
  ]),

  // Generated for the same reason as remaster: the words combine freely ("Expanded Deluxe Edition",
  // "30th Anniversary Super Deluxe") and hand-listing the combinations kept missing one.
  edition: group(['track', 'album'], 'auto', [
    editionOrders(),
    String.raw`bonus\s+tracks?\s+version`,
    String.raw`expanded\s+${YEAR}`,
    String.raw`deluxe\s+${YEAR}`,
  ]),

  bonus: group(['track', 'album'], 'auto', [
    String.raw`bonus\s+tracks?`,
    String.raw`bonus\s+versions?`,
    String.raw`explicit(?:\s+version)?`,
    String.raw`clean(?:\s+version)?`,
  ]),

  // Split from feat-track because deleting a credit from an *album* title drops store cruft, while
  // deleting it from a track title destroys real information.
  'feat-album': group(['album'], 'off', [
    String.raw`feat\.?\s+.+`,
    String.raw`featuring\s+.+`,
    String.raw`ft\.?\s+.+`,
  ]),

  'feat-track': group(['track'], 'off', [
    String.raw`feat\.?\s+.+`,
    String.raw`featuring\s+.+`,
    String.raw`ft\.?\s+.+`,
  ]),

  'ep-single': group(['album'], 'off', [String.raw`ep`, String.raw`single`]),

  // Split by field, and both off. A live *album* labelled "(Live)" is usually a release that only
  // exists live, so the label is redundant — 14 in a real library, none with a studio twin. A live
  // *track* sits beside the studio take you also own, and merging them is irreversible. Use shadow
  // mode to see what either would do before enabling it.
  'live-album': group(['album'], 'off', [String.raw`live`]),

  'live-track': group(['track'], 'off', [String.raw`live`]),

  // These name *which recording* it is, so merging them loses information: off by default.
  version: group(['track', 'album'], 'off', [
    String.raw`radio\s+edit`,
    String.raw`single\s+version`,
    String.raw`album\s+version`,
  ]),

  'mono-stereo': group(['track', 'album'], 'off', [
    String.raw`mono(?:\s+version)?`,
    String.raw`stereo(?:\s+version)?`,
  ]),
};

export const ALL_GROUPS = Object.keys(MARKER_GROUPS) as GroupName[];

export const DEFAULT_TIERS: Record<GroupName, Tier> = Object.fromEntries(
  ALL_GROUPS.map((g) => [g, MARKER_GROUPS[g].defaultTier]),
) as Record<GroupName, Tier>;

export const DEFAULT_ENABLED = ALL_GROUPS.filter((g) => MARKER_GROUPS[g].defaultTier === 'auto');


export function isGroupName(value: string): value is GroupName {
  return Object.hasOwn(MARKER_GROUPS, value);
}
