import { EditRejectedError } from './errors.js';
import { extractAlerts } from './editor.js';
import { LibraryPages, albumLibraryPath } from './pages.js';
import { ORIGIN, type Session } from './session.js';

/** The album form's own fields, harvested from a library page. */
export interface AlbumFormFields {
  csrfmiddlewaretoken: string;
  album_name: string;
  album_artist_name: string;
  action: string;
}

export interface PlannedAlbumEdit {
  artist: string;
  from: string;
  to: string;
  csrfToken: string;
  action: string;
  refererPath: string;
  groups: string[];
}

export interface AlbumEditorOptions {
  verify?: boolean;
  verifyDelayMs?: number;
  verifyAttempts?: number;
  createAutomaticRule?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export type AlbumOutcome = 'verified' | 'unverified' | 'applied';

/**
 * Renames an album in a single request. `edit-album` takes no timestamp, no track name and no
 * edit_all — it is inherently album-wide, so one POST replaces one-per-track via `edit-track`.
 */
export class AlbumEditor {
  private readonly verify: boolean;
  private readonly verifyDelayMs: number;
  private readonly verifyAttempts: number;
  private readonly createAutomaticRule: boolean;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly session: Session,
    private readonly pages: LibraryPages,
    private readonly username: string,
    opts: AlbumEditorOptions = {},
  ) {
    this.verify = opts.verify ?? true;
    this.verifyDelayMs = opts.verifyDelayMs ?? 2000;
    this.verifyAttempts = opts.verifyAttempts ?? 3;
    this.createAutomaticRule = opts.createAutomaticRule ?? true;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  buildBody(edit: PlannedAlbumEdit): URLSearchParams {
    const body = new URLSearchParams();
    body.set('csrfmiddlewaretoken', edit.csrfToken);
    body.set('album_name_original', edit.from);
    body.set('album_name', edit.to);
    body.set('album_artist_name_original', edit.artist);
    body.set('album_artist_name', edit.artist);
    body.set('submit', 'edit-album');
    if (this.createAutomaticRule) body.set('create_automatic_edit_rule', 'on');
    body.set('ajax', '1');
    return body;
  }

  async apply(edit: PlannedAlbumEdit): Promise<AlbumOutcome> {
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
      throw new EditRejectedError(`Last.fm rejected the album edit: ${alerts.join('; ')}`, alerts);
    }
    if (res.status !== 200 && (res.status < 300 || res.status >= 400)) {
      throw new EditRejectedError(`unexpected status ${res.status} from ${edit.action}`, []);
    }

    if (!this.verify) return 'applied';
    return (await this.confirm(edit)) ? 'verified' : 'unverified';
  }

  /** The old album page 404s or empties once the rename lands, which is the confirmation. */
  private async confirm(edit: PlannedAlbumEdit): Promise<boolean> {
    const stale = albumLibraryPath(this.username, edit.artist, edit.from);
    for (let attempt = 1; attempt <= this.verifyAttempts; attempt++) {
      await this.sleep(this.verifyDelayMs);
      const html = await this.pages.fetch(stale);
      if (html === '') return true;
    }
    return false;
  }
}

export function extractAlbumForm(html: string): AlbumFormFields | undefined {
  const form = /<form[^>]*data-edit-album[^>]*>([\s\S]*?)<\/form>/.exec(html);
  if (!form) return undefined;
  const action = /action="([^"]+)"/.exec(form[0])?.[1];
  if (action === undefined) return undefined;

  const fields: Record<string, string> = {};
  for (const m of form[1]!.matchAll(/name=['"]([^'"]+)['"]\s+value=['"]([^'"]*)['"]/g)) {
    fields[m[1]!] = decodeHtml(m[2]!);
  }
  const token = fields['csrfmiddlewaretoken'];
  const album = fields['album_name'];
  const albumArtist = fields['album_artist_name'];
  if (token === undefined || album === undefined || albumArtist === undefined) return undefined;

  return {
    csrfmiddlewaretoken: token,
    album_name: album,
    album_artist_name: albumArtist,
    action: decodeHtml(action),
  };
}

function decodeHtml(v: string): string {
  return v
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
