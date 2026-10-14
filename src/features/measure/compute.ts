import type { AnalysisObject, Geometry, MeasurementInfo, Project, ProjectDisplay, Pt } from '@/core/types';
import { segmentLength } from '@/geometry/bulge';
import { isClosed } from '@/geometry/convert';
import { area, length, perimeter, radiusOf } from '@/geometry/measure';
import { ccwSweep } from '@/geometry/vec';

import { coordinateAxes, fmtAngle, fmtArea, fmtCoord, fmtLength, unitLabel } from '@/features/units/format';

/**
 * Measurement values (row 35) computed exactly from world geometry (float64, analytic arcs and
 * bulges) and their text in the project's display units. Used by the live tools, the result panel,
 * measurement annotations on the canvas and exports.
 */

export type MeasureMode = MeasurementInfo['mode'];

export interface MeasureValues {
  mode: MeasureMode;
  distance?: number;
  dx?: number;
  dy?: number;
  /** Direction of the measured line, radians CCW from +X. */
  direction?: number;
  segments?: number[];
  total?: number;
  area?: number;
  perimeter?: number;
  radius?: number;
  diameter?: number;
  arcLength?: number;
  sweep?: number;
  angle?: number;
  point?: Pt;
}

function pathPoints(g: Geometry): Pt[] {
  if (g.type === 'polyline') return g.pts;
  if (g.type === 'point') return [g.p];
  return [];
}

/** Interior angle (0…π) at `v` between the arms to `a` and `b`. */
export function angleAt(a: Pt, v: Pt, b: Pt): number {
  const ux = a.x - v.x;
  const uy = a.y - v.y;
  const wx = b.x - v.x;
  const wy = b.y - v.y;
  return Math.atan2(Math.abs(ux * wy - uy * wx), ux * wx + uy * wy);
}

export function polylineSegments(g: Extract<Geometry, { type: 'polyline' }>): number[] {
  const n = g.pts.length;
  const segs = g.closed ? n : n - 1;
  const out: number[] = [];
  for (let i = 0; i < segs; i++) out.push(segmentLength(g.pts[i], g.pts[(i + 1) % n], g.pts[i].bulge));
  return out;
}

/** The natural measurement of a picked object or entity: radius for circular shapes, area for closed ones, length otherwise. */
export function modeForGeometry(g: Geometry): MeasureMode {
  if (g.type === 'point') return 'point';
  if (radiusOf(g) !== null && (g.type === 'circle' || g.type === 'arc')) return 'radius';
  return isClosed(g) ? 'area' : 'length';
}

export function measureGeometry(mode: MeasureMode, g: Geometry): MeasureValues {
  const v: MeasureValues = { mode };
  const pts = pathPoints(g);
  switch (mode) {
    case 'distance':
    case 'check': {
      if (pts.length < 2) break;
      const a = pts[0];
      const b = pts[pts.length - 1];
      v.dx = b.x - a.x;
      v.dy = b.y - a.y;
      v.distance = Math.hypot(v.dx, v.dy);
      v.direction = Math.atan2(v.dy, v.dx);
      break;
    }
    case 'chain':
    case 'length':
      if (g.type === 'polyline') {
        v.segments = polylineSegments(g);
        v.total = v.segments.reduce((s, x) => s + x, 0);
      } else {
        v.total = length(g);
      }
      if (g.type === 'arc') {
        v.radius = Math.abs(g.r);
        v.sweep = ccwSweep(g.a0, g.a1);
      }
      break;
    case 'area':
      v.area = area(g);
      v.perimeter = perimeter(g);
      if (g.type === 'polyline') v.segments = polylineSegments(g);
      break;
    case 'radius': {
      const r = radiusOf(g);
      if (r !== null) {
        v.radius = r;
        v.diameter = 2 * r;
      }
      if (g.type === 'arc') {
        v.sweep = ccwSweep(g.a0, g.a1);
        v.arcLength = Math.abs(g.r) * v.sweep;
      } else if (isClosed(g)) {
        v.area = area(g);
        v.perimeter = perimeter(g);
      }
      break;
    }
    case 'angle':
      if (pts.length >= 3) v.angle = angleAt(pts[0], pts[1], pts[2]);
      break;
    case 'point':
      if (g.type === 'point') v.point = { x: g.p.x, y: g.p.y };
      else if (pts.length) v.point = { x: pts[0].x, y: pts[0].y };
      break;
  }
  return v;
}

export interface MeasureText {
  title: string;
  /** Main value (e.g. "25.000 m"). */
  primary: string;
  details: { label: string; value: string }[];
}

const TITLES: Record<MeasureMode, string> = {
  distance: 'Distance',
  chain: 'Chained distance',
  length: 'Length',
  area: 'Area',
  radius: 'Radius',
  angle: 'Angle',
  check: 'Check distance',
  point: 'Point',
};

export function measureText(
  v: MeasureValues,
  d: ProjectDisplay,
  axes: [string, string] = ['X', 'Y'],
): MeasureText {
  const L = (m: number) => fmtLength(m, d);
  const details: MeasureText['details'] = [];
  let primary = '—';
  switch (v.mode) {
    case 'distance':
    case 'check':
      if (v.distance !== undefined) {
        primary = L(v.distance);
        details.push({ label: `Δ${axes[0]}`, value: L(v.dx!) });
        details.push({ label: `Δ${axes[1]}`, value: L(v.dy!) });
        details.push({ label: 'Direction', value: fmtAngle(v.direction!, d) });
      }
      break;
    case 'chain':
    case 'length':
      if (v.total !== undefined) {
        primary = L(v.total);
        if (v.segments && v.segments.length > 1) {
          details.push({ label: 'Segments', value: String(v.segments.length) });
          details.push({ label: 'Last segment', value: L(v.segments[v.segments.length - 1]) });
        }
        if (v.radius !== undefined) details.push({ label: 'Radius', value: L(v.radius) });
        if (v.sweep !== undefined) details.push({ label: 'Sweep', value: fmtAngle(v.sweep, d) });
      }
      break;
    case 'area':
      if (v.area !== undefined) {
        primary = fmtArea(v.area, d);
        details.push({ label: 'Perimeter', value: L(v.perimeter!) });
        if (v.segments) details.push({ label: 'Sides', value: String(v.segments.length) });
      }
      break;
    case 'radius':
      if (v.radius !== undefined) {
        primary = `R ${L(v.radius)}`;
        details.push({ label: 'Diameter', value: L(v.diameter!) });
        if (v.arcLength !== undefined) details.push({ label: 'Arc length', value: L(v.arcLength) });
        if (v.sweep !== undefined) details.push({ label: 'Sweep', value: fmtAngle(v.sweep, d) });
        if (v.area !== undefined) details.push({ label: 'Area', value: fmtArea(v.area, d) });
        if (v.perimeter !== undefined) details.push({ label: 'Circumference', value: L(v.perimeter) });
      } else primary = 'Not circular';
      break;
    case 'angle':
      if (v.angle !== undefined) {
        primary = fmtAngle(v.angle, d);
        details.push({ label: 'Supplement', value: fmtAngle(Math.PI - v.angle, d) });
      }
      break;
    case 'point':
      if (v.point) {
        // Two lines: one per coordinate.
        primary = [
          `${axes[0]} ${fmtCoord(v.point.x, d)} ${unitLabel(d)}`,
          `${axes[1]} ${fmtCoord(v.point.y, d)} ${unitLabel(d)}`,
        ].join('\n');
      }
      break;
  }
  return { title: TITLES[v.mode], primary, details };
}

/** Text lines of a measurement annotation in the project's current display settings (canvas and exports). */
export function annotationLines(project: Project, o: AnalysisObject): string[] {
  const mode = o.measurement?.mode ?? modeForGeometry(o.geometry);
  const v = measureGeometry(mode, o.geometry);
  const t = measureText(v, project.display, coordinateAxes(project));
  if (mode === 'area' && v.perimeter !== undefined)
    return [t.primary, `P ${fmtLength(v.perimeter, project.display)}`];
  if (mode === 'radius' && v.diameter !== undefined)
    return [`${t.primary} · Ø ${fmtLength(v.diameter, project.display)}`];
  if (mode === 'check' && o.measurement?.value !== undefined)
    return [`${t.primary} (check ${fmtLength(o.measurement.value, project.display)})`];
  return t.primary.split('\n');
}

/** Plain-text result for the clipboard. */
export function resultClipboardText(t: MeasureText): string {
  return [`${t.title}: ${t.primary}`, ...t.details.map((x) => `${x.label}: ${x.value}`)].join('\n');
}
