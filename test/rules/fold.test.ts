import { describe, expect, it } from 'vitest';
import { foldPunctuation, punctuationKey } from '../../src/rules/fold.js';

describe('foldPunctuation — the canonical target form', () => {
  const FOLDED: [string, string][] = [
    ['Don’t Stop', "Don't Stop"],
    ['Because I’m Me', "Because I'm Me"],
    ['Apple O’', "Apple O'"],
    ['Isn’t It Now?', "Isn't It Now?"],
    ['“Heroes”', '"Heroes"'],
    ['…For the Whole World To See', '...For the Whole World To See'],
    ['If You Leave…', 'If You Leave...'],
    ['Onset – Beyond Clouds', 'Onset - Beyond Clouds'],
    ['Negative Space (1981–2014)', 'Negative Space (1981-2014)'],
    ['I:Cube — Disco Cubizm', 'I:Cube - Disco Cubizm'],
  ];

  it.each(FOLDED)('folds %s', (from, to) => {
    expect(foldPunctuation(from)).toBe(to);
  });

  /** Real corpus entry: opened with a curly quote and closed with a straight one. */
  it('folds a title whose quote pair is mismatched', () => {
    expect(foldPunctuation('Pacifics - “N.Y. Is Red Hot"')).toBe('Pacifics - "N.Y. Is Red Hot"');
  });

  /** Real cluster: one title carried both apostrophe forms at once. */
  it('folds every apostrophe in a title, not just the first', () => {
    expect(foldPunctuation('Let’s Save Tony Orlando’s House')).toBe(
      "Let's Save Tony Orlando's House",
    );
  });

  it('collapses runs of whitespace, including non-breaking space', () => {
    expect(foldPunctuation('viagr  aboys')).toBe('viagr aboys');
    expect(foldPunctuation('  Vol.   3  ')).toBe('Vol. 3');
  });

  it('leaves an already-canonical title untouched', () => {
    expect(foldPunctuation("Don't Stop")).toBe("Don't Stop");
    expect(foldPunctuation('Vol. 3: Hollywood Sportatorium')).toBe(
      'Vol. 3: Hollywood Sportatorium',
    );
  });

  /** The key is punctuation only: folding these would merge genuinely distinct titles. */
  const UNTOUCHED = ['Björk', 'Café', 'R&B', 'Pt. II', 'ロック・ミュージック', '5/22/77'];

  it.each(UNTOUCHED)('leaves %s alone', (title) => {
    expect(foldPunctuation(title)).toBe(title);
  });
});

describe('punctuationKey — the cluster identity', () => {
  it('makes the two apostrophe forms one key', () => {
    expect(punctuationKey('Don’t Stop')).toBe(punctuationKey("Don't Stop"));
  });

  /** 9 of 31 real clusters differ by case as well, so the key has to ignore case. */
  it('makes a punctuation-and-casing pair one key', () => {
    expect(punctuationKey('She’s Like Heroin To Me')).toBe(
      punctuationKey("She's Like Heroin to Me"),
    );
  });

  it('keeps genuinely different titles apart', () => {
    expect(punctuationKey('Björk')).not.toBe(punctuationKey('Bjork'));
    expect(punctuationKey('R&B')).not.toBe(punctuationKey('R and B'));
    expect(punctuationKey('Pt. II')).not.toBe(punctuationKey('Part II'));
    expect(punctuationKey('Kassel Jaeger / Jim O’Rourke')).not.toBe(
      punctuationKey("Kassel Jaeger & Jim O'Rourke"),
    );
  });
});
