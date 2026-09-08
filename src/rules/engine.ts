import { DASH_NORMALIZED, type Field, type GroupName, MARKER_GROUPS, type RuleTag } from './markers.js';

/**
 * What a normalizing group does with the tail it matched: rewrite it into the dash form, or drop it.
 * Only the decision path passes `strip`; everything else takes the default.
 */
export type NormalizeAction = 'rewrite' | 'strip';

export interface CleanResult {
  clean: string;
  groups: RuleTag[];
  passes: number;
}

/** Returns the replacement for this exact (field, artist, title), or undefined to fall through. */
export type OverrideLookup = (field: Field, artist: string, title: string) => string | undefined;

const MAX_PASSES = 3;

// A bare year is only cruft once a marker has already been stripped ("Hand of Doom - 2012 -
// Remaster"); standalone it can be a legitimate remix or live year, so it never matches on pass 0.
const BARE_YEAR = /^\s*(?:19|20)\d{2}\s*$/u;
const ENDS_IN_YEAR = /(?:19|20)\d{2}\s*$/u;

const DELIMITERS = [
  { open: ' - ', close: '' },
  { open: '(', close: ')' },
  { open: '[', close: ']' },
] as const;

interface Tail {
  head: string;
  segment: string;
  /** Which delimiter opened this tail: a dash tail is already the normalized form. */
  open: string;
}

/** A dash inside brackets is not a tail: "[2011 - Remaster]" would otherwise split at the dash. */
function balanced(segment: string): boolean {
  let round = 0;
  let square = 0;
  for (const ch of segment) {
    if (ch === '(') round++;
    else if (ch === ')') round--;
    else if (ch === '[') square++;
    else if (ch === ']') square--;
    if (round < 0 || square < 0) return false;
  }
  return round === 0 && square === 0;
}

function splitTail(title: string): Tail | null {
  let best: Tail | null = null;
  let bestIndex = -1;

  for (const { open, close } of DELIMITERS) {
    const index = title.lastIndexOf(open);
    if (index === -1 || index <= bestIndex) continue;

    let segment = title.slice(index + open.length);
    if (close !== '') {
      if (!segment.endsWith(close)) continue;
      segment = segment.slice(0, -close.length);
    }
    // Reject a split that lands inside a bracket group, so the bracket delimiter can win instead.
    if (!balanced(segment)) continue;

    bestIndex = index;
    best = { head: title.slice(0, index), segment, open };
  }

  return best;
}

function hasAlphanumeric(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

function matchOne(segment: string, field: Field, enabled: ReadonlySet<GroupName>): GroupName | null {
  for (const [name, group] of Object.entries(MARKER_GROUPS) as [GroupName, typeof MARKER_GROUPS[GroupName]][]) {
    if (!enabled.has(name) || !group.appliesTo.includes(field)) continue;
    if (DASH_NORMALIZED[name] !== undefined) continue;
    if (group.patterns.some((pattern) => pattern.test(segment))) return name;
  }
  return null;
}

// Labels join two claims inside one segment: "40th Anniversary Deluxe Edition; 2016 Remaster",
// "40th anniversary: remaster". Only ever applied *inside* an already-split trailing segment, so a
// colon in a title ("Deadringer: Deluxe", "Vol. 3: Hollywood Sportatorium") is never reached.
const COMPOUND_SEPARATOR = /[;/:]/;

/**
 * A segment matches when it matches whole, or when **every** part of a compound matches. Requiring
 * all parts is what keeps this from becoming a substring match: one unrecognised part and the whole
 * segment is left alone, so "Live in Rotterdam 1984" and "Vol. 3: … FL 5/22/77" stay untouched.
 *
 * A segment carrying its own trailing tail is a compound too, by the same rule — which reaches the
 * nested "Remastered (Bonus Version)" and the dash-joined "Deluxe Edition - Remaster" alike.
 */
function matchGroup(
  segment: string,
  field: Field,
  enabled: ReadonlySet<GroupName>,
): GroupName[] | null {
  const whole = matchOne(segment, field, enabled);
  if (whole !== null) return [whole];

  const nested = splitTail(segment);
  if (nested !== null) {
    const head = matchOne(nested.head.trim(), field, enabled);
    const tail = matchOne(nested.segment.trim(), field, enabled);
    if (head !== null && tail !== null) return [head, tail];
  }

  if (!COMPOUND_SEPARATOR.test(segment)) return null;
  const parts = segment.split(COMPOUND_SEPARATOR).map((p) => p.trim());
  if (parts.length < 2 || parts.some((p) => p === '')) return null;

  const found: GroupName[] = [];
  for (const part of parts) {
    const group = matchOne(part, field, enabled);
    if (group === null) return null;
    found.push(group);
  }
  return found;
}

/**
 * The group that would reformat this segment into a dash suffix, or null.
 *
 * A compound is excluded deliberately: rewriting "Live; 2001 Remaster" would preserve the remaster
 * label the compound rule exists to remove, so such a segment is left alone instead.
 */
function normalizingGroup(
  segment: string,
  field: Field,
  enabled: ReadonlySet<GroupName>,
): GroupName | null {
  if (COMPOUND_SEPARATOR.test(segment)) return null;
  for (const name of Object.keys(DASH_NORMALIZED) as GroupName[]) {
    if (!enabled.has(name) || !MARKER_GROUPS[name].appliesTo.includes(field)) continue;
    if (DASH_NORMALIZED[name]!.marker.test(segment.trim())) return name;
  }
  return null;
}

/** The segment with its leading marker re-cased to the canonical spelling. */
function normalized(segment: string, group: GroupName): string {
  const { marker, canonical } = DASH_NORMALIZED[group]!;
  return segment.trim().replace(marker, canonical);
}

/** Returns null when the title should be left untouched; never returns a casing-only change. */
export function cleanTitle(
  title: string,
  field: Field,
  enabled: ReadonlySet<GroupName>,
  override?: { artist: string; lookup: OverrideLookup },
  opts?: { normalizeAction?: NormalizeAction },
): CleanResult | null {
  // Checked before the loop, not inside it: a user's replacement is an arbitrary rename, so none of
  // splitTail's segment logic or remainder guards apply to it. One rule, one answer — the result is
  // never fed back through the catalogue, so what the user typed is what lands.
  const replacement = override?.lookup(field, override.artist, title);
  if (replacement !== undefined && replacement.toLowerCase() !== title.toLowerCase()) {
    return { clean: replacement, groups: ['custom'], passes: 1 };
  }

  const groups: GroupName[] = [];
  let current = title;
  let passes = 0;

  while (passes < MAX_PASSES) {
    const tail = splitTail(current);
    if (!tail) break;

    const matched = matchGroup(tail.segment, field, enabled);
    const normalizing = matched === null ? normalizingGroup(tail.segment, field, enabled) : null;
    // A head that also ends in a year makes this a range ("The Beatles 1967 - 1970"), not cruft.
    const isContinuation =
      matched === null &&
      normalizing === null &&
      passes > 0 &&
      BARE_YEAR.test(tail.segment) &&
      !ENDS_IN_YEAR.test(tail.head);
    if (matched === null && normalizing === null && !isContinuation) break;

    const head = tail.head.trimEnd();
    if (Array.from(head).length < 2 || !hasAlphanumeric(head)) break;

    if (normalizing !== null) {
      const strip = opts?.normalizeAction === 'strip';
      // Already the dash form: rewriting is a no-op, and recording it would mistag an earlier strip.
      if (!strip && tail.open === ' - ') break;
      current = strip ? head : `${head} - ${normalized(tail.segment, normalizing)}`;
      passes += 1;
      if (!groups.includes(normalizing)) groups.push(normalizing);
      // Terminal: a rewrite still ends in a marker-prefixed segment and would re-match itself.
      break;
    }

    current = head;
    passes += 1;
    for (const group of matched ?? []) {
      if (!groups.includes(group)) groups.push(group);
    }
  }

  if (passes === 0) return null;
  // Last.fm silently rejects edits that only change casing, so emitting one wastes a write.
  if (current.toLowerCase() === title.toLowerCase()) return null;

  return { clean: current, groups: groups.sort(), passes };
}
