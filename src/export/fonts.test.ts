import { describe, expect, it } from 'vitest';

import {
  DEFAULT_METRICS,
  anchorFraction,
  baselineOffset,
  createFontSet,
  cssFontFamily,
  emMetrics,
  layoutText,
  layoutToPath,
  lineDirection,
  shapeWithFontkit,
  splitLines,
} from './fonts';
import { pathBounds } from './scene';
import { testFontBytes, testFontSet } from './test-fonts';

describe('createFontSet', () => {
  it('loads fonts and resolves families with fallbacks', () => {
    const fs = testFontSet();
    expect(fs.primary('sans', false).key).toBe('sans');
    expect(fs.primary('sans', true).key).toBe('sansBold');
    expect(fs.primary('serif', false).key).toBe('sans'); // no serif supplied → sans
    expect(fs.primary('mono', true).key).toBe('sansBold');
    expect(fs.arabic(true).key).toBe('arabicBold');
    const sans = fs.get('sans');
    expect(sans.unitsPerEm).toBe(1000);
    expect(sans.ascent).toBeCloseTo(DEFAULT_METRICS.ascent, 6);
    expect(sans.descent).toBeCloseTo(DEFAULT_METRICS.descent, 6);
    expect(emMetrics(fs).capHeight).toBeCloseTo(0.714, 6);
    expect(() => fs.get('nope')).toThrow();
  });

  it('accepts ArrayBuffers and rejects garbage', () => {
    const b = testFontBytes();
    const ab = (u: Uint8Array | ArrayBuffer) => (u instanceof Uint8Array ? u.slice().buffer : u);
    const fs = createFontSet({ sans: ab(b.sans), arabic: ab(b.arabic) });
    expect(fs.primary('sans', true).key).toBe('sans');
    expect(() => createFontSet({ sans: new Uint8Array([1, 2, 3, 4]), arabic: b.arabic })).toThrow(/sans/);
  });

  it('glyph outlines are cached cubic paths', () => {
    const sans = testFontSet().get('sans');
    const id = sans.font.glyphForCodePoint(0x4f).id; // 'O'
    const o = sans.outline(id);
    expect(o).toBe(sans.outline(id));
    expect(o.some((c) => c.op === 'C')).toBe(true);
    expect(o.filter((c) => c.op === 'M')).toHaveLength(2); // outer + counter
  });
});

describe('layoutText', () => {
  const fs = testFontSet();

  it('lays out Latin text with kerning, anchors and baselines', () => {
    const l = layoutText(fs, 'AV', { size: 10 });
    const plain =
      (fs.get('sans').font.glyphForCodePoint(0x41).advanceWidth +
        fs.get('sans').font.glyphForCodePoint(0x56).advanceWidth) /
      100;
    expect(l.width).toBeLessThan(plain); // kerned
    expect(l.lines[0].x).toBe(0);
    expect(l.ascent).toBeCloseTo(10.69, 6);
    const mid = layoutText(fs, 'Hello', { size: 5, anchor: 'middle', baseline: 'top' });
    expect(mid.lines[0].x).toBeCloseTo(-mid.width / 2, 9);
    expect(mid.lines[0].y).toBeCloseTo(5 * 1.069, 9);
    const end = layoutText(fs, 'Hello', { size: 5, anchor: 'end', baseline: 'bottom' });
    expect(end.lines[0].x + end.lines[0].width).toBeCloseTo(0, 9);
    expect(end.lines[0].y).toBeCloseTo(-5 * 0.293, 9);
    // glyph outlines are y-down: capital H sits above the baseline (negative y)
    const b = pathBounds(layoutToPath(layoutText(fs, 'H', { size: 10 })))!;
    expect(b.minY).toBeCloseTo(-7.14, 1);
    expect(b.maxY).toBeCloseTo(0, 6);
  });

  it('supports multi-line text with line height 1.2', () => {
    const l = layoutText(fs, 'one\ntwo\nthree', { size: 4, anchor: 'end', baseline: 'middle' });
    expect(l.lines).toHaveLength(3);
    expect(l.lines[1].y - l.lines[0].y).toBeCloseTo(4.8, 9);
    for (const line of l.lines) expect(line.x + line.width).toBeCloseTo(0, 9);
    // middle: box centred on y = 0
    expect(l.bounds.minY + l.bounds.maxY).toBeCloseTo(0, 9);
    expect(l.width).toBe(Math.max(...l.lines.map((x) => x.width)));
    expect(splitLines('a\r\nb\rc' + String.fromCharCode(0x2028) + 'd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('shapes Arabic "منطقة الخطر 15 م" with joined forms in visual order', () => {
    const text = 'منطقة الخطر 15 م';
    const l = layoutText(fs, text, { size: 5 });
    expect(l.rtl).toBe(true);
    expect(l.runs.map((r) => r.text)).toEqual([' م', '15', 'منطقة الخطر ']);
    expect(l.runs.map((r) => r.fontKey)).toEqual(['arabic', 'sans', 'arabic']);
    // runs are laid out left → right without gaps
    for (let i = 1; i < l.runs.length; i++)
      expect(l.runs[i].x).toBeCloseTo(l.runs[i - 1].x + l.runs[i - 1].width, 9);

    const arabic = fs.get('arabic').font;
    const isolated = new Set([...'منطقةالخطر'].map((c) => arabic.glyphForCodePoint(c.codePointAt(0)!).id));
    const shaped = l.glyphs.filter((g) => g.fontKey === 'arabic' && g.cmds.length > 0);
    const joined = shaped.filter((g) => !isolated.has(g.glyphId));
    expect(joined.length).toBeGreaterThanOrEqual(6); // initial/medial/final forms

    // Digits stay LTR: '1' left of '5'.
    const sans = fs.get('sans').font;
    const one = l.glyphs.find((g) => g.fontKey === 'sans' && g.glyphId === sans.glyphForCodePoint(0x31).id)!;
    const five = l.glyphs.find((g) => g.fontKey === 'sans' && g.glyphId === sans.glyphForCodePoint(0x35).id)!;
    expect(one.x).toBeLessThan(five.x);
    // The isolated/final 'م' (last logical character) is the leftmost visible glyph.
    const visible = l.glyphs.filter((g) => g.cmds.length > 0).sort((a, b) => a.x - b.x);
    const meemIds = [
      arabic.glyphForCodePoint(0x645).id,
      ...shapeWithFontkit(arabic, ' م', 'arab', 'rtl').glyphs.map((g) => g.id),
    ];
    expect(meemIds).toContain(visible[0].glyphId);
    // The first logical word "منطقة" ends up at the right end.
    const firstWord = shapeWithFontkit(arabic, 'منطقة', 'arab', 'rtl').glyphs.map((g) => g.id);
    const rightmost = visible.slice(-3).map((g) => g.glyphId);
    expect(firstWord).toEqual(expect.arrayContaining(rightmost.filter((id) => firstWord.includes(id))));
    expect(firstWord).toContain(visible[visible.length - 1].glyphId);
  });

  it('falls back across fonts for mixed Latin/Arabic text and keeps bold', () => {
    const l = layoutText(fs, 'Tank T-101 خزان', { size: 3, bold: true });
    expect(l.rtl).toBe(false);
    expect(new Set(l.runs.map((r) => r.fontKey))).toEqual(new Set(['sansBold', 'arabicBold']));
    expect(l.runs[0].text.startsWith('Tank')).toBe(true);
    expect(lineDirection('Tank خزان')).toBe('ltr');
    expect(lineDirection('خزان Tank')).toBe('rtl');
  });

  it('reuses shaping results from the cache', () => {
    const a = layoutText(fs, 'cache me', { size: 2 });
    const b = layoutText(fs, 'cache me', { size: 4 });
    expect(b.width).toBeCloseTo(a.width * 2, 9);
  });
});

describe('placement helpers', () => {
  it('baselineOffset / anchorFraction / css families', () => {
    expect(baselineOffset('alphabetic', 10, 1)).toBe(0);
    expect(baselineOffset('top', 10, 2)).toBeCloseTo(10.69, 9);
    expect(baselineOffset('bottom', 10, 2)).toBeCloseTo(-(12 + 2.93), 9);
    expect(baselineOffset('hanging', 10, 1)).toBeCloseTo(7.14, 9);
    expect(anchorFraction('end')).toBe(1);
    expect(cssFontFamily('sans')).toContain('Noto Sans Arabic');
  });
});
