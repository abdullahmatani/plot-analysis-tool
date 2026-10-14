import type { Geometry, Vertex } from '@/core/types';

import { ET_NAME, FLAG, GK, readPoly, readRings, type EntityStore } from './entity-store';

/** Exact analysis geometry for an underlay entity, in drawing units (pick-trace row 50, inspector row 20). */
export function entityToGeometry(s: EntityStore, i: number): Geometry | null {
  const g = s.geom;
  const o = s.geomStart[i];
  switch (s.geomKind[i]) {
    case GK.LINE:
      return {
        type: 'polyline',
        pts: [
          { x: g[o], y: g[o + 1] },
          { x: g[o + 2], y: g[o + 3] },
        ],
        closed: false,
      };
    case GK.CIRCLE:
      return { type: 'circle', c: { x: g[o], y: g[o + 1] }, r: g[o + 2] };
    case GK.ARC:
      return { type: 'arc', c: { x: g[o], y: g[o + 1] }, r: g[o + 2], a0: g[o + 3], a1: g[o + 4] };
    case GK.ELLIPSE: {
      const cx = g[o];
      const cy = g[o + 1];
      const mx = g[o + 2];
      const my = g[o + 3];
      const ratio = g[o + 4];
      const t0 = g[o + 5];
      const t1 = g[o + 6];
      const rx = Math.hypot(mx, my);
      const full = Math.abs(t1 - t0 - Math.PI * 2) < 1e-9 || (t0 === 0 && Math.abs(t1 - Math.PI * 2) < 1e-9);
      if (full) return { type: 'ellipse', c: { x: cx, y: cy }, rx, ry: rx * ratio, rot: Math.atan2(my, mx) };
      let sweep = t1 - t0;
      if (sweep <= 0) sweep += Math.PI * 2;
      const n = Math.max(16, Math.ceil((sweep / (Math.PI * 2)) * 128));
      const pts: Vertex[] = [];
      for (let k = 0; k <= n; k++) {
        const t = t0 + (sweep * k) / n;
        pts.push({
          x: cx + mx * Math.cos(t) - my * ratio * Math.sin(t),
          y: cy + my * Math.cos(t) + mx * ratio * Math.sin(t),
        });
      }
      return { type: 'polyline', pts, closed: false };
    }
    case GK.POLY: {
      const pts = readPoly(s, i).map((v) =>
        v.bulge ? { x: v.x, y: v.y, bulge: v.bulge } : { x: v.x, y: v.y },
      );
      return { type: 'polyline', pts, closed: (s.flags[i] & FLAG.CLOSED) !== 0 };
    }
    case GK.POINT:
    case GK.TEXT:
      return { type: 'point', p: { x: g[o], y: g[o + 1] } };
    case GK.FILL: {
      const rings = readRings(s, i).map((r) =>
        r.map((v) => (v.bulge ? { x: v.x, y: v.y, bulge: v.bulge } : { x: v.x, y: v.y })),
      );
      if (rings.length === 1) return { type: 'polyline', pts: rings[0], closed: true };
      return { type: 'multipolygon', rings };
    }
  }
  return null;
}

export function entityTypeName(s: EntityStore, i: number): string {
  return ET_NAME[s.type[i]] ?? 'ENTITY';
}

export function entityText(s: EntityStore, i: number): string | null {
  const t = s.textIndex[i];
  return t >= 0 ? s.texts[t] : null;
}
