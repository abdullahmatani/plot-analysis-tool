import type { Pt, Vertex } from '@/core/types';

/**
 * Polyline cleanup (FDR row 53): duplicate removal and tolerance-bounded simplification.
 *
 * simplifyPolyline never moves a vertex: its output is a subsequence of the input vertices (same
 * numbers), and every removed vertex lies within `tol` of the simplified segment that replaced
 * it. Arc (bulge) segments are preserved exactly: vertices adjacent to an arc are never removed.
 */

function cloneVertex(v: Vertex, bulge = v.bulge ?? 0): Vertex {
  return bulge ? { x: v.x, y: v.y, bulge } : { x: v.x, y: v.y };
}

/** Distance from p to segment a–b, computed relative to a (precision-safe for large coordinates). */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const qx = p.x - a.x;
  const qy = p.y - a.y;
  const rr = rx * rx + ry * ry;
  if (rr === 0) return Math.hypot(qx, qy);
  let t = (qx * rx + qy * ry) / rr;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(qx - rx * t, qy - ry * t);
}

/**
 * Removes consecutive vertices within `tol` of the previously kept vertex (and, for closed
 * polylines, trailing vertices coinciding with the first). The kept vertex takes over the bulge of
 * the segment that leaves the removed duplicate.
 */
export function removeDuplicateVertices(pts: readonly Vertex[], closed: boolean, tol = 0): Vertex[] {
  const out: Vertex[] = [];
  for (const v of pts) {
    const last = out[out.length - 1];
    if (last && Math.hypot(v.x - last.x, v.y - last.y) <= tol) {
      out[out.length - 1] = cloneVertex(last, v.bulge ?? 0);
      continue;
    }
    out.push(cloneVertex(v));
  }
  if (closed) {
    while (out.length > 1) {
      const last = out[out.length - 1];
      if (Math.hypot(last.x - out[0].x, last.y - out[0].y) > tol) break;
      out.pop();
    }
  }
  return out;
}

/**
 * Douglas–Peucker over the cyclic index range (i, j) of `pts` (j may exceed n for closed rings).
 * Marks kept vertices in `keep`. Uses an explicit stack (no recursion limits).
 */
function dp(pts: readonly Vertex[], i: number, j: number, tol: number, keep: Uint8Array, force = false) {
  const n = pts.length;
  const stack: [number, number, boolean][] = [[i, j, force]];
  while (stack.length) {
    const [s, e, f] = stack.pop()!;
    if (e - s < 2) continue;
    const a = pts[s % n];
    const b = pts[e % n];
    let best = -1;
    let bestD = -1;
    for (let k = s + 1; k < e; k++) {
      const d = distToSegment(pts[k % n], a, b);
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    if (bestD > tol || f) {
      keep[best % n] = 1;
      stack.push([s, best, false], [best, e, false]);
    }
  }
}

/**
 * Tolerance-bounded simplification. Returns a subsequence of the input vertices such that every
 * removed vertex is within `tol` of the simplified path. Vertices adjacent to arc segments are
 * kept so arcs are preserved; closed rings keep at least three vertices.
 */
export function simplifyPolyline(pts: readonly Vertex[], closed: boolean, tol: number): Vertex[] {
  const n = pts.length;
  if (n <= (closed ? 3 : 2) || !(tol >= 0)) return pts.map((v) => cloneVertex(v));
  const keep = new Uint8Array(n);
  const segCount = closed ? n : n - 1;
  for (let s = 0; s < segCount; s++) {
    if (pts[s].bulge) {
      keep[s] = 1;
      keep[(s + 1) % n] = 1;
    }
  }
  if (!closed) {
    keep[0] = 1;
    keep[n - 1] = 1;
  }
  const anchors: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) anchors.push(i);
  if (closed && anchors.length === 0) {
    // Anchor on the vertex farthest from vertex 0, then on the vertex farthest from that one.
    const far = (from: Pt) => {
      let bi = 0;
      let bd = -1;
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(pts[i].x - from.x, pts[i].y - from.y);
        if (d > bd) {
          bd = d;
          bi = i;
        }
      }
      return { i: bi, d: bd };
    };
    const A = far(pts[0]).i;
    const B = far(pts[A]);
    if (B.d === 0) return pts.map((v) => cloneVertex(v));
    const lo = Math.min(A, B.i);
    const hi = Math.max(A, B.i);
    keep[lo] = 1;
    keep[hi] = 1;
    dp(pts, lo, hi, tol, keep);
    dp(pts, hi, lo + n, tol, keep);
  } else if (closed) {
    for (let a = 0; a < anchors.length; a++) {
      const s = anchors[a];
      const e = a + 1 < anchors.length ? anchors[a + 1] : anchors[0] + n;
      dp(pts, s, e, tol, keep);
    }
  } else {
    for (let a = 0; a + 1 < anchors.length; a++) dp(pts, anchors[a], anchors[a + 1], tol, keep);
  }
  let idx: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
  if (closed && idx.length < 3) {
    // Keep rings non-degenerate: force a split of the span holding the vertex farthest from its chord.
    let bestSpan = -1;
    let bestD = -1;
    for (let s = 0; s < idx.length; s++) {
      const a = idx[s];
      const e = s + 1 < idx.length ? idx[s + 1] : idx[0] + n;
      for (let k = a + 1; k < e; k++) {
        const d = distToSegment(pts[k % n], pts[a], pts[e % n]);
        if (d > bestD) {
          bestD = d;
          bestSpan = s;
        }
      }
    }
    if (bestSpan >= 0) {
      const a = idx[bestSpan];
      dp(pts, a, bestSpan + 1 < idx.length ? idx[bestSpan + 1] : idx[0] + n, tol, keep, true);
      idx = [];
      for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
    }
  }
  const out: Vertex[] = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const next = k + 1 < idx.length ? idx[k + 1] : closed ? idx[0] + n : -1;
    // A kept vertex keeps its bulge only when its successor is unchanged (arc segments always are).
    const bulge = next === i + 1 ? (pts[i].bulge ?? 0) : 0;
    out.push(cloneVertex(pts[i], !closed && k === idx.length - 1 ? (pts[i].bulge ?? 0) : bulge));
  }
  return out;
}
