import { describe, expect, it } from 'vitest';

import { DWG_ERR, describeReaderErrors, joinList } from './errors';
import { flattenRings, generatePatternSegments } from './hatch';
import { dwgTimeLimitMs, MAX_DWG_BYTES } from './limits';
import { interpolateFitPoints, tessellateNurbs } from '../spline';
import { decodeTextCodes, mtextToPlain } from './text';
import { dwgVersionInfo, readDwgVersionCode } from './version';
import { ocsXform } from './xform';

const bytesOf = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

describe('DWG version detection', () => {
  it('reads the format code from the first six bytes', () => {
    expect(readDwgVersionCode(bytesOf('AC1032\0\0\0'))).toBe('AC1032');
    expect(readDwgVersionCode(bytesOf('AC1009xyz'))).toBe('AC1009');
    expect(readDwgVersionCode(bytesOf('AC402a'))).toBe('AC402a');
    expect(readDwgVersionCode(bytesOf('AC2.10'))).toBe('AC2.10');
    expect(readDwgVersionCode(bytesOf('AC103-4'))).toBe('AC103-');
    expect(readDwgVersionCode(bytesOf('%PDF-1.7'))).toBeNull();
    expect(readDwgVersionCode(bytesOf('AC10'))).toBeNull();
  });

  it('classifies supported, legacy, newer and unknown formats', () => {
    expect(dwgVersionInfo('AC1032')).toMatchObject({
      label: 'AutoCAD 2018',
      status: 'ok',
      preR13: false,
      preR2000: false,
    });
    expect(dwgVersionInfo('AC1015')).toMatchObject({ status: 'ok', preR2000: false });
    expect(dwgVersionInfo('AC1014')).toMatchObject({ label: 'AutoCAD R14', status: 'ok', preR2000: true });
    expect(dwgVersionInfo('AC1009')).toMatchObject({ status: 'legacy', preR13: true });
    expect(dwgVersionInfo('AC1500')).toMatchObject({ status: 'legacy', preR2000: true });
    expect(dwgVersionInfo('AC1033').status).toBe('newer');
    expect(dwgVersionInfo('AC103-').status).toBe('newer');
    expect(dwgVersionInfo('AC9999').status).toBe('unknown');
  });
});

describe('text decoding', () => {
  it('decodes %% codes and escapes', () => {
    expect(decodeTextCodes('%%c10 %%d %%p0.5 %%%%%u under%%u %%176')).toBe('Ø10 ° ±0.5 % under °');
    expect(decodeTextCodes('\\U+00E9t\\U+00E9')).toBe('été');
    expect(decodeTextCodes('\\M+18140')).toBe('\u3000'); // Shift-JIS 0x8140: ideographic space
  });

  it('strips MTEXT formatting', () => {
    expect(mtextToPlain('\\A1;{\\H2.5x;\\C1;Red}\\Ptwo\\Nthree')).toBe('Red\ntwo\nthree');
    expect(mtextToPlain('\\pxqc;Centred \\Lunder\\l \\S3#4; \\{x\\}')).toBe('Centred under 3/4 {x}');
    expect(mtextToPlain('a^Ib^Jc')).toBe('a\tb\nc');
  });
});

describe('errors and limits', () => {
  it('describes LibreDWG error bits', () => {
    expect(describeReaderErrors(DWG_ERR.UNHANDLEDCLASS | DWG_ERR.VALUEOUTOFBOUNDS)).toEqual([
      'custom or proxy object classes the DWG reader cannot interpret',
      'values outside the valid range',
    ]);
    expect(describeReaderErrors(0)).toEqual([]);
    expect(joinList(['a', 'b', 'c'])).toBe('a, b and c');
  });

  it('scales the time limit with the file size', () => {
    expect(dwgTimeLimitMs(0)).toBe(60_000);
    expect(dwgTimeLimitMs(10 * 1024 * 1024)).toBe(210_000);
    expect(dwgTimeLimitMs(MAX_DWG_BYTES)).toBe(600_000);
  });
});

describe('geometry helpers', () => {
  it('maps OCS (0, 0, −1) to a mirror about the Y axis and ignores degenerate normals', () => {
    const x = ocsXform({ x: 0, y: 0, z: -1 })!;
    expect([x.x(1, 2, 3), x.y(1, 2, 3), x.z(1, 2, 3)]).toEqual([-1, 2, -3]);
    expect(ocsXform({ x: 0, y: 0, z: 1 })).toBeNull();
    expect(ocsXform({ x: 0, y: 0, z: 0 })).toBeNull();
  });

  it('evaluates rational splines (quarter circle) and falls back to uniform knots', () => {
    const w = Math.SQRT1_2;
    const pts = tessellateNurbs(2, [0, 0, 0, 1, 1, 1], [1, 0, 0, 1, 1, 0, 0, 1, 0], [1, w, 1]);
    for (let i = 0; i < pts.length; i += 3) expect(Math.hypot(pts[i], pts[i + 1])).toBeCloseTo(1, 12);
    const warnings: string[] = [];
    const fallback = tessellateNurbs(3, [0, 1], [0, 0, 0, 1, 1, 0, 2, 0, 0, 3, 1, 0], null, (m) =>
      warnings.push(m),
    );
    expect(fallback.slice(0, 3)).toEqual([0, 0, 0]);
    expect(warnings).toHaveLength(1);
  });

  it('interpolates fit points with end tangents', () => {
    const pts = interpolateFitPoints([0, 0, 0, 1, 0, 0, 2, 0, 0], [1, 0, 0], [1, 0, 0], false);
    for (let i = 0; i < pts.length; i += 3) expect(Math.abs(pts[i + 1])).toBeLessThan(1e-12);
  });

  it('clips pattern lines to a disc boundary', () => {
    const polys = flattenRings([[-1, 0, 1, 1, 0, 1]], 1e-4);
    const { segs, capped, tooDense } = generatePatternSegments(polys, [
      { angle: Math.PI / 2, bx: 0, by: 0, ox: -0.25, oy: 0, dashes: [] },
    ]);
    expect(capped || tooDense).toBe(false);
    expect(segs.length / 4).toBe(7); // x = −0.75 … 0.75; the tangent lines x = ±1 give no segment
    for (let i = 0; i < segs.length; i += 4) {
      expect(Math.hypot(segs[i], segs[i + 1])).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.hypot(segs[i + 2], segs[i + 3])).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});
