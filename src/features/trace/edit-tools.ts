import { toast } from 'sonner';

import { currentSession } from '@/app/session';
import { newId, nowIso } from '@/core/ids';
import type { AnalysisObject, Geometry, Pt } from '@/core/types';
import { traceGeometry } from '@/render/draw-geometry';
import { commit, getProject, useProjectStore } from '@/store/project';
import { useViewStore } from '@/store/view';
import { refreshHint, setTool } from '@/tools/registry';
import type { FrameInfo, Tool, ToolPointerEvent } from '@/tools/types';
import { snapExclusions } from '@/features/snap/register';
import { lockedLayerIds, nextName, updateGeometries } from '@/features/objects/ops';
import { pickObject } from '@/features/objects/pick';

import {
  convertSegmentAt,
  insertVertexAt,
  nearestSegment,
  nearestVertex,
  removeVertexAt,
  segmentIsArc,
  splitGeometryAt,
  type SegmentRef,
  type VertexRef,
} from './edit-ops';

/**
 * Click tools for trace editing (row 53): add a vertex on a segment, remove a vertex, split at a
 * vertex or point, convert a segment line ↔ arc. They act on the editable object under the cursor
 * (selected objects first; locked and hidden layers are never edited). Each edit is one command.
 */

const VERTEX_PX = 9;
/** A point this close to a segment (metres) counts as lying on it. */
const ON_SEGMENT_TOL = 1e-6;
const chordTol = () => getProject()?.chordTolerance ?? 0.005;

function editableAt(world: Pt, scale: number): AnalysisObject | null {
  const p = getProject();
  if (!p || useProjectStore.getState().readOnly) return null;
  const locked = lockedLayerIds(p);
  const sel = new Set(useViewStore.getState().selection);
  const tol = 8 / scale;
  // Selected objects win when they are within reach.
  let best: AnalysisObject | null = null;
  let bestD = Infinity;
  for (const o of p.objects) {
    if (!sel.has(o.id) || locked.has(o.layerId)) continue;
    const s = nearestSegment(o.geometry, world, chordTol());
    if (s && s.dist <= tol && s.dist < bestD) {
      best = o;
      bestD = s.dist;
    }
  }
  if (best) return best;
  const hit = pickObject(p, world, scale);
  return hit && !locked.has(hit.layerId) && hit.geometry.type !== 'point' ? hit : null;
}

interface Target {
  obj: AnalysisObject;
  vertex: VertexRef | null;
  seg: SegmentRef | null;
}

function targetAt(e: ToolPointerEvent, f: FrameInfo): Target | null {
  const obj = editableAt(e.world, f.scale);
  if (!obj) return null;
  const v = nearestVertex(obj.geometry, e.world, chordTol());
  const vertex = v && v.dist * f.scale <= VERTEX_PX ? v : null;
  const seg = nearestSegment(obj.geometry, e.world, chordTol());
  return { obj, vertex, seg };
}

function drawTarget(
  g: CanvasRenderingContext2D,
  f: FrameInfo,
  t: Target | null,
  mode: 'vertex' | 'point' | 'segment',
) {
  if (!t) return;
  g.beginPath();
  traceGeometry(g, t.obj.geometry, f.toScreen, f.scale);
  g.strokeStyle = 'rgba(56,189,248,0.9)';
  g.lineWidth = 2;
  g.stroke();
  const mark = mode === 'vertex' ? t.vertex?.pt : mode === 'point' ? (t.vertex?.pt ?? t.seg?.pt) : t.seg?.pt;
  if (!mark) return;
  const s = f.toScreen(mark);
  g.beginPath();
  if (mode === 'vertex' || (mode === 'point' && t.vertex)) g.rect(s.x - 5, s.y - 5, 10, 10);
  else g.arc(s.x, s.y, 5, 0, Math.PI * 2);
  g.strokeStyle = '#f59e0b';
  g.lineWidth = 2;
  g.stroke();
}

function makeClickTool(spec: {
  id: string;
  title: string;
  hint: string;
  mode: 'vertex' | 'point' | 'segment';
  snaps?: boolean;
  apply(t: Target, e: ToolPointerEvent, f: FrameInfo): void;
}): Tool {
  let hover: Target | null = null;
  return {
    id: spec.id,
    title: spec.title,
    cursor: 'crosshair',
    snaps: spec.snaps,
    hint: () => spec.hint,
    deactivate() {
      hover = null;
    },
    pointerMove(e, ctx) {
      hover = targetAt(e, ctx.frame());
    },
    pointerDown(e, ctx) {
      if (e.button !== 0) return;
      const t = targetAt(e, ctx.frame());
      if (!t) {
        toast.info('Click on an editable polyline, polygon or shape.');
        return;
      }
      spec.apply(t, e, ctx.frame());
      hover = targetAt(e, ctx.frame());
    },
    keyDown(e) {
      if (e.key === 'Escape') {
        setTool('select');
        return true;
      }
      return false;
    },
    render(g, f) {
      drawTarget(g, f, hover, spec.mode);
    },
  };
}

export const insertVertexTool = makeClickTool({
  id: 'trace.insertVertex',
  title: 'Add vertex',
  hint: 'Add vertex: click on a segment (snaps apply) · Esc to finish',
  mode: 'segment',
  snaps: true,
  apply(t, e) {
    if (!t.seg) return;
    // A snapped point on the segment (e.g. an intersection) is inserted exactly; otherwise its projection.
    const g = insertVertexAt(t.obj.geometry, t.seg, e.pt, chordTol(), ON_SEGMENT_TOL);
    if (g) updateGeometries([t.obj.id], 'Add vertex', () => g);
  },
});

export const removeVertexTool = makeClickTool({
  id: 'trace.removeVertex',
  title: 'Remove vertex',
  hint: 'Remove vertex: click a vertex · Esc to finish',
  mode: 'vertex',
  apply(t) {
    if (!t.vertex) {
      toast.info('Click closer to a vertex.');
      return;
    }
    const g = removeVertexAt(t.obj.geometry, t.vertex, chordTol());
    if (!g) {
      toast.error('This vertex cannot be removed (too few vertices would remain).');
      return;
    }
    updateGeometries([t.obj.id], 'Remove vertex', () => g);
  },
});

export const splitTool = makeClickTool({
  id: 'trace.split',
  title: 'Split at point',
  hint: 'Split: click a vertex or a point on a polyline (a closed outline opens there) · Esc to finish',
  mode: 'point',
  apply(t) {
    const g = t.obj.geometry;
    const at = t.vertex ? { vertex: t.vertex.index } : t.seg ? { segment: t.seg.index, t: t.seg.t } : null;
    if (!at || (t.vertex && t.vertex.ring) || (t.seg && t.seg.ring)) {
      toast.error('Areas with holes cannot be split.');
      return;
    }
    const parts = splitGeometryAt(g, at, chordTol());
    if (!parts?.length) {
      toast.info('Nothing to split here (an open polyline cannot be split at its end).');
      return;
    }
    splitObject(t.obj, parts);
  },
});

/** Replaces an object by split parts: the first keeps the object, the others are copies. */
export function splitObject(o: AnalysisObject, parts: Geometry[]) {
  const p = getProject();
  if (!p) return;
  let proj = p;
  const copies: AnalysisObject[] = parts.slice(1).map((geometry) => {
    const c = structuredClone(o);
    delete c.derived; // a copy of a live offset would not follow the edit
    const copy = {
      ...c,
      id: newId('obj'),
      name: nextName(proj, o.name.replace(/ \d+$/, '')),
      geometry,
      createdAt: nowIso(),
    };
    proj = { ...proj, objects: [...proj.objects, copy] };
    return copy;
  });
  const ok = commit(parts.length > 1 ? 'Split polyline' : 'Open polyline at point', (d) => {
    const i = d.objects.findIndex((x) => x.id === o.id);
    if (i < 0) return;
    d.objects[i].geometry = parts[0];
    d.objects.splice(i + 1, 0, ...copies);
  });
  if (ok) useViewStore.getState().set({ selection: [o.id, ...copies.map((c) => c.id)] });
}

// ------------------------------------------------------------------------------- convert segment

let convertPending: { id: string; ring: number; index: number; at: Pt } | null = null;
let convertCursor: Pt | null = null;
const convertDraft = {
  key: 'tool:trace.convertSegment',
  tool: 'trace.convertSegment',
  label: 'Convert segment',
};

function saveConvertDraft() {
  const s = currentSession();
  if (!s) return;
  if (convertPending) s.drafts.set(convertDraft, { points: [convertPending.at], segment: convertPending });
  else s.drafts.clear(convertDraft.key);
}

function arcPreview(): Geometry | null {
  const p = getProject();
  if (!p || !convertPending || !convertCursor) return null;
  const o = p.objects.find((x) => x.id === convertPending!.id);
  if (!o) return null;
  return convertSegmentAt(o.geometry, convertPending, { kind: 'arc', through: convertCursor }, chordTol());
}

const convertBase = makeClickTool({
  id: 'trace.convertSegment',
  title: 'Convert segment line ↔ arc',
  hint: '',
  mode: 'segment',
  apply(t) {
    if (!t.seg) return;
    if (segmentIsArc(t.obj.geometry, t.seg, chordTol())) {
      const g = convertSegmentAt(t.obj.geometry, t.seg, 'line', chordTol());
      if (g) updateGeometries([t.obj.id], 'Convert arc to line', () => g);
      return;
    }
    convertPending = { id: t.obj.id, ring: t.seg.ring, index: t.seg.index, at: t.seg.pt };
    snapExclusions.add(t.obj.id);
    saveConvertDraft();
    refreshHint();
  },
});

export const convertSegmentTool: Tool & { restoreDraft(state: unknown): void } = {
  ...convertBase,
  snaps: true,
  hint: () =>
    convertPending
      ? 'Convert to arc: click a point the arc passes through · Esc to cancel'
      : 'Convert segment: click a straight segment (then a point on the arc), or click an arc to straighten it',
  deactivate(ctx) {
    convertPending = null;
    snapExclusions.clear();
    saveConvertDraft();
    convertBase.deactivate?.(ctx);
  },
  pointerMove(e, ctx) {
    convertCursor = e.pt;
    if (!convertPending) convertBase.pointerMove?.(e, ctx);
  },
  pointerDown(e, ctx) {
    if (e.button !== 0) return;
    if (!convertPending) {
      convertBase.pointerDown?.(e, ctx);
      return;
    }
    const pend = convertPending;
    const o = getProject()?.objects.find((x) => x.id === pend.id);
    convertPending = null;
    snapExclusions.clear();
    saveConvertDraft();
    refreshHint();
    if (!o) return;
    const g = convertSegmentAt(o.geometry, pend, { kind: 'arc', through: e.pt }, chordTol());
    if (!g) {
      toast.error('No arc passes through that point.');
      return;
    }
    updateGeometries([o.id], 'Convert line to arc', () => g);
  },
  keyDown(e, ctx) {
    if (e.key === 'Escape' && convertPending) {
      convertPending = null;
      snapExclusions.clear();
      saveConvertDraft();
      refreshHint();
      return true;
    }
    return convertBase.keyDown?.(e, ctx) ?? false;
  },
  render(g, f) {
    if (!convertPending) {
      convertBase.render?.(g, f);
      return;
    }
    const prev = arcPreview();
    if (!prev) return;
    g.beginPath();
    traceGeometry(g, prev, f.toScreen, f.scale);
    g.strokeStyle = '#f59e0b';
    g.lineWidth = 1.5;
    g.setLineDash([6, 4]);
    g.stroke();
    g.setLineDash([]);
  },
  restoreDraft(state: unknown) {
    const s = state as { segment?: { id: string; ring: number; index: number; at: Pt } } | null;
    if (!s?.segment) return;
    if (!getProject()?.objects.some((o) => o.id === s.segment!.id)) return;
    convertPending = { ...s.segment };
    snapExclusions.add(convertPending.id);
    refreshHint();
  },
};

export const editTools: Tool[] = [insertVertexTool, removeVertexTool, splitTool, convertSegmentTool];
