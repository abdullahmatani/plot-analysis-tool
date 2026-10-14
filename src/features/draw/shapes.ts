import {
  Minus,
  Spline,
  Pentagon,
  Square,
  RectangleHorizontal,
  Circle,
  CircleDot,
  Disc,
  Waves,
  Cloud,
  Egg,
} from 'lucide-react';

import type { Geometry, Pt, Vertex } from '@/core/types';
import { parseLength } from '@/core/units';
import { signedArea } from '@/geometry/measure';

import { addObjects } from '@/features/objects/ops';

import { createPickTool, displayUnit, type PickToolSpec } from './pick-tool';

/** Shape tools (row 38). Dimensions can be typed while drawing (Enter to apply). */

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
const ang = (a: Pt, b: Pt) => Math.atan2(b.y - a.y, b.x - a.x);

export function circumcircle(a: Pt, b: Pt, c: Pt): { c: Pt; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  // Relative to a for precision with large coordinates.
  const bx = b.x - a.x;
  const by = b.y - a.y;
  const cx = c.x - a.x;
  const cy = c.y - a.y;
  const dd = 2 * (bx * cy - by * cx);
  if (Math.abs(dd) < 1e-18) return null;
  const ux = (cy * (bx * bx + by * by) - by * (cx * cx + cy * cy)) / dd;
  const uy = (bx * (cx * cx + cy * cy) - cx * (bx * bx + by * by)) / dd;
  return { c: { x: a.x + ux, y: a.y + uy }, r: Math.hypot(ux, uy) };
}

export function arcThrough(p1: Pt, p2: Pt, p3: Pt): Geometry | null {
  const cc = circumcircle(p1, p2, p3);
  if (!cc) return null;
  const a1 = ang(cc.c, p1);
  const a2 = ang(cc.c, p2);
  const a3 = ang(cc.c, p3);
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const ccw = norm(a2 - a1) < norm(a3 - a1);
  return ccw
    ? { type: 'arc', c: cc.c, r: cc.r, a0: a1, a1: a3 }
    : { type: 'arc', c: cc.c, r: cc.r, a0: a3, a1: a1 };
}

export function rotatedRect(p1: Pt, p2: Pt, p3: Pt): Geometry {
  const w = dist(p1, p2);
  const rot = ang(p1, p2);
  const nx = -Math.sin(rot);
  const ny = Math.cos(rot);
  const h = (p3.x - p1.x) * nx + (p3.y - p1.y) * ny;
  return {
    type: 'rect',
    c: { x: (p1.x + p2.x) / 2 + (nx * h) / 2, y: (p1.y + p2.y) / 2 + (ny * h) / 2 },
    w: Math.max(w, 1e-9),
    h: Math.max(Math.abs(h), 1e-9),
    rot,
  };
}

export function axisRect(a: Pt, b: Pt): Geometry {
  return {
    type: 'rect',
    c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    w: Math.max(Math.abs(b.x - a.x), 1e-9),
    h: Math.max(Math.abs(b.y - a.y), 1e-9),
    rot: 0,
  };
}

/** Revision cloud: polygon edges replaced by outward arcs of about `arcLen`. */
export function cloudFromPolygon(pts: Pt[], arcLen: number): Vertex[] {
  let ring = pts.map((p) => ({ x: p.x, y: p.y }));
  if (signedArea(ring) < 0) ring = ring.reverse();
  const out: Vertex[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const n = Math.max(1, Math.round(dist(a, b) / arcLen));
    for (let k = 0; k < n; k++)
      out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n, bulge: 0.55 });
  }
  return out;
}

function polyFromPts(pts: Pt[], closed: boolean): Geometry {
  return { type: 'polyline', pts: pts.map((p) => ({ x: p.x, y: p.y })), closed };
}

function withCursor(pts: Pt[], cursor: Pt | null): Pt[] {
  return cursor ? [...pts, cursor] : pts;
}

const add = (geometry: Geometry, label: string, kind: 'shape' | 'cloud' = 'shape') =>
  addObjects([{ geometry, kind }], label).length > 0;

const parseLen = (v: string) => parseLength(v, displayUnit());

export const SHAPE_TOOLS: (PickToolSpec & { shortcut?: string })[] = [
  {
    id: 'draw.line',
    title: 'Line',
    icon: Minus,
    shortcut: 'L',
    creates: true,
    minPoints: 2,
    maxPoints: 2,
    prompt: (n) => (n === 0 ? 'Line: first point' : 'Line: next point (or type a length)'),
    preview: (pts, c) => (pts.length && c ? polyFromPts([pts[0], c], false) : null),
    finish: (pts) => add(polyFromPts(pts, false), 'Draw line'),
  },
  {
    id: 'draw.polyline',
    title: 'Polyline',
    icon: Spline,
    shortcut: 'P',
    creates: true,
    minPoints: 2,
    prompt: (n) =>
      n === 0 ? 'Polyline: first point' : 'Polyline: next point · Enter or double-click to finish',
    preview: (pts, c) => (pts.length ? polyFromPts(withCursor(pts, c), false) : null),
    finish: (pts) => add(polyFromPts(pts, false), 'Draw polyline'),
    key: (e, pts) => (e.key.toLowerCase() === 'c' && pts.length >= 3 ? 'finish' : null),
  },
  {
    id: 'draw.polygon',
    title: 'Polygon',
    icon: Pentagon,
    shortcut: 'G',
    creates: true,
    minPoints: 3,
    prompt: (n) =>
      n < 3 ? `Polygon: point ${n + 1}` : 'Polygon: next point · Enter or double-click to close',
    preview: (pts, c) => (pts.length ? polyFromPts(withCursor(pts, c), pts.length >= 2) : null),
    finish: (pts) => add(polyFromPts(pts, true), 'Draw polygon'),
  },
  {
    id: 'draw.rect',
    title: 'Rectangle',
    icon: Square,
    shortcut: 'R',
    creates: true,
    minPoints: 2,
    maxPoints: 2,
    prompt: (n) =>
      n === 0 ? 'Rectangle: first corner' : 'Rectangle: opposite corner (or type width,height)',
    preview: (pts, c) => (pts.length && c ? axisRect(pts[0], c) : null),
    typed: (v, pts, c) => {
      const m = /^([^,@<]+),([^,]+)$/.exec(v.trim());
      if (pts.length !== 1 || !m) return null;
      const w = parseLen(m[1]);
      const h = parseLen(m[2]);
      if (w === null || h === null) return null;
      const sx = c && c.x < pts[0].x ? -1 : 1;
      const sy = c && c.y < pts[0].y ? -1 : 1;
      return { x: pts[0].x + sx * Math.abs(w), y: pts[0].y + sy * Math.abs(h) };
    },
    finish: (pts) => add(axisRect(pts[0], pts[1]), 'Draw rectangle'),
  },
  {
    id: 'draw.rectRotated',
    title: 'Rotated rectangle',
    icon: RectangleHorizontal,
    creates: true,
    minPoints: 3,
    maxPoints: 3,
    prompt: (n) =>
      [
        'Rotated rectangle: first corner of the base',
        'Second corner of the base (sets the angle)',
        'Height (pick or type)',
      ][n] ?? '',
    preview: (pts, c) =>
      pts.length === 1 && c
        ? polyFromPts([pts[0], c], false)
        : pts.length === 2 && c
          ? rotatedRect(pts[0], pts[1], c)
          : null,
    typed: (v, pts, c) => {
      if (pts.length !== 2) return null;
      const h = parseLen(v);
      if (h === null) return null;
      const r = ang(pts[0], pts[1]);
      const nx = -Math.sin(r);
      const ny = Math.cos(r);
      const side = c && (c.x - pts[0].x) * nx + (c.y - pts[0].y) * ny < 0 ? -1 : 1;
      return { x: pts[1].x + nx * h * side, y: pts[1].y + ny * h * side };
    },
    finish: (pts) => add(rotatedRect(pts[0], pts[1], pts[2]), 'Draw rotated rectangle'),
  },
  {
    id: 'draw.circle',
    title: 'Circle (centre, radius)',
    icon: Circle,
    shortcut: 'C',
    creates: true,
    minPoints: 2,
    maxPoints: 2,
    prompt: (n) =>
      n === 0 ? 'Circle: centre' : 'Circle: radius (pick, or type a radius; "d30" or "Ø30" for a diameter)',
    preview: (pts, c) => (pts.length && c ? { type: 'circle', c: pts[0], r: dist(pts[0], c) } : null),
    typedStart: (k, pts) => pts.length === 1 && /^[dD]$/.test(k),
    typed: (v, pts) => {
      if (pts.length !== 1) return null;
      const dia = /^\s*(d|ø|Ø|dia)\s*(.+)$/i.exec(v);
      const r = dia ? (parseLen(dia[2]) ?? NaN) / 2 : parseLen(v);
      if (r === null || !(r > 0)) return null;
      return { x: pts[0].x + r, y: pts[0].y };
    },
    finish: (pts) => add({ type: 'circle', c: pts[0], r: dist(pts[0], pts[1]) }, 'Draw circle'),
  },
  {
    id: 'draw.circleDiameter',
    title: 'Circle (centre, diameter)',
    icon: CircleDot,
    creates: true,
    minPoints: 2,
    maxPoints: 2,
    prompt: (n) =>
      n === 0 ? 'Circle: centre' : 'Circle: diameter (pick a point on the diameter or type it)',
    preview: (pts, c) => (pts.length && c ? { type: 'circle', c: pts[0], r: dist(pts[0], c) / 2 } : null),
    typedStart: (k, pts) => pts.length === 1 && /^[dD]$/.test(k),
    typed: (v, pts) => {
      if (pts.length !== 1) return null;
      const d = parseLen(v.replace(/^\s*(ø|Ø|d)\s*/i, ''));
      if (d === null || !(d > 0)) return null;
      return { x: pts[0].x + d, y: pts[0].y };
    },
    finish: (pts) => add({ type: 'circle', c: pts[0], r: dist(pts[0], pts[1]) / 2 }, 'Draw circle'),
  },
  {
    id: 'draw.circle3',
    title: 'Circle (3 points)',
    icon: Disc,
    creates: true,
    minPoints: 3,
    maxPoints: 3,
    prompt: (n) => `Circle through 3 points: point ${n + 1}`,
    preview: (pts, c) => {
      const all = withCursor(pts, c);
      if (all.length === 3) {
        const cc = circumcircle(all[0], all[1], all[2]);
        return cc ? { type: 'circle', c: cc.c, r: cc.r } : null;
      }
      return all.length === 2 ? polyFromPts(all, false) : null;
    },
    finish: (pts) => {
      const cc = circumcircle(pts[0], pts[1], pts[2]);
      return cc ? add({ type: 'circle', c: cc.c, r: cc.r }, 'Draw circle') : false;
    },
  },
  {
    id: 'draw.arc3',
    title: 'Arc (3 points)',
    icon: Waves,
    shortcut: 'A',
    creates: true,
    minPoints: 3,
    maxPoints: 3,
    prompt: (n) => ['Arc: start point', 'Arc: a point on the arc', 'Arc: end point'][n] ?? '',
    preview: (pts, c) => {
      const all = withCursor(pts, c);
      return all.length === 3
        ? arcThrough(all[0], all[1], all[2])
        : all.length === 2
          ? polyFromPts(all, false)
          : null;
    },
    finish: (pts) => {
      const g = arcThrough(pts[0], pts[1], pts[2]);
      return g ? add(g, 'Draw arc') : false;
    },
  },
  {
    id: 'draw.arcCentre',
    title: 'Arc (centre, start, end)',
    creates: true,
    minPoints: 3,
    maxPoints: 3,
    prompt: (n) =>
      ['Arc: centre', 'Arc: start point (sets the radius)', 'Arc: end point (counter-clockwise)'][n] ?? '',
    preview: (pts, c) => {
      const all = withCursor(pts, c);
      if (all.length === 3)
        return {
          type: 'arc',
          c: all[0],
          r: dist(all[0], all[1]),
          a0: ang(all[0], all[1]),
          a1: ang(all[0], all[2]),
        };
      return all.length === 2 ? { type: 'circle', c: all[0], r: dist(all[0], all[1]) } : null;
    },
    finish: (pts) =>
      add(
        { type: 'arc', c: pts[0], r: dist(pts[0], pts[1]), a0: ang(pts[0], pts[1]), a1: ang(pts[0], pts[2]) },
        'Draw arc',
      ),
  },
  {
    id: 'draw.ellipse',
    title: 'Ellipse',
    icon: Egg,
    shortcut: 'E',
    creates: true,
    minPoints: 3,
    maxPoints: 3,
    prompt: (n) =>
      ['Ellipse: centre', 'Ellipse: end of the first axis', 'Ellipse: other axis length'][n] ?? '',
    preview: (pts, c) => {
      const all = withCursor(pts, c);
      if (all.length === 2) return polyFromPts(all, false);
      if (all.length === 3) return ellipseOf(all);
      return null;
    },
    typed: (v, pts) => {
      if (pts.length !== 2) return null;
      const r = parseLen(v);
      if (r === null) return null;
      const a = ang(pts[0], pts[1]) + Math.PI / 2;
      return { x: pts[0].x + r * Math.cos(a), y: pts[0].y + r * Math.sin(a) };
    },
    finish: (pts) => add(ellipseOf(pts), 'Draw ellipse'),
  },
  {
    id: 'draw.cloud',
    title: 'Revision cloud',
    icon: Cloud,
    creates: true,
    minPoints: 3,
    prompt: (n) =>
      n < 3 ? `Revision cloud: corner ${n + 1}` : 'Revision cloud: next corner · Enter to close',
    preview: (pts, c) => (pts.length ? polyFromPts(withCursor(pts, c), pts.length >= 2) : null),
    finish: (pts) => {
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      return add(
        { type: 'polyline', pts: cloudFromPolygon(pts, Math.max(diag / 25, 1e-6)), closed: true },
        'Draw revision cloud',
        'cloud',
      );
    },
  },
];

function ellipseOf(pts: Pt[]): Geometry {
  const c = pts[0];
  const rx = dist(c, pts[1]);
  const rot = ang(c, pts[1]);
  const nx = -Math.sin(rot);
  const ny = Math.cos(rot);
  const ry = Math.abs((pts[2].x - c.x) * nx + (pts[2].y - c.y) * ny);
  return { type: 'ellipse', c, rx: Math.max(rx, 1e-9), ry: Math.max(ry, 1e-9), rot };
}

export const shapeTools = SHAPE_TOOLS.map((s) => ({ spec: s, tool: createPickTool(s) }));
