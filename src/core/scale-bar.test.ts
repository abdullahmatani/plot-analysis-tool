import { describe, expect, it } from 'vitest';

import { niceScaleBar, scaleBarLabel } from './scale-bar';

describe('niceScaleBar', () => {
  it('picks the largest nice length not above the maximum', () => {
    expect(niceScaleBar(120).length).toBe(100);
    expect(niceScaleBar(260).length).toBe(250);
    expect(niceScaleBar(499).length).toBe(250);
    expect(niceScaleBar(500).length).toBe(500);
    expect(niceScaleBar(0.37).length).toBeCloseTo(0.25, 12);
    expect(niceScaleBar(9999).length).toBe(5000);
  });
  it('labels lengths with sensible units', () => {
    expect(scaleBarLabel(250)).toBe('250 m');
    expect(scaleBarLabel(2500)).toBe('2.5 km');
    expect(scaleBarLabel(0.05)).toBe('5 cm');
    expect(scaleBarLabel(0.002)).toBe('2 mm');
  });
});
