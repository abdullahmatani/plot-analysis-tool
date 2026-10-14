import type { DwgBoundaryPath, DwgHatchEntity } from '@mlightcad/libredwg-web';

import { arcSegments } from '@/geometry/bulge';
import { TAU } from '@/geometry/vec';

import { tessellateNurbs, interpolateFitPoints } from './spline';

/**
 * HATCH support: boundary paths → rings of (x, y, bulge) in the hatch's OCS, and pattern-line
 * generation (scanline clipping with the even-odd rule) for pattern fills.
 */

/** Flat (x, y, bulge) triples. */
export type Ring = number[];

export interface PatternLine {
  /** Radians. */
  angle: number;
  bx: number;
  by: number;
  ox: number;
  oy: number;
  /** Dash lengths: positive = dash, negative = gap, 0 = dot. Empty = continuous. */
  dashes: number[];
}

export interface HatchGeometry {
  solid: boolean;
  patternName: string;
  rings: Ring[];
  lines: PatternLine[];
}

/** Maximum generated pattern segments per hatch. */
export const MAX_PATTERN_SEGMENTS = 20000;
/** Pattern families with more lines than this across the boundary are not generated. */
const MAX_LINES_PER_FAMILY = 200000;

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Arc as ring vertices (start point + bulge), split into pieces of at most 180°. */
function pushArc(ring: Ring, cx: number, cy: number, r: number, a0: number, sweep: number) {
  const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / Math.PI - 1e-9));
  const step = sweep / pieces;
  const b = Math.tan(step / 4);
  for (let k = 0; k < pieces; k++) {
    const a = a0 + step * k;
    ring.push(cx + r * Math.cos(a), cy + r * Math.sin(a), b);
  }
}

/** Elliptical arc as straight ring vertices (end point excluded). */
function pushEllipse(
  ring: Ring,
  cx: number,
  cy: number,
  mx: number,
  my: number,
  ratio: number,
  t0: number,
  sweep: number,
) {
  const major = Math.hypot(mx, my);
  const n = Math.min(1024, Math.max(4, arcSegments(major, sweep, Math.max(major * 1e-3, 1e-9))));
  const nx = -my * ratio;
  const ny = mx * ratio;
  for (let k = 0; k < n; k++) {
    const t = t0 + (sweep * k) / n;
    ring.push(cx + mx * Math.cos(t) + nx * Math.sin(t), cy + my * Math.cos(t) + ny * Math.sin(t), 0);
  }
}

/** Sweep from a0 to a1 (radians) in the given direction; full turn when |a1 − a0| ≥ 2π. */
function sweepOf(a0: number, a1: number, ccw: boolean): number {
  if (Math.abs(a1 - a0) >= TAU - 1e-9) return ccw ? TAU : -TAU;
  let s = a1 - a0;
  if (ccw) {
    while (s <= 0) s += TAU;
  } else {
    while (s >= 0) s -= TAU;
  }
  return s;
}

function pathRing(path: DwgBoundaryPath, warn: (m: string) => void): Ring | null {
  const ring: Ring = [];
  if ('vertices' in path && Array.isArray(path.vertices)) {
    for (const v of path.vertices)
      ring.push(num(v.x, NaN), num(v.y, NaN), path.hasBulge === false ? 0 : num(v.bulge));
    // A repeated closing vertex adds nothing.
    const n = ring.length / 3;
    if (n > 1 && ring[0] === ring[(n - 1) * 3] && ring[1] === ring[(n - 1) * 3 + 1]) ring.length -= 3;
    return ring.length >= 6 ? ring : null;
  }
  if (!('edges' in path) || !Array.isArray(path.edges)) return null;
  for (const edge of path.edges) {
    switch (edge.type) {
      case 1: {
        const e = edge as { start?: { x: number; y: number } };
        ring.push(num(e.start?.x, NaN), num(e.start?.y, NaN), 0);
        break;
      }
      case 2: {
        const e = edge as {
          center?: { x: number; y: number };
          radius?: number;
          startAngle?: number;
          endAngle?: number;
          isCCW?: boolean;
        };
        const ccw = e.isCCW !== false;
        let s = num(e.startAngle);
        let en = num(e.endAngle);
        // Clockwise edges store mirrored angles (2π − angle).
        if (!ccw) {
          s = TAU - s;
          en = TAU - en;
        }
        const r = num(e.radius);
        if (!(r > 0)) break;
        pushArc(ring, num(e.center?.x, NaN), num(e.center?.y, NaN), r, s, sweepOf(s, en, ccw));
        break;
      }
      case 3: {
        const e = edge as {
          center?: { x: number; y: number };
          end?: { x: number; y: number };
          lengthOfMinorAxis?: number;
          startAngle?: number;
          endAngle?: number;
          isCCW?: boolean;
        };
        const ccw = e.isCCW !== false;
        let s = num(e.startAngle);
        let en = num(e.endAngle);
        if (!ccw) {
          s = TAU - s;
          en = TAU - en;
        }
        const ratio = num(e.lengthOfMinorAxis, 1) || 1;
        const full = Math.abs(en - s) >= TAU - 1e-9;
        const ps = Math.atan2(Math.sin(s) / ratio, Math.cos(s));
        const pe = Math.atan2(Math.sin(en) / ratio, Math.cos(en));
        const sweep = full ? (ccw ? TAU : -TAU) : sweepOf(ps, pe, ccw);
        pushEllipse(
          ring,
          num(e.center?.x, NaN),
          num(e.center?.y, NaN),
          num(e.end?.x),
          num(e.end?.y),
          ratio,
          ps,
          sweep,
        );
        break;
      }
      case 4: {
        const e = edge as {
          degree?: number;
          knots?: number[];
          controlPoints?: { x: number; y: number; weight?: number; w?: number }[];
          fitDatum?: { x: number; y: number }[];
          startTangent?: { x: number; y: number };
          endTangent?: { x: number; y: number };
          isRational?: boolean;
        };
        const cps = e.controlPoints ?? [];
        let pts: number[];
        if (cps.length >= 2) {
          const ctrl: number[] = [];
          const w: number[] = [];
          for (const c of cps) {
            ctrl.push(num(c.x, NaN), num(c.y, NaN), 0);
            w.push(num(c.weight ?? c.w, 1));
          }
          pts = tessellateNurbs(num(e.degree, 3), e.knots ?? [], ctrl, e.isRational ? w : null, warn);
        } else {
          const fit: number[] = [];
          for (const f of e.fitDatum ?? []) fit.push(num(f.x, NaN), num(f.y, NaN), 0);
          const tan = (t?: { x: number; y: number }): [number, number, number] | null =>
            t && (t.x || t.y) ? [num(t.x), num(t.y), 0] : null;
          pts = interpolateFitPoints(fit, tan(e.startTangent), tan(e.endTangent), false);
        }
        for (let i = 0; i + 3 < pts.length; i += 3) ring.push(pts[i], pts[i + 1], 0);
        break;
      }
      default:
        break;
    }
  }
  return ring.length >= 6 ? ring : null;
}

/** Boundary rings and pattern definition of a HATCH. */
export function hatchGeometry(h: DwgHatchEntity, warn: (m: string) => void): HatchGeometry {
  const paths = Array.isArray(h.boundaryPaths) ? h.boundaryPaths : [];
  let use = paths;
  // Style 2 ("ignore"): only the outermost boundary is filled.
  if (h.hatchStyle === 2) {
    const outer = paths.filter((p) => num(p.boundaryPathTypeFlag) & 17);
    if (outer.length) use = outer.slice(0, 1);
  }
  const rings: Ring[] = [];
  for (const p of use) {
    const r = pathRing(p, warn);
    if (r) rings.push(r);
  }
  const gradient = (h as { gradientFlag?: number }).gradientFlag === 1;
  const name = String(h.patternName ?? '');
  const solid = gradient || h.solidFill === 1 || name.toUpperCase() === 'SOLID';
  const lines: PatternLine[] = [];
  if (!solid) {
    for (const d of h.definitionLines ?? []) {
      lines.push({
        angle: num(d.angle),
        bx: num(d.base?.x),
        by: num(d.base?.y),
        ox: num(d.offset?.x),
        oy: num(d.offset?.y),
        dashes: (d.dashLengths ?? []).filter((v) => Number.isFinite(v)),
      });
    }
  }
  return { solid, patternName: name, rings, lines };
}

/** Flattens bulged rings to straight polygons (flat x, y). */
export function flattenRings(rings: Ring[], tol: number): number[][] {
  const out: number[][] = [];
  for (const ring of rings) {
    const n = ring.length / 3;
    const poly: number[] = [];
    for (let i = 0; i < n; i++) {
      const x0 = ring[i * 3];
      const y0 = ring[i * 3 + 1];
      const b = ring[i * 3 + 2];
      poly.push(x0, y0);
      if (!b) continue;
      const j = (i + 1) % n;
      const x1 = ring[j * 3];
      const y1 = ring[j * 3 + 1];
      const chord = Math.hypot(x1 - x0, y1 - y0);
      if (chord === 0) continue;
      const theta = 4 * Math.atan(b);
      const r = chord / (2 * Math.abs(Math.sin(theta / 2)));
      const h = (chord / 2) * ((1 - b * b) / (2 * b));
      const ux = (x1 - x0) / chord;
      const uy = (y1 - y0) / chord;
      const cx = (x0 + x1) / 2 - uy * h;
      const cy = (y0 + y1) / 2 + ux * h;
      const a0 = Math.atan2(y0 - cy, x0 - cx);
      const k = Math.min(256, arcSegments(r, theta, tol));
      for (let q = 1; q < k; q++) {
        const a = a0 + (theta * q) / k;
        poly.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
    }
    if (poly.length >= 6) out.push(poly);
  }
  return out;
}

export interface PatternSegments {
  /** Flat x1, y1, x2, y2 in the hatch's OCS. */
  segs: Float64Array;
  /** The segment limit was reached; the pattern is incomplete. */
  capped: boolean;
  /** A pattern family was skipped because its line spacing is implausibly small for the area. */
  tooDense: boolean;
}

/**
 * Clips each pattern family to the polygons (even-odd). Line k of a family passes through
 * base + k·offset and its dash sequence starts there.
 */
export function generatePatternSegments(
  polys: number[][],
  lines: PatternLine[],
  maxSegs = MAX_PATTERN_SEGMENTS,
): PatternSegments {
  const out: number[] = [];
  let capped = false;
  let tooDense = false;
  const ax: number[] = [];
  const ay: number[] = [];
  const bx: number[] = [];
  const by: number[] = [];
  for (const p of polys) {
    const n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (p[i * 2] === p[j * 2] && p[i * 2 + 1] === p[j * 2 + 1]) continue;
      ax.push(p[i * 2]);
      ay.push(p[i * 2 + 1]);
      bx.push(p[j * 2]);
      by.push(p[j * 2 + 1]);
    }
  }
  const ne = ax.length;
  if (ne < 3) return { segs: new Float64Array(0), capped, tooDense };
  let work = 0;
  const maxWork = maxSegs * 16;
  const emit = (x0: number, y0: number, x1: number, y1: number): boolean => {
    out.push(x0, y0, x1, y1);
    return out.length < maxSegs * 4;
  };

  families: for (const L of lines) {
    const dx = Math.cos(L.angle);
    const dy = Math.sin(L.angle);
    const nx = -dy;
    const ny = dx;
    const spacing = L.ox * nx + L.oy * ny;
    if (!(Math.abs(spacing) > 1e-12)) continue;
    const lo = new Float64Array(ne);
    const hi = new Float64Array(ne);
    const pa = new Float64Array(ne);
    const pb = new Float64Array(ne);
    let nMin = Infinity;
    let nMax = -Infinity;
    for (let e = 0; e < ne; e++) {
      pa[e] = (ax[e] - L.bx) * nx + (ay[e] - L.by) * ny;
      pb[e] = (bx[e] - L.bx) * nx + (by[e] - L.by) * ny;
      lo[e] = Math.min(pa[e], pb[e]);
      hi[e] = Math.max(pa[e], pb[e]);
      nMin = Math.min(nMin, lo[e]);
      nMax = Math.max(nMax, hi[e]);
    }
    const k0 = Math.ceil(Math.min(nMin / spacing, nMax / spacing));
    const k1 = Math.floor(Math.max(nMin / spacing, nMax / spacing));
    if (k1 - k0 > MAX_LINES_PER_FAMILY) {
      tooDense = true;
      continue;
    }
    // Sweep lines in ascending normal coordinate with an active edge list.
    const order = Array.from({ length: ne }, (_, i) => i).sort((a, b) => lo[a] - lo[b]);
    let active: number[] = [];
    let next = 0;
    const ts: number[] = [];
    const period = L.dashes.reduce((s, d) => s + Math.abs(d), 0);
    const count = k1 - k0 + 1;
    for (let q = 0; q < count; q++) {
      const k = spacing > 0 ? k0 + q : k1 - q;
      const c = k * spacing;
      while (next < ne && lo[order[next]] <= c) active.push(order[next++]);
      active = active.filter((e) => hi[e] >= c);
      ts.length = 0;
      const ox = k * L.ox;
      const oy = k * L.oy;
      for (const e of active) {
        const a = pa[e] - c;
        const b = pb[e] - c;
        if (a > 0 === b > 0) continue; // half-open: a vertex on the line counts once
        const f = a / (a - b);
        const px = ax[e] - L.bx + (bx[e] - ax[e]) * f;
        const py = ay[e] - L.by + (by[e] - ay[e]) * f;
        ts.push((px - ox) * dx + (py - oy) * dy);
      }
      if (ts.length < 2) continue;
      ts.sort((a, b) => a - b);
      const x0 = L.bx + ox;
      const y0 = L.by + oy;
      for (let i = 0; i + 1 < ts.length; i += 2) {
        const ta = ts[i];
        const tb = ts[i + 1];
        if (!(tb > ta)) continue;
        if (!(period > 0)) {
          if (!emit(x0 + dx * ta, y0 + dy * ta, x0 + dx * tb, y0 + dy * tb)) {
            capped = true;
            break families;
          }
          continue;
        }
        let pos = Math.floor(ta / period) * period;
        while (pos < tb) {
          for (const d of L.dashes) {
            const s0 = pos;
            const s1 = pos + Math.abs(d);
            pos = s1;
            if (++work > maxWork) {
              capped = true;
              break families;
            }
            if (d < 0 || s1 < ta || s0 > tb) continue;
            if (
              !emit(
                x0 + dx * Math.max(s0, ta),
                y0 + dy * Math.max(s0, ta),
                x0 + dx * Math.min(s1, tb),
                y0 + dy * Math.min(s1, tb),
              )
            ) {
              capped = true;
              break families;
            }
          }
        }
      }
    }
  }
  return { segs: Float64Array.from(out), capped, tooDense };
}
