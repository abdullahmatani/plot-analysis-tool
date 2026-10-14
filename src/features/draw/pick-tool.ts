import type { LucideIcon } from 'lucide-react';

import { currentSession } from '@/app/session';
import type { Geometry, Pt } from '@/core/types';
import { parseLength, degToRad } from '@/core/units';
import { traceGeometry } from '@/render/draw-geometry';
import { getProject } from '@/store/project';
import { refreshHint, setTool, useToolUi } from '@/tools/registry';
import type { FrameInfo, Tool, ToolContext, ToolPointerEvent } from '@/tools/types';
import { activeLayerWritable } from '@/features/objects/ops';

/**
 * Point-collecting tool framework used by the shape, trace and measurement tools. Handles snapping
 * bases, typed coordinates/dimensions ("x,y", "@dx,dy", "@d<angle", or a distance along the cursor
 * direction), previews, Backspace to remove the last point, Enter/double-click to finish, and
 * in-progress drafts saved within 1 s for crash recovery (row 93).
 */

export interface PickToolSpec {
  id: string;
  title: string;
  icon?: LucideIcon;
  /** Prompt for the next point, given how many points are placed. */
  prompt(n: number): string;
  /** Minimum points to finish; when `maxPoints` is reached the tool finishes automatically. */
  minPoints: number;
  maxPoints?: number;
  /** Preview geometry for the placed points plus the live cursor point. */
  preview(pts: Pt[], cursor: Pt | null): Geometry | Geometry[] | null;
  /** Called on finish; return false to keep collecting. */
  finish(pts: Pt[]): boolean | void;
  /** Interpret a typed value (other than a point), e.g. a radius. Return a point to add, 'finish', or null. */
  typed?(value: string, pts: Pt[], cursor: Pt | null): Pt | 'finish' | null;
  /** Letters that may start typed input at this stage (e.g. "d" for a diameter). */
  typedStart?(key: string, pts: Pt[]): boolean;
  /** Restart after finishing (continuous mode) instead of returning to Select. */
  repeat?: boolean;
  /** Extra overlay drawing. */
  render?(g: CanvasRenderingContext2D, f: FrameInfo, pts: Pt[], cursor: Pt | null): void;
  /** Whether this tool creates objects (requires an editable active layer). */
  creates?: boolean;
  /** Handles extra keys (e.g. 'C' to close). */
  key?(e: KeyboardEvent, pts: Pt[]): 'finish' | 'handled' | null;
}

export function displayUnit() {
  return getProject()?.display.units ?? 'm';
}

/** Parses typed point input relative to the last point. Returns null when not a point. */
export function parseTypedPoint(value: string, last: Pt | null, cursor: Pt | null): Pt | null {
  const u = displayUnit();
  const v = value.trim().replace(/\s+/g, '');
  let m = /^@(.+?),(.+)$/.exec(v);
  if (m && last) {
    const dx = parseLength(m[1], u);
    const dy = parseLength(m[2], u);
    return dx !== null && dy !== null ? { x: last.x + dx, y: last.y + dy } : null;
  }
  m = /^@(.+?)<(.+)$/.exec(v);
  if (m && last) {
    const d = parseLength(m[1], u);
    const a = Number(m[2].replace(/°$/, ''));
    return d !== null && Number.isFinite(a)
      ? { x: last.x + d * Math.cos(degToRad(a)), y: last.y + d * Math.sin(degToRad(a)) }
      : null;
  }
  m = /^(-?[\d.]+[a-z]*),(-?[\d.]+[a-z]*)$/i.exec(v);
  if (m) {
    const x = parseLength(m[1], u);
    const y = parseLength(m[2], u);
    return x !== null && y !== null ? { x, y } : null;
  }
  // A single distance along the cursor direction from the last point.
  const d = parseLength(v, u);
  if (d !== null && last && cursor) {
    const dx = cursor.x - last.x;
    const dy = cursor.y - last.y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: last.x + (dx / l) * d, y: last.y + (dy / l) * d };
  }
  return null;
}

export function strokePreview(g: CanvasRenderingContext2D, f: FrameInfo, geom: Geometry | Geometry[] | null) {
  if (!geom) return;
  for (const gm of Array.isArray(geom) ? geom : [geom]) {
    g.beginPath();
    traceGeometry(g, gm, f.toScreen, f.scale);
    g.strokeStyle = '#f59e0b';
    g.lineWidth = 1.5;
    g.setLineDash([6, 4]);
    g.stroke();
    g.setLineDash([]);
  }
}

export function createPickTool(
  spec: PickToolSpec,
): Tool & { restoreDraft(state: unknown): void; points(): Pt[] } {
  let pts: Pt[] = [];
  let cursor: Pt | null = null;
  let ctxRef: ToolContext | null = null;
  const draftHandle = { key: `tool:${spec.id}`, tool: spec.id, label: spec.title };

  const saveDraft = () => {
    const s = currentSession();
    if (!s) return;
    if (pts.length) s.drafts.set(draftHandle, { points: pts });
    else s.drafts.clear(draftHandle.key);
  };
  const reset = () => {
    pts = [];
    cursor = null;
    ctxRef?.setSnapBase(null);
    saveDraft();
    refreshHint();
  };
  const add = (p: Pt) => {
    pts.push({ x: p.x, y: p.y });
    ctxRef?.setSnapBase(p);
    saveDraft();
    if (spec.maxPoints && pts.length >= spec.maxPoints) finish();
    refreshHint();
  };
  const finish = () => {
    if (pts.length < spec.minPoints) return;
    const done = spec.finish([...pts]);
    if (done === false) return;
    reset();
    if (!spec.repeat) setTool('select');
  };

  const tool: Tool & { restoreDraft(state: unknown): void; points(): Pt[] } = {
    id: spec.id,
    title: spec.title,
    cursor: 'crosshair',
    snaps: true,
    hint: () =>
      spec.prompt(pts.length) +
      (pts.length ? '  (Backspace: undo point · Esc: cancel)' : '  (type a value + Enter for exact input)'),
    activate(ctx) {
      ctxRef = ctx;
      if (spec.creates && !activeLayerWritable()) {
        setTimeout(() => setTool('select'), 0);
      }
    },
    deactivate() {
      reset();
    },
    pointerDown(e: ToolPointerEvent) {
      if (e.button !== 0) return;
      add(e.pt);
    },
    pointerMove(e) {
      cursor = e.pt;
    },
    doubleClick() {
      if (pts.length > spec.minPoints) pts.pop(); // the second click of a double-click added a duplicate point
      finish();
    },
    keyDown(e) {
      const r = spec.key?.(e, pts);
      if (r === 'finish') {
        finish();
        return true;
      }
      if (r === 'handled') {
        saveDraft();
        return true;
      }
      if (e.key === 'Escape') {
        if (pts.length) {
          reset();
          return true;
        }
        setTool('select');
        return true;
      }
      if (e.key === 'Backspace' && pts.length && !useToolUi.getState().typed) {
        pts.pop();
        ctxRef?.setSnapBase(pts[pts.length - 1] ?? null);
        saveDraft();
        refreshHint();
        return true;
      }
      if (e.key === 'Enter' && !useToolUi.getState().typed) {
        finish();
        return true;
      }
      return false;
    },
    typedInput(value) {
      const custom = spec.typed?.(value, pts, cursor);
      if (custom === 'finish') {
        finish();
        return true;
      }
      if (custom) {
        add(custom);
        return true;
      }
      const p = parseTypedPoint(value, pts[pts.length - 1] ?? null, cursor);
      if (p) {
        add(p);
        return true;
      }
      return false;
    },
    render(g, f) {
      strokePreview(g, f, spec.preview(pts, cursor));
      g.fillStyle = '#f59e0b';
      for (const p of pts) {
        const s = f.toScreen(p);
        g.fillRect(s.x - 3, s.y - 3, 6, 6);
      }
      spec.render?.(g, f, pts, cursor);
    },
    typedStart: spec.typedStart ? (key) => spec.typedStart!(key, pts) : undefined,
    restoreDraft(state: unknown) {
      const st = state as { points?: Pt[] } | null;
      if (!st?.points?.length) return;
      pts = st.points.map((p) => ({ x: p.x, y: p.y }));
      ctxRef?.setSnapBase(pts[pts.length - 1]);
      refreshHint();
    },
    points: () => pts,
  };
  return tool;
}
