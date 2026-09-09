/**
 * Typographic punctuation folded to ASCII, whole-string.
 *
 * Deliberately narrow: diacritics and symbol words are left alone, because `Björk` and `Bjork` are
 * arguably different names while `Don’t` and `Don't` are not. Nothing here is safe on its own — a
 * fold only ever runs against a title a cluster has already proved has a differently-punctuated
 * twin, which is what keeps a year range like `1981–2014` from being rewritten in isolation.
 */
const SUBSTITUTIONS: readonly [RegExp, string][] = [
  [/[‘’‚‛ʼ´`]/gu, "'"],
  [/[“”„‟«»]/gu, '"'],
  [/[‐-―−]/gu, '-'],
  [/…/gu, '...'],
  [/\s+/gu, ' '],
];

export function foldPunctuation(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SUBSTITUTIONS) out = out.replace(pattern, replacement);
  return out.trim();
}

/** Two entities belong to the same cluster when this matches; Last.fm's own casing varies by page. */
export function punctuationKey(value: string): string {
  return foldPunctuation(value).toLowerCase();
}
