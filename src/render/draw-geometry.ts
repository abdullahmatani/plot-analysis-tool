import type { Geometry, Pt, Vertex } from '@/core/types';
import { bulgeToArc } from '@/geometry/bulge';

/**
 * Adds a geometry's outline to the current Canvas 2D path in screen space. Curves are tessellated
 * in screen space (≤ 0.25 px deviation), so arbitrary view rotations, mirrored placements and
 * non-uniform calibrations render correctly.
 */

export type ToScreen = (p: Pt) => Pt;

function steps(rPx: number, sweep: number): number {
  if (rPx <= 0.5) return 4;
  const step = 2 * Math.acos(Math.max(-1, 1 - 0.25 / rPx));
  return Math.max(4, Math.min(2048, Math.ceil(Math.abs(sweep) / step)));
}

function arcPoints(
  c: Pt,
  r: number,
  a0: number,
  sweep: number,
  scale: number,
  xf: ToScreen,
  ctx: CanvasRenderingContext2D,
  move: boolean,
) {
  const n = steps(r * scale, sweep);
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    const s = xf({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
    if (i === 0 && move) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  }
}

export function tracePolyline(
  ctx: CanvasRenderingContext2D,
  pts: Vertex[],
  closed: boolean,
  xf: ToScreen,
  scale: number,
) {
  if (!pts.length) return;
  const s0 = xf(pts[0]);
  ctx.moveTo(s0.x, s0.y);
  const n = pts.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const arc = a.bulge ? bulgeToArc(a, b, a.bulge) : null;
    if (arc) arcPoints(arc.c, arc.r, arc.a0, arc.sweep, scale, xf, ctx, false);
    else {
      const s = xf(b);
      ctx.lineTo(s.x, s.y);
    }
  }
  if (closed) ctx.closePath();
}

/** `scale` = screen px per world unit (for curve tessellation). */
export function traceGeometry(ctx: CanvasRenderingContext2D, g: Geometry, xf: ToScreen, scale: number) {
  switch (g.type) {
    case 'circle':
      arcPoints(g.c, g.r, 0, Math.PI * 2, scale, xf, ctx, true);
      ctx.closePath();
      break;
    case 'arc': {
      let sweep = g.a1 - g.a0;
      if (sweep <= 0) sweep += Math.PI * 2;
      arcPoints(g.c, g.r, g.a0, sweep, scale, xf, ctx, true);
      break;
    }
    case 'rect': {
      const c = Math.cos(g.rot);
      const s = Math.sin(g.rot);
      const hw = g.w / 2;
      const hh = g.h / 2;
      const corners = [
        [-hw, -hh],
        [hw, -hh],
        [hw, hh],
        [-hw, hh],
      ].map(([x, y]) => xf({ x: g.c.x + x * c - y * s, y: g.c.y + x * s + y * c }));
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      break;
    }
    case 'ellipse': {
      const n = steps(Math.max(g.rx, g.ry) * scale, Math.PI * 2);
      const c = Math.cos(g.rot);
      const s = Math.sin(g.rot);
      for (let i = 0; i <= n; i++) {
        const t = (Math.PI * 2 * i) / n;
        const x = g.rx * Math.cos(t);
        const y = g.ry * Math.sin(t);
        const p = xf({ x: g.c.x + x * c - y * s, y: g.c.y + x * s + y * c });
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      break;
    }
    case 'polyline':
      tracePolyline(ctx, g.pts, g.closed, xf, scale);
      break;
    case 'multipolygon':
      for (const ring of g.rings) tracePolyline(ctx, ring, true, xf, scale);
      break;
    case 'point': {
      const p = xf(g.p);
      ctx.moveTo(p.x - 4, p.y);
      ctx.lineTo(p.x + 4, p.y);
      ctx.moveTo(p.x, p.y - 4);
      ctx.lineTo(p.x, p.y + 4);
      break;
    }
  }
}

export function isClosedGeometry(g: Geometry): boolean {
  return (
    g.type === 'circle' ||
    g.type === 'rect' ||
    g.type === 'ellipse' ||
    g.type === 'multipolygon' ||
    (g.type === 'polyline' && g.closed)
  );
}
