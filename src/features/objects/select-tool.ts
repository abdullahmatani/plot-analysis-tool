import type { AnalysisObject, Geometry, Pt } from '@/core/types';
import { translateGeometry } from '@/geometry/convert';
import { traceGeometry } from '@/render/draw-geometry';
import { getProject, useProjectStore } from '@/store/project';
import { useViewStore } from '@/store/view';
import { underlayHover } from '@/tools/nav-tools';
import { registerTool } from '@/tools/registry';
import type { FrameInfo, Tool, ToolPointerEvent } from '@/tools/types';
import { snapExclusions } from '@/features/snap/register';

import { applyGrip, gripsOf, type Grip } from './grips';
import { deleteObjects, editableSelection, lockedLayerIds, moveObjects, updateGeometries } from './ops';
import { objectsInLasso, objectsInRect, pickObject } from './pick';

/**
 * Select tool (rows 20, 43): click / Shift-click selection, window (drag right) and crossing (drag
 * left) rectangles, Alt-drag lasso, drag to move (snapped, Ctrl to copy), grip editing of vertices,
 * radii and corners. Hovering empty space still inspects underlay entities (row 20).
 */

type Mode =
  | { k: 'idle' }
  | {
      k: 'press';
      start: ToolPointerEvent;
      hit: AnalysisObject | null;
      grip: { id: string; grip: Grip } | null;
    }
  | { k: 'rubber'; start: Pt; end: Pt; lasso: Pt[] | null }
  | { k: 'move'; from: Pt; to: Pt; ids: string[]; copy: boolean }
  | { k: 'grip'; id: string; grip: Grip; to: Pt };

let mode: Mode = { k: 'idle' };
const GRIP_PX = 5;

function findGrip(world: Pt, f: FrameInfo): { id: string; grip: Grip } | null {
  const p = getProject();
  if (!p) return null;
  const ids = new Set(editableSelection());
  for (const o of p.objects) {
    if (!ids.has(o.id)) continue;
    for (const g of gripsOf(o.geometry)) {
      const s = f.toScreen(g.pt);
      const w = f.toScreen(world);
      if (Math.abs(s.x - w.x) <= GRIP_PX + 2 && Math.abs(s.y - w.y) <= GRIP_PX + 2)
        return { id: o.id, grip: g };
    }
  }
  return null;
}

function setSelection(ids: string[], additive: boolean) {
  const cur = useViewStore.getState().selection;
  if (!additive) return useViewStore.getState().set({ selection: ids, pickedEntity: null });
  const next = new Set(cur);
  for (const id of ids) {
    if (next.has(id)) next.delete(id);
    else next.add(id);
  }
  useViewStore.getState().set({ selection: [...next] });
}

export const objectSelectTool: Tool = {
  id: 'select',
  title: 'Select',
  cursor: 'default',
  snaps: true,
  hint: () =>
    useViewStore.getState().selection.length
      ? 'Drag to move (Ctrl copies), drag grips to edit, Del deletes. Shift adds to the selection.'
      : 'Click or drag a window (→ inside, ← crossing; Alt for lasso) to select. Hover drawing geometry to inspect it.',
  deactivate() {
    mode = { k: 'idle' };
    snapExclusions.clear();
  },
  pointerDown(e, ctx) {
    if (e.button !== 0) return;
    const p = getProject();
    if (!p) return;
    const f = ctx.frame();
    const readOnly = useProjectStore.getState().readOnly;
    const grip = readOnly ? null : findGrip(e.world, f);
    const hit = grip ? null : pickObject(p, e.world, f.scale);
    mode = { k: 'press', start: e, hit, grip };
    if (grip) {
      snapExclusions.clear();
      snapExclusions.add(grip.id);
    }
  },
  pointerMove(e, ctx) {
    const f = ctx.frame();
    const p = getProject();
    if (!p) return;
    if (mode.k === 'idle') {
      const hit = pickObject(p, e.world, f.scale);
      useViewStore.getState().set({ hoverObject: hit?.id ?? null });
      if (!hit) underlayHover.update(e.world, f.scale);
      else if (useViewStore.getState().hoverEntity) useViewStore.getState().set({ hoverEntity: null });
      ctx.setCursor(findGrip(e.world, f) ? 'pointer' : hit ? 'move' : 'default');
      return;
    }
    if (mode.k === 'press') {
      const d = Math.hypot(e.screen.x - mode.start.screen.x, e.screen.y - mode.start.screen.y);
      if (d < 4) return;
      const readOnly = useProjectStore.getState().readOnly;
      if (mode.grip) {
        mode = { k: 'grip', id: mode.grip.id, grip: mode.grip.grip, to: e.pt };
      } else if (mode.hit && !readOnly && !lockedLayerIds(p).has(mode.hit.layerId)) {
        const sel = useViewStore.getState().selection;
        if (!sel.includes(mode.hit.id)) useViewStore.getState().set({ selection: [mode.hit.id] });
        const ids = editableSelection();
        snapExclusions.clear();
        ids.forEach((id) => snapExclusions.add(id));
        // Snap the grab point so moves can be exact (base point → target point).
        const from = mode.start.snap ? mode.start.pt : mode.start.world;
        ctx.setSnapBase(from);
        mode = { k: 'move', from, to: e.pt, ids, copy: e.ctrl };
      } else {
        mode = {
          k: 'rubber',
          start: mode.start.world,
          end: e.world,
          lasso: e.alt ? [mode.start.world, e.world] : null,
        };
      }
      return;
    }
    if (mode.k === 'rubber') {
      mode.end = e.world;
      if (mode.lasso) mode.lasso.push(e.world);
    } else if (mode.k === 'move') {
      mode.to = e.pt;
      mode.copy = e.ctrl;
    } else if (mode.k === 'grip') {
      mode.to = e.pt;
    }
  },
  pointerUp(e, ctx) {
    const p = getProject();
    const m = mode;
    mode = { k: 'idle' };
    snapExclusions.clear();
    ctx.setSnapBase(null);
    if (!p) return;
    if (m.k === 'press') {
      if (m.hit) setSelection([m.hit.id], e.shift);
      else if (!e.shift) {
        useViewStore.getState().set({ selection: [], pickedEntity: useViewStore.getState().hoverEntity });
      }
      return;
    }
    if (m.k === 'rubber') {
      const f = ctx.frame();
      let ids: string[];
      if (m.lasso && m.lasso.length > 2) {
        ids = objectsInLasso(p, m.lasso, false);
      } else {
        const crossing = f.toScreen(m.end).x < f.toScreen(m.start).x;
        const b = {
          minX: Math.min(m.start.x, m.end.x),
          minY: Math.min(m.start.y, m.end.y),
          maxX: Math.max(m.start.x, m.end.x),
          maxY: Math.max(m.start.y, m.end.y),
        };
        ids = objectsInRect(p, b, crossing);
      }
      setSelection(ids, e.shift);
      return;
    }
    if (m.k === 'move') {
      const dx = m.to.x - m.from.x;
      const dy = m.to.y - m.from.y;
      if (dx || dy) moveObjects(m.ids, dx, dy, m.copy);
      return;
    }
    if (m.k === 'grip') {
      updateGeometries([m.id], 'Edit shape', (g) => applyGrip(g, m.grip, m.to));
    }
  },
  keyDown(e) {
    if (e.key === 'Escape') {
      if (mode.k !== 'idle') {
        mode = { k: 'idle' };
        snapExclusions.clear();
        return true;
      }
      if (useViewStore.getState().selection.length || useViewStore.getState().pickedEntity) {
        useViewStore.getState().set({ selection: [], pickedEntity: null });
        return true;
      }
      return false;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !useProjectStore.getState().readOnly) {
      return deleteObjects(editableSelection());
    }
    return false;
  },
  render(g, f) {
    const p = getProject();
    if (!p) return;
    // Grips of selected (editable) objects.
    const sel = new Set(editableSelection());
    g.fillStyle = '#3b82f6';
    g.strokeStyle = '#ffffff';
    g.lineWidth = 1;
    for (const o of p.objects) {
      if (!sel.has(o.id) || sel.size > 50) continue;
      for (const gr of gripsOf(o.geometry)) {
        const s = f.toScreen(gr.pt);
        if (gr.kind === 'insert') {
          // Segment midpoint: drag to insert a vertex (row 53).
          g.beginPath();
          g.arc(s.x, s.y, GRIP_PX / 2 + 1.5, 0, Math.PI * 2);
          g.fillStyle = 'rgba(255,255,255,0.85)';
          g.fill();
          g.strokeStyle = '#3b82f6';
          g.stroke();
          g.beginPath();
          g.moveTo(s.x - 2.5, s.y);
          g.lineTo(s.x + 2.5, s.y);
          g.moveTo(s.x, s.y - 2.5);
          g.lineTo(s.x, s.y + 2.5);
          g.stroke();
          g.fillStyle = '#3b82f6';
          g.strokeStyle = '#ffffff';
          continue;
        }
        g.fillRect(s.x - GRIP_PX / 2 - 1, s.y - GRIP_PX / 2 - 1, GRIP_PX + 2, GRIP_PX + 2);
        g.strokeRect(s.x - GRIP_PX / 2 - 1, s.y - GRIP_PX / 2 - 1, GRIP_PX + 2, GRIP_PX + 2);
      }
    }
    const preview = (geom: Geometry) => {
      g.beginPath();
      traceGeometry(g, geom, f.toScreen, f.scale);
      g.strokeStyle = '#f59e0b';
      g.lineWidth = 1.5;
      g.setLineDash([5, 4]);
      g.stroke();
      g.setLineDash([]);
    };
    if (mode.k === 'rubber') {
      const a = f.toScreen(mode.start);
      const b = f.toScreen(mode.end);
      g.beginPath();
      if (mode.lasso) {
        mode.lasso.forEach((pt, i) => {
          const s = f.toScreen(pt);
          if (i === 0) g.moveTo(s.x, s.y);
          else g.lineTo(s.x, s.y);
        });
        g.closePath();
      } else {
        g.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      }
      const crossing = !mode.lasso && b.x < a.x;
      g.fillStyle = crossing ? 'rgba(34,197,94,0.08)' : 'rgba(59,130,246,0.08)';
      g.strokeStyle = crossing ? '#22c55e' : '#3b82f6';
      g.setLineDash(crossing ? [5, 4] : []);
      g.fill();
      g.stroke();
      g.setLineDash([]);
    } else if (mode.k === 'move') {
      const dx = mode.to.x - mode.from.x;
      const dy = mode.to.y - mode.from.y;
      const ids = new Set(mode.ids);
      for (const o of p.objects) if (ids.has(o.id)) preview(translateGeometry(o.geometry, dx, dy));
    } else if (mode.k === 'grip') {
      const m = mode;
      const o = p.objects.find((x) => x.id === m.id);
      if (o) preview(applyGrip(o.geometry, m.grip, m.to));
    }
  },
};

/**
 * Geometry of the objects currently being dragged (grip edit or move), so features can preview
 * dependent geometry while dragging (live offsets, row 59).
 */
export function dragPreview(): { id: string; geometry: Geometry }[] {
  const p = getProject();
  if (!p) return [];
  const m = mode;
  if (m.k === 'grip') {
    const o = p.objects.find((x) => x.id === m.id);
    return o ? [{ id: o.id, geometry: applyGrip(o.geometry, m.grip, m.to) }] : [];
  }
  if (m.k === 'move' && !m.copy) {
    const ids = new Set(m.ids);
    const dx = m.to.x - m.from.x;
    const dy = m.to.y - m.from.y;
    return p.objects
      .filter((o) => ids.has(o.id))
      .map((o) => ({ id: o.id, geometry: translateGeometry(o.geometry, dx, dy) }));
  }
  return [];
}

export function registerSelectTool() {
  registerTool(objectSelectTool);
}
