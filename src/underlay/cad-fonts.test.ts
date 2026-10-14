import { describe, expect, it } from 'vitest';

import { substituteFont } from './cad-fonts';

describe('CAD font substitution (row 24)', () => {
  it('maps SHX and TrueType names to bundled fonts with width compensation', () => {
    expect(substituteFont('txt.shx')).toMatchObject({ kind: 'sans', widthScale: 0.85 });
    expect(substituteFont('ROMANS.SHX')).toMatchObject({ kind: 'sans', widthScale: 0.9 });
    expect(substituteFont('C:\\Fonts\\isocpeur.ttf')).toMatchObject({ kind: 'sans', widthScale: 0.9 });
    expect(substituteFont('arial.ttf')).toMatchObject({ kind: 'sans', widthScale: 1 });
    expect(substituteFont('monotxt.shx').kind).toBe('mono');
    expect(substituteFont('gdt.shx').kind).toBe('symbol');
    expect(substituteFont('Traditional Arabic').rule.note).toMatch(/Arabic/);
  });

  it('falls back to the bundled sans font for unknown or missing fonts', () => {
    expect(substituteFont('mystery-font.shx')).toMatchObject({ kind: 'sans', widthScale: 0.92 });
    expect(substituteFont(undefined).font).toBe('(default)');
    expect(substituteFont('anything').css).toContain('PAT CAD Sans');
  });
});
