import type { Draft } from 'immer';
import { toast } from 'sonner';

import { apply, invert, scaleFactor, transformBounds } from '@/core/affine';
import { newId } from '@/core/ids';
import type { Affine2D, Anchor, Bounds, ContourDataset, Project, Pt } from '@/core/types';
import { commit, getProject } from '@/store/project';
import { findColumn, normaliseAnchorName } from '@/tables/access';
import { cellText } from '@/tables/values';
import { entityText, entityToGeometry } from '@/underlay/entity-geometry';
import { FLAG, GK } from '@/underlay/entity-store';
import { getModel } from '@/underlay/models';
import { drawingPlacement, pickUnderlay, visibleLayerFlags } from '@/underlay/pick';

/**
 * Anchors (row 47): named reference points used by contour datasets in anchor mode (row 64). Every
 * change is one undoable command; renaming an anchor also renames every dataset cell referencing it
 * (in the same command), so the rows stay attached.
 */

/** Next free name like "A1", "A2"… (or `${prefix}${n}`). */
export function nextAnchorName(p: Project, prefix = 'A'): string {
  const used = new Set(p.anchors.map((a) => normaliseAnchorName(a.name)));
  for (let n = 1; ; n++) {
    const name = `${prefix}${n}`;
    if (!used.has(normaliseAnchorName(name))) return name;
  }
}

/** Makes names unique against existing anchors and each other ("P-101", "P-101 (2)"). */
export function uniqueAnchorNames(p: Project, names: string[]): string[] {
  const used = new Set(p.anchors.map((a) => normaliseAnchorName(a.name)));
  return names.map((n) => {
    let name = n.trim() || 'A';
    if (used.has(normaliseAnchorName(name))) {
      for (let k = 2; ; k++) {
        const c = `${name} (${k})`;
        if (!used.has(normaliseAnchorName(c))) {
          name = c;
          break;
        }
      }
    }
    used.add(normaliseAnchorName(name));
    return name;
  });
}

export function addAnchors(list: { name: string; p: Pt }[], label?: string): string[] {
  const p = getProject();
  if (!p || !list.length) return [];
  const names = uniqueAnchorNames(
    p,
    list.map((a) => a.name),
  );
  const anchors: Anchor[] = list.map((a, i) => ({
    id: newId('anc'),
    name: names[i],
    p: { x: a.p.x, y: a.p.y },
  }));
  const ok = commit(
    label ?? (anchors.length === 1 ? `Place anchor “${anchors[0].name}”` : `Place ${anchors.length} anchors`),
    (d) => {
      d.anchors.push(...anchors);
    },
  );
  return ok ? anchors.map((a) => a.id) : [];
}

/** Dataset cells (dataset id → row indices) whose anchor column references `name`. */
export function anchorReferences(p: Project, name: string): Map<string, number[]> {
  const key = normaliseAnchorName(name);
  const out = new Map<string, number[]>();
  for (const ds of p.datasets) {
    const col = findColumn(ds.table.columns, ds.mapping.position.anchor);
    if (col < 0) continue;
    const rows: number[] = [];
    ds.table.rows.forEach((r, i) => {
      if (normaliseAnchorName(cellText(r[col])) === key) rows.push(i);
    });
    if (rows.length) out.set(ds.id, rows);
  }
  return out;
}

/** Number of dataset rows referencing each anchor (normalised name → count). */
export function anchorUsage(datasets: readonly ContourDataset[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const ds of datasets) {
    const col = findColumn(ds.table.columns, ds.mapping.position.anchor);
    if (col < 0) continue;
    for (const r of ds.table.rows) {
      const k = normaliseAnchorName(cellText(r[col]));
      if (k) out.set(k, (out.get(k) ?? 0) + 1);
    }
  }
  return out;
}

/** Renames references in a project draft (pure on the draft): returns the number of cells changed. */
export function renameReferencesInDraft(
  d: Draft<Project> | Project,
  oldName: string,
  newName: string,
): number {
  const key = normaliseAnchorName(oldName);
  let n = 0;
  for (const ds of d.datasets as ContourDataset[]) {
    const col = findColumn(ds.table.columns, ds.mapping.position.anchor);
    if (col < 0) continue;
    for (const r of ds.table.rows) {
      if (normaliseAnchorName(cellText(r[col])) === key) {
        r[col] = newName;
        n++;
      }
    }
  }
  return n;
}

export type RenameResult = { ok: true; rows: number } | { ok: false; error: string };

/** Renames an anchor and every dataset row referencing it, as one undo step (row 47 acceptance). */
export function renameAnchor(id: string, newName: string): RenameResult {
  const p = getProject();
  const a = p?.anchors.find((x) => x.id === id);
  if (!p || !a) return { ok: false, error: 'Anchor not found.' };
  const name = newName.trim();
  if (!name) return { ok: false, error: 'Enter a name.' };
  if (name === a.name) return { ok: true, rows: 0 };
  const clash = p.anchors.find(
    (x) => x.id !== id && normaliseAnchorName(x.name) === normaliseAnchorName(name),
  );
  if (clash) return { ok: false, error: `An anchor named “${clash.name}” already exists.` };
  let rows = 0;
  const ok = commit(`Rename anchor “${a.name}” to “${name}”`, (d) => {
    const anc = d.anchors.find((x) => x.id === id);
    if (!anc) return;
    rows = renameReferencesInDraft(d, a.name, name);
    anc.name = name;
  });
  return ok ? { ok: true, rows } : { ok: false, error: 'The project is read-only.' };
}

export function deleteAnchors(ids: string[]): boolean {
  if (!ids.length) return false;
  const set = new Set(ids);
  return commit(ids.length === 1 ? 'Delete anchor' : `Delete ${ids.length} anchors`, (d) => {
    d.anchors = d.anchors.filter((a) => !set.has(a.id));
  });
}

export function moveAnchor(id: string, p: Pt): boolean {
  return commit('Move anchor', (d) => {
    const a = d.anchors.find((x) => x.id === id);
    if (a) a.p = { x: p.x, y: p.y };
  });
}

export function renameWithToast(id: string, name: string) {
  const r = renameAnchor(id, name);
  if (!r.ok) toast.error(r.error);
  else if (r.rows > 0) toast.success(`Anchor renamed`, { description: `${r.rows} dataset row(s) updated.` });
}

// --- circles (bulk creation) --------------------------------------------------------------------------

export interface PickedCircle {
  key: string;
  /** World centre and radius. */
  c: Pt;
  r: number;
  /** A text tag found inside the circle (equipment number), if any. */
  text?: string;
}

function textInside(drawingId: string, cd: Pt, rd: number): string | undefined {
  const m = getModel(drawingId);
  const store = m?.result?.store;
  if (!m?.textIndex || !store || !m.render) return undefined;
  let best: { d: number; t: string } | undefined;
  for (const k of m.textIndex.search(cd.x - rd, cd.y - rd, cd.x + rd, cd.y + rd)) {
    const i = m.render.textIds[k];
    const o = store.geomStart[i];
    const d = Math.hypot(store.geom[o] - cd.x, store.geom[o + 1] - cd.y);
    if (d > rd) continue;
    const t = entityText(store, i)?.split('\n')[0].trim();
    if (t && (!best || d < best.d)) best = { d, t };
  }
  return best?.t;
}

function underlayCircle(drawingId: string, index: number): PickedCircle | null {
  const p = getProject();
  const d = p?.drawings.find((x) => x.id === drawingId);
  const store = getModel(drawingId)?.result?.store;
  if (!d || !store) return null;
  const g = entityToGeometry(store, index);
  if (!g || (g.type !== 'circle' && g.type !== 'arc')) return null;
  const place = drawingPlacement(d);
  return {
    key: `u:${drawingId}:${index}`,
    c: apply(place, g.c),
    r: g.r * scaleFactor(place),
    text: textInside(drawingId, g.c, g.r),
  };
}

/** An analysis circle's name is a tag unless it is an automatic name ("Circle 3"). */
function objectTag(name: string): string | undefined {
  return /^(circle|shape|trace|offset) \d+$/i.test(name.trim()) ? undefined : name.trim() || undefined;
}

/** Circle (or arc) under the cursor: underlay entities first, then analysis circles. */
export function circleAt(p: Project, world: Pt, scale: number): PickedCircle | null {
  for (const h of pickUnderlay(p.drawings, world, scale, 6, { limit: 8 })) {
    const c = underlayCircle(h.drawingId, h.index);
    if (c) return c;
  }
  const hidden = new Set(p.layers.filter((l) => !l.visible).map((l) => l.id));
  const tol = 6 / scale;
  for (const o of p.objects) {
    if (hidden.has(o.layerId) || o.geometry.type !== 'circle') continue;
    const g = o.geometry;
    if (Math.abs(Math.hypot(world.x - g.c.x, world.y - g.c.y) - g.r) <= tol)
      return { key: `o:${o.id}`, c: g.c, r: g.r, text: objectTag(o.name) };
  }
  return null;
}

/**
 * Circles in a world window: `inside` = whole circle inside, else its centre inside. Underlay circle
 * entities of visible drawings and layers, and analysis-object circles on visible layers.
 */
export function circlesInWindow(p: Project, b: Bounds, inside: boolean): PickedCircle[] {
  const out: PickedCircle[] = [];
  const contains = (c: Pt, r: number) =>
    inside
      ? c.x - r >= b.minX && c.x + r <= b.maxX && c.y - r >= b.minY && c.y + r <= b.maxY
      : c.x >= b.minX && c.x <= b.maxX && c.y >= b.minY && c.y <= b.maxY;
  for (const d of p.drawings) {
    if (!d.visible) continue;
    const m = getModel(d.id);
    const store = m?.result?.store;
    if (!m?.index || !store) continue;
    const place = drawingPlacement(d);
    let inv: Affine2D;
    try {
      inv = invert(place);
    } catch {
      continue;
    }
    const bd = transformBounds(inv, b);
    const flags = visibleLayerFlags(d);
    for (const i of m.index.search(bd.minX, bd.minY, bd.maxX, bd.maxY)) {
      if (store.geomKind[i] !== GK.CIRCLE) continue;
      if (store.flags[i] & FLAG.HIDDEN || !flags[store.layer[i]]) continue;
      const c = underlayCircle(d.id, i);
      if (c && contains(c.c, c.r)) out.push(c);
    }
  }
  const hidden = new Set(p.layers.filter((l) => !l.visible).map((l) => l.id));
  for (const o of p.objects) {
    if (hidden.has(o.layerId) || o.geometry.type !== 'circle') continue;
    if (contains(o.geometry.c, o.geometry.r))
      out.push({ key: `o:${o.id}`, c: o.geometry.c, r: o.geometry.r, text: objectTag(o.name) });
  }
  return out;
}

/**
 * Anchors for picked circles: one per distinct centre (concentric circles give one anchor), skipping
 * centres that already have an anchor; named from a text tag inside the circle, else `prefix` + n.
 */
export function anchorsFromCircles(
  p: Project,
  circles: PickedCircle[],
  prefix: string,
  useText = true,
): { name: string; p: Pt }[] {
  const same = (a: Pt, b: Pt) =>
    Math.abs(a.x - b.x) <= 1e-6 * Math.max(1, Math.abs(a.x)) &&
    Math.abs(a.y - b.y) <= 1e-6 * Math.max(1, Math.abs(a.y));
  // One circle per distinct centre: the largest, so a concentric group takes the outer circle's tag.
  const unique: PickedCircle[] = [];
  for (const c of [...circles].sort((a, b) => b.r - a.r)) {
    if (p.anchors.some((a) => same(a.p, c.c)) || unique.some((u) => same(u.c, c.c))) continue;
    unique.push(c);
  }
  // Number in reading order: top to bottom, then left to right.
  unique.sort((a, b) => b.c.y - a.c.y || a.c.x - b.c.x);
  const used = new Set(p.anchors.map((a) => normaliseAnchorName(a.name)));
  let n = 1;
  const nextName = () => {
    for (; ; n++) {
      const name = `${prefix}${n}`;
      if (!used.has(normaliseAnchorName(name))) {
        used.add(normaliseAnchorName(name));
        return name;
      }
    }
  };
  return unique.map((c) => {
    const tag = useText && c.text && !used.has(normaliseAnchorName(c.text)) ? c.text : undefined;
    if (tag) used.add(normaliseAnchorName(tag));
    return { name: tag ?? nextName(), p: { x: c.c.x, y: c.c.y } };
  });
}
