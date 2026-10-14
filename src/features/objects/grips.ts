import type { Geometry, Pt } from '@/core/types';
import { translateGeometry } from '@/geometry/convert';

/** Grip editing (row 43): vertex, centre, radius and corner handles. */

export interface Grip {
  kind: 'vertex' | 'centre' | 'radius' | 'corner' | 'start' | 'end' | 'rx' | 'ry' | 'point' | 'insert';
  pt: Pt;
  index?: number;
  ring?: number;
}

/**
 * Extra grips contributed by feature modules, e.g. segment midpoint "+" grips that insert a vertex
 * (row 53). `apply` returns null for grips it does not own.
 */
export interface GripExtension {
  grips(g: Geometry): Grip[];
  apply(g: Geometry, grip: Grip, to: Pt): Geometry | null;
}

export const gripExtensions: GripExtension[] = [];

const rot = (p: Pt, a: number): Pt => ({
  x: p.x * Math.cos(a) - p.y * Math.sin(a),
  y: p.x * Math.sin(a) + p.y * Math.cos(a),
});

export function gripsOf(g: Geometry): Grip[] {
  const base = baseGrips(g);
  return gripExtensions.length ? [...base, ...gripExtensions.flatMap((e) => e.grips(g))] : base;
}

function baseGrips(g: Geometry): Grip[] {
  switch (g.type) {
    case 'point':
      return [{ kind: 'point', pt: g.p }];
    case 'circle':
      return [
        { kind: 'centre', pt: g.c },
        ...[0, 1, 2, 3].map((k) => ({
          kind: 'radius' as const,
          index: k,
          pt: { x: g.c.x + g.r * Math.cos((k * Math.PI) / 2), y: g.c.y + g.r * Math.sin((k * Math.PI) / 2) },
        })),
      ];
    case 'arc': {
      const mid = g.a0 + ((g.a1 - g.a0 + Math.PI * 4) % (Math.PI * 2)) / 2;
      return [
        { kind: 'centre', pt: g.c },
        { kind: 'start', pt: { x: g.c.x + g.r * Math.cos(g.a0), y: g.c.y + g.r * Math.sin(g.a0) } },
        { kind: 'end', pt: { x: g.c.x + g.r * Math.cos(g.a1), y: g.c.y + g.r * Math.sin(g.a1) } },
        { kind: 'radius', pt: { x: g.c.x + g.r * Math.cos(mid), y: g.c.y + g.r * Math.sin(mid) } },
      ];
    }
    case 'rect': {
      const hw = g.w / 2;
      const hh = g.h / 2;
      const corners = [
        [-hw, -hh],
        [hw, -hh],
        [hw, hh],
        [-hw, hh],
      ].map(([x, y], k) => {
        const r = rot({ x, y }, g.rot);
        return { kind: 'corner' as const, index: k, pt: { x: g.c.x + r.x, y: g.c.y + r.y } };
      });
      return [{ kind: 'centre', pt: g.c }, ...corners];
    }
    case 'ellipse': {
      const a = rot({ x: g.rx, y: 0 }, g.rot);
      const b = rot({ x: 0, y: g.ry }, g.rot);
      return [
        { kind: 'centre', pt: g.c },
        { kind: 'rx', pt: { x: g.c.x + a.x, y: g.c.y + a.y } },
        { kind: 'ry', pt: { x: g.c.x + b.x, y: g.c.y + b.y } },
      ];
    }
    case 'polyline':
      return g.pts.map((p, i) => ({ kind: 'vertex' as const, index: i, pt: { x: p.x, y: p.y } }));
    case 'multipolygon':
      return g.rings.flatMap((ring, r) =>
        ring.map((p, i) => ({ kind: 'vertex' as const, ring: r, index: i, pt: { x: p.x, y: p.y } })),
      );
  }
}

export function applyGrip(g: Geometry, grip: Grip, to: Pt): Geometry {
  for (const e of gripExtensions) {
    const r = e.apply(g, grip, to);
    if (r) return r;
  }
  switch (g.type) {
    case 'point':
      return { ...g, p: { ...to } };
    case 'circle':
      if (grip.kind === 'centre') return { ...g, c: { ...to } };
      return { ...g, r: Math.max(1e-6, Math.hypot(to.x - g.c.x, to.y - g.c.y)) };
    case 'arc': {
      if (grip.kind === 'centre') return translateGeometry(g, to.x - g.c.x, to.y - g.c.y);
      const a = Math.atan2(to.y - g.c.y, to.x - g.c.x);
      if (grip.kind === 'start') return { ...g, a0: a };
      if (grip.kind === 'end') return { ...g, a1: a };
      return { ...g, r: Math.max(1e-6, Math.hypot(to.x - g.c.x, to.y - g.c.y)) };
    }
    case 'rect': {
      if (grip.kind === 'centre') return { ...g, c: { ...to } };
      const k = grip.index ?? 0;
      const signs = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ];
      const opp = { x: -signs[k][0] * (g.w / 2), y: -signs[k][1] * (g.h / 2) };
      const q = rot({ x: to.x - g.c.x, y: to.y - g.c.y }, -g.rot);
      const cl = { x: (q.x + opp.x) / 2, y: (q.y + opp.y) / 2 };
      const cw = rot(cl, g.rot);
      return {
        ...g,
        c: { x: g.c.x + cw.x, y: g.c.y + cw.y },
        w: Math.max(1e-6, Math.abs(q.x - opp.x)),
        h: Math.max(1e-6, Math.abs(q.y - opp.y)),
      };
    }
    case 'ellipse': {
      if (grip.kind === 'centre') return { ...g, c: { ...to } };
      const q = rot({ x: to.x - g.c.x, y: to.y - g.c.y }, -g.rot);
      if (grip.kind === 'rx') return { ...g, rx: Math.max(1e-6, Math.abs(q.x)) };
      return { ...g, ry: Math.max(1e-6, Math.abs(q.y)) };
    }
    case 'polyline': {
      const pts = g.pts.map((p, i) => (i === grip.index ? { ...p, x: to.x, y: to.y } : p));
      return { ...g, pts };
    }
    case 'multipolygon': {
      const rings = g.rings.map((ring, r) =>
        r === grip.ring ? ring.map((p, i) => (i === grip.index ? { ...p, x: to.x, y: to.y } : p)) : ring,
      );
      return { ...g, rings };
    }
  }
}
