import { toast } from 'sonner';

import { currentSession } from '@/app/session';
import {
  applyVec,
  apply,
  approxEqual,
  invert,
  isSimilarity,
  multiply,
  scaleFactor,
  transformBounds,
} from '@/core/affine';
import type { Affine2D, AnalysisObject, Anchor, Bounds, Drawing, Project } from '@/core/types';
import { transformGeometry } from '@/geometry/convert';
import { bounds as geometryBounds } from '@/geometry/measure';
import { clampScale, visibleWorldBounds } from '@/render/view';
import { commit, getProject } from '@/store/project';
import { useViewStore } from '@/store/view';
import { getModel, placementOf } from '@/underlay/models';

import { askRecalibration } from './prompts';

/**
 * Recalibration behaviour (row 33). When a drawing's placement (calibration, unit override or
 * alignment) changes and analysis objects lie on it, the user chooses whether they move with the
 * drawing — the delta transform new ∘ old⁻¹ is applied exactly to their geometry (circles stay circles
 * under similarity transforms) — or stay at their world position. Drawing and objects change in ONE
 * undoable command.
 */

/** World → world map taking a point on the drawing at its old placement to its new placement. */
export function deltaTransform(oldPlacement: Affine2D, newPlacement: Affine2D): Affine2D {
  return multiply(newPlacement, invert(oldPlacement));
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function inside(p: { x: number; y: number }, b: Bounds): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
}

/**
 * Analysis objects and anchors that lie on a drawing: every one when the project has a single drawing,
 * otherwise those overlapping the drawing's world extents (at its current placement).
 */
export function itemsOnDrawing(
  project: Project,
  drawingId: string,
  worldExtents: Bounds | null,
): { objects: string[]; anchors: string[] } {
  if (project.drawings.length <= 1 || !worldExtents) {
    return { objects: project.objects.map((o) => o.id), anchors: project.anchors.map((a) => a.id) };
  }
  void drawingId;
  return {
    objects: project.objects
      .filter((o) => intersects(geometryBounds(o.geometry), worldExtents))
      .map((o) => o.id),
    anchors: project.anchors.filter((a) => inside(a.p, worldExtents)).map((a) => a.id),
  };
}

/** Geometry and label offset of an object moved by `delta` (exact for similarity transforms). */
export function movedObject(
  o: AnalysisObject,
  delta: Affine2D,
  chordTol: number,
): Pick<AnalysisObject, 'geometry' | 'label'> {
  const geometry = transformGeometry(o.geometry, delta, chordTol);
  const label = o.label?.offset ? { ...o.label, offset: applyVec(delta, o.label.offset) } : o.label;
  return { geometry, label };
}

export function movedAnchor(a: Anchor, delta: Affine2D): Anchor {
  return { ...a, p: apply(delta, a.p) };
}

export interface PlacementPlan {
  drawing: Drawing;
  next: Drawing;
  oldPlacement: Affine2D;
  newPlacement: Affine2D;
  delta: Affine2D;
  changed: boolean;
  objects: string[];
  anchors: string[];
}

/** Computes what a drawing change does to its placement and which items lie on the drawing. */
export function planPlacementChange(
  project: Project,
  drawingId: string,
  mutate: (d: Drawing) => void,
  insunits: number | undefined,
  extents: Bounds | null,
): PlacementPlan | null {
  const drawing = project.drawings.find((d) => d.id === drawingId);
  if (!drawing) return null;
  const next = structuredClone(drawing);
  mutate(next);
  const oldPlacement = placementOf(drawing, insunits);
  const newPlacement = placementOf(next, insunits);
  const changed = !approxEqual(oldPlacement, newPlacement, 1e-15);
  const delta = deltaTransform(oldPlacement, newPlacement);
  const items = changed
    ? itemsOnDrawing(project, drawingId, extents ? transformBounds(oldPlacement, extents) : null)
    : { objects: [], anchors: [] };
  return { drawing, next, oldPlacement, newPlacement, delta, changed, ...items };
}

/**
 * Applies a plan in one commit. `move` = objects and anchors on the drawing follow it. Verification
 * (row 32) is cleared when the placement changes.
 */
export function commitPlan(
  project: Project,
  plan: PlacementPlan,
  label: string,
  mutate: (d: Drawing) => void,
  move: boolean,
): boolean {
  const moved = new Map<string, Pick<AnalysisObject, 'geometry' | 'label'>>();
  const movedAnchors = new Map<string, Anchor>();
  if (move && plan.changed) {
    const ids = new Set(plan.objects);
    for (const o of project.objects)
      if (ids.has(o.id)) moved.set(o.id, movedObject(o, plan.delta, project.chordTolerance));
    const aids = new Set(plan.anchors);
    for (const a of project.anchors) if (aids.has(a.id)) movedAnchors.set(a.id, movedAnchor(a, plan.delta));
  }
  return commit(label, (p) => {
    const d = p.drawings.find((x) => x.id === plan.drawing.id);
    if (!d) return;
    mutate(d as Drawing);
    if (plan.changed) delete d.verified;
    for (const o of p.objects) {
      const m = moved.get(o.id);
      if (!m) continue;
      o.geometry = m.geometry;
      if (m.label) o.label = m.label;
    }
    p.anchors = p.anchors.map((a) => movedAnchors.get(a.id) ?? a);
  });
}

/**
 * Changes a drawing's calibration / units / alignment (rows 26, 28–31, 34) with the row-33 prompt.
 * Resolves false when cancelled or read-only.
 */
export async function applyPlacementChange(
  drawingId: string,
  label: string,
  mutate: (d: Drawing) => void,
): Promise<boolean> {
  const project = getProject();
  if (!project) return false;
  const model = getModel(drawingId);
  const plan = planPlacementChange(
    project,
    drawingId,
    mutate,
    model?.result?.insunits,
    model?.result?.extents ?? null,
  );
  if (!plan) return false;
  let move = false;
  const count = plan.objects.length + plan.anchors.length;
  if (plan.changed && count > 0) {
    const choice = await askRecalibration({
      label,
      drawingName: plan.drawing.name,
      objects: plan.objects.length,
      anchors: plan.anchors.length,
      distorting: !isSimilarity(plan.delta),
    });
    if (choice === null) return false;
    move = choice === 'move';
    if (move) await currentSession()?.beforeHighImpact(label);
  }
  // Re-read: the project may have changed while the prompt was open.
  const now = getProject();
  if (!now) return false;
  const fresh = planPlacementChange(
    now,
    drawingId,
    mutate,
    model?.result?.insunits,
    model?.result?.extents ?? null,
  );
  if (!fresh) return false;
  const ok = commitPlan(now, fresh, label, mutate, move);
  if (!ok && plan.changed) toast.error('The change could not be applied (the project is read-only).');
  if (ok && fresh.changed) followView(fresh, model?.result?.extents ?? null);
  return ok;
}

/**
 * Keeps the drawing on screen when its placement changes (e.g. paper → site scale, or a sub-drawing
 * moved onto the plot plan): when the drawing was in view, the view follows the delta transform.
 */
export function followView(plan: PlacementPlan, extents: Bounds | null) {
  const vs = useViewStore.getState();
  const v = vs.view;
  if (extents) {
    const b = transformBounds(plan.oldPlacement, extents);
    const vis = visibleWorldBounds(v, vs.canvasSize.w, vs.canvasSize.h);
    if (b.minX > vis.maxX || b.maxX < vis.minX || b.minY > vis.maxY || b.maxY < vis.minY) return;
  }
  const c = apply(plan.delta, { x: v.cx, y: v.cy });
  const k = scaleFactor(plan.delta);
  if (!(k > 0) || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return;
  vs.setView({ cx: c.x, cy: c.y, scale: clampScale(v.scale / k) });
}
