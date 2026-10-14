import {
  Circle,
  LocateFixed,
  Ruler,
  Spline,
  SquareDashed,
  Triangle,
  ScanLine,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import type { Geometry, Pt } from '@/core/types';
import { transformGeometry } from '@/geometry/convert';
import { distanceToGeometry } from '@/geometry/hit';
import { radiusOf } from '@/geometry/measure';
import { traceGeometry } from '@/render/draw-geometry';
import { getProject } from '@/store/project';
import { refreshHint, setTool } from '@/tools/registry';
import type { FrameInfo, Tool } from '@/tools/types';
import { entityToGeometry } from '@/underlay/entity-geometry';
import { getModel } from '@/underlay/models';
import { drawingPlacement, pickUnderlay } from '@/underlay/pick';

import { createPickTool, type PickToolSpec } from '@/features/draw/pick-tool';
import { geomBounds } from '@/features/objects/geometry-cache';
import { pickObject } from '@/features/objects/pick';
import { coordinateAxes, displayOf } from '@/features/units/format';

import { addMeasurement } from './annotations';
import { measureGeometry, measureText, modeForGeometry, type MeasureMode } from './compute';
import { drawMeasurement } from './draw';
import { useMeasureStore, type MeasureEntry } from './store';

/**
 * Measurement tools (row 35): distance, chained distance, area & perimeter, angle, point
 * coordinates (picked with snapping and typed input via the shared pick-tool framework), and
 * length / area / radius of a picked object or underlay entity. Results show live; finished
 * measurements are kept as annotations when "Keep" is on.
 */

export interface MeasureToolDef {
  id: string;
  title: string;
  icon: LucideIcon;
  shortcut?: string;
  tool: Tool;
}

const ACCENT = '#0ea5e9';

export function liveStyle(f: FrameInfo) {
  return { color: ACCENT, fill: 'rgba(14,165,233,0.12)', textPx: 12, lightBg: f.lightBg };
}

function linesFor(entry: MeasureEntry): string[] {
  const p = getProject();
  const d = displayOf(p);
  const t = measureText(measureGeometry(entry.mode, entry.geometry), d, p ? coordinateAxes(p) : ['X', 'Y']);
  return t.primary.split('\n');
}

export function drawEntry(g: CanvasRenderingContext2D, f: FrameInfo, entry: MeasureEntry, dim = false) {
  g.save();
  if (dim) g.globalAlpha = 0.6;
  drawMeasurement(g, f, entry.mode, entry.geometry, linesFor(entry), liveStyle(f));
  g.restore();
}

const MODE_LABEL: Record<MeasureMode, string> = {
  distance: 'distance',
  chain: 'chained distance',
  length: 'length',
  area: 'area',
  radius: 'radius',
  angle: 'angle',
  check: 'check',
  point: 'point',
};

/** Finishes a measurement: shows it in the result panel and keeps it as an annotation when asked. */
export function finishMeasurement(entry: MeasureEntry) {
  const st = useMeasureStore.getState();
  let keptId: string | null = null;
  if (st.keep)
    keptId = addMeasurement(
      entry.geometry,
      entry.mode,
      undefined,
      `Add ${MODE_LABEL[entry.mode]} measurement`,
    );
  st.setResult({ ...entry, keptId });
}

const poly = (pts: Pt[], closed = false): Geometry => ({
  type: 'polyline',
  pts: pts.map((p) => ({ x: p.x, y: p.y })),
  closed,
});

function withCursor(pts: Pt[], c: Pt | null): Pt[] {
  return c ? [...pts, c] : pts;
}

interface MeasureSpec {
  id: string;
  title: string;
  icon: LucideIcon;
  shortcut?: string;
  mode: MeasureMode;
  minPoints: number;
  maxPoints?: number;
  prompt(n: number): string;
  /** Geometry from the picked points (+ cursor while live). */
  geometry(pts: Pt[]): Geometry | null;
}

const SPECS: MeasureSpec[] = [
  {
    id: 'measure.distance',
    title: 'Measure distance',
    icon: Ruler,
    shortcut: 'D',
    mode: 'distance',
    minPoints: 2,
    maxPoints: 2,
    prompt: (n) => (n === 0 ? 'Distance: first point' : 'Distance: second point'),
    geometry: (pts) => (pts.length >= 2 ? poly([pts[0], pts[pts.length - 1]]) : null),
  },
  {
    id: 'measure.chain',
    title: 'Measure chained distance / polyline length',
    icon: Spline,
    mode: 'chain',
    minPoints: 2,
    prompt: (n) =>
      n === 0 ? 'Chained distance: first point' : 'Next point · Enter or double-click to finish',
    geometry: (pts) => (pts.length >= 2 ? poly(pts) : null),
  },
  {
    id: 'measure.area',
    title: 'Measure area and perimeter',
    icon: SquareDashed,
    mode: 'area',
    minPoints: 3,
    prompt: (n) => (n < 3 ? `Area: corner ${n + 1}` : 'Area: next corner · Enter or double-click to close'),
    geometry: (pts) => (pts.length >= 3 ? poly(pts, true) : pts.length === 2 ? poly(pts) : null),
  },
  {
    id: 'measure.angle',
    title: 'Measure angle',
    icon: Triangle,
    mode: 'angle',
    minPoints: 3,
    maxPoints: 3,
    prompt: (n) =>
      ['Angle: vertex', 'Angle: point on the first arm', 'Angle: point on the second arm'][n] ?? '',
    // Picked as vertex, arm 1, arm 2; stored as [arm 1, vertex, arm 2].
    geometry: (pts) =>
      pts.length >= 3 ? poly([pts[1], pts[0], pts[2]]) : pts.length === 2 ? poly([pts[1], pts[0]]) : null,
  },
  {
    id: 'measure.point',
    title: 'Point coordinates',
    icon: LocateFixed,
    mode: 'point',
    minPoints: 1,
    maxPoints: 1,
    prompt: () => 'Point coordinates: pick a point (snaps to drawing geometry)',
    geometry: (pts) => (pts.length ? { type: 'point', p: { x: pts[0].x, y: pts[0].y } } : null),
  },
];

function pickSpec(s: MeasureSpec): PickToolSpec {
  return {
    id: s.id,
    title: s.title,
    icon: s.icon,
    minPoints: s.minPoints,
    maxPoints: s.maxPoints,
    repeat: true,
    prompt: s.prompt,
    preview: () => null,
    finish: (pts) => {
      const g = s.geometry(pts);
      if (!g) return false;
      finishMeasurement({ mode: s.mode, geometry: g });
    },
    render: (g, f, pts, cursor) => {
      const st = useMeasureStore.getState();
      if (!pts.length) {
        useMeasureStore.getState().setLive(null);
        if (st.result && st.result.mode === s.mode && !st.result.keptId) drawEntry(g, f, st.result, true);
        if (s.mode === 'point' && cursor) {
          const live = { mode: s.mode, geometry: s.geometry([cursor])! };
          st.setLive(live);
        }
        return;
      }
      const all = withCursor(pts, cursor);
      const geom = s.geometry(all);
      if (!geom) return;
      const live = { mode: s.mode, geometry: geom };
      st.setLive(live);
      drawEntry(g, f, live);
    },
  };
}

// --------------------------------------------------------------------- object / entity pickers

const TOL_PX = 6;

/**
 * Exact world geometry of the analysis object or underlay entity whose outline is nearest the cursor
 * (within 6 px); a filled object containing the cursor is the fallback. `accept` filters candidates
 * (e.g. circular shapes for the radius tool).
 */
export function geometryUnder(
  world: Pt,
  f: FrameInfo,
  accept: (g: Geometry) => boolean = () => true,
): { geometry: Geometry; label: string } | null {
  const p = getProject();
  if (!p) return null;
  const tol = TOL_PX / f.scale;
  const hidden = new Set(p.layers.filter((l) => !l.visible).map((l) => l.id));
  let best: { geometry: Geometry; label: string; d: number } | null = null;
  for (const o of p.objects) {
    if (hidden.has(o.layerId) || o.geometry.type === 'point') continue;
    const b = geomBounds(o.geometry);
    if (world.x < b.minX - tol || world.x > b.maxX + tol || world.y < b.minY - tol || world.y > b.maxY + tol)
      continue;
    const d = distanceToGeometry(world, o.geometry);
    if (d <= tol && (!best || d < best.d) && accept(o.geometry))
      best = { geometry: o.geometry, label: o.name, d };
  }
  for (const hit of pickUnderlay(p.drawings, world, f.scale, TOL_PX, { limit: 12 })) {
    const d = hit.distPx / f.scale;
    if (best && d >= best.d) break;
    const drawing = p.drawings.find((x) => x.id === hit.drawingId);
    const store = getModel(hit.drawingId)?.result?.store;
    const g = drawing && store ? entityToGeometry(store, hit.index) : null;
    if (!drawing || !g || g.type === 'point') continue;
    const wg = transformGeometry(g, drawingPlacement(drawing), p.chordTolerance);
    if (!accept(wg)) continue;
    best = { geometry: wg, label: drawing.name, d };
    break;
  }
  if (best) return { geometry: best.geometry, label: best.label };
  const o = pickObject(p, world, f.scale, TOL_PX);
  return o && accept(o.geometry) ? { geometry: o.geometry, label: o.name } : null;
}

const circular = (g: Geometry) => radiusOf(g) !== null;

function objectTool(id: string, title: string, forceRadius: boolean): Tool {
  let hover: Geometry | null = null;
  return {
    id,
    title,
    cursor: 'crosshair',
    hint: () =>
      forceRadius
        ? 'Radius / diameter: click a circle or arc (drawing entity or analysis object)  (Esc: done)'
        : 'Measure object: click a line, polyline, shape or entity for its length, area or radius  (Esc: done)',
    deactivate() {
      hover = null;
      useMeasureStore.getState().setLive(null);
    },
    pointerMove(e, ctx) {
      hover = geometryUnder(e.world, ctx.frame(), forceRadius ? circular : undefined)?.geometry ?? null;
    },
    pointerDown(e, ctx) {
      if (e.button !== 0) return;
      const hit = geometryUnder(e.world, ctx.frame(), forceRadius ? circular : undefined);
      if (!hit) {
        if (forceRadius)
          toast.info('No circle or arc here.', {
            description: 'Click on the outline of a circular entity or object.',
          });
        else toast.info('Nothing to measure here.');
        return;
      }
      const g = hit.geometry;
      finishMeasurement({ mode: forceRadius ? 'radius' : modeForGeometry(g), geometry: g });
      refreshHint();
    },
    keyDown(e) {
      if (e.key === 'Escape') {
        setTool('select');
        return true;
      }
      return false;
    },
    render(g, f) {
      if (hover) {
        g.save();
        g.beginPath();
        traceGeometry(g, hover, f.toScreen, f.scale);
        g.strokeStyle = 'rgba(14,165,233,0.85)';
        g.lineWidth = 3;
        g.stroke();
        g.restore();
      }
      const r = useMeasureStore.getState().result;
      if (r && !r.keptId) drawEntry(g, f, r);
    },
  };
}

export const MEASURE_TOOLS: MeasureToolDef[] = [
  ...SPECS.map((s) => ({
    id: s.id,
    title: s.title,
    icon: s.icon,
    shortcut: s.shortcut,
    tool: createPickTool(pickSpec(s)),
  })),
  {
    id: 'measure.object',
    title: 'Measure object (length, area, radius)',
    icon: ScanLine,
    tool: objectTool('measure.object', 'Measure object', false),
  },
  {
    id: 'measure.radius',
    title: 'Measure radius / diameter',
    icon: Circle,
    tool: objectTool('measure.radius', 'Measure radius', true),
  },
];

export const MEASURE_TOOL_IDS = new Set(MEASURE_TOOLS.map((t) => t.id));
