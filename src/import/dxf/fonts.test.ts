import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GK } from '@/underlay/entity-store';

import { parseDxf } from './index';

/** Row 24: text entities reference their style's font so a substitute can be chosen. */
describe('DXF text style fonts', () => {
  it('records the font file of each text entity from the STYLE table', () => {
    const file = path.resolve(__dirname, '../../../tests/fixtures/dxf/r2018_plotplan.dxf');
    const r = parseDxf(new Uint8Array(readFileSync(file)));
    const s = r.store;
    const fonts = new Set<string>();
    let texts = 0;
    for (let i = 0; i < s.count; i++) {
      if (s.geomKind[i] !== GK.TEXT) continue;
      texts++;
      expect(s.geomLen[i]).toBe(11);
      const fi = s.geom[s.geomStart[i] + 10];
      if (fi >= 0) fonts.add(s.fonts![fi]);
    }
    expect(texts).toBeGreaterThan(0);
    expect(fonts.size).toBeGreaterThan(0);
  });
});
