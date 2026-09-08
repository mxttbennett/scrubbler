import { type Field, type GroupName, MARKER_GROUPS } from './markers.js';

export interface CleanResult {
  clean: string;
  groups: GroupName[];
  passes: number;
}

const MAX_PASSES = 3;

// A bare year is only cruft once a marker has already been stripped ("Hand of Doom - 2012 -
// Remaster"); standalone it can be a legitimate remix or live year, so it never matches on pass 0.
const BARE_YEAR = /^\s*(?:19|20)\d{2}\s*$/u;
const ENDS_IN_YEAR = /(?:19|20)\d{2}\s*$/u;

const DELIMITERS = [
  { open: ' - ', close: '' },
  { open: ' (', close: ')' },
  { open: ' [', close: ']' },
] as const;

interface Tail {
  head: string;
  segment: string;
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

    bestIndex = index;
    best = { head: title.slice(0, index), segment };
  }

  return best;
}

function hasAlphanumeric(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

function matchGroup(segment: string, field: Field, enabled: ReadonlySet<GroupName>): GroupName | null {
  for (const [name, group] of Object.entries(MARKER_GROUPS) as [GroupName, typeof MARKER_GROUPS[GroupName]][]) {
    if (!enabled.has(name) || !group.appliesTo.includes(field)) continue;
    if (group.patterns.some((pattern) => pattern.test(segment))) return name;
  }
  return null;
}

/** Returns null when the title should be left untouched; never returns a casing-only change. */
export function cleanTitle(
  title: string,
  field: Field,
  enabled: ReadonlySet<GroupName>,
): CleanResult | null {
  const groups: GroupName[] = [];
  let current = title;
  let passes = 0;

  while (passes < MAX_PASSES) {
    const tail = splitTail(current);
    if (!tail) break;

    const group = matchGroup(tail.segment, field, enabled);
    // A head that also ends in a year makes this a range ("The Beatles 1967 - 1970"), not cruft.
    const isContinuation =
      group === null &&
      passes > 0 &&
      BARE_YEAR.test(tail.segment) &&
      !ENDS_IN_YEAR.test(tail.head);
    if (!group && !isContinuation) break;

    const head = tail.head.trimEnd();
    if (Array.from(head).length < 2 || !hasAlphanumeric(head)) break;

    current = head;
    passes += 1;
    if (group && !groups.includes(group)) groups.push(group);
  }

  if (passes === 0) return null;
  // Last.fm silently rejects edits that only change casing, so emitting one wastes a write.
  if (current.toLowerCase() === title.toLowerCase()) return null;

  return { clean: current, groups: groups.sort(), passes };
}
