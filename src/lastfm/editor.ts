import { EditRejectedError } from './errors.js';
import { LibraryPages } from './pages.js';
import { ORIGIN, type Session } from './session.js';
import type { PlannedEdit } from '../scrub/types.js';
import { extractScrobbleRows } from './pages.js';
import { tupleKey, rowTuple } from '../scrub/types.js';

export interface EditorOptions {
  verify?: boolean;
  verifyDelayMs?: number;
  verifyAttempts?: number;
  createAutomaticRule?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export type EditOutcome = 'verified' | 'unverified' | 'applied';

export class Editor {
  private readonly verify: boolean;
  private readonly verifyDelayMs: number;
  private readonly verifyAttempts: number;
  private readonly createAutomaticRule: boolean;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly session: Session,
    private readonly pages: LibraryPages,
    opts: EditorOptions = {},
  ) {
    this.verify = opts.verify ?? true;
    this.verifyDelayMs = opts.verifyDelayMs ?? 2000;
    this.verifyAttempts = opts.verifyAttempts ?? 3;
    this.createAutomaticRule = opts.createAutomaticRule ?? true;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  buildBody(edit: PlannedEdit): URLSearchParams {
    const body = new URLSearchParams();
    body.set('csrfmiddlewaretoken', edit.csrfToken);
    for (const field of ['track_name', 'artist_name', 'album_name', 'album_artist_name'] as const) {
      body.set(`${field}_original`, edit.original[field]);
      body.set(field, edit.next[field]);
    }
    body.set('timestamp', edit.timestamp);
    body.set('submit', 'edit-scrobble');
    body.set('edit_all', 'on');
    // An unchecked checkbox sends no key at all; there is no "off" value Last.fm understands.
    if (this.createAutomaticRule) body.set('create_automatic_edit_rule', 'on');
    body.set('ajax', '1');
    return body;
  }

  async apply(edit: PlannedEdit): Promise<EditOutcome> {
    const res = await this.session.request(edit.action, {
      method: 'POST',
      body: this.buildBody(edit),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: ORIGIN + edit.refererPath,
        Origin: ORIGIN,
      },
    });
    const html = res.status === 200 ? await res.text() : (await res.body?.cancel(), '');
    const alerts = extractAlerts(html);
    if (alerts.length > 0) {
      throw new EditRejectedError(`Last.fm rejected the edit: ${alerts.join('; ')}`, alerts);
    }
    if (res.status !== 200) {
      throw new EditRejectedError(`unexpected status ${res.status} from ${edit.action}`, []);
    }

    if (!this.verify) return 'applied';
    return (await this.confirm(edit)) ? 'verified' : 'unverified';
  }

  /** Last.fm serves stale rows for a moment after a write, so a delay and retries are required. */
  private async confirm(edit: PlannedEdit): Promise<boolean> {
    const staleKey = tupleKey(edit.original);
    for (let attempt = 1; attempt <= this.verifyAttempts; attempt++) {
      await this.sleep(this.verifyDelayMs);
      const { html, gone } = await this.pages.fetchOutcome(edit.refererPath);
      // A track rename makes its own page disappear, which is proof the edit landed — but only
      // when the page is genuinely absent rather than Last.fm refusing to answer.
      if (gone) return true;
      if (html === '') continue;
      const keys = extractScrobbleRows(html).map((row) => tupleKey(rowTuple(row)));
      if (keys.length > 0 && !keys.includes(staleKey)) return true;
    }
    return false;
  }

}

export function extractAlerts(html: string): string[] {
  const alerts: string[] = [];
  for (const m of html.matchAll(
    /class="[^"]*alert-danger[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p|li)>/g,
  )) {
    const text = m[1]!
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text !== '') alerts.push(text);
  }
  return alerts;
}
