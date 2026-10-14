import { describe, expect, it } from 'vitest';

import { createProject } from '@/core/project';
import type { AnalysisObject, Project } from '@/core/types';
import { makeObject } from '@/features/objects/ops';
import { resolveStyle } from '@/features/objects/style';

import './annotations';
import { objectItems, type ObjectSceneContext } from './objects';

/** Rows 35, 41, 48: annotation kinds are exported with their text, not as bare shapes. */

function ctxFor(p: Project): ObjectSceneContext {
  // 1:1000 — 1 m = 1 mm on paper; y flipped.
  return { project: p, paperFromWorld: [1, 0, 0, -1, 100, 100], mmPerMetre: 1 };
}

function texts(p: Project, o: AnalysisObject): string[] {
  const items = objectItems(o, resolveStyle(p, o), ctxFor(p));
  return [...items.shapes, ...items.labels].flatMap((i) => (i.kind === 'text' ? [i.text] : []));
}

describe('annotation export', () => {
  const p = createProject('P');
  p.layers[0].tagPrefix = 'T-';

  it('exports free text (incl. Arabic) and callout text', () => {
    const t = makeObject(p, {
      kind: 'text',
      geometry: { type: 'point', p: { x: 0, y: 0 } },
      text: 'خزان الوقود\nTank',
    });
    expect(texts(p, t)).toEqual(['خزان الوقود\nTank']);
    const c = makeObject(p, {
      kind: 'callout',
      geometry: {
        type: 'polyline',
        pts: [
          { x: 0, y: 0 },
          { x: 10, y: 5 },
        ],
        closed: false,
      },
      text: 'Pump P-101',
    });
    const items = objectItems(c, resolveStyle(p, c), ctxFor(p));
    expect(items.labels.some((i) => i.kind === 'text' && i.text === 'Pump P-101')).toBe(true);
    expect(items.labels.filter((i) => i.kind === 'path').length).toBeGreaterThanOrEqual(3); // leader, arrow, box
  });

  it('exports bubble tags with the layer prefix', () => {
    const g = makeObject(p, { kind: 'tag', geometry: { type: 'point', p: { x: 5, y: 5 } }, tagNumber: 3 });
    expect(texts(p, g)).toEqual(['T-3']);
  });

  it('exports measurement annotations with their value in display units', () => {
    const m = makeObject(p, {
      kind: 'measurement',
      geometry: {
        type: 'polyline',
        pts: [
          { x: 0, y: 0 },
          { x: 30, y: 40 },
        ],
        closed: false,
      },
      measurement: { mode: 'distance' },
    });
    const [label] = texts(p, m);
    expect(label).toMatch(/50[.,]00/);
  });
});
