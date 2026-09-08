interface StoredCookie {
  value: string;
  expires: number | undefined;
}

/**
 * Stores every cookie the server sets rather than an allowlist: the anonymous Last.fm flow alone
 * sets seven, and which ones the authenticated edit path needs is not documented.
 */
export class CookieJar {
  private cookies = new Map<string, StoredCookie>();

  absorb(headers: Headers): void {
    for (const line of headers.getSetCookie()) this.absorbOne(line);
  }

  private absorbOne(line: string): void {
    const [pair, ...attrs] = line.split(';');
    if (pair === undefined) return;
    const eq = pair.indexOf('=');
    if (eq <= 0) return;

    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();

    let maxAge: number | undefined;
    let expiresAt: number | undefined;
    for (const attr of attrs) {
      const [rawKey, ...rest] = attr.split('=');
      const key = rawKey?.trim().toLowerCase();
      const raw = rest.join('=').trim();
      if (key === 'max-age') maxAge = Number(raw);
      else if (key === 'expires') expiresAt = Date.parse(raw);
    }

    // A CSRF rejection clears csrftoken with Max-Age=0, so honouring expiry is load-bearing.
    if (maxAge !== undefined && Number.isFinite(maxAge) && maxAge <= 0) {
      this.cookies.delete(name);
      return;
    }
    if (expiresAt !== undefined && Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      this.cookies.delete(name);
      return;
    }

    const expires =
      maxAge !== undefined && Number.isFinite(maxAge)
        ? Date.now() + maxAge * 1000
        : expiresAt !== undefined && Number.isFinite(expiresAt)
          ? expiresAt
          : undefined;

    this.cookies.set(name, { value, expires });
  }

  header(): string {
    const now = Date.now();
    const parts: string[] = [];
    for (const [name, cookie] of this.cookies) {
      if (cookie.expires !== undefined && cookie.expires <= now) {
        this.cookies.delete(name);
        continue;
      }
      parts.push(`${name}=${cookie.value}`);
    }
    return parts.join('; ');
  }

  get(name: string): string | undefined {
    return this.cookies.get(name)?.value;
  }

  get size(): number {
    return this.cookies.size;
  }

  toJSON(): Record<string, StoredCookie> {
    return Object.fromEntries(this.cookies);
  }

  static fromJSON(raw: unknown): CookieJar {
    const jar = new CookieJar();
    if (typeof raw !== 'object' || raw === null) return jar;
    for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { value, expires } = entry as StoredCookie;
      if (typeof value !== 'string') continue;
      if (expires !== undefined && expires <= Date.now()) continue;
      jar.cookies.set(name, { value, expires });
    }
    return jar;
  }

  clear(): void {
    this.cookies.clear();
  }
}
