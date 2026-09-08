import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CookieJar } from './cookieJar.js';
import { SessionError } from './errors.js';

export const ORIGIN = 'https://www.last.fm';
const AUTH_PROBE_PATH = '/settings/subscription/automatic-edits';
const MAX_LOGIN_ATTEMPTS = 2;

export interface SessionOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  statePath?: string;
  log?: (msg: string) => void;
}

export interface SessionCredentials {
  username: string;
  password: string;
  userAgent: string;
}

export class Session {
  private jar: CookieJar;
  private readonly fetchImpl: typeof fetch;
  private readonly statePath: string | undefined;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly creds: SessionCredentials,
    opts: SessionOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.statePath = opts.statePath;
    this.log = opts.log ?? ((m) => console.log(m));
    this.jar = this.loadState();
  }

  private loadState(): CookieJar {
    if (this.statePath === undefined) return new CookieJar();
    try {
      return CookieJar.fromJSON(JSON.parse(readFileSync(this.statePath, 'utf8')));
    } catch {
      // no usable saved session is the normal first-run case
      return new CookieJar();
    }
  }

  private saveState(): void {
    if (this.statePath === undefined) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(this.jar.toJSON()), { mode: 0o600 });
    } catch (error) {
      this.log(`could not persist session: ${String(error)}`);
    }
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith('http') ? path : `${ORIGIN}${path}`;
    const headers = new Headers(init.headers);
    headers.set('User-Agent', this.creds.userAgent);
    if (!headers.has('Accept')) {
      headers.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    }
    headers.set('Accept-Language', 'en-US,en;q=0.9');
    const cookie = this.jar.header();
    if (cookie !== '') headers.set('Cookie', cookie);

    const res = await this.fetchImpl(url, { ...init, headers, redirect: 'manual' });
    this.jar.absorb(res.headers);
    this.saveState();
    return res;
  }

  /**
   * The probe path 302s whether or not you are signed in, so only the redirect target distinguishes
   * them: `/login...` means anonymous, anything else (e.g. `.../automatic-edits/albums`) means live.
   */
  async isAuthenticated(): Promise<boolean> {
    const res = await this.request(AUTH_PROBE_PATH);
    await res.body?.cancel();
    if (res.status === 200) return true;
    const location = res.headers.get('location') ?? '';
    return res.status >= 300 && res.status < 400 && !location.startsWith('/login');
  }

  private async loginOnce(): Promise<void> {
    const page = await this.request('/login');
    const html = await page.text();
    const token = extractCsrfToken(html);
    if (token === undefined) throw new SessionError('no csrfmiddlewaretoken on /login');

    const body = new URLSearchParams({
      csrfmiddlewaretoken: token,
      next: `/user/${this.creds.username}`,
      username_or_email: this.creds.username,
      password: this.creds.password,
    });

    // Django's CSRF middleware rejects HTTPS POSTs without a Referer, and the rejection looks like
    // a successful 302 — omit these headers and the failure is silent.
    const res = await this.request('/login', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${ORIGIN}/login`,
        Origin: ORIGIN,
      },
    });
    await res.body?.cancel();
  }

  async ensureSession(): Promise<void> {
    if (await this.isAuthenticated()) return;

    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
      this.jar.clear();
      await this.loginOnce();
      if (await this.isAuthenticated()) {
        this.log(`logged in as ${this.creds.username}`);
        return;
      }
      this.log(`login attempt ${attempt} did not produce an authenticated session`);
    }

    throw new SessionError(
      `could not authenticate as ${this.creds.username} after ${MAX_LOGIN_ATTEMPTS} attempts — check LASTFM_PASSWORD`,
    );
  }

  /** Any authenticated page's token works for any POST, since it is derived from the cookie. */
  async freshCsrfToken(path: string): Promise<string | undefined> {
    const res = await this.request(path);
    if (res.status !== 200) {
      await res.body?.cancel();
      return undefined;
    }
    return extractCsrfToken(await res.text());
  }

  cookie(name: string): string | undefined {
    return this.jar.get(name);
  }
}

export function extractCsrfToken(html: string): string | undefined {
  const match = /name=['"]csrfmiddlewaretoken['"]\s+value=['"]([^'"]+)['"]/.exec(html);
  return match?.[1];
}

export function sessionStatePath(dbPath: string): string {
  return join(dirname(dbPath), 'session.json');
}
