import { describe, expect, it } from 'vitest';
import { LibraryPages } from '../../src/lastfm/pages.js';

const CHARTLIST = '<table class="chartlist chartlist--with-album"><tr></tr></table>';
const SETTLED_EMPTY = '<table class="table"></table>';
const THROTTLED = '<title>Page not available | Last.fm</title><h1>You’re requesting too many pages</h1>';

function session(responses: { status: number; body?: string }[]) {
  let i = 0;
  return {
    request: async () => {
      const r = responses[Math.min(i++, responses.length - 1)]!;
      return new Response(r.body ?? '', { status: r.status });
    },
  } as never;
}

const fast = { minIntervalMs: 0, jitterMs: 0, sleep: async () => {}, log: () => {} };

describe('fetchOutcome distinguishes gone from unanswered', () => {
  it('reports a rendered page as present', async () => {
    const p = new LibraryPages(session([{ status: 200, body: CHARTLIST }]), fast);
    const r = await p.fetchOutcome('/x');
    expect(r.gone).toBe(false);
    expect(r.html).toContain('chartlist');
  });

  it('reports a settled page with no chartlist as gone — a rename proves itself this way', async () => {
    const p = new LibraryPages(session([{ status: 200, body: SETTLED_EMPTY }]), fast);
    expect((await p.fetchOutcome('/x')).gone).toBe(true);
  });

  it('reports a 404 as gone', async () => {
    const p = new LibraryPages(session([{ status: 404 }]), fast);
    expect((await p.fetchOutcome('/x')).gone).toBe(true);
  });

  it('does NOT report a throttle as gone — it proves nothing', async () => {
    const p = new LibraryPages(session([{ status: 200, body: THROTTLED }]), fast);
    const r = await p.fetchOutcome('/x');
    expect(r.html).toBe('');
    expect(r.gone).toBe(false);
  });

  it('does NOT report a run of server errors as gone', async () => {
    const p = new LibraryPages(session([{ status: 500 }]), fast);
    const r = await p.fetchOutcome('/x');
    expect(r.html).toBe('');
    expect(r.gone).toBe(false);
  });

  it('reports gone again after a failed fetch, so one bad page does not poison later checks', async () => {
    const p = new LibraryPages(session([{ status: 500 }]), fast);
    expect((await p.fetchOutcome('/a')).gone).toBe(false);

    const q = new LibraryPages(session([{ status: 200, body: SETTLED_EMPTY }]), fast);
    expect((await q.fetchOutcome('/b')).gone).toBe(true);
  });
});
