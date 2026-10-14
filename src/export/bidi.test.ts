import { describe, expect, it } from 'vitest';

import {
  bidiClass,
  isArabicScript,
  mirrorCodePoint,
  paragraphLevel,
  reorderRuns,
  resolveLevels,
  visualString,
} from './bidi';

const cps = (s: string) => [...s].map((c) => c.codePointAt(0)!);

describe('bidi classes', () => {
  it('classifies representative characters', () => {
    expect(bidiClass('A'.codePointAt(0)!)).toBe('L');
    expect(bidiClass('5'.codePointAt(0)!)).toBe('EN');
    expect(bidiClass(' '.codePointAt(0)!)).toBe('WS');
    expect(bidiClass('م'.codePointAt(0)!)).toBe('AL');
    expect(bidiClass('א'.codePointAt(0)!)).toBe('R');
    expect(bidiClass(0x0661)).toBe('AN'); // Arabic-Indic one
    expect(bidiClass(0x064e)).toBe('NSM'); // fatha
    expect(bidiClass('%'.codePointAt(0)!)).toBe('ET');
    expect(bidiClass('.'.codePointAt(0)!)).toBe('CS');
    expect(bidiClass('-'.codePointAt(0)!)).toBe('ES');
    expect(bidiClass('('.codePointAt(0)!)).toBe('ON');
    expect(bidiClass(0xfeb5)).toBe('AL'); // presentation form B
    expect(bidiClass(0x4e2d)).toBe('L'); // CJK default
    expect(isArabicScript('ع'.codePointAt(0)!)).toBe(true);
    expect(isArabicScript('A'.codePointAt(0)!)).toBe(false);
    expect(mirrorCodePoint('('.codePointAt(0)!)).toBe(')'.codePointAt(0)!);
  });
});

describe('bidi levels and reordering', () => {
  it('paragraph level from first strong character', () => {
    expect(paragraphLevel(cps('123 abc'))).toBe(0);
    expect(paragraphLevel(cps('15 منطقة'))).toBe(1);
    expect(paragraphLevel(cps('123'), 1)).toBe(1);
  });

  it('keeps numbers LTR inside RTL text', () => {
    const text = 'منطقة الخطر 15 م';
    const levels = Array.from(resolveLevels(cps(text), 1));
    expect(levels).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 1, 1]);
    // visual: م, space, 15, space, الخطر reversed, space, منطقة reversed
    expect(visualString(text)).toBe(
      'م 15 ' + [...'الخطر'].reverse().join('') + ' ' + [...'منطقة'].reverse().join(''),
    );
  });

  it('embeds RTL words in LTR paragraphs', () => {
    // A number following an RTL word attaches to it (N1: EN counts as R).
    expect(visualString('Zone עבר 2')).toBe('Zone 2 רבע');
    expect(visualString('Zone עבר B')).toBe('Zone רבע B');
    expect(visualString('abc 12.5% def')).toBe('abc 12.5% def');
  });

  it('handles number separators and terminators', () => {
    // EN after AL → AN; "12.5" stays together and in LTR order.
    const t = 'قطر 12.5 م';
    expect(visualString(t)).toBe('م 12.5 ' + [...'قطر'].reverse().join(''));
    // After Arabic letters digits become AN, so '%' stays a neutral and resolves RTL ("%50").
    expect(visualString('نسبة 50%')).toBe('%50 ' + [...'نسبة'].reverse().join(''));
    // In an LTR paragraph ET adjacent to EN joins the number.
    expect(visualString('rate 50% ok')).toBe('rate 50% ok');
  });

  it('mirrors brackets in RTL runs', () => {
    expect(visualString('(أ)')).toBe('(أ)');
    expect(visualString('أ (ب)')).toBe('(ب) أ');
  });

  it('applies L1 to trailing whitespace', () => {
    const lv = resolveLevels(cps('abc אב  '), 0);
    expect(Array.from(lv).slice(-2)).toEqual([0, 0]);
  });

  it('reorderRuns implements L2', () => {
    expect(reorderRuns([0, 0, 0])).toEqual([0, 1, 2]);
    expect(reorderRuns([1, 1, 1])).toEqual([2, 1, 0]);
    expect(reorderRuns([1, 2, 2, 1])).toEqual([3, 1, 2, 0]);
    expect(reorderRuns([0, 1, 1, 0])).toEqual([0, 2, 1, 3]);
    expect(reorderRuns([])).toEqual([]);
  });

  it('forced direction overrides auto detection', () => {
    expect(visualString('abc def', 'rtl')).toBe('abc def'); // L inside RTL paragraph keeps its order
    expect(visualString('a b', 'rtl')).not.toBe('');
  });
});
