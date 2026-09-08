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

export const MARKER_GROUPS: Record<GroupName, MarkerGroup> = {
  remaster: group(['track', 'album'], false, [
    String.raw`remastered(?:\s+${YEAR})?`,
    String.raw`remastered\s+${YEAR}\s+version`,
    String.raw`${YEAR}\s+remaster(?:ed)?`,
    String.raw`${YEAR}\s+digital\s+remaster(?:ed)?`,
    String.raw`${YEAR}\s+digital\s+master(?:ed)?`,
    String.raw`remaster`,
    String.raw`remastered\s+version`,
    String.raw`digital\s+remaster(?:ed)?`,
    String.raw`expanded\s*&\s*remastered`,
    String.raw`remastered\s*&\s*expanded`,
    // Word orders the original survey missed; each was found unmatched in a real library.
    String.raw`${YEAR}\s+remastered\s+version`,
    String.raw`remaster(?:ed)?\s+${YEAR}`,
    String.raw`remastered\s+original\s+album`,
    String.raw`hd\s+remaster(?:ed)?`,
    String.raw`digital\s+remaster(?:ed)?\s+${YEAR}`,
    String.raw`${YEAR}\s+remaster(?:ed)?\s+version`,
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
