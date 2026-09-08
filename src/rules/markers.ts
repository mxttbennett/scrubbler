export type Field = 'track' | 'album';

export type GroupName =
  | 'remaster'
  | 'edition'
  | 'bonus'
  | 'feat-album'
  | 'feat-track'
  | 'ep-single'
  | 'live-track'
  | 'version'
  | 'mono-stereo';

/**
 * A custom replacement is not a catalogue group: it has no pattern, applies to one artist's title,
 * and must never be nameable in RULES_ENABLED — hence a widened tag rather than a tenth GroupName.
 */
export type RuleTag = GroupName | 'custom';

export interface MarkerGroup {
  appliesTo: readonly Field[];
  experimental: boolean;
  patterns: readonly RegExp[];
}

const YEAR = String.raw`(?:19|20)\d{2}`;

// The catalogue is deliberately closed: a survey of 8,831 real albums and 8,000 real tracks found
// that most trailing segments are genuine title content (`Pt. II`, `Taylor's Version`, `Live in
// Rotterdam 1984`), so anything matched by shape rather than by name destroys real metadata.
function group(
  appliesTo: readonly Field[],
  experimental: boolean,
  sources: readonly string[],
): MarkerGroup {
  return {
    appliesTo,
    experimental,
    patterns: sources.map((p) => new RegExp(String.raw`^\s*(?:${p})\s*$`, 'iu')),
  };
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
  const word = String.raw`remaster(?:ed)?`;
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
  remaster: group(['track', 'album'], false, [
    ...remasterOrders(),
    String.raw`expanded\s*&\s*remastered`,
    String.raw`remastered\s*&\s*expanded`,
    String.raw`remastered\s+original\s+album`,
  ]),

  edition: group(['track', 'album'], false, [
    String.raw`deluxe(?:\s+(?:edition|version))?`,
    String.raw`super\s+deluxe(?:\s+(?:edition|version))?`,
    String.raw`expanded(?:\s+(?:edition|version))?`,
    String.raw`collector'?s\s+edition`,
    String.raw`special\s+edition`,
    String.raw`legacy\s+edition`,
    String.raw`definitive\s+edition`,
    String.raw`anniversary\s+edition`,
    String.raw`\d+(?:st|nd|rd|th)\s+anniversary(?:\s+deluxe)?(?:\s+(?:edition|version))?`,
    String.raw`bonus\s+tracks?\s+version`,
    String.raw`japanese\s+edition`,
    String.raw`reissue`,
    String.raw`remastered\s+deluxe\s+edition`,
    String.raw`expanded\s+${YEAR}`,
    String.raw`deluxe\s+${YEAR}`,
  ]),

  bonus: group(['track', 'album'], false, [
    String.raw`bonus\s+tracks?`,
    String.raw`explicit(?:\s+version)?`,
    String.raw`clean(?:\s+version)?`,
  ]),

  // Split from feat-track because deleting a credit from an *album* title drops store cruft, while
  // deleting it from a track title destroys real information.
  'feat-album': group(['album'], true, [
    String.raw`feat\.?\s+.+`,
    String.raw`featuring\s+.+`,
    String.raw`ft\.?\s+.+`,
  ]),

  'feat-track': group(['track'], true, [
    String.raw`feat\.?\s+.+`,
    String.raw`featuring\s+.+`,
    String.raw`ft\.?\s+.+`,
  ]),

  'ep-single': group(['album'], true, [String.raw`ep`, String.raw`single`]),

  // Track-only, and off: a live track sits beside the studio take you also own, so enabling this
  // merges two different recordings irreversibly. Kept available because whether that matters is a
  // judgement only the library's owner can make.
  'live-track': group(['track'], true, [String.raw`live`]),

  // These name *which recording* it is, so merging them loses information: off by default.
  version: group(['track', 'album'], true, [
    String.raw`radio\s+edit`,
    String.raw`single\s+version`,
    String.raw`album\s+version`,
  ]),

  'mono-stereo': group(['track', 'album'], true, [
    String.raw`mono(?:\s+version)?`,
    String.raw`stereo(?:\s+version)?`,
  ]),
};

export const ALL_GROUPS = Object.keys(MARKER_GROUPS) as GroupName[];

export const DEFAULT_ENABLED = ALL_GROUPS.filter((g) => !MARKER_GROUPS[g].experimental);

export const EXPERIMENTAL_GROUPS = ALL_GROUPS.filter((g) => MARKER_GROUPS[g].experimental);

export function isGroupName(value: string): value is GroupName {
  return Object.hasOwn(MARKER_GROUPS, value);
}
