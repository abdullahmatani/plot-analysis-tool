import { isDraft, original, type Draft } from 'immer';

import type { AnalysisObject, Geometry, OffsetDerivation, Project } from '@/core/types';
import { centroid } from '@/geometry/measure';
import { offsetGeometry, type OffsetOptions, type OffsetResult } from '@/geometry/offset';

/**
 * Parametric (live) offsets (FDR row 59).
 *
 * An offset object keeps `derived = { sourceId, distance, join, cap, miterLimit, ringGroup }`. The
 * derivation registered with `registerDerivation` (core/history) runs inside every commit, after the
 * user's recipe, and recomputes each live offset whose source geometry, own parameters or the
 * project chord tolerance changed. The recomputed geometry is part of the same patches, so a source
 * edit and its offsets are one undo step and replay identically from the journal.
 *
 * Rules:
 *  - source geometry, offset parameters or `project.chordTolerance` changed → recompute (offsets of
 *    offsets are processed source-first);
 *  - source deleted (or a dependency cycle) → the offset is detached (keeps its geometry, static);
 *  - the offset's own geometry edited directly (grip, move, vertex table) while its source and
 *    parameters are unchanged → detached, so the edit is kept;
 *  - a contraction that collapses the shape leaves a point at the source centroid (the offset stays
 *    live and reappears when the source grows again); a warning is reported.
 * Change detection uses object identity: Immer keeps unchanged objects and geometries identical.
 */

export function offsetOptions(der: OffsetDerivation, chordTol: number): OffsetOptions {
  return {
    join: der.join,
    cap: der.cap ?? 'round',
    miterLimit: der.miterLimit ?? 2,
    chordTol: chordTol > 0 ? chordTol : 0.005,
  };
}

/** Offset of a source geometry with the parameters of a derivation. */
export function computeOffset(src: Geometry, der: OffsetDerivation, chordTol: number): OffsetResult {
  return offsetGeometry(src, der.distance, offsetOptions(der, chordTol));
}

export interface DeriveReport {
  recomputed: string[];
  detached: { id: string; reason: 'source-deleted' | 'edited' | 'cycle' }[];
  collapsed: { id: string; message: string }[];
}

interface BeforeIndex {
  byId: Map<string, AnalysisObject>;
  derivedCount: number;
}

const indexCache = new WeakMap<readonly AnalysisObject[], BeforeIndex>();

function indexOf(objects: readonly AnalysisObject[]): BeforeIndex {
  let ix = indexCache.get(objects);
  if (!ix) {
    const byId = new Map<string, AnalysisObject>();
    let derivedCount = 0;
    for (const o of objects) {
      byId.set(o.id, o);
      if (o.derived) derivedCount++;
    }
    ix = { byId, derivedCount };
    indexCache.set(objects, ix);
  }
  return ix;
}

/** True when the project has at least one live offset (cheap; cached per objects array). */
export function hasLiveOffsets(p: Project): boolean {
  return indexOf(p.objects).derivedCount > 0;
}

/** Geometry shown for a collapsed live offset: a point at the source centroid. */
function collapsedGeometry(src: Geometry): Geometry {
  try {
    const c = centroid(src);
    if (Number.isFinite(c.x) && Number.isFinite(c.y)) return { type: 'point', p: { x: c.x, y: c.y } };
  } catch {
    /* fall through */
  }
  return { type: 'point', p: { x: 0, y: 0 } };
}

/**
 * The derivation itself (see module notes). `before` is the project before the commit; `d` a draft
 * of the project after the user's recipe. Returns what was done (for user feedback).
 */
export function deriveOffsets(d: Draft<Project>, before: Project): DeriveReport {
  const report: DeriveReport = { recomputed: [], detached: [], collapsed: [] };
  const prev = indexOf(before.objects);
  // Only offsets that existed before the commit can be out of date: new offsets are created with
  // their geometry computed by the creating command.
  if (prev.derivedCount === 0) return report;
  // The post-recipe project (plain, structurally shared with `before`: unchanged objects are identical).
  const after = (isDraft(d) ? original(d) : d) as Project;
  const objs = after.objects;
  const at = new Map<string, number>();
  objs.forEach((o, i) => at.set(o.id, i));
  const chordTol = after.chordTolerance;
  const chordChanged = chordTol !== before.chordTolerance;

  // Live offsets that existed before, deepest dependency last.
  const live: AnalysisObject[] = [];
  for (const o of objs) if (o.derived && prev.byId.get(o.id)?.derived) live.push(o);
  if (!live.length) return report;
  const depthMemo = new Map<string, number>();
  const depth = (o: AnalysisObject, seen: Set<string>): number => {
    const memo = depthMemo.get(o.id);
    if (memo !== undefined) return memo;
    if (seen.has(o.id)) return Infinity; // cycle
    seen.add(o.id);
    const si = o.derived ? at.get(o.derived.sourceId) : undefined;
    const src = si === undefined ? undefined : objs[si];
    const dep = src?.derived ? 1 + depth(src, seen) : 0;
    depthMemo.set(o.id, dep);
    return dep;
  };
  const ordered = live.map((o) => ({ o, dep: depth(o, new Set()) })).sort((a, b) => a.dep - b.dep);

  const updated = new Map<string, Geometry>();
  for (const { o, dep } of ordered) {
    const i = at.get(o.id)!;
    const der = o.derived!;
    const b = prev.byId.get(o.id)!;
    const si = at.get(der.sourceId);
    if (si === undefined || dep === Infinity || der.sourceId === o.id) {
      delete d.objects[i].derived;
      report.detached.push({ id: o.id, reason: si === undefined ? 'source-deleted' : 'cycle' });
      continue;
    }
    const src = objs[si];
    const srcBefore = prev.byId.get(src.id);
    const srcChanged = !srcBefore || srcBefore.geometry !== src.geometry || updated.has(src.id);
    const paramsChanged = b.derived !== der;
    if (!srcChanged && !paramsChanged && !chordChanged) {
      if (b.geometry !== o.geometry) {
        delete d.objects[i].derived;
        report.detached.push({ id: o.id, reason: 'edited' });
      }
      continue;
    }
    // The source's current geometry: recomputed in this pass if it is itself a live offset.
    const srcGeom = updated.get(src.id) ?? src.geometry;
    const res = computeOffset(srcGeom, der, chordTol);
    const geometry = res.geometry ?? collapsedGeometry(srcGeom);
    d.objects[i].geometry = geometry;
    updated.set(o.id, geometry);
    report.recomputed.push(o.id);
    if (!res.geometry) report.collapsed.push({ id: o.id, message: res.warning ?? 'The offset collapses' });
  }
  return report;
}
