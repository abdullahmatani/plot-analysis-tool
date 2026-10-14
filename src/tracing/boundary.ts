import Flatbush from 'flatbush';
import type { Pt, Vertex } from '@/core/types';
import { arcSegments, bulgeToArc } from '@/geometry/bulge';
import { intersectInfiniteLines, intersectPrimsParams } from '@/geometry/intersect';
import {
  arcEnd,
  arcStart,
  arcSweep,
  ellipsePoint,
  ellipseSweep,
  isFullEllipse,
  primBounds,
  primsFromStoreEntity,
  type Prim,
} from '@/geometry/prims';
import { distToSegment } from '@/geometry/simplify';
import { TAU } from '@/geometry/vec';
import { FLAG, GK, type EntityStore } from '@/underlay/entity-store';

/**
 * Boundary pick (FDR row 52), like a CAD hatch pick-point.
 *
 * Pipeline (all coordinates stay float64; products are always taken on coordinate differences):
 *  1. Primitives → curves (segments, arcs, circles; ellipses are tessellated at chordTol).
 *  2. Pairwise intersections of candidate pairs from a flatbush index; every curve is split at its
 *     intersection parameters. Points within `eps` share a node; source endpoints are inserted
 *     first, so nodes keep exact source coordinates. Duplicate (overlapping) pieces are dropped.
 *  3. Arc pieces are tessellated at chordTol into chords between private (non-real) nodes.
 *  4. Gap closing (≤ gapTol): short overshoot stubs at junctions are removed; pairs of dangling
 *     ends are joined at the corner where their lines meet (or merged); remaining dangling ends are
 *     extended onto, or snapped to, the nearest node or edge.
 *  5. Dangling edges are pruned; a half-edge structure is built (outgoing edges sorted by angle,
 *     next = previous-CCW around the destination) and faces are traced. Bridges (edges with the
 *     same face on both sides) are removed and faces re-traced.
 *  6. The smallest counter-clockwise face containing the pick is the outer boundary. With
 *     detectIslands, the outer boundaries (clockwise) of other components lying inside it — and
 *     not inside another such island — are returned as holes.
 *  7. Faces are converted back to exact geometry: runs along an arc become one bulge vertex;
 *     exactly collinear joints and co-circular arc joints are merged.
 *
 * The work is limited to a window around the pick that grows ×4 until the found face (plus a
 * gap/chord margin) fits inside it, so local picks in large drawings stay fast. A face that fits in
 * the window is provably unaffected by geometry outside it.
 */

export interface BoundaryOptions {
  /** Gaps up to this size are closed. */
  gapTol: number;
  /** Return enclosed islands as holes. */
  detectIslands: boolean;
  /** Chord tolerance for tessellating arcs/circles/ellipses in the arrangement. */
  chordTol: number;
  /** Abort (null) when the window needed holds more primitives than this. */
  maxSegments?: number;
}

export interface BoundaryResult {
  /** Counter-clockwise outer boundary (bulge vertices for arcs). */
  outer: Vertex[];
  /** Clockwise island boundaries. */
  holes: Vertex[][];
}

interface Curve {
  prim: Extract<Prim, { k: 'seg' | 'arc' | 'circle' }>;
  /** Index of the source primitive. */
  src: number;
}

const isArcLike = (c: Curve) => c.prim.k !== 'seg';

function curvesFromPrims(prims: readonly Prim[], chordTol: number): Curve[] {
  const out: Curve[] = [];
  prims.forEach((p, src) => {
    switch (p.k) {
      case 'seg':
        if (p.a.x !== p.b.x || p.a.y !== p.b.y) out.push({ prim: p, src });
        break;
      case 'arc':
      case 'circle':
        if (p.r > 0 && Number.isFinite(p.r)) out.push({ prim: p, src });
        break;
      case 'ellipse': {
        const sweep = ellipseSweep(p);
        const lenM = Math.hypot(p.major.x, p.major.y);
        // |E''| ≤ the major semi-axis, so parameter steps sized for a circle of that radius keep
        // every chord's sagitta within chordTol.
        const rMax = lenM * Math.max(1, p.ratio);
        if (!(lenM * Math.min(1, p.ratio) > 0)) break;
        const n = Math.max(isFullEllipse(p) ? 8 : 1, arcSegments(rMax, sweep, chordTol, 8192));
        const full = isFullEllipse(p);
        const pts: Pt[] = [];
        for (let k = 0; k <= n; k++)
          pts.push(full && k === n ? pts[0] : ellipsePoint(p, p.t0 + (sweep * k) / n));
        for (let k = 0; k < n; k++) out.push({ prim: { k: 'seg', a: pts[k], b: pts[k + 1] }, src });
        break;
      }
      case 'point':
        break;
    }
  });
  return out;
}

function curveStart(c: Curve): Pt {
  const p = c.prim;
  if (p.k === 'seg') return p.a;
  if (p.k === 'arc') return arcStart(p);
  return { x: p.c.x + p.r, y: p.c.y };
}

function curveEnd(c: Curve): Pt {
  const p = c.prim;
  if (p.k === 'seg') return p.b;
  if (p.k === 'arc') return arcEnd(p);
  return { x: p.c.x + p.r, y: p.c.y };
}

/** Arc data of an arc-like curve: centre, radius, start angle, CCW sweep. */
function arcData(c: Curve): { cx: number; cy: number; r: number; a0: number; sweep: number } {
  const p = c.prim as Extract<Prim, { k: 'arc' | 'circle' }>;
  if (p.k === 'circle') return { cx: p.c.x, cy: p.c.y, r: p.r, a0: 0, sweep: TAU };
  return { cx: p.c.x, cy: p.c.y, r: p.r, a0: p.a0, sweep: arcSweep(p) };
}

/**
 * Signed sweep of an arc run from node a to node b: the accumulated chord angles fix the number of
 * turns, a single atan2 between the end vectors gives the precise value.
 */
function runSweep(
  arc: { cx: number; cy: number },
  nx: number[],
  ny: number[],
  a: number,
  b: number,
  deltas: number[],
): number {
  const sum = deltas.reduce((s, d) => s + d, 0);
  const ax = nx[a] - arc.cx;
  const ay = ny[a] - arc.cy;
  const bx = nx[b] - arc.cx;
  const by = ny[b] - arc.cy;
  const direct = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  let total = direct + TAU * Math.round((sum - direct) / TAU);
  // Semicircles (e.g. halves of a circle) get an exact bulge of ±1.
  if (Math.abs(Math.abs(total) - Math.PI) < 1e-9) total = Math.sign(sum) * Math.PI;
  return total;
}

/** Bulge of a signed sweep, exact for semicircles. */
function sweepBulge(sweep: number): number {
  if (Math.abs(Math.abs(sweep) - Math.PI) < 1e-9) return Math.sign(sweep);
  return Math.tan(sweep / 4);
}

interface Face {
  start: number;
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 2^26: numeric hash keys combine two non-negative integers below this bound. */
const KEY = 67108864;

const pairKey = (u: number, v: number) => (u < v ? u * KEY + v : v * KEY + u);

/** Planar arrangement of a set of curves. */
class Arrangement {
  // Nodes
  nx: number[] = [];
  ny: number[] = [];
  /** 1 = real vertex (source endpoint, intersection, gap target); 0 = arc tessellation point. */
  real: number[] = [];
  // Pieces (curve sub-ranges between nodes)
  pCurve: number[] = [];
  private pmx: number[] = [];
  private pmy: number[] = [];
  // Edges (straight chords); direction follows the piece direction
  eu: number[] = [];
  ev: number[] = [];
  ePiece: number[] = [];
  alive: number[] = [];
  /** Edges created for curve i occupy [edgeStart[i], edgeEnd[i]). */
  private edgeStart: Int32Array;
  private edgeEnd: Int32Array;
  /** Spatial index over curve bounds (expanded by eps). */
  private index: Flatbush | null = null;

  // Node hash grid: cell key → first node, then a per-node chain.
  private head = new Map<number, number>();
  private chain: number[] = [];
  private readonly cell: number;

  constructor(
    readonly curves: Curve[],
    /** minX, minY, maxX, maxY per curve. */
    private readonly cb: Float64Array,
    private readonly ox: number,
    private readonly oy: number,
    size: number,
    readonly eps: number,
    readonly chordTol: number,
    readonly gapTol: number,
  ) {
    // Cells are ≥ 16·eps and small enough that cell indices of the data stay below 2^23.
    this.cell = Math.max(eps * 16, size / 8388608, 1e-300);
    this.edgeStart = new Int32Array(curves.length);
    this.edgeEnd = new Int32Array(curves.length);
  }

  private cellKey(ix: number, iy: number): number {
    const kx = Math.min(KEY - 1, Math.max(0, ix + 16777216));
    const ky = Math.min(KEY - 1, Math.max(0, iy + 16777216));
    return kx * KEY + ky;
  }

  /** Node at (x, y), reusing an existing node within eps (the first inserted keeps its coordinates). */
  node(x: number, y: number, real: number): number {
    const { eps, cell, ox, oy } = this;
    const ix0 = Math.floor((x - eps - ox) / cell);
    const ix1 = Math.floor((x + eps - ox) / cell);
    const iy0 = Math.floor((y - eps - oy) / cell);
    const iy1 = Math.floor((y + eps - oy) / cell);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        let id = this.head.get(this.cellKey(ix, iy)) ?? -1;
        while (id >= 0) {
          if (Math.abs(this.nx[id] - x) <= eps && Math.abs(this.ny[id] - y) <= eps) {
            if (real) this.real[id] = 1;
            return id;
          }
          id = this.chain[id];
        }
      }
    }
    return this.addNode(x, y, real, true);
  }

  addNode(x: number, y: number, real: number, indexed = false): number {
    const id = this.nx.length;
    this.nx.push(x);
    this.ny.push(y);
    this.real.push(real);
    if (indexed) {
      const k = this.cellKey(Math.floor((x - this.ox) / this.cell), Math.floor((y - this.oy) / this.cell));
      this.chain.push(this.head.get(k) ?? -1);
      this.head.set(k, id);
    } else this.chain.push(-1);
    return id;
  }

  addEdge(u: number, v: number, piece: number): number {
    this.eu.push(u);
    this.ev.push(v);
    this.ePiece.push(piece);
    this.alive.push(1);
    return this.eu.length - 1;
  }

  build() {
    const { curves, eps, cb } = this;
    const n = curves.length;
    // Endpoints first so nodes keep exact source coordinates.
    const startNode = new Int32Array(n);
    const endNode = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const s = curveStart(curves[i]);
      const e = curveEnd(curves[i]);
      startNode[i] = this.node(s.x, s.y, 1);
      endNode[i] = this.node(e.x, e.y, 1);
    }
    // Intersections of candidate pairs. splits[i] = flat [t, x, y, t, x, y, ...].
    const splits: (number[] | undefined)[] = new Array(n);
    const index = new Flatbush(Math.max(1, n));
    for (let i = 0; i < n; i++)
      index.add(cb[i * 4] - eps, cb[i * 4 + 1] - eps, cb[i * 4 + 2] + eps, cb[i * 4 + 3] + eps);
    if (n === 0) index.add(0, 0, 0, 0);
    index.finish();
    this.index = index;
    const addSplit = (i: number, t: number, p: Pt) => {
      if (t <= 0 || t >= 1) return;
      (splits[i] ??= []).push(t, p.x, p.y);
    };
    for (let i = 0; i < n; i++) {
      const ci = curves[i].prim;
      const cand = index.search(
        cb[i * 4] - eps,
        cb[i * 4 + 1] - eps,
        cb[i * 4 + 2] + eps,
        cb[i * 4 + 3] + eps,
      );
      for (let q = 0; q < cand.length; q++) {
        const j = cand[q];
        if (j <= i) continue;
        const cj = curves[j].prim;
        // Fast path: non-parallel segments sharing a node can only meet at that node.
        if (ci.k === 'seg' && cj.k === 'seg') {
          const shared =
            startNode[i] === startNode[j] ||
            startNode[i] === endNode[j] ||
            endNode[i] === startNode[j] ||
            endNode[i] === endNode[j];
          if (shared) {
            const rx = ci.b.x - ci.a.x;
            const ry = ci.b.y - ci.a.y;
            const sx = cj.b.x - cj.a.x;
            const sy = cj.b.y - cj.a.y;
            const cr = rx * sy - ry * sx;
            if (Math.abs(cr) > 1e-6 * Math.hypot(rx, ry) * Math.hypot(sx, sy)) continue;
          }
        }
        const hits = intersectPrimsParams(ci, cj, eps);
        for (const h of hits) {
          addSplit(i, h.ta, h.p);
          addSplit(j, h.tb, h.p);
        }
      }
    }
    // Pieces, deduplicated by node pair and midpoint.
    const first = new Map<number, number>();
    const more = new Map<number, number[]>();
    const dupTol = 2 * this.chordTol + 10 * eps;
    for (let i = 0; i < n; i++) {
      const c = curves[i];
      const sp = splits[i];
      this.edgeStart[i] = this.eu.length;
      if (!sp && c.prim.k !== 'circle') {
        if (startNode[i] !== endNode[i])
          this.addPiece(i, startNode[i], endNode[i], 0, 1, first, more, dupTol);
        this.edgeEnd[i] = this.eu.length;
        continue;
      }
      const ts: number[] = [0];
      const nodes: number[] = [startNode[i]];
      if (sp) {
        for (let k = 0; k < sp.length; k += 3) {
          ts.push(sp[k]);
          nodes.push(this.node(sp[k + 1], sp[k + 2], 1));
        }
      }
      if (c.prim.k === 'circle') {
        ts.push(0.5);
        nodes.push(this.node(c.prim.c.x - c.prim.r, c.prim.c.y, 1));
      }
      ts.push(1);
      nodes.push(endNode[i]);
      const order = ts.map((_, k) => k).sort((a, b) => ts[a] - ts[b] || a - b);
      let prev = order[0];
      for (let k = 1; k < order.length; k++) {
        const cur = order[k];
        if (nodes[cur] === nodes[prev]) continue;
        this.addPiece(i, nodes[prev], nodes[cur], ts[prev], ts[cur], first, more, dupTol);
        prev = cur;
      }
      this.edgeEnd[i] = this.eu.length;
    }
  }

  private addPiece(
    curve: number,
    u: number,
    v: number,
    t0: number,
    t1: number,
    first: Map<number, number>,
    more: Map<number, number[]>,
    dupTol: number,
  ) {
    const c = this.curves[curve];
    let mx: number;
    let my: number;
    let arc: ReturnType<typeof arcData> | null = null;
    if (isArcLike(c)) {
      arc = arcData(c);
      const am = arc.a0 + arc.sweep * ((t0 + t1) / 2);
      mx = arc.cx + arc.r * Math.cos(am);
      my = arc.cy + arc.r * Math.sin(am);
    } else {
      mx = (this.nx[u] + this.nx[v]) / 2;
      my = (this.ny[u] + this.ny[v]) / 2;
    }
    const key = pairKey(u, v);
    const f = first.get(key);
    if (f !== undefined) {
      const isDup = (q: number) =>
        Math.abs(this.pmx[q] - mx) <= dupTol && Math.abs(this.pmy[q] - my) <= dupTol;
      if (isDup(f)) return;
      const others = more.get(key);
      if (others?.some(isDup)) return;
    }
    const piece = this.pCurve.length;
    this.pCurve.push(curve);
    this.pmx.push(mx);
    this.pmy.push(my);
    if (f === undefined) first.set(key, piece);
    else {
      const others = more.get(key);
      if (others) others.push(piece);
      else more.set(key, [piece]);
    }
    if (!arc) {
      this.addEdge(u, v, piece);
      return;
    }
    const sweep = arc.sweep * (t1 - t0);
    const segs = arcSegments(arc.r, sweep, this.chordTol);
    let prev = u;
    for (let k = 1; k < segs; k++) {
      const a = arc.a0 + arc.sweep * t0 + (sweep * k) / segs;
      const id = this.addNode(arc.cx + arc.r * Math.cos(a), arc.cy + arc.r * Math.sin(a), 0);
      this.addEdge(prev, id, piece);
      prev = id;
    }
    this.addEdge(prev, v, piece);
  }

  isArcPiece(piece: number): boolean {
    return isArcLike(this.curves[this.pCurve[piece]]);
  }

  edgeLen(k: number): number {
    return Math.hypot(this.nx[this.ev[k]] - this.nx[this.eu[k]], this.ny[this.ev[k]] - this.ny[this.eu[k]]);
  }

  /** CSR adjacency of alive edges: edges at node i are list[off[i] .. off[i + 1]). */
  adjacency(): { off: Int32Array; list: Int32Array; deg: Int32Array } {
    const N = this.nx.length;
    const E = this.eu.length;
    const deg = new Int32Array(N);
    for (let k = 0; k < E; k++) {
      if (!this.alive[k]) continue;
      deg[this.eu[k]]++;
      deg[this.ev[k]]++;
    }
    const off = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) off[i + 1] = off[i] + deg[i];
    const fill = off.slice(0, N);
    const list = new Int32Array(off[N]);
    for (let k = 0; k < E; k++) {
      if (!this.alive[k]) continue;
      list[fill[this.eu[k]]++] = k;
      list[fill[this.ev[k]]++] = k;
    }
    return { off, list, deg };
  }

  private other(k: number, node: number): number {
    return this.eu[k] === node ? this.ev[k] : this.eu[k];
  }

  private aliveEdgeAt(adj: { off: Int32Array; list: Int32Array }, node: number, except: number): number {
    for (let j = adj.off[node]; j < adj.off[node + 1]; j++) {
      const k = adj.list[j];
      if (this.alive[k] && k !== except) return k;
    }
    return -1;
  }

  closeGaps() {
    const { gapTol, eps } = this;
    if (!(gapTol > 0)) return;
    const adj = this.adjacency();
    const deg = adj.deg;
    const N = this.nx.length;
    const kill = (k: number) => {
      if (!this.alive[k]) return;
      this.alive[k] = 0;
      deg[this.eu[k]]--;
      deg[this.ev[k]]--;
    };
    // A. Overshoot stubs: dangling paths no longer than gapTol ending at a junction.
    for (let d = 0; d < N; d++) {
      if (deg[d] !== 1 || !this.real[d]) continue;
      const path: number[] = [];
      let cur = d;
      let prevEdge = -1;
      let length = 0;
      for (;;) {
        const k = this.aliveEdgeAt(adj, cur, prevEdge);
        if (k < 0) break;
        length += this.edgeLen(k);
        if (length > gapTol) break;
        path.push(k);
        const o = this.other(k, cur);
        if (deg[o] >= 3) {
          for (const e of path) kill(e);
          break;
        }
        if (deg[o] !== 2) break;
        cur = o;
        prevEdge = k;
      }
    }
    // Dangling ends after stub removal.
    const dang: number[] = [];
    for (let d = 0; d < N; d++) if (deg[d] === 1) dang.push(d);
    if (dang.length === 0) return;
    const edgeOf = new Map<number, number>();
    for (const d of dang) edgeOf.set(d, this.aliveEdgeAt(adj, d, -1));
    const remap = new Map<number, number>();
    const matched = new Set<number>();
    const straightEdge = (k: number) => !this.isArcPiece(this.ePiece[k]);
    const P = (id: number): Pt => ({ x: this.nx[id], y: this.ny[id] });
    const dist = (a: number, b: number) => Math.hypot(this.nx[a] - this.nx[b], this.ny[a] - this.ny[b]);

    // B. Pairs of dangling ends, closest first.
    const dIndex = new Flatbush(dang.length);
    for (const d of dang) dIndex.add(this.nx[d], this.ny[d], this.nx[d], this.ny[d]);
    dIndex.finish();
    const pairs: { a: number; b: number; d: number }[] = [];
    for (const d of dang) {
      const x = this.nx[d];
      const y = this.ny[d];
      for (const j of dIndex.search(x - gapTol, y - gapTol, x + gapTol, y + gapTol)) {
        const f = dang[j];
        if (f <= d) continue;
        const dd = dist(d, f);
        if (dd <= gapTol && edgeOf.get(d) !== edgeOf.get(f)) pairs.push({ a: d, b: f, d: dd });
      }
    }
    pairs.sort((p, q) => p.d - q.d || p.a - q.a || p.b - q.b);
    for (const { a, b } of pairs) {
      if (matched.has(a) || matched.has(b)) continue;
      matched.add(a);
      matched.add(b);
      const ka = edgeOf.get(a)!;
      const kb = edgeOf.get(b)!;
      let target = a;
      if (straightEdge(ka) && straightEdge(kb)) {
        const oa = this.other(ka, a);
        const ob = this.other(kb, b);
        const x = intersectInfiniteLines(P(oa), P(a), P(ob), P(b));
        if (x) {
          const reach = 2 * gapTol;
          const fa =
            (x.x - this.nx[oa]) * (this.nx[a] - this.nx[oa]) +
            (x.y - this.ny[oa]) * (this.ny[a] - this.ny[oa]);
          const fb =
            (x.x - this.nx[ob]) * (this.nx[b] - this.nx[ob]) +
            (x.y - this.ny[ob]) * (this.ny[b] - this.ny[ob]);
          const da = Math.hypot(x.x - this.nx[a], x.y - this.ny[a]);
          const db = Math.hypot(x.x - this.nx[b], x.y - this.ny[b]);
          if (da <= reach && db <= reach && fa > 0 && fb > 0) {
            if (da <= eps) target = a;
            else if (db <= eps) target = b;
            else target = this.addNode(x.x, x.y, 1);
          }
        }
      }
      if (target !== a) remap.set(a, target);
      if (target !== b) remap.set(b, target);
    }

    // C. Remaining dangling ends: extend onto / snap to nearby nodes or edges.
    const left = dang.filter((d) => !matched.has(d));
    if (left.length) {
      const index = this.index!;
      const splitReq = new Map<number, { u: number; node: number }[]>();
      const split = (k: number, u: number, x: number, y: number): number => {
        if (u <= 0 || Math.hypot(x - this.nx[this.eu[k]], y - this.ny[this.eu[k]]) <= eps) return this.eu[k];
        if (u >= 1 || Math.hypot(x - this.nx[this.ev[k]], y - this.ny[this.ev[k]]) <= eps) return this.ev[k];
        const node = this.addNode(x, y, 1);
        const list = splitReq.get(k);
        if (list) list.push({ u, node });
        else splitReq.set(k, [{ u, node }]);
        return node;
      };
      for (const d of left) {
        const kd = edgeOf.get(d)!;
        const od = this.other(kd, d);
        const x = this.nx[d];
        const y = this.ny[d];
        let ext: { k: number; s: number; u: number } | null = null;
        let nearNode = -1;
        let nearNodeD = Infinity;
        let foot: { k: number; u: number; d: number } | null = null;
        const straight = straightEdge(kd);
        const lx = x - this.nx[od];
        const ly = y - this.ny[od];
        const ll = Math.hypot(lx, ly);
        const dx = lx / ll;
        const dy = ly / ll;
        const considerNode = (nn: number) => {
          if (!this.real[nn] || deg[nn] < 1) return;
          const dn = dist(d, nn);
          if (dn <= gapTol && dn < nearNodeD) {
            nearNodeD = dn;
            nearNode = nn;
          }
        };
        const curvesNear = index.search(x - gapTol, y - gapTol, x + gapTol, y + gapTol);
        for (const ci of curvesNear)
          for (let k = this.edgeStart[ci]; k < this.edgeEnd[ci]; k++) {
            if (!this.alive[k] || k === kd) continue;
            const u0 = this.eu[k];
            const v0 = this.ev[k];
            if (u0 === d || v0 === d || u0 === od || v0 === od) continue;
            const ax = this.nx[u0] - x;
            const ay = this.ny[u0] - y;
            const rx = this.nx[v0] - this.nx[u0];
            const ry = this.ny[v0] - this.ny[u0];
            // Cheap reject: edge bounding box farther than gapTol.
            if (Math.min(ax, ax + rx) > gapTol || Math.max(ax, ax + rx) < -gapTol) continue;
            if (Math.min(ay, ay + ry) > gapTol || Math.max(ay, ay + ry) < -gapTol) continue;
            considerNode(u0);
            considerNode(v0);
            if (straight && ll > 0) {
              const den = dx * ry - dy * rx;
              if (Math.abs(den) > 1e-12 * Math.hypot(rx, ry)) {
                const s = (ax * ry - ay * rx) / den;
                const u = (ax * dy - ay * dx) / den;
                if (s >= -eps && s <= gapTol && u >= 0 && u <= 1 && (!ext || s < ext.s)) ext = { k, s, u };
              }
            }
            const rr = rx * rx + ry * ry;
            if (rr > 0) {
              const u = Math.min(1, Math.max(0, -(ax * rx + ay * ry) / rr));
              const fd = Math.hypot(ax + rx * u, ay + ry * u);
              if (fd <= gapTol && (!foot || fd < foot.d)) foot = { k, u, d: fd };
            }
          }
        let target = -1;
        if (ext) {
          const k = ext.k;
          const px = this.nx[this.eu[k]] + (this.nx[this.ev[k]] - this.nx[this.eu[k]]) * ext.u;
          const py = this.ny[this.eu[k]] + (this.ny[this.ev[k]] - this.ny[this.eu[k]]) * ext.u;
          target = split(k, ext.u, px, py);
        } else if (nearNode >= 0) target = nearNode;
        else if (foot) {
          const k = foot.k;
          const px = this.nx[this.eu[k]] + (this.nx[this.ev[k]] - this.nx[this.eu[k]]) * foot.u;
          const py = this.ny[this.eu[k]] + (this.ny[this.ev[k]] - this.ny[this.eu[k]]) * foot.u;
          target = split(k, foot.u, px, py);
        }
        if (target >= 0 && target !== d) {
          this.real[target] = 1;
          remap.set(d, target);
        }
      }
      for (const [k, list] of splitReq) {
        list.sort((p, q) => p.u - q.u);
        const end = this.ev[k];
        let prev = this.eu[k];
        let first = true;
        for (const s of list) {
          if (s.node === prev) continue;
          if (first) {
            this.ev[k] = s.node;
            first = false;
          } else this.addEdge(prev, s.node, this.ePiece[k]);
          prev = s.node;
        }
        if (prev !== end) {
          if (first) this.ev[k] = end;
          else this.addEdge(prev, end, this.ePiece[k]);
        }
      }
    }
    if (remap.size) {
      const find = (x: number) => {
        let guard = 0;
        while (remap.has(x) && guard++ < 64) x = remap.get(x)!;
        return x;
      };
      for (let k = 0; k < this.eu.length; k++) {
        this.eu[k] = find(this.eu[k]);
        this.ev[k] = find(this.ev[k]);
      }
    }
  }

  /** Removes self-loops and duplicate edges, then prunes dangling edges iteratively. */
  cleanAndPrune() {
    const seen = new Set<number>();
    for (let k = 0; k < this.eu.length; k++) {
      if (!this.alive[k]) continue;
      const u = this.eu[k];
      const v = this.ev[k];
      if (u === v) {
        this.alive[k] = 0;
        continue;
      }
      const key = pairKey(u, v);
      if (seen.has(key)) this.alive[k] = 0;
      else seen.add(key);
    }
    this.prune();
  }

  prune() {
    const adj = this.adjacency();
    const deg = adj.deg;
    const stack: number[] = [];
    for (let i = 0; i < deg.length; i++) if (deg[i] === 1) stack.push(i);
    while (stack.length) {
      const d = stack.pop()!;
      if (deg[d] !== 1) continue;
      const k = this.aliveEdgeAt(adj, d, -1);
      if (k < 0) continue;
      this.alive[k] = 0;
      deg[this.eu[k]]--;
      deg[this.ev[k]]--;
      const o = this.other(k, d);
      if (deg[o] === 1) stack.push(o);
    }
  }

  // Half-edge structure (h = 2k: eu→ev, h = 2k+1: ev→eu)
  next = new Int32Array(0);
  faceOf = new Int32Array(0);
  faces: Face[] = [];

  origin(h: number): number {
    return h & 1 ? this.ev[h >> 1] : this.eu[h >> 1];
  }

  dest(h: number): number {
    return h & 1 ? this.eu[h >> 1] : this.ev[h >> 1];
  }

  buildFaces() {
    const N = this.nx.length;
    const E = this.eu.length;
    const deg = new Int32Array(N + 1);
    for (let k = 0; k < E; k++) {
      if (!this.alive[k]) continue;
      deg[this.eu[k]]++;
      deg[this.ev[k]]++;
    }
    const off = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) off[i + 1] = off[i] + deg[i];
    const fill = off.slice(0, N);
    const outH = new Int32Array(off[N]);
    const ang = new Float64Array(2 * E);
    for (let k = 0; k < E; k++) {
      if (!this.alive[k]) continue;
      const u = this.eu[k];
      const v = this.ev[k];
      const dx = this.nx[v] - this.nx[u];
      const dy = this.ny[v] - this.ny[u];
      ang[2 * k] = Math.atan2(dy, dx);
      ang[2 * k + 1] = Math.atan2(-dy, -dx);
      outH[fill[u]++] = 2 * k;
      outH[fill[v]++] = 2 * k + 1;
    }
    const pos = new Int32Array(2 * E);
    for (let i = 0; i < N; i++) {
      const a = off[i];
      const b = off[i + 1];
      const d = b - a;
      if (d > 32) {
        const seg = Array.from(outH.subarray(a, b)).sort((p, q) => ang[p] - ang[q] || p - q);
        for (let j = 0; j < d; j++) outH[a + j] = seg[j];
      } else if (d > 1) {
        // Insertion sort by angle (ties by half-edge id) for the usual small degrees.
        for (let j = a + 1; j < b; j++) {
          const h = outH[j];
          let q = j - 1;
          while (q >= a && (ang[outH[q]] > ang[h] || (ang[outH[q]] === ang[h] && outH[q] > h))) {
            outH[q + 1] = outH[q];
            q--;
          }
          outH[q + 1] = h;
        }
      }
      for (let j = a; j < b; j++) pos[outH[j]] = j - a;
    }
    const next = new Int32Array(2 * E).fill(-1);
    for (let k = 0; k < E; k++) {
      if (!this.alive[k]) continue;
      for (let h = 2 * k; h <= 2 * k + 1; h++) {
        const v = this.dest(h);
        const d = off[v + 1] - off[v];
        const i = pos[h ^ 1];
        next[h] = outH[off[v] + ((i - 1 + d) % d)];
      }
    }
    this.next = next;
    const faceOf = new Int32Array(2 * E).fill(-1);
    const faces: Face[] = [];
    for (let h0 = 0; h0 < 2 * E; h0++) {
      if (next[h0] < 0 || faceOf[h0] >= 0) continue;
      const id = faces.length;
      const o = this.origin(h0);
      const ox = this.nx[o];
      const oy = this.ny[o];
      let area = 0;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let h = h0;
      let guard = 0;
      do {
        faceOf[h] = id;
        const a = this.origin(h);
        const b = this.dest(h);
        const ax = this.nx[a];
        const ay = this.ny[a];
        area += ((ax - ox) * (this.ny[b] - oy) - (ay - oy) * (this.nx[b] - ox)) / 2;
        if (ax < minX) minX = ax;
        if (ay < minY) minY = ay;
        if (ax > maxX) maxX = ax;
        if (ay > maxY) maxY = ay;
        h = next[h];
      } while (h !== h0 && ++guard <= 2 * E);
      faces.push({ start: h0, area, minX, minY, maxX, maxY });
    }
    this.faceOf = faceOf;
    this.faces = faces;
  }

  /** Removes edges with the same face on both sides; returns true if any were removed. */
  removeBridges(): boolean {
    let removed = false;
    for (let k = 0; k < this.eu.length; k++) {
      if (!this.alive[k]) continue;
      if (this.faceOf[2 * k] === this.faceOf[2 * k + 1]) {
        this.alive[k] = 0;
        removed = true;
      }
    }
    return removed;
  }

  faceHalfEdges(f: number): number[] {
    const out: number[] = [];
    const h0 = this.faces[f].start;
    let h = h0;
    do {
      out.push(h);
      h = this.next[h];
    } while (h !== h0 && out.length <= this.next.length);
    return out;
  }

  /** Even–odd point-in-face test on the face's (tessellated) boundary, relative to p. */
  faceContains(f: number, px: number, py: number): boolean {
    const face = this.faces[f];
    if (px < face.minX || px > face.maxX || py < face.minY || py > face.maxY) return false;
    let inside = false;
    const h0 = face.start;
    let h = h0;
    let guard = 0;
    do {
      const a = this.origin(h);
      const b = this.dest(h);
      const ay = this.ny[a] - py;
      const by = this.ny[b] - py;
      if (ay > 0 !== by > 0) {
        const ax = this.nx[a] - px;
        const bx = this.nx[b] - px;
        const x = ax + ((0 - ay) * (bx - ax)) / (by - ay);
        if (x > 0) inside = !inside;
      }
      h = this.next[h];
    } while (h !== h0 && ++guard <= this.next.length);
    return inside;
  }

  components(): Int32Array {
    const N = this.nx.length;
    const parent = new Int32Array(N);
    for (let i = 0; i < N; i++) parent[i] = i;
    const find = (x: number) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    for (let k = 0; k < this.eu.length; k++) {
      if (!this.alive[k]) continue;
      const a = find(this.eu[k]);
      const b = find(this.ev[k]);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
    for (let i = 0; i < N; i++) parent[i] = find(i);
    return parent;
  }

  /** Converts a face boundary back to exact bulge vertices. */
  faceVertices(f: number): Vertex[] {
    const hs = this.faceHalfEdges(f);
    const m = hs.length;
    let i0 = -1;
    for (let i = 0; i < m; i++) {
      if (this.real[this.origin(hs[i])]) {
        i0 = i;
        break;
      }
    }
    if (i0 < 0) return hs.map((h) => ({ x: this.nx[this.origin(h)], y: this.ny[this.origin(h)] }));
    interface Out {
      node: number;
      bulge: number;
      sweep: number;
      curve: number;
    }
    const out: Out[] = [];
    let i = 0;
    while (i < m) {
      const h = hs[(i0 + i) % m];
      const start = this.origin(h);
      const piece = this.ePiece[h >> 1];
      const curve = this.pCurve[piece];
      // Collect the run up to the next real node.
      const run: number[] = [h];
      i++;
      while (i < m && !this.real[this.origin(hs[(i0 + i) % m])]) {
        run.push(hs[(i0 + i) % m]);
        i++;
      }
      if (!this.isArcPiece(piece)) {
        out.push({ node: start, bulge: 0, sweep: 0, curve });
        continue;
      }
      const arc = arcData(this.curves[curve]);
      const deltas = run.map((hh) => {
        const a = this.origin(hh);
        const b = this.dest(hh);
        const ax = this.nx[a] - arc.cx;
        const ay = this.ny[a] - arc.cy;
        const bx = this.nx[b] - arc.cx;
        const by = this.ny[b] - arc.cy;
        return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
      });
      const total = runSweep(arc, this.nx, this.ny, start, this.dest(run[run.length - 1]), deltas);
      if (Math.abs(total) > Math.PI + 1e-9 && run.length > 1) {
        // Split long runs (e.g. a nearly closed arc) at the middle tessellation node.
        let acc = 0;
        let cut = 1;
        for (let j = 0; j < run.length - 1; j++) {
          acc += deltas[j];
          cut = j + 1;
          if (Math.abs(acc) >= Math.abs(total) / 2) break;
        }
        const mid = this.origin(run[cut]);
        const s1 = runSweep(arc, this.nx, this.ny, start, mid, deltas.slice(0, cut));
        const s2 = runSweep(arc, this.nx, this.ny, mid, this.dest(run[run.length - 1]), deltas.slice(cut));
        out.push({ node: start, bulge: sweepBulge(s1), sweep: s1, curve });
        out.push({ node: mid, bulge: sweepBulge(s2), sweep: s2, curve });
      } else out.push({ node: start, bulge: sweepBulge(total), sweep: total, curve });
    }
    // Merge exactly collinear joints and joints between pieces of the same source arc.
    let changed = true;
    while (changed && out.length > 2) {
      changed = false;
      for (let j = 0; j < out.length && out.length > 2; j++) {
        const n = out.length;
        const prev = out[(j - 1 + n) % n];
        const cur = out[j];
        const nxt = out[(j + 1) % n];
        if (prev.bulge === 0 && cur.bulge === 0) {
          if (out.length <= 3) continue;
          const a = { x: this.nx[prev.node], y: this.ny[prev.node] };
          const v = { x: this.nx[cur.node], y: this.ny[cur.node] };
          const b = { x: this.nx[nxt.node], y: this.ny[nxt.node] };
          if ((v.x - a.x) * (b.x - v.x) + (v.y - a.y) * (b.y - v.y) <= 0) continue;
          if (distToSegment(v, a, b) > this.eps) continue;
          out.splice(j, 1);
          changed = true;
          j--;
        } else if (prev.bulge !== 0 && cur.bulge !== 0 && prev.curve === cur.curve) {
          const sweep = prev.sweep + cur.sweep;
          // Merge up to a semicircle: keeps |bulge| ≤ 1 and gives circles two ±1 bulges.
          if (Math.sign(prev.sweep) !== Math.sign(cur.sweep) || Math.abs(sweep) > Math.PI + 1e-9) continue;
          prev.sweep = sweep;
          prev.bulge = sweepBulge(sweep);
          out.splice(j, 1);
          changed = true;
          j--;
        }
      }
    }
    return out.map((o) =>
      o.bulge
        ? { x: this.nx[o.node], y: this.ny[o.node], bulge: o.bulge }
        : { x: this.nx[o.node], y: this.ny[o.node] },
    );
  }
}

/** Bounds of a primitive into out[o .. o + 3] (segments inline, others via primBounds). */
function fastBounds(p: Prim, out: Float64Array, o: number) {
  if (p.k === 'seg') {
    out[o] = p.a.x < p.b.x ? p.a.x : p.b.x;
    out[o + 1] = p.a.y < p.b.y ? p.a.y : p.b.y;
    out[o + 2] = p.a.x > p.b.x ? p.a.x : p.b.x;
    out[o + 3] = p.a.y > p.b.y ? p.a.y : p.b.y;
    return;
  }
  const b = primBounds(p);
  out[o] = b.minX;
  out[o + 1] = b.minY;
  out[o + 2] = b.maxX;
  out[o + 3] = b.maxY;
}

/** Finds the boundary in one fixed set of primitives (no windowing). */
function solve(prims: readonly Prim[], pick: Pt, opts: BoundaryOptions): BoundaryResult | null {
  const chordTol = opts.chordTol > 0 ? opts.chordTol : 1e-3;
  const curves = curvesFromPrims(prims, chordTol);
  if (curves.length === 0) return null;
  const cb = new Float64Array(curves.length * 4);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < curves.length; i++) {
    fastBounds(curves[i].prim, cb, i * 4);
    if (cb[i * 4] < minX) minX = cb[i * 4];
    if (cb[i * 4 + 1] < minY) minY = cb[i * 4 + 1];
    if (cb[i * 4 + 2] > maxX) maxX = cb[i * 4 + 2];
    if (cb[i * 4 + 3] > maxY) maxY = cb[i * 4 + 3];
  }
  const size = Math.max(maxX - minX, maxY - minY);
  const mag = Math.max(Math.abs(minX), Math.abs(minY), Math.abs(maxX), Math.abs(maxY));
  let eps = Math.max(1e-9 * size, 4e-15 * mag, 1e-12);
  if (opts.gapTol > 0) eps = Math.min(eps, opts.gapTol / 10);
  const arr = new Arrangement(curves, cb, minX, minY, size, eps, chordTol, Math.max(0, opts.gapTol));
  arr.build();
  arr.closeGaps();
  arr.cleanAndPrune();
  arr.buildFaces();
  for (let iter = 0; iter < 16 && arr.removeBridges(); iter++) {
    arr.prune();
    arr.buildFaces();
  }
  // Smallest CCW face containing the pick.
  let outer = -1;
  for (let f = 0; f < arr.faces.length; f++) {
    const face = arr.faces[f];
    if (!(face.area > 0)) continue;
    if (outer >= 0 && face.area >= arr.faces[outer].area) continue;
    if (arr.faceContains(f, pick.x, pick.y)) outer = f;
  }
  if (outer < 0) return null;
  const holes: Vertex[][] = [];
  if (opts.detectIslands) {
    const comp = arr.components();
    const of = arr.faces[outer];
    const outerComp = comp[arr.origin(of.start)];
    const cands: number[] = [];
    for (let f = 0; f < arr.faces.length; f++) {
      const face = arr.faces[f];
      if (!(face.area < 0)) continue;
      const o = arr.origin(face.start);
      if (comp[o] === outerComp) continue;
      if (face.minX < of.minX || face.maxX > of.maxX || face.minY < of.minY || face.maxY > of.maxY) continue;
      if (!arr.faceContains(outer, arr.nx[o], arr.ny[o])) continue;
      // The island's region is the inside of its clockwise outer boundary.
      if (arr.faceContains(f, pick.x, pick.y)) continue;
      cands.push(f);
    }
    // Drop islands nested inside other islands.
    if (cands.length > 1) {
      const idx = new Flatbush(cands.length);
      for (const f of cands) {
        const face = arr.faces[f];
        idx.add(face.minX, face.minY, face.maxX, face.maxY);
      }
      idx.finish();
      for (const f of cands) {
        const face = arr.faces[f];
        const o = arr.origin(face.start);
        let nested = false;
        for (const j of idx.search(face.minX, face.minY, face.maxX, face.maxY)) {
          const g = cands[j];
          if (g === f) continue;
          const gf = arr.faces[g];
          if (-gf.area <= -face.area) continue;
          if (gf.minX > face.minX || gf.maxX < face.maxX || gf.minY > face.minY || gf.maxY < face.maxY)
            continue;
          if (arr.faceContains(g, arr.nx[o], arr.ny[o])) {
            nested = true;
            break;
          }
        }
        if (!nested) holes.push(arr.faceVertices(f));
      }
    } else for (const f of cands) holes.push(arr.faceVertices(f));
  }
  return { outer: arr.faceVertices(outer), holes };
}

/**
 * Detects the closed region around `pick` (hatch-style pick point). Returns null when the pick is
 * not enclosed (or the region needs more than `maxSegments` primitives).
 */
export function findBoundary(prims: readonly Prim[], pick: Pt, opts: BoundaryOptions): BoundaryResult | null {
  const usable: number[] = [];
  for (let i = 0; i < prims.length; i++) if (prims[i].k !== 'point') usable.push(i);
  if (usable.length === 0) return null;
  const maxSegments = opts.maxSegments ?? 2_000_000;
  const index = new Flatbush(usable.length);
  const pb = new Float64Array(usable.length * 4);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let j = 0; j < usable.length; j++) {
    fastBounds(prims[usable[j]], pb, j * 4);
    index.add(pb[j * 4], pb[j * 4 + 1], pb[j * 4 + 2], pb[j * 4 + 3]);
    if (pb[j * 4] < minX) minX = pb[j * 4];
    if (pb[j * 4 + 1] < minY) minY = pb[j * 4 + 1];
    if (pb[j * 4 + 2] > maxX) maxX = pb[j * 4 + 2];
    if (pb[j * 4 + 3] > maxY) maxY = pb[j * 4 + 3];
  }
  index.finish();
  // A pick outside the bounds of everything cannot be enclosed.
  if (pick.x < minX || pick.x > maxX || pick.y < minY || pick.y > maxY) return null;
  const extent = Math.max(maxX - minX, maxY - minY);
  const gapTol = Math.max(0, opts.gapTol);
  const margin = 3 * gapTol + 2 * Math.max(0, opts.chordTol) + 1e-9 * extent;
  const nearest = index.neighbors(pick.x, pick.y, 1);
  let half = extent * 1e-3;
  if (nearest.length) {
    const o = nearest[0] * 4;
    const dx = Math.max(pb[o] - pick.x, 0, pick.x - pb[o + 2]);
    const dy = Math.max(pb[o + 1] - pick.y, 0, pick.y - pb[o + 3]);
    half = Math.max(half, 4 * Math.hypot(dx, dy));
  }
  half = Math.max(half, 10 * gapTol, 1e-9);
  for (;;) {
    const wx0 = pick.x - half;
    const wy0 = pick.y - half;
    const wx1 = pick.x + half;
    const wy1 = pick.y + half;
    const coversAll = wx0 <= minX && wy0 <= minY && wx1 >= maxX && wy1 >= maxY;
    const ids = coversAll ? usable.map((_, j) => j) : index.search(wx0, wy0, wx1, wy1);
    if (ids.length > maxSegments) return null;
    const subset = ids.map((j) => prims[usable[j]]);
    const res = subset.length ? solve(subset, pick, opts) : null;
    if (coversAll) return res;
    if (res) {
      let ok = true;
      for (const v of res.outer) {
        if (v.x - margin < wx0 || v.x + margin > wx1 || v.y - margin < wy0 || v.y + margin > wy1) {
          ok = false;
          break;
        }
      }
      // Arcs can bulge beyond their vertices: check their bounds too.
      if (ok) {
        const n = res.outer.length;
        for (let k = 0; k < n && ok; k++) {
          const a = res.outer[k];
          if (!a.bulge) continue;
          const arc = bulgeToArc(a, res.outer[(k + 1) % n], a.bulge);
          if (!arc) continue;
          const { c, r } = arc;
          if (
            c.x - r - margin < wx0 ||
            c.x + r + margin > wx1 ||
            c.y - r - margin < wy0 ||
            c.y + r + margin > wy1
          )
            ok = false;
        }
      }
      if (ok) return res;
    }
    half *= 4;
  }
}

/**
 * Worker-friendly entry: builds primitives for the given underlay entities (skipping derived
 * hatch pattern lines, hidden entities, text and points) and runs findBoundary.
 */
export function findBoundaryFromStore(
  store: EntityStore,
  entityIndices: readonly number[],
  pick: Pt,
  opts: BoundaryOptions,
): BoundaryResult | null {
  const prims: Prim[] = [];
  for (const i of entityIndices) {
    if (i < 0 || i >= store.count) continue;
    if (store.flags[i] & (FLAG.DERIVED | FLAG.HIDDEN)) continue;
    const kind = store.geomKind[i];
    if (kind === GK.TEXT || kind === GK.POINT) continue;
    for (const p of primsFromStoreEntity(store, i)) if (p.k !== 'point') prims.push(p);
  }
  return findBoundary(prims, pick, opts);
}
