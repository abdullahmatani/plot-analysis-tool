import { apply, applyVec, invert, isSimilarity, rotationOf, scaleFactor } from '@/core/affine';
import type { Affine2D, AnalysisObject, Project, Pt } from '@/core/types';
import { intersectPrims, primsTolerance } from '@/geometry/intersect';
import { snapCandidates, SNAP_PRIORITY, type SnapCandidate, type SnapMode } from '@/geometry/nearest';
import { primBounds, primsFromGeometry, primsFromStoreEntity, type Prim } from '@/geometry/prims';
import type { SnapResult } from '@/tools/types';
import { FLAG, GK } from '@/underlay/entity-store';
import { getModel } from '@/underlay/models';
import { drawingPlacement, visibleLayerFlags } from '@/underlay/pick';

/**
 * Snapping engine (row 27): endpoint, midpoint, centre, quadrant, intersection, nearest,
 * perpendicular and tangent snaps on vector underlays (DXF/DWG entities and PDF vectors) and on
 * analysis objects and anchors; ortho and polar tracking; grid snap. Underlay candidates are computed
 * in each drawing's own units and mapped to the world with the drawing's placement, so endpoint and
 * centre snaps return the transformed stored coordinates without re-computation error.
 */

export interface SnapSettings {
  enabled: boolean;
  modes: ReadonlySet<SnapMode>;
  ortho: boolean;
  polar: boolean;
  polarIncrementDeg: number;
  gridSnap: boolean;
  gridSize: number;
  /** Pixel radius around the cursor. */
  radiusPx: number;
  /** View rotation (ortho follows the screen axes). */
  viewRotation: number;
}

export interface SnapQuery {
  project: Project;
  world: Pt;
  /** Screen px per world metre. */
  scale: number;
  base: Pt | null;
  settings: SnapSettings;
  /** Objects to ignore (e.g. the one being edited). */
  exclude?: ReadonlySet<string>;
  /** Hidden analysis layers are not snappable. */
  objectFilter?: (o: AnalysisObject) => boolean;
}

interface Scored {
  pt: Pt;
  mode: string;
  distPx: number;
  prio: number;
  source: SnapResult['source'];
}

const MAX_ENTITIES = 400;

function transformPrim(p: Prim, m: Affine2D): Prim | null {
  const k = scaleFactor(m);
  const rot = rotationOf(m);
  switch (p.k) {
    case 'seg':
      return { k: 'seg', a: apply(m, p.a), b: apply(m, p.b) };
    case 'point':
      return { k: 'point', p: apply(m, p.p) };
    case 'circle':
      return { k: 'circle', c: apply(m, p.c), r: p.r * k };
    case 'arc':
      return { k: 'arc', c: apply(m, p.c), r: p.r * k, a0: p.a0 + rot, a1: p.a1 + rot };
    case 'ellipse':
      return {
        k: 'ellipse',
        c: apply(m, p.c),
        major: applyVec(m, p.major),
        ratio: p.ratio,
        t0: p.t0,
        t1: p.t1,
      };
  }
}

function objectPrims(o: AnalysisObject): Prim[] {
  if (o.geometry.type === 'point') return [{ k: 'point', p: o.geometry.p }];
  return primsFromGeometry(o.geometry);
}

export function computeSnap(q: SnapQuery): SnapResult | null {
  const { project, world, scale, settings } = q;
  if (!settings.enabled) return null;
  const radiusW = settings.radiusPx / scale;
  const out: Scored[] = [];
  const worldPrims: { prim: Prim; source: SnapResult['source'] }[] = [];

  // --- underlay drawings, in their own units
  for (const d of project.drawings) {
    if (!d.visible) continue;
    const m = getModel(d.id);
    const store = m?.result?.store;
    if (!m?.index || !store || m.result?.page?.raster) continue;
    const place = drawingPlacement(d);
    let inv: Affine2D;
    try {
      inv = invert(place);
    } catch {
      continue;
    }
    const unitPx = scale * scaleFactor(place);
    const pd = apply(inv, world);
    const r = settings.radiusPx / unitPx;
    const flags = visibleLayerFlags(d);
    const ids = m.index.search(pd.x - r, pd.y - r, pd.x + r, pd.y + r);
    const prims: Prim[] = [];
    const owners: number[] = [];
    // Large circles' centres are far from the cursor; include entities whose bbox contains the cursor region generously.
    for (const i of ids.slice(0, MAX_ENTITIES)) {
      if (store.flags[i] & (FLAG.HIDDEN | FLAG.DERIVED)) continue;
      if (!flags[store.layer[i]]) continue;
      if (store.geomKind[i] === GK.TEXT) continue;
      for (const p of primsFromStoreEntity(store, i)) {
        prims.push(p);
        owners.push(i);
      }
    }
    if (!prims.length) continue;
    const base = q.base ? apply(inv, q.base) : undefined;
    const cands: SnapCandidate[] = snapCandidates(pd, prims, {
      modes: settings.modes,
      radius: r,
      from: base,
    });
    for (const c of cands) {
      out.push({
        pt: apply(place, c.pt),
        mode: c.mode,
        distPx: c.dist * unitPx,
        prio: SNAP_PRIORITY[c.mode],
        source: { kind: 'underlay', drawingId: d.id, index: owners[c.primIndex] },
      });
    }
    if (settings.modes.has('intersection') && isSimilarity(place)) {
      for (let k = 0; k < prims.length; k++) {
        const wp = transformPrim(prims[k], place);
        if (wp)
          worldPrims.push({ prim: wp, source: { kind: 'underlay', drawingId: d.id, index: owners[k] } });
      }
    }
  }

  // --- analysis objects and anchors, in world units
  const objPrims: { prim: Prim; source: SnapResult['source'] }[] = [];
  const hiddenLayers = new Set(project.layers.filter((l) => !l.visible).map((l) => l.id));
  for (const o of project.objects) {
    if (q.exclude?.has(o.id) || hiddenLayers.has(o.layerId)) continue;
    if (q.objectFilter && !q.objectFilter(o)) continue;
    for (const p of objectPrims(o)) {
      const b = primBounds(p);
      const centreReach = p.k === 'circle' || p.k === 'arc' || p.k === 'ellipse';
      const near =
        world.x >= b.minX - radiusW &&
        world.x <= b.maxX + radiusW &&
        world.y >= b.minY - radiusW &&
        world.y <= b.maxY + radiusW;
      if (near || centreReach) objPrims.push({ prim: p, source: { kind: 'object', id: o.id } });
    }
  }
  if (objPrims.length) {
    const cands = snapCandidates(
      world,
      objPrims.map((p) => p.prim),
      { modes: settings.modes, radius: radiusW, from: q.base ?? undefined },
    );
    for (const c of cands) {
      out.push({
        pt: c.pt,
        mode: c.mode,
        distPx: c.dist * scale,
        prio: SNAP_PRIORITY[c.mode],
        source: objPrims[c.primIndex].source,
      });
    }
  }
  // Intersections between underlay geometry and analysis objects.
  if (settings.modes.has('intersection') && worldPrims.length && objPrims.length) {
    for (const a of worldPrims) {
      for (const b of objPrims) {
        for (const p of intersectPrims(a.prim, b.prim, primsTolerance(a.prim, b.prim))) {
          const d = Math.hypot(p.x - world.x, p.y - world.y) * scale;
          if (d <= settings.radiusPx)
            out.push({ pt: p, mode: 'intersection', distPx: d, prio: 0, source: b.source });
        }
      }
    }
  }
  for (const a of project.anchors) {
    const d = Math.hypot(a.p.x - world.x, a.p.y - world.y) * scale;
    if (d <= settings.radiusPx)
      out.push({ pt: a.p, mode: 'anchor', distPx: d, prio: 0, source: { kind: 'anchor', id: a.id } });
  }

  if (!out.length) return null;
  out.sort((a, b) => a.prio - b.prio || a.distPx - b.distPx);
  const best = out[0];
  return { pt: best.pt, mode: best.mode, source: best.source };
}

/** Ortho / polar tracking relative to a base point (applied when no object snap is active). */
export function constrain(world: Pt, base: Pt | null, s: SnapSettings): { pt: Pt; mode: string } | null {
  if (!base) return null;
  const dx = world.x - base.x;
  const dy = world.y - base.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const ang = Math.atan2(dy, dx);
  if (s.ortho) {
    const step = Math.PI / 2;
    const a = Math.round((ang - s.viewRotation) / step) * step + s.viewRotation;
    const proj = dx * Math.cos(a) + dy * Math.sin(a);
    return { pt: { x: base.x + proj * Math.cos(a), y: base.y + proj * Math.sin(a) }, mode: 'ortho' };
  }
  if (s.polar) {
    const step = (s.polarIncrementDeg * Math.PI) / 180;
    const a = Math.round((ang - s.viewRotation) / step) * step + s.viewRotation;
    if (Math.abs(a - ang) <= (3 * Math.PI) / 180) {
      const proj = dx * Math.cos(a) + dy * Math.sin(a);
      return { pt: { x: base.x + proj * Math.cos(a), y: base.y + proj * Math.sin(a) }, mode: 'polar' };
    }
  }
  return null;
}

export function gridSnap(world: Pt, size: number): Pt {
  return { x: Math.round(world.x / size) * size, y: Math.round(world.y / size) * size };
}
