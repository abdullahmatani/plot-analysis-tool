import { arcSegments } from '@/geometry/bulge';
import { TAU } from '@/geometry/vec';
import { InvalidEntityError } from './errors';
import { tessellateNurbs, interpolateFitPoints } from './spline';
import type { Rec, Tags } from './tokenizer';

/** Ring vertex list: flat (x, y, bulge) triples in the hatch's OCS. */
export type Ring = number[];

export interface PatternLine {
  angle: number; // radians
  bx: number;
  by: number;
  ox: number;
  oy: number;
  dashes: number[];
}

export interface HatchData {
  solid: boolean;
  patternName: string;
  elevation: number;
  extrusion: [number, number, number];
  rings: Ring[];
  lines: PatternLine[];
  style: number;
}

export const MAX_PATTERN_SEGMENTS = 20000;
const DEG = Math.PI / 180;

class Cursor {
  i: number;
  constructor(
    readonly t: Tags,
    readonly r: Rec,
  ) {
    this.i = r.s;
  }
  get done() {
    return this.i >= this.r.e;
  }
  /** Current group code (-1 at the end of the record). A method, so TS does not narrow it across reads. */
  peek(): number {
    return this.i < this.r.e ? this.t.code[this.i] : -1;
  }
  get num() {
    return this.t.num[this.i];
  }
  get str() {
    return this.t.str[this.i];
  }
  /** Reads the value of `code` when it is the current tag, otherwise returns `def` without advancing. */
  opt(code: number, def: number): number {
    if (this.peek() === code) return this.t.num[this.i++];
    return def;
  }
  req(code: number, what: string): number {
    if (this.peek() !== code)
      throw new InvalidEntityError(`HATCH: expected ${what} (code ${code}), found code ${this.peek()}`);
    return this.t.num[this.i++];
  }
}

/** Arc → ring vertices (start point + bulge), split into ≤ 180° pieces. */
function pushArc(ring: Ring, cx: number, cy: number, r: number, a0: number, sweep: number) {
  const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / Math.PI - 1e-9));
  const step = sweep / pieces;
  const b = Math.tan(step / 4);
  for (let k = 0; k < pieces; k++) {
    const a = a0 + step * k;
    ring.push(cx + r * Math.cos(a), cy + r * Math.sin(a), b);
  }
}

/** Ellipse param range → ring vertices (excluding the end point), straight segments. */
function pushEllipse(
  ring: Ring,
  cx: number,
  cy: number,
  mx: number,
  my: number,
  ratio: number,
  t0: number,
  sweep: number,
  tol: number,
) {
  const major = Math.hypot(mx, my);
  const n = Math.min(1024, Math.max(4, arcSegments(major, sweep, tol)));
  const nx = -my * ratio;
  const ny = mx * ratio;
  for (let k = 0; k < n; k++) {
    const t = t0 + (sweep * k) / n;
    const c = Math.cos(t);
    const s = Math.sin(t);
    ring.push(cx + mx * c + nx * s, cy + my * c + ny * s, 0);
  }
}

function angleToParam(ratio: number, a: number): number {
  return Math.atan2(Math.sin(a) / ratio, Math.cos(a));
}

/** Parses a HATCH record (boundary paths in OCS, pattern definition). */
export function parseHatch(t: Tags, r: Rec, warn: (msg: string) => void): HatchData {
  const h: HatchData = {
    solid: false,
    patternName: '',
    elevation: 0,
    extrusion: [0, 0, 1],
    rings: [],
    lines: [],
    style: 0,
  };
  const cur = new Cursor(t, r);
  // Header part, up to the boundary path count (91).
  let nPaths = -1;
  while (!cur.done) {
    const c = cur.peek();
    if (c === 30) h.elevation = cur.num;
    else if (c === 210) h.extrusion[0] = cur.num;
    else if (c === 220) h.extrusion[1] = cur.num;
    else if (c === 230) h.extrusion[2] = cur.num;
    else if (c === 2) h.patternName = cur.str.trim();
    else if (c === 70) h.solid = (cur.num & 1) === 1;
    else if (c === 91) {
      nPaths = cur.num;
      cur.i++;
      break;
    }
    cur.i++;
  }
  if (nPaths < 0) throw new InvalidEntityError('HATCH without boundary paths');
  if (nPaths > 1e6) throw new InvalidEntityError('HATCH boundary path count is implausible');

  const rawRings: { ring: Ring; flags: number }[] = [];
  for (let p = 0; p < nPaths; p++) {
    while (!cur.done && cur.peek() !== 92) cur.i++;
    if (cur.done) break;
    const flags = cur.req(92, 'boundary path type');
    const ring: Ring = [];
    if (flags & 2) {
      const hasBulge = cur.opt(72, 0);
      cur.opt(73, 1);
      const nv = cur.req(93, 'vertex count');
      for (let v = 0; v < nv; v++) {
        const x = cur.req(10, 'vertex x');
        const y = cur.req(20, 'vertex y');
        const b = cur.peek() === 42 ? cur.opt(42, 0) : 0;
        ring.push(x, y, hasBulge || b ? b : 0);
      }
    } else {
      const ne = cur.req(93, 'edge count');
      // Each edge contributes its start vertex (+ intermediate points); its end point is kept so a
      // gap to the next edge can be bridged with an explicit vertex (bulges must end on the next vertex).
      const edges: { verts: Ring; ex: number; ey: number }[] = [];
      for (let e = 0; e < ne; e++) {
        const type = cur.req(72, 'edge type');
        const ring: Ring = [];
        let ex = NaN;
        let ey = NaN;
        if (type === 1) {
          const x0 = cur.req(10, 'line start x');
          const y0 = cur.req(20, 'line start y');
          ex = cur.req(11, 'line end x');
          ey = cur.req(21, 'line end y');
          ring.push(x0, y0, 0);
        } else if (type === 2) {
          const cx = cur.req(10, 'arc centre x');
          const cy = cur.req(20, 'arc centre y');
          const rad = cur.req(40, 'arc radius');
          let s = cur.req(50, 'arc start angle');
          let en = cur.req(51, 'arc end angle');
          const ccw = cur.opt(73, 1) !== 0;
          // Clockwise arcs are stored with complementary angles (360 - angle).
          if (!ccw) {
            s = 360 - s;
            en = 360 - en;
          }
          let sweep = (en - s) * DEG;
          if (ccw) {
            while (sweep <= 0) sweep += TAU;
            if (sweep > TAU) sweep = TAU;
          } else {
            while (sweep >= 0) sweep -= TAU;
            if (sweep < -TAU) sweep = -TAU;
          }
          if (Math.abs(en - s) >= 360 - 1e-9) sweep = ccw ? TAU : -TAU;
          pushArc(ring, cx, cy, rad, s * DEG, sweep);
          ex = cx + rad * Math.cos(s * DEG + sweep);
          ey = cy + rad * Math.sin(s * DEG + sweep);
        } else if (type === 3) {
          const cx = cur.req(10, 'ellipse centre x');
          const cy = cur.req(20, 'ellipse centre y');
          const mx = cur.req(11, 'ellipse major axis x');
          const my = cur.req(21, 'ellipse major axis y');
          const ratio = cur.req(40, 'ellipse ratio');
          let s = cur.req(50, 'ellipse start angle');
          let en = cur.req(51, 'ellipse end angle');
          const ccw = cur.opt(73, 1) !== 0;
          if (!ccw) {
            s = 360 - s;
            en = 360 - en;
          }
          const full = Math.abs(en - s) >= 360 - 1e-9;
          const ps = angleToParam(ratio || 1, s * DEG);
          const pe = angleToParam(ratio || 1, en * DEG);
          let sweep = pe - ps;
          if (full) sweep = ccw ? TAU : -TAU;
          else if (ccw) while (sweep <= 0) sweep += TAU;
          else while (sweep >= 0) sweep -= TAU;
          const tol = Math.max(Math.hypot(mx, my) * 1e-3, 1e-9);
          const q = ratio || 1;
          pushEllipse(ring, cx, cy, mx, my, q, ps, sweep, tol);
          const pe1 = ps + sweep;
          ex = cx + mx * Math.cos(pe1) - my * q * Math.sin(pe1);
          ey = cy + my * Math.cos(pe1) + mx * q * Math.sin(pe1);
        } else if (type === 4) {
          const degree = cur.req(94, 'spline degree');
          const rational = cur.opt(73, 0);
          cur.opt(74, 0);
          const nk = cur.req(95, 'knot count');
          const nc = cur.req(96, 'control point count');
          const knots: number[] = [];
          for (let k = 0; k < nk; k++) knots.push(cur.req(40, 'knot'));
          const ctrl: number[] = [];
          const weights: number[] = [];
          for (let k = 0; k < nc; k++) {
            ctrl.push(cur.req(10, 'control x'), cur.req(20, 'control y'), 0);
            if (cur.peek() === 42) weights.push(cur.opt(42, 1));
          }
          // Optional fit data (R2010+): 97 count, 11/21 points, 12/22 & 13/23 tangents.
          const fit: number[] = [];
          let st: [number, number, number] | null = null;
          let et: [number, number, number] | null = null;
          if (cur.peek() === 97) {
            const save = cur.i;
            const nf = cur.num;
            cur.i++;
            const next = cur.peek();
            if (next === 11 || next === 12 || next === 13 || (next === 97 && nf === 0)) {
              for (let k = 0; k < nf; k++) fit.push(cur.req(11, 'fit x'), cur.req(21, 'fit y'), 0);
              if (cur.peek() === 12) st = [cur.opt(12, 0), cur.opt(22, 0), 0];
              if (cur.peek() === 13) et = [cur.opt(13, 0), cur.opt(23, 0), 0];
            } else cur.i = save; // it was the source boundary count
          }
          let pts: number[];
          if (nc >= 2)
            pts = tessellateNurbs(
              degree,
              knots,
              ctrl,
              rational && weights.length === nc ? weights : null,
              warn,
            );
          else pts = interpolateFitPoints(fit, st, et, false);
          for (let k = 0; k + 3 < pts.length; k += 3) ring.push(pts[k], pts[k + 1], 0);
          if (pts.length >= 3) {
            ex = pts[pts.length - 3];
            ey = pts[pts.length - 2];
          }
          if (pts.length === 3) ring.push(pts[0], pts[1], 0);
        } else {
          throw new InvalidEntityError(`HATCH: unknown boundary edge type ${type}`);
        }
        edges.push({ verts: ring, ex, ey });
      }
      for (let k = 0; k < edges.length; k++) {
        const { verts, ex, ey } = edges[k];
        for (const v of verts) ring.push(v);
        const next = edges[(k + 1) % edges.length].verts;
        if (!next.length || !Number.isFinite(ex)) continue;
        const tol = 1e-9 * (1 + Math.abs(ex) + Math.abs(ey));
        if (Math.abs(next[0] - ex) > tol || Math.abs(next[1] - ey) > tol) ring.push(ex, ey, 0);
      }
    }
    // Source boundary objects
    if (cur.peek() === 97) {
      const ns = cur.num;
      cur.i++;
      for (let k = 0; k < ns && cur.peek() === 330; k++) cur.i++;
    }
    // Drop a closing vertex that repeats the first one.
    const nv = ring.length / 3;
    if (nv > 1 && ring[0] === ring[(nv - 1) * 3] && ring[1] === ring[(nv - 1) * 3 + 1]) ring.length -= 3;
    if (ring.length >= 6) rawRings.push({ ring, flags });
  }

  // Pattern / style.
  let nLines = 0;
  while (!cur.done) {
    const c = cur.peek();
    if (c === 75) h.style = cur.num;
    else if (c === 78) {
      nLines = cur.num;
      cur.i++;
      break;
    } else if (c === 98 || c === 450 || c === 47) break;
    cur.i++;
  }
  for (let k = 0; k < nLines && !cur.done; k++) {
    const angle = cur.req(53, 'pattern line angle') * DEG;
    const bx = cur.req(43, 'pattern base x');
    const by = cur.req(44, 'pattern base y');
    const ox = cur.req(45, 'pattern offset x');
    const oy = cur.req(46, 'pattern offset y');
    const nd = cur.opt(79, 0);
    const dashes: number[] = [];
    for (let d = 0; d < nd; d++) dashes.push(cur.req(49, 'dash length'));
    h.lines.push({ angle, bx, by, ox, oy, dashes });
  }
  // Gradient fills render as solid.
  for (let i = cur.i; i < r.e; i++) if (t.code[i] === 450 && t.num[i] !== 0) h.solid = true;

  // Hatch style 2 ("ignore"): only the outermost boundary is used.
  let use = rawRings;
  if (h.style === 2) {
    const outer = rawRings.filter((x) => x.flags & 17);
    if (outer.length) use = outer.slice(0, 1);
  }
  h.rings = use.map((x) => x.ring);
  return h;
}

/** Flattens bulged rings to straight-edge polygons (flat x, y) for clipping. */
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
      if (b) {
        const j = (i + 1) % n;
        const x1 = ring[j * 3];
        const y1 = ring[j * 3 + 1];
        const chord = Math.hypot(x1 - x0, y1 - y0);
        if (chord === 0) continue;
        const theta = 4 * Math.atan(b);
        const rad = chord / (2 * Math.abs(Math.sin(theta / 2)));
        const hgt = (chord / 2) * ((1 - b * b) / (2 * b));
        const ux = (x1 - x0) / chord;
        const uy = (y1 - y0) / chord;
        const cx = (x0 + x1) / 2 - uy * hgt;
        const cy = (y0 + y1) / 2 + ux * hgt;
        const a0 = Math.atan2(y0 - cy, x0 - cx);
        const segs = Math.min(256, arcSegments(rad, theta, tol));
        for (let k = 1; k < segs; k++) {
          const a = a0 + (theta * k) / segs;
          poly.push(cx + rad * Math.cos(a), cy + rad * Math.sin(a));
        }
      }
    }
    if (poly.length >= 6) out.push(poly);
  }
  return out;
}

export interface PatternResult {
  /** Flat x1, y1, x2, y2 segments in OCS. */
  segs: Float64Array;
  capped: boolean;
  /** Pattern lines were not generated because the line density is implausible for the area. */
  tooDense: boolean;
}

/**
 * Generates pattern line segments clipped to the boundary polygons with the even-odd rule.
 * Each pattern family is swept across the boundary: line k passes through base + k·offset.
 */
export function generatePattern(
  polys: number[][],
  lines: PatternLine[],
  maxSegs = MAX_PATTERN_SEGMENTS,
): PatternResult {
  const out: number[] = [];
  let capped = false;
  let tooDense = false;
  // Edges as flat arrays.
  const ex0: number[] = [];
  const ey0: number[] = [];
  const ex1: number[] = [];
  const ey1: number[] = [];
  for (const p of polys) {
    const n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (p[i * 2] === p[j * 2] && p[i * 2 + 1] === p[j * 2 + 1]) continue;
      ex0.push(p[i * 2]);
      ey0.push(p[i * 2 + 1]);
      ex1.push(p[j * 2]);
      ey1.push(p[j * 2 + 1]);
    }
  }
  const ne = ex0.length;
  if (ne < 3) return { segs: new Float64Array(0), capped, tooDense };
  // Bounds the dash loop when a pattern is mostly gaps.
  let work = 0;
  const maxWork = maxSegs * 16;

  outer: for (const L of lines) {
    const dx = Math.cos(L.angle);
    const dy = Math.sin(L.angle);
    // normal
    const nx = -dy;
    const ny = dx;
    const spacing = L.ox * nx + L.oy * ny; // perpendicular distance between successive lines
    if (!(Math.abs(spacing) > 1e-12)) continue;
    // Edge projections onto the normal, relative to the base point (keeps numbers small).
    const en0 = new Float64Array(ne);
    const en1 = new Float64Array(ne);
    const lo = new Float64Array(ne);
    const hi = new Float64Array(ne);
    let nMin = Infinity;
    let nMax = -Infinity;
    for (let e = 0; e < ne; e++) {
      const a = (ex0[e] - L.bx) * nx + (ey0[e] - L.by) * ny;
      const b = (ex1[e] - L.bx) * nx + (ey1[e] - L.by) * ny;
      en0[e] = a;
      en1[e] = b;
      lo[e] = Math.min(a, b);
      hi[e] = Math.max(a, b);
      if (lo[e] < nMin) nMin = lo[e];
      if (hi[e] > nMax) nMax = hi[e];
    }
    // Lines k = kLo…kHi cross the boundary's extent; sweep them in ascending normal coordinate.
    const kA = nMin / spacing;
    const kB = nMax / spacing;
    const kLo = Math.ceil(Math.min(kA, kB));
    const kHi = Math.floor(Math.max(kA, kB));
    if (kHi - kLo > 200000) {
      tooDense = true;
      continue;
    }
    const order = Array.from({ length: ne }, (_, i) => i).sort((a, b) => lo[a] - lo[b]);
    const step = spacing > 0 ? 1 : -1;
    const count = kHi - kLo + 1;
    let active: number[] = [];
    let next = 0;
    const ts: number[] = [];
    const period = L.dashes.reduce((sum, d) => sum + Math.abs(d), 0);
    for (let q = 0; q < count; q++) {
      const k = step > 0 ? kLo + q : kHi - q;
      const c = k * spacing;
      while (next < ne && lo[order[next]] <= c) active.push(order[next++]);
      active = active.filter((e) => hi[e] >= c);
      ts.length = 0;
      // Line k passes through base + k·offset; the dash pattern starts there.
      const ox = k * L.ox;
      const oy = k * L.oy;
      for (const e of active) {
        const a = en0[e] - c;
        const b = en1[e] - c;
        if (a > 0 === b > 0) continue; // half-open rule: vertices on the line are counted once
        const f = a / (a - b);
        const px = ex0[e] - L.bx + (ex1[e] - ex0[e]) * f;
        const py = ey0[e] - L.by + (ey1[e] - ey0[e]) * f;
        ts.push((px - ox) * dx + (py - oy) * dy);
      }
      if (ts.length < 2) continue;
      ts.sort((a, b) => a - b);
      const baseX = L.bx + ox;
      const baseY = L.by + oy;
      for (let i = 0; i + 1 < ts.length; i += 2) {
        const ta = ts[i];
        const tb = ts[i + 1];
        if (tb <= ta) continue;
        if (!(period > 0)) {
          out.push(baseX + dx * ta, baseY + dy * ta, baseX + dx * tb, baseY + dy * tb);
          if (out.length >= maxSegs * 4) {
            capped = true;
            break outer;
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
              break outer;
            }
            if (d < 0 || s1 < ta || s0 > tb) continue; // gap, or outside the interval
            const c0 = Math.max(s0, ta);
            const c1 = Math.min(s1, tb);
            out.push(baseX + dx * c0, baseY + dy * c0, baseX + dx * c1, baseY + dy * c1);
            if (out.length >= maxSegs * 4) {
              capped = true;
              break outer;
            }
          }
        }
      }
    }
  }
  return { segs: Float64Array.from(out), capped, tooDense };
}
