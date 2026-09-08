import type { Session } from './session.js';
import { decodeEntities } from './pages.js';
import { type Tuple, tupleKey } from '../scrub/types.js';

const RULE_PAGES = [
  { path: '/settings/subscription/automatic-edits/albums', kind: 'album' as const },
  { path: '/settings/subscription/automatic-edits/tracks', kind: 'track' as const },
];

export interface RuleSet {
  keys: Set<string>;
  albumCount: number;
  trackCount: number;
  partial: boolean;
}

/**
 * Best-effort only: the ledger is the authoritative dedupe. A page whose markup we cannot parse
 * degrades to redundant work, never to a skipped or duplicated edit.
 */
export async function readExistingRules(
  session: Session,
  log: (msg: string) => void = (m) => console.log(m),
): Promise<RuleSet> {
  const result: RuleSet = { keys: new Set(), albumCount: 0, trackCount: 0, partial: false };

  for (const { path, kind } of RULE_PAGES) {
    try {
      let page = 1;
      let pages = 1;
      do {
        const res = await session.request(page === 1 ? path : `${path}?page=${page}`);
        if (res.status !== 200) {
          await res.body?.cancel();
          result.partial = true;
          log(`automatic-edit rules: ${path} returned ${res.status}, continuing ledger-only`);
          break;
        }
        const html = await res.text();
        if (page === 1) pages = rulePageCount(html);
        const before = result.keys.size;
        for (const tuple of extractRuleTuples(html)) result.keys.add(tupleKey(tuple));
        const added = result.keys.size - before;
        if (kind === 'album') result.albumCount += added;
        else result.trackCount += added;
        page++;
      } while (page <= pages);
    } catch (error) {
      result.partial = true;
      log(`automatic-edit rules: could not read ${path} (${String(error)})`);
    }
  }

  return result;
}

export function rulePageCount(html: string): number {
  const nums = [...html.matchAll(/class="[^"]*pagination-page[^"]*"[^>]*>([\s\S]*?)<\/li>/g)]
    .map((m) => Number.parseInt(m[1]!.replace(/<[^>]+>/g, '').trim(), 10))
    .filter((n) => Number.isInteger(n));
  return nums.length > 0 ? Math.max(...nums) : 1;
}

export function extractRuleTuples(html: string): Tuple[] {
  const tuples: Tuple[] = [];
  for (const form of html.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)) {
    const fields: Record<string, string> = {};
    for (const input of form[1]!.matchAll(/name=['"]([^'"]+)['"][^>]*?value=['"]([^'"]*)['"]/g)) {
      fields[input[1]!] = decodeEntities(input[2]!);
    }
    const track = fields['track_name_original'];
    const album = fields['album_name_original'];
    if (track === undefined && album === undefined) continue;
    tuples.push({
      track_name: track ?? '',
      artist_name: fields['artist_name_original'] ?? '',
      album_name: album ?? '',
      album_artist_name: fields['album_artist_name_original'] ?? '',
    });
  }
  return tuples;
}
