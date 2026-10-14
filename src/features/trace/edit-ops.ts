import type { Geometry, Pt, Vertex } from '@/core/types';
import { isClosed, toPolyline } from '@/geometry/convert';
import { bulgeMidpoint } from '@/geometry/measure';
import {
  closePolyline,
  convertSegment,
  insertVertex,
  joinPolylines,
  locateOnPolyline,
  moveVertex,
  openPolyline,
  removeVertex,
  reversePolyline,
  segmentCount,
  splitPolyline,
  type Poly,
  type SegmentConversion,
} from '@/geometry/polyline-edit';
import { removeDuplicateVertices, simplifyPolyline } from '@/geometry/simplify';

/**
 * Trace editing and cleanup (row 53) on analysis geometry: polylines and multipolygon rings are
 * edited directly; rectangles, circles, arcs and ellipses are first converted to their (exact,
 * except ellipses) bulge polyline. All functions are pure and return new geometry.
 */

export interface Editable {
  polys: Poly[];
  /** Multipolygon (rings) rather than a single polyline. */
  multi: boolean;
}

/** Polyline view of a geometry for editing (null for points). */
export function editable(g: Geometry, chordTol: number): Editable | null {
  switch (g.type) {
    case 'point':
      return null;
    case 'polyline':
      return { polys: [{ pts: g.pts, closed: g.closed }], multi: false };
    case 'multipolygon':
      return { polys: g.rings.map((r) => ({ pts: r, closed: true })), multi: true };
    default:
      return { polys: toPolyline(g, chordTol).map((pts) => ({ pts, closed: isClosed(g) })), multi: false };
  }
}

export function fromEditable(e: Editable): Geometry {
  if (e.multi) return { type: 'multipolygon', rings: e.polys.map((p) => p.pts) };
  const p = e.polys[0];
  return { type: 'polyline', pts: p.pts, closed: p.closed };
}

function mapPolys(g: Geometry, chordTol: number, fn: (p: Poly) => Poly): Geometry | null {
  const e = editable(g, chordTol);
  if (!e) return null;
  return fromEditable({ ...e, polys: e.polys.map(fn) });
}

export function reverseGeometry(g: Geometry, chordTol: number): Geometry | null {
  return mapPolys(g, chordTol, reversePolyline);
}

export function closeGeometry(g: Geometry, chordTol: number): Geometry | null {
  if (g.type !== 'polyline' && g.type !== 'arc') return null;
  const e = editable(g, chordTol)!;
  const p = e.polys[0];
  if (p.closed || p.pts.length < 2) return null;
  return fromEditable({ polys: [closePolyline(p, 0)], multi: false });
}

export function openGeometry(g: Geometry, chordTol: number): Geometry | null {
  if (g.type === 'multipolygon' || g.type === 'point') return null;
  const e = editable(g, chordTol)!;
  const p = e.polys[0];
  if (!p.closed) return null;
  return fromEditable({ polys: [openPolyline(p)], multi: false });
}

/** Removes consecutive vertices closer than `tol`; returns null when nothing changes. */
export function dedupeGeometry(g: Geometry, tol: number): { geometry: Geometry; removed: number } | null {
  if (g.type !== 'polyline' && g.type !== 'multipolygon') return null;
  const e = editable(g, 0)!;
  let removed = 0;
  const polys = e.polys.map((p) => {
    const pts = removeDuplicateVertices(p.pts, p.closed, tol);
    removed += p.pts.length - pts.length;
    return { pts, closed: p.closed };
  });
  if (!removed) return null;
  return { geometry: fromEditable({ ...e, polys }), removed };
}

/**
 * Tolerance-bounded simplification: the result keeps a subsequence of the vertices (never moved)
 * and every removed vertex is within `tol` of the simplified outline; arcs are kept.
 */
export function simplifyGeometry(g: Geometry, tol: number): { geometry: Geometry; removed: number } | null {
  if (g.type !== 'polyline' && g.type !== 'multipolygon') return null;
  const e = editable(g, 0)!;
  let removed = 0;
  const polys = e.polys.map((p) => {
    const pts = simplifyPolyline(p.pts, p.closed, tol);
    removed += p.pts.length - pts.length;
    return { pts, closed: p.closed };
  });
  if (!removed) return null;
  return { geometry: fromEditable({ ...e, polys }), removed };
}

// ------------------------------------------------------------------------------- locating

export interface VertexRef {
  ring: number;
  index: number;
  pt: Pt;
  dist: number;
}

export interface SegmentRef {
  ring: number;
  index: number;
  /** Parameter along the segment (angular on arcs). */
  t: number;
  /** Nearest point on the segment. */
  pt: Pt;
  dist: number;
}

export function nearestVertex(g: Geometry, p: Pt, chordTol: number): VertexRef | null {
  const e = editable(g, chordTol);
  if (!e) return null;
  let best: VertexRef | null = null;
  e.polys.forEach((poly, ring) =>
    poly.pts.forEach((v, index) => {
      const dist = Math.hypot(v.x - p.x, v.y - p.y);
      if (!best || dist < best.dist) best = { ring, index, pt: { x: v.x, y: v.y }, dist };
    }),
  );
  return best;
}

export function nearestSegment(g: Geometry, p: Pt, chordTol: number): SegmentRef | null {
  const e = editable(g, chordTol);
  if (!e) return null;
  let best: SegmentRef | null = null;
  e.polys.forEach((poly, ring) => {
    const loc = locateOnPolyline(poly, p);
    if (loc && (!best || loc.dist < best.dist))
      best = { ring, index: loc.index, t: loc.t, pt: loc.pt, dist: loc.dist };
  });
  return best;
}

function replaceRing(e: Editable, ring: number, poly: Poly): Geometry {
  return fromEditable({ ...e, polys: e.polys.map((p, i) => (i === ring ? poly : p)) });
}

/**
 * Inserts a vertex on a segment. `at` is used as is when it lies on the segment (keeps snapped
 * coordinates exact), otherwise its projection onto the segment.
 */
export function insertVertexAt(
  g: Geometry,
  seg: SegmentRef,
  at: Pt,
  chordTol: number,
  onTol: number,
): Geometry | null {
  const e = editable(g, chordTol);
  if (!e) return null;
  const poly = e.polys[seg.ring];
  if (!poly || seg.index >= segmentCount(poly)) return null;
  // The snapped point may lie on another segment of the ring than the one under the cursor.
  const loc = locateOnPolyline(poly, at);
  if (loc && loc.dist <= onTol) return replaceRing(e, seg.ring, insertVertex(poly, loc.index, at));
  return replaceRing(e, seg.ring, insertVertex(poly, seg.index, seg.pt));
}

export function removeVertexAt(
  g: Geometry,
  v: { ring: number; index: number },
  chordTol: number,
): Geometry | null {
  const e = editable(g, chordTol);
  if (!e) return null;
  const poly = e.polys[v.ring];
  if (!poly) return null;
  const minPts = poly.closed ? 3 : 2;
  if (poly.pts.length <= minPts) return null;
  const r = removeVertex(poly, v.index);
  return r ? replaceRing(e, v.ring, r) : null;
}

/** Splits at a vertex or a point on a segment. Multipolygons cannot be split. */
export function splitGeometryAt(
  g: Geometry,
  at: { vertex: number } | { segment: number; t: number },
  chordTol: number,
): Geometry[] | null {
  if (g.type === 'multipolygon' || g.type === 'point') return null;
  const e = editable(g, chordTol)!;
  const poly = e.polys[0];
  const parts = splitPolyline(poly, 'vertex' in at ? at.vertex : { index: at.segment, t: at.t });
  if (parts.length === 1 && !poly.closed) return null;
  return parts.filter((p) => p.pts.length >= 2).map((p) => fromEditable({ polys: [p], multi: false }));
}

export function convertSegmentAt(
  g: Geometry,
  seg: { ring: number; index: number },
  to: SegmentConversion,
  chordTol: number,
): Geometry | null {
  const e = editable(g, chordTol);
  if (!e) return null;
  const poly = e.polys[seg.ring];
  if (!poly || seg.index >= segmentCount(poly)) return null;
  const r = convertSegment(poly, seg.index, to);
  return r ? replaceRing(e, seg.ring, r) : null;
}

export function segmentIsArc(g: Geometry, seg: { ring: number; index: number }, chordTol: number): boolean {
  const e = editable(g, chordTol);
  return !!e?.polys[seg.ring]?.pts[seg.index]?.bulge;
}

/**
 * Joins open polylines whose ends meet within `tol`, starting from the first one. Returns the
 * joined geometry and the indices (into `gs`) that were consumed (including 0).
 */
export function joinGeometries(gs: Geometry[], tol: number): { geometry: Geometry; used: number[] } | null {
  const polys: (Poly | null)[] = gs.map((g) =>
    g.type === 'polyline' && !g.closed && g.pts.length >= 2 ? { pts: g.pts, closed: false } : null,
  );
  if (!polys[0]) return null;
  let acc: Poly = polys[0];
  const used = [0];
  let progress = true;
  while (progress && !acc.closed) {
    progress = false;
    for (let i = 1; i < polys.length; i++) {
      const p = polys[i];
      if (!p || used.includes(i)) continue;
      const j = joinPolylines(acc, p, tol);
      if (j) {
        acc = j;
        used.push(i);
        progress = true;
        if (acc.closed) break;
      }
    }
  }
  if (used.length < 2) return null;
  return { geometry: { type: 'polyline', pts: acc.pts, closed: acc.closed }, used };
}

// ------------------------------------------------------------------------------- insert grips

export interface InsertGrip {
  ring: number;
  index: number;
  pt: Pt;
}

/** Midpoints of every segment (for "+" grips), polylines and multipolygons up to `max` segments. */
export function segmentMidpoints(g: Geometry, max = 400): InsertGrip[] {
  if (g.type !== 'polyline' && g.type !== 'multipolygon') return [];
  const rings: { pts: Vertex[]; closed: boolean }[] =
    g.type === 'polyline'
      ? [{ pts: g.pts, closed: g.closed }]
      : g.rings.map((pts) => ({ pts, closed: true }));
  const total = rings.reduce((n, r) => n + segmentCount(r), 0);
  if (total > max) return [];
  const out: InsertGrip[] = [];
  rings.forEach((r, ring) => {
    const n = r.pts.length;
    for (let i = 0; i < segmentCount(r); i++) {
      const a = r.pts[i];
      const b = r.pts[(i + 1) % n];
      if (a.x === b.x && a.y === b.y) continue;
      out.push({ ring, index: i, pt: bulgeMidpoint(a, b, a.bulge) });
    }
  });
  return out;
}

/** Inserts a vertex at the midpoint of a segment and moves it to `to` (dragging a "+" grip). */
export function insertAndMove(g: Geometry, grip: InsertGrip, to: Pt): Geometry | null {
  const e = editable(g, 0);
  if (!e || (g.type !== 'polyline' && g.type !== 'multipolygon')) return null;
  const poly = e.polys[grip.ring];
  if (!poly || grip.index >= segmentCount(poly)) return null;
  const inserted = insertVertex(poly, grip.index, grip.pt);
  return replaceRing(e, grip.ring, moveVertex(inserted, grip.index + 1, to));
}
