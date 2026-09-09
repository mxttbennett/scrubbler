import type { CustomRuleLookup } from '../rules/customRules.js';
import type { Field } from '../rules/markers.js';
import type { Candidate } from '../scrub/types.js';

/** One row the browser already computed a replacement for. The server never derives `to` itself. */
export interface BulkItem {
  kind: Field;
  artist: string;
  from: string;
  to: string;
}

export interface BulkResult {
  applied: number;
  skipped: BulkItem[];
}

/** Matches `customRules.key` exactly: casing and padding vary between the API and the page. */
export function overrideKey(field: Field, artist: string, title: string): string {
  return `${field} ${artist.trim().toLowerCase()} ${title.trim().toLowerCase()}`;
}

/**
 * An album rename must land before any track edit from that album. A track edit's
 * `album_name_original` is part of its WHERE clause, so a rename applied afterwards leaves the
 * track's clause pointing at a title that no longer exists — and Last.fm answers the resulting
 * no-op with a 200, which reads as success. Same reason `sweep()` orders albums first.
 */
export function orderBulkItems(items: readonly BulkItem[]): BulkItem[] {
  return [...items].sort((a, b) => Number(a.kind === 'track') - Number(b.kind === 'track'));
}

/** A casing-only change is refused before it reaches Last.fm, which answers one with a silent 200. */
export function isCasingOnly(item: BulkItem): boolean {
  return item.from.toLowerCase() === item.to.toLowerCase();
}

/**
 * The ephemeral lookup the resolver consults. It answers only for the items in this request and
 * falls through to the persisted rules, so `custom_rules` is untouched unless the caller saved one.
 */
export function ephemeralLookup(
  items: readonly BulkItem[],
  fallback: CustomRuleLookup,
): CustomRuleLookup {
  const map = new Map(items.map((i) => [overrideKey(i.kind, i.artist, i.from), i.to]));
  return (field, artist, title) => map.get(overrideKey(field, artist, title)) ?? fallback(field, artist, title);
}

export function candidatesFor(items: readonly BulkItem[]): Candidate[] {
  return items.map((i) => ({ kind: i.kind, artist: i.artist, title: i.from }));
}
