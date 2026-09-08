import { AUTOMATIC_EDITS_PATH } from '../lastfm/rules.js';
import { ORIGIN } from '../lastfm/session.js';

/**
 * Markdown-safe, which is stricter than URL-safe: encodeURIComponent leaves `(` and `)` alone, and
 * a literal `)` inside a link target ends the link early — "In Utero (Deluxe Edition)" would break.
 */
function segment(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

/**
 * The user's own library pages, not the global artist pages: these are the pages that show what the
 * rename did, and the same paths the scraper reads. Deliberately without `+noredirect`, which exists
 * to stop Last.fm canonicalising a title mid-edit and only makes a link uglier.
 */
export function artistUrl(user: string, artist: string): string {
  return `${ORIGIN}/user/${segment(user)}/library/music/${segment(artist)}`;
}

export function albumUrl(user: string, artist: string, album: string): string {
  return `${artistUrl(user, artist)}/${segment(album)}`;
}

export function trackUrl(user: string, artist: string, track: string): string {
  return `${artistUrl(user, artist)}/_/${segment(track)}`;
}

/**
 * Where the rule each write creates shows up. Needs no username, unlike the library links: it is the
 * signed-in user's own settings page, so this one renders even when none is configured.
 */
export function automaticEditsUrl(kind: 'track' | 'album'): string {
  return `${ORIGIN}${AUTOMATIC_EDITS_PATH[kind]}`;
}

export const LINK_GLYPH = '↗';

/**
 * A small trailing link rather than a linked name: the titles carry the meaning and Discord renders
 * a linked one in accent blue, which fights the struck-through/bold pairing the card is built on.
 */
export function linkSuffix(url: string | undefined): string {
  return url === undefined ? '' : ` [${LINK_GLYPH}](${url})`;
}
