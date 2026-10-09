import { describe, expect, it } from 'vitest';
import {
  type BulkItem,
  candidatesFor,
  ephemeralLookup,
  isCasingOnly,
  orderBulkItems,
  overrideKey,
} from '../../src/web/bulk.js';

const album = (title: string, to: string): BulkItem => ({ kind: 'album', artist: 'Slint', from: title, to });
const track = (title: string, to: string): BulkItem => ({ kind: 'track', artist: 'Slint', from: title, to });

describe('orderBulkItems — album before tracks', () => {
  it('moves the album rename ahead of every track edit', () => {
    const items = [
      track('Breadcrumb Trail (Live)', 'Breadcrumb Trail'),
      track('Washer (Live)', 'Washer'),
      album('Spiderland (Live)', 'Spiderland'),
    ];

    expect(orderBulkItems(items).map((i) => i.kind)).toEqual(['album', 'track', 'track']);
  });

  it('keeps the album first no matter where the caller put it', () => {
    const first = orderBulkItems([album('A (Live)', 'A'), track('t (Live)', 't')]);
    const last = orderBulkItems([track('t (Live)', 't'), album('A (Live)', 'A')]);

    expect(first.map((i) => i.kind)).toEqual(['album', 'track']);
    expect(last.map((i) => i.kind)).toEqual(['album', 'track']);
  });

  it('is stable within a kind, so the browser\'s order survives', () => {
    const items = [track('c', 'c1'), track('a', 'a1'), track('b', 'b1')];

    expect(orderBulkItems(items).map((i) => i.from)).toEqual(['c', 'a', 'b']);
  });

  it('handles a selection with several albums and several tracks', () => {
    const items = [
      track('t1 (Live)', 't1'),
      album('A1 (Live)', 'A1'),
      track('t2 (Live)', 't2'),
      album('A2 (Live)', 'A2'),
    ];

    expect(orderBulkItems(items).map((i) => i.kind)).toEqual(['album', 'album', 'track', 'track']);
  });

  it('does not mutate the caller\'s array', () => {
    const items = [track('t', 't1'), album('A', 'A1')];
    orderBulkItems(items);

    expect(items.map((i) => i.kind)).toEqual(['track', 'album']);
  });
});

describe('ephemeralLookup', () => {
  const none = () => undefined;

  it('answers for an item in this request', () => {
    const lookup = ephemeralLookup([track('Washer - Live', 'Washer')], none);

    expect(lookup('track', 'Slint', 'Washer - Live')).toBe('Washer');
  });

  it('ignores casing and padding, matching the persisted rule key', () => {
    const lookup = ephemeralLookup([track('Washer - Live', 'Washer')], none);

    expect(lookup('track', '  SLINT ', 'washer - LIVE')).toBe('Washer');
    expect(overrideKey('track', ' Slint ', 'Washer')).toBe('track slint washer');
  });

  it('does not answer across kinds', () => {
    const lookup = ephemeralLookup([album('Spiderland (Live)', 'Spiderland')], none);

    expect(lookup('track', 'Slint', 'Spiderland (Live)')).toBeUndefined();
    expect(lookup('album', 'Slint', 'Spiderland (Live)')).toBe('Spiderland');
  });

  it('falls through to the persisted rules when this request has no opinion', () => {
    const fallback = (_f: 'track' | 'album', _a: string, t: string) =>
      t === 'Nosferatu Man (Remastered)' ? 'Nosferatu Man' : undefined;
    const lookup = ephemeralLookup([track('Washer - Live', 'Washer')], fallback);

    expect(lookup('track', 'Slint', 'Nosferatu Man (Remastered)')).toBe('Nosferatu Man');
    expect(lookup('track', 'Slint', 'Unrelated')).toBeUndefined();
  });

  it('takes precedence over a persisted rule for the same title', () => {
    const fallback = () => 'from the database';
    const lookup = ephemeralLookup([track('Washer - Live', 'Washer')], fallback);

    expect(lookup('track', 'Slint', 'Washer - Live')).toBe('Washer');
  });
});

describe('isCasingOnly', () => {
  it('refuses a change that only alters case', () => {
    expect(isCasingOnly(track('Ripple', 'RIPPLE'))).toBe(true);
    expect(isCasingOnly(track('ripple', 'Ripple'))).toBe(true);
  });

  it('allows a real change', () => {
    expect(isCasingOnly(track('Ripple - Live', 'Ripple'))).toBe(false);
  });
});

describe('candidatesFor', () => {
  it('addresses the candidate by the original title, never the replacement', () => {
    expect(candidatesFor([track('Washer - Live', 'Washer')])).toEqual([
      { kind: 'track', artist: 'Slint', title: 'Washer - Live' },
    ]);
  });
});
