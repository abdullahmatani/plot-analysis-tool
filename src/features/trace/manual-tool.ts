import { PenTool } from 'lucide-react';

import { currentSession } from '@/app/session';
import type { Geometry, Pt, Vertex } from '@/core/types';
import { refreshHint, setTool, useToolUi } from '@/tools/registry';
import type { FrameInfo, Tool, ToolContext, ToolPointerEvent } from '@/tools/types';
import { activeLayerWritable, addObjects } from '@/features/objects/ops';
import { parseTypedPoint, strokePreview } from '@/features/draw/pick-tool';

import { lastTangent, tangentBulge, threePointBulge } from './arcs';

/**
 * Manual trace (row 49): click-by-click polyline / polygon over the underlay. Every click uses the
 * snapped point as is, so traced vertices equal the snapped source points exactly (row 27). Segment
 * modes: L straight, A tangent arc (continues the previous segment smoothly), S three-point arc
 * (a point on the arc, then its end). C or a click on the first vertex closes the polygon; Enter or
 * a double-click finishes an open polyline; Backspace removes the last vertex (or the pending arc
 * point); Esc cancels. Ortho/polar tracking and grid snap apply relative to the last vertex. The
 * in-progress trace is saved as a draft (row 93).
 */

export type SegmentMode = 'line' | 'tangent' | 'arc3';

export interface ManualTraceState {
  points: Vertex[];
  mode: SegmentMode;
  /** Point on the arc picked for a three-point arc (waiting for the end point). */
  mid: Pt | null;
}

const CLOSE_PX = 8;

let st: ManualTraceState = { points: [], mode: 'line', mid: null };
let cursor: Pt | null = null;
let cursorScreen: Pt | null = null;
let ctxRef: ToolContext | null = null;
const draft = { key: 'tool:trace.manual', tool: 'trace.manual', label: 'Trace' };

const copyV = (v: Vertex): Vertex => (v.bulge ? { x: v.x, y: v.y, bulge: v.bulge } : { x: v.x, y: v.y });

function saveDraft() {
  const s = currentSession();
  if (!s) return;
  if (st.points.length) s.drafts.set(draft, { points: st.points, mode: st.mode, mid: st.mid });
  else s.drafts.clear(draft.key);
}

function reset() {
  st = { points: [], mode: st.mode, mid: null };
  ctxRef?.setSnapBase(null);
  saveDraft();
  refreshHint();
}

/** Bulge of the segment from the last vertex to `q` in the current mode (null = invalid). */
export function segmentBulge(state: ManualTraceState, q: Pt): number | null {
  const last = state.points[state.points.length - 1];
  if (!last) return 0;
  if (state.mode === 'tangent') {
    const t = lastTangent(state.points);
    return t ? tangentBulge(last, t, q) : 0;
  }
  if (state.mode === 'arc3') {
    if (!state.mid) return null;
    return threePointBulge(last, state.mid, q);
  }
  return 0;
}

/** Applies a click at `p` to a trace state (pure; returns the next state and whether it closed). */
export function applyClick(
  state: ManualTraceState,
  p: Pt,
  closesOnFirst: boolean,
): { state: ManualTraceState; closed: boolean } {
  const pts = state.points.map(copyV);
  if (!pts.length) return { state: { ...state, points: [{ x: p.x, y: p.y }], mid: null }, closed: false };
  if (state.mode === 'arc3' && !state.mid)
    return { state: { ...state, points: pts, mid: { x: p.x, y: p.y } }, closed: false };
  const bulge = segmentBulge(state, p);
  if (bulge === null) return { state, closed: false };
  const last = pts[pts.length - 1];
  pts[pts.length - 1] = bulge ? { x: last.x, y: last.y, bulge } : { x: last.x, y: last.y };
  if (closesOnFirst) return { state: { ...state, points: pts, mid: null }, closed: true };
  if (p.x === last.x && p.y === last.y) return { state, closed: false };
  pts.push({ x: p.x, y: p.y });
  return { state: { ...state, points: pts, mid: null }, closed: false };
}

/** Removes the pending arc point, or the last vertex (and the bulge of the segment that led to it). */
export function applyBackspace(state: ManualTraceState): ManualTraceState {
  if (state.mid) return { ...state, mid: null };
  const pts = state.points.slice(0, -1).map(copyV);
  if (pts.length) {
    const l = pts[pts.length - 1];
    pts[pts.length - 1] = { x: l.x, y: l.y };
  }
  return { ...state, points: pts };
}

function finish(closed: boolean) {
  const pts = st.points.map(copyV);
  const n = pts.length;
  if (closed ? n < 2 || (n === 2 && !pts[0].bulge && !pts[1].bulge) : n < 2) return;
  if (!closed) pts[n - 1] = { x: pts[n - 1].x, y: pts[n - 1].y };
  const geometry: Geometry = { type: 'polyline', pts, closed };
  const ids = addObjects([{ kind: 'trace', geometry }], closed ? 'Trace polygon' : 'Trace polyline');
  if (!ids.length) return;
  reset();
}

function nearFirst(f: FrameInfo | null, screen: Pt | null): boolean {
  if (!f || !screen || st.points.length < 2) return false;
  const s = f.toScreen(st.points[0]);
  return Math.hypot(s.x - screen.x, s.y - screen.y) <= CLOSE_PX;
}

function previewGeometry(cur: Pt | null): Geometry[] {
  const out: Geometry[] = [];
  if (!st.points.length) return out;
  const pts = st.points.map(copyV);
  if (cur) {
    if (st.mode === 'arc3' && !st.mid) {
      out.push({ type: 'polyline', pts: [pts[pts.length - 1], cur], closed: false });
    } else {
      const b = segmentBulge(st, cur);
      const last = pts[pts.length - 1];
      if (b) pts[pts.length - 1] = { x: last.x, y: last.y, bulge: b };
      pts.push({ x: cur.x, y: cur.y });
    }
  }
  out.unshift({ type: 'polyline', pts, closed: false });
  return out;
}

const MODE_TEXT: Record<SegmentMode, string> = {
  line: 'line',
  tangent: 'tangent arc',
  arc3: 'arc through a point',
};

export const manualTraceTool: Tool & { restoreDraft(state: unknown): void } = {
  id: 'trace.manual',
  title: 'Trace polyline / polygon',
  cursor: 'crosshair',
  snaps: true,
  hint: () => {
    const n = st.points.length;
    if (!n) return 'Trace: click the first point (snaps to the drawing; type x,y + Enter for exact input)';
    const seg =
      st.mode === 'arc3' && !st.mid
        ? 'pick a point on the arc'
        : st.mode === 'arc3'
          ? 'pick the arc end'
          : 'next point';
    return `Trace (${MODE_TEXT[st.mode]}): ${seg} · L line · A tangent arc · S 3-point arc · C close · Enter finish · Backspace undo point`;
  },
  activate(ctx) {
    ctxRef = ctx;
    if (!activeLayerWritable()) setTimeout(() => setTool('select'), 0);
  },
  deactivate() {
    st = { points: [], mode: 'line', mid: null };
    cursor = null;
    ctxRef?.setSnapBase(null);
    saveDraft();
  },
  pointerDown(e: ToolPointerEvent, ctx) {
    if (e.button !== 0) return;
    const close = nearFirst(ctx.frame(), e.screen) && !(st.mode === 'arc3' && !st.mid);
    const p = close ? st.points[0] : e.pt;
    const r = applyClick(st, p, close);
    st = r.state;
    if (r.closed) {
      finish(true);
      return;
    }
    ctx.setSnapBase(st.points[st.points.length - 1] ?? null);
    saveDraft();
    refreshHint();
  },
  pointerMove(e) {
    cursor = e.pt;
    cursorScreen = e.screen;
  },
  doubleClick() {
    // The second click of a double-click added the same point again.
    const n = st.points.length;
    if (n >= 2) {
      const a = st.points[n - 1];
      const b = st.points[n - 2];
      if (a.x === b.x && a.y === b.y) st = applyBackspace(st);
    }
    finish(false);
  },
  keyDown(e) {
    const typed = !!useToolUi.getState().typed;
    const k = e.key.toLowerCase();
    if (!typed && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (k === 'l' || k === 'a' || k === 's') {
        st = { ...st, mode: k === 'l' ? 'line' : k === 'a' ? 'tangent' : 'arc3', mid: null };
        saveDraft();
        refreshHint();
        return true;
      }
      if (k === 'c' && st.points.length >= 2) {
        if (st.mode === 'arc3' && st.mid) {
          st = applyClick(st, st.points[0], true).state;
        } else if (st.mode === 'tangent') {
          st = applyClick(st, st.points[0], true).state;
        }
        finish(true);
        return true;
      }
    }
    if (e.key === 'Escape' && !typed) {
      if (st.points.length) {
        reset();
        return true;
      }
      setTool('select');
      return true;
    }
    if (e.key === 'Backspace' && !typed && (st.points.length || st.mid)) {
      st = applyBackspace(st);
      ctxRef?.setSnapBase(st.points[st.points.length - 1] ?? null);
      saveDraft();
      refreshHint();
      return true;
    }
    if (e.key === 'Enter' && !typed) {
      finish(false);
      return true;
    }
    return false;
  },
  typedInput(value) {
    const p = parseTypedPoint(value, st.points[st.points.length - 1] ?? null, cursor);
    if (!p) return false;
    const r = applyClick(st, p, false);
    st = r.state;
    ctxRef?.setSnapBase(st.points[st.points.length - 1] ?? null);
    saveDraft();
    refreshHint();
    return true;
  },
  render(g, f) {
    strokePreview(g, f, previewGeometry(cursor));
    g.fillStyle = '#f59e0b';
    for (const p of st.points) {
      const s = f.toScreen(p);
      g.fillRect(s.x - 3, s.y - 3, 6, 6);
    }
    if (st.mid) {
      const s = f.toScreen(st.mid);
      g.strokeStyle = '#f59e0b';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(s.x, s.y, 4, 0, Math.PI * 2);
      g.stroke();
    }
    // Closing hint: ring around the first vertex when the cursor is over it.
    if (nearFirst(f, cursorScreen) && st.points.length >= 2) {
      const s = f.toScreen(st.points[0]);
      g.strokeStyle = '#22c55e';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(s.x, s.y, CLOSE_PX, 0, Math.PI * 2);
      g.stroke();
    }
  },
  restoreDraft(state: unknown) {
    const s = state as Partial<ManualTraceState> | null;
    if (!s?.points?.length) return;
    st = {
      points: s.points.map(copyV),
      mode: s.mode === 'tangent' || s.mode === 'arc3' ? s.mode : 'line',
      mid: s.mid ? { x: s.mid.x, y: s.mid.y } : null,
    };
    ctxRef?.setSnapBase(st.points[st.points.length - 1]);
    refreshHint();
  },
};

export const manualTraceIcon = PenTool;

/** For tests: the current state. */
export function manualTraceState(): ManualTraceState {
  return st;
}
