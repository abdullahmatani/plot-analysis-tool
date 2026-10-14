import { toast } from 'sonner';

import { newId, nowIso } from '@/core/ids';
import type {
  AnalysisObject,
  Geometry,
  LabelSpec,
  ObjectKind,
  Project,
  Pt,
  StyleOverride,
} from '@/core/types';
import { mirrorGeometry, rotateGeometry, scaleGeometry, translateGeometry } from '@/geometry/convert';
import { isClosedGeometry } from '@/render/draw-geometry';
import { commit, getProject, useProjectStore } from '@/store/project';
import { useViewStore } from '@/store/view';

import { DEFAULT_LABEL_TEMPLATE } from './labels';

/** Object creation and editing commands (rows 38, 43). Every change is one undoable command. */

const KIND_NAMES: Record<ObjectKind, string> = {
  shape: 'Shape',
  trace: 'Trace',
  offset: 'Offset',
  measurement: 'Measurement',
  text: 'Text',
  callout: 'Callout',
  tag: 'Tag',
  cloud: 'Cloud',
};

const GEOM_NAMES: Record<Geometry['type'], string> = {
  circle: 'Circle',
  arc: 'Arc',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  polyline: 'Polyline',
  multipolygon: 'Area',
  point: 'Point',
};

export function nextName(project: Project, base: string): string {
  const used = new Set(project.objects.map((o) => o.name));
  for (let n = 1; ; n++) {
    const name = `${base} ${n}`;
    if (!used.has(name)) return name;
  }
}

export interface NewObjectInput {
  kind?: ObjectKind;
  geometry: Geometry;
  name?: string;
  layerId?: string;
  style?: StyleOverride;
  label?: Partial<LabelSpec>;
  text?: string;
  attributes?: Record<string, string | number>;
  category?: string;
  derived?: AnalysisObject['derived'];
  measurement?: AnalysisObject['measurement'];
  tagNumber?: number;
}

export function makeObject(project: Project, input: NewObjectInput): AnalysisObject {
  const kind = input.kind ?? 'shape';
  const base = kind === 'shape' ? GEOM_NAMES[input.geometry.type] : KIND_NAMES[kind];
  const closed = isClosedGeometry(input.geometry);
  return {
    id: newId('obj'),
    layerId: input.layerId ?? project.activeLayerId,
    name: input.name ?? nextName(project, base),
    kind,
    geometry: input.geometry,
    style: input.style ?? {},
    label: {
      template: DEFAULT_LABEL_TEMPLATE,
      placement: 'centroid',
      visible: closed && (kind === 'shape' || kind === 'trace' || kind === 'offset'),
      ...input.label,
    },
    text: input.text,
    attributes: input.attributes ?? {},
    category: input.category,
    derived: input.derived,
    measurement: input.measurement,
    tagNumber: input.tagNumber,
    createdAt: nowIso(),
  };
}

export function activeLayerWritable(): boolean {
  const p = getProject();
  if (!p || useProjectStore.getState().readOnly) return false;
  const layer = p.layers.find((l) => l.id === p.activeLayerId);
  if (!layer) return false;
  if (layer.locked) {
    toast.error(`Layer “${layer.name}” is locked. Unlock it or choose another layer.`);
    return false;
  }
  return true;
}

/** Adds objects on the active layer; returns their ids. */
export function addObjects(inputs: NewObjectInput[], label: string, select = true): string[] {
  const p = getProject();
  if (!p || !activeLayerWritable()) return [];
  const objs: AnalysisObject[] = [];
  let proj = p;
  for (const input of inputs) {
    const o = makeObject(proj, input);
    objs.push(o);
    proj = { ...proj, objects: [...proj.objects, o] };
  }
  const ok = commit(label, (d) => {
    d.objects.push(...objs);
  });
  if (!ok) return [];
  if (select) useViewStore.getState().set({ selection: objs.map((o) => o.id) });
  return objs.map((o) => o.id);
}

export function lockedLayerIds(p: Project): Set<string> {
  return new Set(p.layers.filter((l) => l.locked).map((l) => l.id));
}

export function editableSelection(): string[] {
  const p = getProject();
  if (!p) return [];
  const locked = lockedLayerIds(p);
  const sel = new Set(useViewStore.getState().selection);
  return p.objects.filter((o) => sel.has(o.id) && !locked.has(o.layerId)).map((o) => o.id);
}

export function updateGeometries(
  ids: string[],
  label: string,
  fn: (g: Geometry, o: AnalysisObject) => Geometry,
  coalesceKey?: string,
) {
  const set = new Set(ids);
  return commit(
    label,
    (d) => {
      for (const o of d.objects)
        if (set.has(o.id)) o.geometry = fn(o.geometry as Geometry, o as AnalysisObject);
    },
    coalesceKey ? { coalesceKey } : undefined,
  );
}

export function deleteObjects(ids: string[]) {
  if (!ids.length) return false;
  const set = new Set(ids);
  const ok = commit(ids.length === 1 ? 'Delete object' : `Delete ${ids.length} objects`, (d) => {
    d.objects = d.objects.filter((o) => !set.has(o.id));
  });
  if (ok) useViewStore.getState().set({ selection: [] });
  return ok;
}

export function moveObjects(ids: string[], dx: number, dy: number, copy = false) {
  const p = getProject();
  if (!p || !ids.length) return;
  if (copy) {
    const src = p.objects.filter((o) => ids.includes(o.id));
    const copies = src.map((o) => ({
      ...structuredClone(o),
      id: newId('obj'),
      name: nextName(p, o.name.replace(/ \d+$/, '')),
      geometry: translateGeometry(o.geometry, dx, dy),
      createdAt: nowIso(),
    }));
    commit(copies.length === 1 ? 'Copy object' : `Copy ${copies.length} objects`, (d) => {
      d.objects.push(...copies);
    });
    useViewStore.getState().set({ selection: copies.map((c) => c.id) });
    return;
  }
  updateGeometries(ids, ids.length === 1 ? 'Move object' : `Move ${ids.length} objects`, (g) =>
    translateGeometry(g, dx, dy),
  );
}

export function rotateObjects(ids: string[], angle: number, about: Pt) {
  updateGeometries(ids, 'Rotate', (g) => rotateGeometry(g, angle, about));
}

export function scaleObjects(ids: string[], k: number, about: Pt) {
  updateGeometries(ids, 'Scale', (g) => scaleGeometry(g, k, about));
}

export function mirrorObjects(ids: string[], a: Pt, b: Pt, keepOriginal: boolean) {
  const p = getProject();
  if (!p) return;
  if (!keepOriginal) {
    updateGeometries(ids, 'Mirror', (g) => mirrorGeometry(g, a, b));
    return;
  }
  const src = p.objects.filter((o) => ids.includes(o.id));
  const copies = src.map((o) => ({
    ...structuredClone(o),
    id: newId('obj'),
    name: nextName(p, o.name.replace(/ \d+$/, '')),
    geometry: mirrorGeometry(o.geometry, a, b),
    createdAt: nowIso(),
  }));
  commit('Mirror copy', (d) => {
    d.objects.push(...copies);
  });
  useViewStore.getState().set({ selection: copies.map((c) => c.id) });
}

/** Moves objects to the front/back of the draw order (row 39). */
export function reorderObjects(ids: string[], where: 'front' | 'back') {
  const set = new Set(ids);
  commit(where === 'front' ? 'Bring to front' : 'Send to back', (d) => {
    const sel = d.objects.filter((o) => set.has(o.id));
    const rest = d.objects.filter((o) => !set.has(o.id));
    d.objects = where === 'front' ? [...rest, ...sel] : [...sel, ...rest];
  });
}
