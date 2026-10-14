import { Crosshair } from 'lucide-react';
import { create } from 'zustand';
import { toast } from 'sonner';

import { promptText } from '@/app/prompt';
import type { Pt } from '@/core/types';
import { createPickTool } from '@/features/draw/pick-tool';
import { getProject, useProjectStore } from '@/store/project';
import { useUiStore } from '@/store/ui';
import { refreshHint, registerTool, setTool } from '@/tools/registry';
import type { Tool } from '@/tools/types';

import {
  addAnchors,
  anchorsFromCircles,
  circleAt,
  circlesInWindow,
  nextAnchorName,
  type PickedCircle,
} from './ops';

/**
 * Anchor tools (row 47): place a named point (snapping to centres, endpoints, nozzles… via the
 * snapping engine) and bulk-create anchors from picked circle centres — click circles or drag a
 * window around them (left→right: whole circle inside; right→left: centre inside), Enter to create.
 */

interface AnchorsUi {
  showOnCanvas: boolean;
  hoverId: string | null;
  set(p: Partial<Omit<AnchorsUi, 'set'>>): void;
}

export const useAnchorsUi = create<AnchorsUi>()((set) => ({
  showOnCanvas: true,
  hoverId: null,
  set: (p) => set(p),
}));

export const PLACE_TOOL = 'anchors.place';
export const CIRCLES_TOOL = 'anchors.fromCircles';

let pendingName: string | null = null;

export const placeAnchorTool = createPickTool({
  id: PLACE_TOOL,
  title: 'Place anchor',
  icon: Crosshair,
  minPoints: 1,
  maxPoints: 1,
  repeat: true,
  prompt: () =>
    pendingName
      ? `Anchor “${pendingName}”: pick its position (snaps to centres and endpoints)`
      : 'Anchor: pick a point — snaps to equipment centres, nozzles and endpoints',
  preview: () => null,
  key(e) {
    if (e.key === 'Escape') pendingName = null;
    return null;
  },
  finish(pts) {
    const at: Pt = pts[0];
    const preset = pendingName;
    pendingName = null;
    void (async () => {
      const p = getProject();
      if (!p || useProjectStore.getState().readOnly) return;
      const name =
        preset ??
        (await promptText({ title: 'New anchor', label: 'Anchor name', defaultValue: nextAnchorName(p) }));
      if (!name?.trim()) return;
      const ids = addAnchors([{ name: name.trim(), p: at }]);
      if (ids.length && preset) setTool('select');
      refreshHint();
    })();
  },
});

/** Starts the place tool for an anchor that dataset rows reference but that does not exist yet. */
export function placeAnchorNamed(name: string) {
  setTool('select');
  pendingName = name;
  setTool(PLACE_TOOL);
  refreshHint();
  toast.info(`Pick the position of anchor “${name}” on the drawing.`);
}

// --- bulk from circles ----------------------------------------------------------------------------------

const picked = new Map<string, PickedCircle>();
let drag: { start: Pt; end: Pt; sx: number; sy: number; moved: boolean } | null = null;

async function createFromPicked() {
  const p = getProject();
  if (!p || !picked.size) return;
  const circles = [...picked.values()];
  const needPrefix = circles.some((c) => !c.text);
  let prefix = 'A';
  if (needPrefix) {
    const v = await promptText({
      title: `Anchors from ${circles.length} circle(s)`,
      description: 'Circles with a text tag inside (e.g. P-101) are named after it; the others are numbered.',
      label: 'Name prefix',
      defaultValue: 'A',
    });
    if (v === null) return;
    prefix = v;
  }
  const list = anchorsFromCircles(getProject() ?? p, circles, prefix);
  if (!list.length) {
    toast.info('Every picked centre already has an anchor.');
    return;
  }
  const ids = addAnchors(list, `Anchors from ${list.length} circle(s)`);
  if (ids.length) {
    toast.success(`${ids.length} anchor(s) created`, {
      description: list
        .slice(0, 6)
        .map((a) => a.name)
        .join(', '),
    });
    picked.clear();
    setTool('select');
    useUiStore.getState().setInspectorTab('layers');
  }
}

export const circlesTool: Tool = {
  id: CIRCLES_TOOL,
  title: 'Anchors from circles',
  cursor: 'crosshair',
  snaps: false,
  hint: () =>
    `${picked.size} circle(s) picked — click circles or drag a window around them; Enter creates anchors, Esc cancels`,
  activate() {
    picked.clear();
    refreshHint();
  },
  deactivate() {
    picked.clear();
    drag = null;
  },
  pointerDown(e) {
    if (e.button !== 0) return;
    drag = { start: e.world, end: e.world, sx: e.screen.x, sy: e.screen.y, moved: false };
  },
  pointerMove(e) {
    if (!drag) return;
    drag.end = e.world;
    if (Math.hypot(e.screen.x - drag.sx, e.screen.y - drag.sy) > 4) drag.moved = true;
  },
  pointerUp(e, ctx) {
    const d = drag;
    drag = null;
    const p = getProject();
    if (!d || !p) return;
    if (d.moved) {
      const f = ctx.frame();
      const inside = f.toScreen(d.end).x >= f.toScreen(d.start).x;
      const b = {
        minX: Math.min(d.start.x, d.end.x),
        minY: Math.min(d.start.y, d.end.y),
        maxX: Math.max(d.start.x, d.end.x),
        maxY: Math.max(d.start.y, d.end.y),
      };
      for (const c of circlesInWindow(p, b, inside)) picked.set(c.key, c);
    } else {
      const c = circleAt(p, e.world, ctx.frame().scale);
      if (c) {
        if (picked.has(c.key)) picked.delete(c.key);
        else picked.set(c.key, c);
      }
    }
    refreshHint();
  },
  keyDown(e) {
    if (e.key === 'Enter') {
      void createFromPicked();
      return true;
    }
    if (e.key === 'Escape') {
      if (picked.size) picked.clear();
      else setTool('select');
      refreshHint();
      return true;
    }
    if (e.key === 'Backspace' && picked.size) {
      picked.delete([...picked.keys()].pop()!);
      refreshHint();
      return true;
    }
    return false;
  },
  render(g, f) {
    g.lineWidth = 2;
    g.strokeStyle = '#f59e0b';
    g.fillStyle = 'rgba(245,158,11,0.15)';
    for (const c of picked.values()) {
      const s = f.toScreen(c.c);
      g.beginPath();
      g.arc(s.x, s.y, Math.max(3, c.r * f.scale), 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.beginPath();
      g.moveTo(s.x - 5, s.y);
      g.lineTo(s.x + 5, s.y);
      g.moveTo(s.x, s.y - 5);
      g.lineTo(s.x, s.y + 5);
      g.stroke();
    }
    if (drag?.moved) {
      const a = f.toScreen(drag.start);
      const b = f.toScreen(drag.end);
      const inside = b.x >= a.x;
      g.beginPath();
      g.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      g.fillStyle = inside ? 'rgba(59,130,246,0.08)' : 'rgba(34,197,94,0.08)';
      g.strokeStyle = inside ? '#3b82f6' : '#22c55e';
      g.lineWidth = 1;
      g.setLineDash(inside ? [] : [5, 4]);
      g.fill();
      g.stroke();
      g.setLineDash([]);
    }
  },
};

/** Creates anchors from selected analysis circles (no tool needed). */
export function anchorsFromSelectedCircles(ids: string[]) {
  const p = getProject();
  if (!p) return;
  const set = new Set(ids);
  const circles: PickedCircle[] = p.objects
    .filter((o) => set.has(o.id) && o.geometry.type === 'circle')
    .map((o) => {
      const g = o.geometry as { c: Pt; r: number };
      return { key: `o:${o.id}`, c: g.c, r: g.r, ...(/^circle \d+$/i.test(o.name) ? {} : { text: o.name }) };
    });
  if (!circles.length) {
    toast.info('Select one or more circles first.');
    return;
  }
  picked.clear();
  for (const c of circles) picked.set(c.key, c);
  void createFromPicked();
}

export function registerAnchorTools() {
  registerTool(placeAnchorTool);
  registerTool(circlesTool);
}
