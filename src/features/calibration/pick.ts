import { apply, invert } from '@/core/affine';
import type { Project, Pt } from '@/core/types';
import { getProject } from '@/store/project';
import { useViewStore } from '@/store/view';
import { refreshHint, registerTool, setTool } from '@/tools/registry';
import type { FrameInfo, SnapResult, Tool, ToolContext } from '@/tools/types';
import { drawingPlacement } from '@/underlay/pick';

import { computeSnap } from '@/features/snap/engine';
import { snapSettings } from '@/features/snap/register';

/**
 * Point picking for calibration, alignment and distance checks (rows 28–32, 34). Snapping is limited
 * to one drawing's geometry (analysis objects and other drawings are ignored) so a pick lands on the
 * intended drawing even where drawings overlap. Each pick is reported in world metres and in the
 * target drawing's own units (inverse of its current placement).
 */

export interface PickRequest {
  /** Restrict snapping to this drawing (null: every visible drawing, no analysis objects). */
  drawingId: string | null;
  /** Number of points to collect. */
  count: number;
  prompt(i: number): string;
  onPoint(world: Pt, drawing: Pt | null, i: number): void;
  onDone?(): void;
  onCancel?(): void;
  /** Draws extra context (e.g. the reference being picked). */
  render?(g: CanvasRenderingContext2D, f: FrameInfo, picked: Pt[], cursor: Pt | null): void;
}

export const PICK_TOOL_ID = 'calibration.pick';

let request: PickRequest | null = null;
let picked: Pt[] = [];
let cursor: { pt: Pt; snap: SnapResult | null } | null = null;
let ctxRef: ToolContext | null = null;

function restrictedProject(p: Project, drawingId: string | null): Project {
  return {
    ...p,
    drawings: drawingId ? p.drawings.filter((d) => d.id === drawingId) : p.drawings,
    objects: [],
    anchors: [],
  };
}

function snapAt(world: Pt, f: FrameInfo, base: Pt | null): { pt: Pt; snap: SnapResult | null } {
  const p = getProject();
  if (!p || !request) return { pt: world, snap: null };
  const snap = computeSnap({
    project: restrictedProject(p, request.drawingId),
    world,
    scale: f.scale,
    base,
    settings: snapSettings(),
  });
  return snap ? { pt: snap.pt, snap } : { pt: world, snap: null };
}

/** World point → drawing units of the request's drawing. */
function toDrawingUnits(world: Pt): Pt | null {
  const p = getProject();
  const d = request?.drawingId ? p?.drawings.find((x) => x.id === request!.drawingId) : null;
  if (!d) return null;
  try {
    return apply(invert(drawingPlacement(d)), world);
  } catch {
    return null;
  }
}

function finish(cancelled: boolean) {
  const r = request;
  request = null;
  picked = [];
  cursor = null;
  if (cancelled) r?.onCancel?.();
  else r?.onDone?.();
}

export function startPick(r: PickRequest) {
  if (request) finish(true);
  request = r;
  picked = [];
  cursor = null;
  setTool(PICK_TOOL_ID);
  refreshHint();
  ctxRef?.requestRender();
}

export function cancelPick() {
  if (!request) return;
  finish(true);
  setTool('select');
}

export function isPicking(): boolean {
  return request !== null;
}

/** Snap glyph like the snap overlay's (the snap overlay is idle while this tool snaps itself). */
export function drawSnapGlyph(g: CanvasRenderingContext2D, s: Pt, mode: string) {
  const r = 6;
  g.save();
  g.strokeStyle = '#22c55e';
  g.lineWidth = 2;
  g.beginPath();
  switch (mode) {
    case 'endpoint':
      g.rect(s.x - r, s.y - r, 2 * r, 2 * r);
      break;
    case 'midpoint':
      g.moveTo(s.x, s.y - r);
      g.lineTo(s.x + r, s.y + r);
      g.lineTo(s.x - r, s.y + r);
      g.closePath();
      break;
    case 'centre':
      g.arc(s.x, s.y, r, 0, Math.PI * 2);
      break;
    case 'quadrant':
      g.moveTo(s.x, s.y - r);
      g.lineTo(s.x + r, s.y);
      g.lineTo(s.x, s.y + r);
      g.lineTo(s.x - r, s.y);
      g.closePath();
      break;
    case 'intersection':
      g.moveTo(s.x - r, s.y - r);
      g.lineTo(s.x + r, s.y + r);
      g.moveTo(s.x + r, s.y - r);
      g.lineTo(s.x - r, s.y + r);
      break;
    default:
      g.moveTo(s.x - r, s.y - r);
      g.lineTo(s.x + r, s.y - r);
      g.lineTo(s.x - r, s.y + r);
      g.lineTo(s.x + r, s.y + r);
      g.closePath();
  }
  g.stroke();
  g.font = '11px Inter Variable, sans-serif';
  const label = mode[0].toUpperCase() + mode.slice(1);
  const tw = g.measureText(label).width;
  g.fillStyle = 'rgba(15,23,42,0.85)';
  g.fillRect(s.x + 10, s.y + 8, tw + 8, 16);
  g.fillStyle = '#f8fafc';
  g.fillText(label, s.x + 14, s.y + 20);
  g.restore();
}

/** Numbered pick marker. */
export function drawMarker(g: CanvasRenderingContext2D, s: Pt, label: string, color = '#f59e0b') {
  g.save();
  g.strokeStyle = color;
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(s.x - 7, s.y);
  g.lineTo(s.x + 7, s.y);
  g.moveTo(s.x, s.y - 7);
  g.lineTo(s.x, s.y + 7);
  g.stroke();
  g.beginPath();
  g.arc(s.x, s.y, 3.5, 0, Math.PI * 2);
  g.stroke();
  if (label) {
    g.font = '600 11px Inter Variable, sans-serif';
    const tw = g.measureText(label).width;
    g.fillStyle = color;
    g.beginPath();
    g.roundRect(s.x + 6, s.y - 20, tw + 8, 15, 3);
    g.fill();
    g.fillStyle = '#0b0f14';
    g.fillText(label, s.x + 10, s.y - 8.5);
  }
  g.restore();
}

export const pickTool: Tool = {
  id: PICK_TOOL_ID,
  title: 'Pick reference point',
  cursor: 'crosshair',
  snaps: false,
  hint: () => (request ? `${request.prompt(picked.length)}  (Esc: cancel)` : 'Pick a point'),
  activate(ctx) {
    ctxRef = ctx;
  },
  deactivate() {
    if (request) finish(true);
  },
  pointerMove(e, ctx) {
    if (!request) return;
    cursor = snapAt(e.world, ctx.frame(), picked[picked.length - 1] ?? null);
    useViewStore.getState().setCursor(cursor.pt);
  },
  pointerDown(e, ctx) {
    if (e.button !== 0 || !request) return;
    const s = snapAt(e.world, ctx.frame(), picked[picked.length - 1] ?? null);
    const pt = { x: s.pt.x, y: s.pt.y };
    const r = request;
    const i = picked.length;
    picked.push(pt);
    r.onPoint(pt, toDrawingUnits(pt), i);
    if (picked.length >= r.count) {
      finish(false);
      setTool('select');
    } else refreshHint();
  },
  keyDown(e) {
    if (e.key === 'Escape') {
      cancelPick();
      return true;
    }
    if (e.key === 'Backspace' && picked.length) {
      picked.pop();
      refreshHint();
      return true;
    }
    return false;
  },
  render(g, f) {
    if (!request) return;
    request.render?.(g, f, picked, cursor?.pt ?? null);
    const last = picked[picked.length - 1];
    if (last && cursor) {
      const a = f.toScreen(last);
      const b = f.toScreen(cursor.pt);
      g.save();
      g.strokeStyle = '#f59e0b';
      g.setLineDash([6, 4]);
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
      g.restore();
    }
    picked.forEach((p, i) => drawMarker(g, f.toScreen(p), String(i + 1)));
    if (cursor?.snap) drawSnapGlyph(g, f.toScreen(cursor.pt), cursor.snap.mode);
  },
};

export function registerPickTool() {
  registerTool(pickTool);
}
