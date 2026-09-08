import { describe, expect, it } from 'vitest';
import { CookieJar } from '../../src/lastfm/cookieJar.js';

function headers(...setCookie: string[]): Headers {
  const h = new Headers();
  for (const line of setCookie) h.append('set-cookie', line);
  return h;
}

describe('CookieJar', () => {
  it('stores every cookie the server sets, not a known subset', () => {
    const jar = new CookieJar();
    jar.absorb(
      headers(
        'sessionid=abc; Path=/; HttpOnly',
        'csrftoken=tok; Path=/',
        'lfmanon=1; Path=/',
        'X-UA-Device-Type=desktop; Path=/',
      ),
    );
    expect(jar.size).toBe(4);
    expect(jar.get('lfmanon')).toBe('1');
  });

  it('evicts a cookie cleared with Max-Age=0, which is how a CSRF rejection clears csrftoken', () => {
    const jar = new CookieJar();
    jar.absorb(headers('csrftoken=tok; Path=/'));
    expect(jar.get('csrftoken')).toBe('tok');
    jar.absorb(headers('csrftoken=""; Max-Age=0; Path=/'));
    expect(jar.get('csrftoken')).toBeUndefined();
  });

  it('drops a cookie whose Expires is in the past', () => {
    const jar = new CookieJar();
    jar.absorb(headers('old=1; expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'));
    expect(jar.get('old')).toBeUndefined();
  });

  it('serialises a Cookie header', () => {
    const jar = new CookieJar();
    jar.absorb(headers('a=1', 'b=2'));
    expect(jar.header()).toBe('a=1; b=2');
  });

  it('round-trips through JSON so a session survives a restart', () => {
    const jar = new CookieJar();
    jar.absorb(headers('sessionid=abc; Max-Age=31536000'));
    const revived = CookieJar.fromJSON(JSON.parse(JSON.stringify(jar.toJSON())));
    expect(revived.get('sessionid')).toBe('abc');
  });

  it('ignores malformed persisted state rather than throwing', () => {
    expect(CookieJar.fromJSON(null).size).toBe(0);
    expect(CookieJar.fromJSON({ a: 'nope' }).size).toBe(0);
  });

  it('overwrites a cookie on reissue', () => {
    const jar = new CookieJar();
    jar.absorb(headers('sessionid=one'));
    jar.absorb(headers('sessionid=two'));
    expect(jar.get('sessionid')).toBe('two');
    expect(jar.size).toBe(1);
  });
});
