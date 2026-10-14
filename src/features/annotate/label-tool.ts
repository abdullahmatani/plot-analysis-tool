import type { AnalysisObject, Project, Pt } from '@/core/types';
import { add, sub } from '@/geometry/vec';
import { labelAnchor, labelText } from '@/features/objects/labels';
import { resolveStyle } from '@/features/objects/style';
import { lockedLayerIds } from '@/features/objects/ops';
import { commit, getProject } from '@/store/project';
import { useViewStore } from '@/store/view';
import { setTool } from '@/tools/registry';
import type { FrameInfo, Tool } from '@/tools/types';

import { distToBox, screenDelta, textBoxPx } from './metrics';

/**
 * Label tool (row 40): drag an object's label to a new position (stored as a world offset from its
 * placement point); with leader placement a line connects it to the object. Double-click a label to
 * reset it. Shift+L.
 */

function labelPos(o: AnalysisObject): Pt {
  const a = labelAnchor(o);
  return o.label?.offset ? add(a, o.label.offset) : a;
}

/** The label under a world point, if any (topmost first). */
export function pickLabel(p: Project, world: Pt, f: FrameInfo): AnalysisObject | null {
  const hidden = new Set(p.layers.filter((l) => !l.visible).map((l) => l.id));
  const locked = lockedLayerIds(p);
  for (let i = p.objects.length - 1; i >= 0; i--) {
    const o = p.objects[i];
    if (!o.label?.visible || hidden.has(o.layerId) || locked.has(o.layerId)) continue;
    const text = labelText(p, o);
    if (!text) continue;
    const s = resolveStyle(p, o);
    const t = textBoxPx(text, s, f.scale);
    const d = screenDelta(world, labelPos(o), f.scale, f.view.rotation);
    const top = o.label.placement === 'top';
    const y0 = top ? -t.h - 3 : -t.h / 2;
    if (distToBox(d, -t.w / 2 - 3, y0 - 3, t.w / 2 + 3, y0 + t.h + 3) === 0) return o;
  }
  return null;
}

let drag: { id: string; grab: Pt; start: Pt; to: Pt } | null = null;

export const labelTool: Tool = {
  id: 'annotate.label',
  title: 'Move label',
  cursor: 'move',
  snaps: false,
  hint: () =>
    drag
      ? 'Release to place the label'
      : 'Drag a label to move it · double-click a label to reset it · Esc: done',
  pointerDown(e, ctx) {
    const p = getProject();
    if (!p || e.button !== 0) return;
    const o = pickLabel(p, e.world, ctx.frame());
    if (!o) return;
    const pos = labelPos(o);
    drag = { id: o.id, grab: sub(e.world, pos), start: pos, to: pos };
  },
  pointerMove(e, ctx) {
    if (drag) {
      drag.to = sub(e.world, drag.grab);
      ctx.requestRender();
      return;
    }
    const p = getProject();
    ctx.setCursor(p && pickLabel(p, e.world, ctx.frame()) ? 'move' : 'default');
  },
  pointerUp() {
    const d = drag;
    drag = null;
    if (!d || (d.to.x === d.start.x && d.to.y === d.start.y)) return;
    const p = getProject();
    const o = p?.objects.find((x) => x.id === d.id);
    if (!o) return;
    const offset = sub(d.to, labelAnchor(o));
    commit(`Move label of “${o.name}”`, (draft) => {
      const t = draft.objects.find((x) => x.id === d.id);
      if (t?.label) t.label.offset = offset;
    });
  },
  doubleClick(e, ctx) {
    const p = getProject();
    if (!p) return;
    const o = pickLabel(p, e.world, ctx.frame());
    if (!o?.label?.offset) return;
    commit(`Reset label of “${o.name}”`, (draft) => {
      const t = draft.objects.find((x) => x.id === o.id);
      if (t?.label) delete t.label.offset;
    });
  },
  keyDown(e) {
    if (e.key === 'Escape') {
      drag = null;
      setTool('select');
      return true;
    }
    return false;
  },
  render(g, f) {
    const p = getProject();
    if (!p) return;
    const sel = new Set(useViewStore.getState().selection);
    // Outline every movable label so they are easy to grab.
    for (const o of p.objects) {
      if (!o.label?.visible) continue;
      const text = labelText(p, o);
      if (!text) continue;
      const s = resolveStyle(p, o);
      const t = textBoxPx(text, s, f.scale);
      const pos = drag?.id === o.id ? drag.to : labelPos(o);
      const c = f.toScreen(pos);
      const top = o.label.placement === 'top';
      const y0 = top ? c.y - t.h - 3 : c.y - t.h / 2;
      g.setLineDash([3, 3]);
      g.strokeStyle = sel.has(o.id) || drag?.id === o.id ? '#3b82f6' : 'rgba(148,163,184,0.8)';
      g.lineWidth = 1;
      g.strokeRect(c.x - t.w / 2 - 3, y0 - 3, t.w + 6, t.h + 6);
      g.setLineDash([]);
      if (drag?.id === o.id) {
        const a = f.toScreen(labelAnchor(o));
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(c.x, c.y);
        g.strokeStyle = '#3b82f6';
        g.stroke();
      }
    }
  },
};
