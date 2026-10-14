import Flatbush from 'flatbush';
import type { Pt, Vertex } from '@/core/types';
import { arcSegments } from '@/geometry/bulge';
import { intersectInfiniteLines } from '@/geometry/intersect';
import { nearestOnPrim } from '@/geometry/nearest';
import { polylineSignedArea, reversePolyline } from '@/geometry/polyline-edit';
import {
  arcEnd,
  arcStart,
  arcSweep,
  ellipsePoint,
  ellipseSweep,
  isFullEllipse,
  primBounds,
  primEndpoints,
  primTangentAt,
  type EllipsePrim,
  type Prim,
} from '@/geometry/prims';
import { distToSegment } from '@/geometry/simplify';

/**
 * Chain trace / auto-follow (FDR row 51).
 *
 * Primitive endpoints closer than `gapTol` form one node of an endpoint graph (union-find over a
 * flatbush index). Starting from the clicked primitive the tracer walks in both directions until
 * the path closes, dead-ends, or reaches a junction (a node with more than one unused
 * continuation). At a junction the alternatives are offered (sorted straightest first); `cycle()`
 * switches between them (Tab) and `accept()` continues along the current one.
 *
 * The result keeps exact source geometry: straight runs use the stored endpoints, arcs become bulge
 * vertices, and gaps are closed at the corner where the two neighbouring lines meet when that
 * corner is within reach (otherwise at the incoming endpoint). Exactly collinear joints between
 * separate lines are merged, so a rectangle drawn as 4–12 lines traces to its 4 corners.
 */

export interface ChainOptions {
  /** Endpoints closer than this are connected. */
  gapTol: number;
  /** Chord tolerance for ellipse arcs (the only primitives without an exact bulge form). */
  chordTol?: number;
  /** Merge exactly collinear joints (default true). */
  mergeCollinear?: boolean;
}

export interface ChainAlternative {
  primIndex: number;
  /** Where auto-follow would go along this alternative, starting at the junction. */
  preview: Vertex[];
}

export interface ChainJunction {
  /** Which free end of the chain the junction is at. */
  side: 'end' | 'start';
  at: Pt;
  alternatives: ChainAlternative[];
  /** Index of the currently highlighted alternative. */
  current: number;
}

export interface ChainState {
  status: 'closed' | 'junction' | 'open';
  closed: boolean;
  pts: Vertex[];
  primIndices: number[];
  junction: ChainJunction | null;
}

interface Step {
  prim: number;
  /** 1 = traversed start → end, −1 = end → start. */
  dir: 1 | -1;
}

/** Incidence of a primitive at a node: which end of it (0 = start, 1 = end) sits there. */
interface Inc {
  prim: number;
  end: 0 | 1;
}

type SideState =
  { kind: 'dead' } | { kind: 'stopped' } | { kind: 'junction'; node: number; alts: Inc[]; current: number };

const copy = (p: Pt): Pt => ({ x: p.x, y: p.y });
const neg = (p: Pt): Pt => ({ x: -p.x, y: -p.y });

function isEdgePrim(p: Prim): boolean {
  return p.k === 'seg' || p.k === 'arc' || (p.k === 'ellipse' && !isFullEllipse(p));
}

/** Exact start (t = 0) and end (t = 1) points of an edge primitive. */
function ends(p: Prim): [Pt, Pt] {
  if (p.k === 'seg') return [copy(p.a), copy(p.b)];
  if (p.k === 'arc') return [arcStart(p), arcEnd(p)];
  const e = primEndpoints(p);
  return [e[0], e[1]];
}

export class ChainTracer {
  private readonly prims: readonly Prim[];
  private readonly gapTol: number;
  private readonly chordTol: number;
  private readonly mergeCollinear: boolean;
  private readonly eps: number;
  /** Node per primitive end (2 per primitive; −1 for non-edge primitives). */
  private readonly nodeOf: Int32Array;
  private readonly adj: Inc[][];
  private readonly nodePt: Pt[];

  private steps: Step[] = [];
  private used = new Set<number>();
  private closed = false;
  private sides: { end: SideState; start: SideState } = { end: { kind: 'dead' }, start: { kind: 'dead' } };

  constructor(prims: readonly Prim[], opts: ChainOptions) {
    this.prims = prims;
    this.gapTol = Math.max(0, opts.gapTol);
    this.mergeCollinear = opts.mergeCollinear ?? true;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of prims) {
      const b = primBounds(p);
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
    const size = Number.isFinite(minX) ? Math.max(maxX - minX, maxY - minY) : 1;
    const mag = Number.isFinite(minX)
      ? Math.max(Math.abs(minX), Math.abs(minY), Math.abs(maxX), Math.abs(maxY))
      : 1;
    this.eps = Math.max(1e-9 * size, 4e-15 * mag, 1e-12);
    this.chordTol = opts.chordTol ?? Math.max(size * 1e-5, this.eps);

    // Cluster endpoints within gapTol (union-find over a spatial index).
    const n = prims.length;
    this.nodeOf = new Int32Array(2 * n).fill(-1);
    const pts: Pt[] = [];
    const owner: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!isEdgePrim(prims[i])) continue;
      const [a, b] = ends(prims[i]);
      pts.push(a, b);
      owner.push(2 * i, 2 * i + 1);
    }
    const m = pts.length;
    const parent = new Int32Array(m);
    for (let k = 0; k < m; k++) parent[k] = k;
    const find = (k: number): number => {
      while (parent[k] !== k) {
        parent[k] = parent[parent[k]];
        k = parent[k];
      }
      return k;
    };
    const tol = Math.max(this.gapTol, this.eps);
    if (m > 0) {
      const index = new Flatbush(m);
      for (const p of pts) index.add(p.x, p.y, p.x, p.y);
      index.finish();
      for (let k = 0; k < m; k++) {
        const p = pts[k];
        for (const j of index.search(p.x - tol, p.y - tol, p.x + tol, p.y + tol)) {
          if (j <= k) continue;
          if (Math.hypot(pts[j].x - p.x, pts[j].y - p.y) <= tol) {
            const ra = find(k);
            const rb = find(j);
            if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
          }
        }
      }
    }
    const nodeId = new Int32Array(m).fill(-1);
    this.adj = [];
    this.nodePt = [];
    for (let k = 0; k < m; k++) {
      const r = find(k);
      if (nodeId[r] < 0) {
        nodeId[r] = this.adj.length;
        this.adj.push([]);
        this.nodePt.push(pts[r]);
      }
      this.nodeOf[owner[k]] = nodeId[r];
    }
    for (let i = 0; i < n; i++) {
      const a = this.nodeOf[2 * i];
      const b = this.nodeOf[2 * i + 1];
      if (a < 0 || a === b) continue; // non-edges and self-loops are not part of the graph
      this.adj[a].push({ prim: i, end: 0 });
      this.adj[b].push({ prim: i, end: 1 });
    }
  }

  /** Starts a trace on primitive `primIndex`; the side nearer `pick` is followed (and offered) first. */
  start(primIndex: number, pick: Pt): ChainState {
    this.steps = [];
    this.used = new Set([primIndex]);
    this.closed = false;
    this.sides = { end: { kind: 'dead' }, start: { kind: 'dead' } };
    const prim = this.prims[primIndex];
    if (!prim) throw new RangeError(`primitive ${primIndex} out of range`);
    if (prim.k === 'point') {
      this.steps = [{ prim: primIndex, dir: 1 }];
      return this.state();
    }
    if (!isEdgePrim(prim) || this.nodeOf[2 * primIndex] === this.nodeOf[2 * primIndex + 1]) {
      // Circles, full ellipses and curves whose ends meet within gapTol close on themselves; a
      // segment shorter than gapTol stays an open segment.
      this.steps = [{ prim: primIndex, dir: 1 }];
      this.closed = prim.k !== 'seg';
      return this.state();
    }
    const t = nearestOnPrim(pick, prim).t;
    this.steps = [{ prim: primIndex, dir: t >= 0.5 ? 1 : -1 }];
    this.walk('end');
    if (!this.closed) this.walk('start');
    return this.state();
  }

  /** Highlights the next alternative at the current junction. */
  cycle(): ChainState {
    const side = this.currentSide();
    if (side) {
      const s = this.sides[side];
      if (s.kind === 'junction') s.current = (s.current + 1) % s.alts.length;
    }
    return this.state();
  }

  /** Continues along the highlighted alternative at the current junction. */
  accept(): ChainState {
    const side = this.currentSide();
    if (!side) return this.state();
    const s = this.sides[side];
    if (s.kind !== 'junction') return this.state();
    this.addStep(side, s.alts[s.current]);
    this.walk(side);
    return this.state();
  }

  /** Stops at the current junction (that end stays open) and moves on to the other end's junction, if any. */
  skip(): ChainState {
    const side = this.currentSide();
    if (side) this.sides[side] = { kind: 'stopped' };
    return this.state();
  }

  /** The traced polyline (closed chains are counter-clockwise). */
  result(): { pts: Vertex[]; closed: boolean; primIndices: number[] } {
    const pts = this.build(this.steps, this.closed);
    let primIndices = this.steps.map((s) => s.prim);
    if (this.closed && pts.length > 1 && polylineSignedArea(pts) < 0) {
      return {
        pts: reversePolyline({ pts, closed: true }).pts,
        closed: true,
        primIndices: primIndices.reverse(),
      };
    }
    primIndices = [...primIndices];
    return { pts, closed: this.closed, primIndices };
  }

  private currentSide(): 'end' | 'start' | null {
    if (this.closed) return null;
    if (this.sides.end.kind === 'junction') return 'end';
    if (this.sides.start.kind === 'junction') return 'start';
    return null;
  }

  private state(): ChainState {
    const r = this.result();
    const side = this.currentSide();
    let junction: ChainJunction | null = null;
    if (side) {
      const s = this.sides[side] as Extract<SideState, { kind: 'junction' }>;
      junction = {
        side,
        at: this.freeEndPoint(side),
        current: s.current,
        alternatives: s.alts.map((alt) => ({ primIndex: alt.prim, preview: this.preview(s.node, alt) })),
      };
    }
    return {
      status: this.closed ? 'closed' : junction ? 'junction' : 'open',
      closed: this.closed,
      pts: r.pts,
      primIndices: r.primIndices,
      junction,
    };
  }

  private stepStartNode(s: Step): number {
    return this.nodeOf[2 * s.prim + (s.dir === 1 ? 0 : 1)];
  }

  private stepEndNode(s: Step): number {
    return this.nodeOf[2 * s.prim + (s.dir === 1 ? 1 : 0)];
  }

  private freeNode(side: 'end' | 'start'): number {
    return side === 'end'
      ? this.stepEndNode(this.steps[this.steps.length - 1])
      : this.stepStartNode(this.steps[0]);
  }

  private freeEndPoint(side: 'end' | 'start'): Pt {
    const s = side === 'end' ? this.steps[this.steps.length - 1] : this.steps[0];
    const [a, b] = ends(this.prims[s.prim]);
    if (side === 'end') return s.dir === 1 ? b : a;
    return s.dir === 1 ? a : b;
  }

  /** Unit direction leaving the node along primitive `inc`. */
  private leaving(inc: Inc): Pt {
    const p = this.prims[inc.prim];
    return inc.end === 0 ? primTangentAt(p, 0) : neg(primTangentAt(p, 1));
  }

  /** Unit direction of travel when arriving at the free end of `side`. */
  private arriving(side: 'end' | 'start'): Pt {
    const s = side === 'end' ? this.steps[this.steps.length - 1] : this.steps[0];
    // The end of the step's primitive that sits on the free node.
    const endAtNode: 0 | 1 = side === 'end' ? (s.dir === 1 ? 1 : 0) : s.dir === 1 ? 0 : 1;
    return neg(this.leaving({ prim: s.prim, end: endAtNode }));
  }

  private sortAlternatives(arrive: Pt, alts: Inc[]): Inc[] {
    const turn = (inc: Inc) => {
      const d = this.leaving(inc);
      return Math.atan2(arrive.x * d.y - arrive.y * d.x, arrive.x * d.x + arrive.y * d.y);
    };
    return alts
      .map((inc) => ({ inc, t: turn(inc) }))
      .sort((a, b) => Math.abs(a.t) - Math.abs(b.t) || b.t - a.t || a.inc.prim - b.inc.prim)
      .map((x) => x.inc);
  }

  private addStep(side: 'end' | 'start', inc: Inc) {
    this.used.add(inc.prim);
    if (side === 'end') this.steps.push({ prim: inc.prim, dir: inc.end === 0 ? 1 : -1 });
    else this.steps.unshift({ prim: inc.prim, dir: inc.end === 1 ? 1 : -1 });
  }

  private walk(side: 'end' | 'start') {
    for (;;) {
      const node = this.freeNode(side);
      const other = this.freeNode(side === 'end' ? 'start' : 'end');
      if (node === other) {
        this.closed = true;
        this.sides = { end: { kind: 'dead' }, start: { kind: 'dead' } };
        return;
      }
      const cands = this.adj[node].filter((inc) => !this.used.has(inc.prim));
      if (cands.length === 0) {
        this.sides[side] = { kind: 'dead' };
        return;
      }
      if (cands.length === 1) {
        this.addStep(side, cands[0]);
        continue;
      }
      this.sides[side] = {
        kind: 'junction',
        node,
        alts: this.sortAlternatives(this.arriving(side), cands),
        current: 0,
      };
      return;
    }
  }

  /** Auto-follow preview from `node` along `first`, without changing the chain. */
  private preview(node: number, first: Inc): Vertex[] {
    const used = new Set(this.used);
    const steps: Step[] = [];
    const stop = new Set<number>([this.freeNode('end'), this.freeNode('start')]);
    let inc: Inc | null = first;
    let at = node;
    while (inc) {
      used.add(inc.prim);
      steps.push({ prim: inc.prim, dir: inc.end === 0 ? 1 : -1 });
      at = this.nodeOf[2 * inc.prim + (inc.end === 0 ? 1 : 0)];
      if (stop.has(at) || at === node) break;
      const cands: Inc[] = this.adj[at].filter((c) => !used.has(c.prim));
      inc = cands.length === 1 ? cands[0] : null;
    }
    return this.build(steps, false);
  }

  /** Start point, end point and per-step body (bulge or interior points) in traversal direction. */
  private stepGeom(s: Step): { a: Pt; b: Pt; bulge: number; inner: Pt[]; straight: boolean } {
    const p = this.prims[s.prim];
    const [p0, p1] = ends(p);
    const a = s.dir === 1 ? p0 : p1;
    const b = s.dir === 1 ? p1 : p0;
    if (p.k === 'seg') return { a, b, bulge: 0, inner: [], straight: true };
    if (p.k === 'arc') return { a, b, bulge: s.dir * Math.tan(arcSweep(p) / 4), inner: [], straight: false };
    if (p.k === 'ellipse') {
      const inner = this.ellipseInner(p);
      if (s.dir === -1) inner.reverse();
      return { a, b, bulge: 0, inner, straight: false };
    }
    return { a, b, bulge: 0, inner: [], straight: false };
  }

  private ellipseInner(e: EllipsePrim): Pt[] {
    const sweep = ellipseSweep(e);
    // |E''| ≤ the major semi-axis: parameter steps sized for a circle of that radius keep each
    // chord's sagitta within chordTol.
    const rMax = Math.hypot(e.major.x, e.major.y) * Math.max(1, e.ratio);
    const n = arcSegments(Math.max(rMax, 1e-300), sweep, this.chordTol, 4096);
    const out: Pt[] = [];
    for (let i = 1; i < n; i++) out.push(ellipsePoint(e, e.t0 + (sweep * i) / n));
    return out;
  }

  /** Vertex where step g1 hands over to step g2 (exact when the endpoints coincide). */
  private joint(g1: { a: Pt; b: Pt; straight: boolean }, g2: { a: Pt; b: Pt; straight: boolean }): Pt {
    if (g1.b.x === g2.a.x && g1.b.y === g2.a.y) return copy(g1.b);
    if (g1.straight && g2.straight) {
      const x = intersectInfiniteLines(g1.a, g1.b, g2.a, g2.b);
      const reach = 2 * this.gapTol + this.eps;
      if (
        x &&
        Math.hypot(x.x - g1.b.x, x.y - g1.b.y) <= reach &&
        Math.hypot(x.x - g2.a.x, x.y - g2.a.y) <= reach
      ) {
        // Do not trim a line back past its own start.
        const ok1 = (x.x - g1.a.x) * (g1.b.x - g1.a.x) + (x.y - g1.a.y) * (g1.b.y - g1.a.y) > 0;
        const ok2 = (g2.b.x - x.x) * (g2.b.x - g2.a.x) + (g2.b.y - x.y) * (g2.b.y - g2.a.y) > 0;
        if (ok1 && ok2) {
          if (Math.hypot(x.x - g1.b.x, x.y - g1.b.y) <= this.eps) return copy(g1.b);
          if (Math.hypot(x.x - g2.a.x, x.y - g2.a.y) <= this.eps) return copy(g2.a);
          return x;
        }
      }
    }
    return copy(g1.b);
  }

  private build(steps: Step[], closed: boolean): Vertex[] {
    if (steps.length === 0) return [];
    const first = this.prims[steps[0].prim];
    if (steps.length === 1 && closed) return this.closedSingle(first);
    if (first.k === 'point') return [copy(first.p)];
    const geoms = steps.map((s) => this.stepGeom(s));
    const m = geoms.length;
    const out: Vertex[] = [];
    const startPt = closed ? this.joint(geoms[m - 1], geoms[0]) : geoms[0].a;
    let cur = startPt;
    for (let i = 0; i < m; i++) {
      const g = geoms[i];
      out.push(g.bulge ? { x: cur.x, y: cur.y, bulge: g.bulge } : { x: cur.x, y: cur.y });
      for (const p of g.inner) out.push(copy(p));
      if (i + 1 < m) cur = this.joint(g, geoms[i + 1]);
      else if (!closed) out.push(copy(g.b));
    }
    return this.mergeCollinear ? this.merge(out, closed) : out;
  }

  private closedSingle(p: Prim): Vertex[] {
    if (p.k === 'circle') {
      return [
        { x: p.c.x + p.r, y: p.c.y, bulge: 1 },
        { x: p.c.x - p.r, y: p.c.y, bulge: 1 },
      ];
    }
    if (p.k === 'ellipse') {
      const out: Pt[] = [ellipsePoint(p, p.t0), ...this.ellipseInner(p)];
      return out;
    }
    if (p.k === 'arc') {
      // An arc whose ends meet within gapTol: two half arcs closing the gap at the start point.
      const half = Math.tan(arcSweep(p) / 8);
      const mid = p.a0 + arcSweep(p) / 2;
      return [
        { ...arcStart(p), bulge: half },
        { x: p.c.x + p.r * Math.cos(mid), y: p.c.y + p.r * Math.sin(mid), bulge: half },
      ];
    }
    const [a, b] = ends(p);
    return [a, b];
  }

  /** Drops joints whose neighbours are straight and exactly collinear through them. */
  private merge(pts: Vertex[], closed: boolean): Vertex[] {
    const out = pts.slice();
    let changed = true;
    while (changed && out.length > (closed ? 3 : 2)) {
      changed = false;
      for (
        let i = closed ? 0 : 1;
        i < (closed ? out.length : out.length - 1) && out.length > (closed ? 3 : 2);
        i++
      ) {
        const n = out.length;
        const prev = out[(i - 1 + n) % n];
        const v = out[i];
        const next = out[(i + 1) % n];
        if (prev.bulge || v.bulge) continue;
        const d1x = v.x - prev.x;
        const d1y = v.y - prev.y;
        const d2x = next.x - v.x;
        const d2y = next.y - v.y;
        if (d1x * d2x + d1y * d2y <= 0) continue;
        if (distToSegment(v, prev, next) > this.eps) continue;
        out.splice(i, 1);
        changed = true;
        i--;
      }
    }
    return out;
  }
}
