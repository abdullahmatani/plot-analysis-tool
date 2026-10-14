import type { Draft } from 'immer';
import { toast } from 'sonner';

import { createLayer } from '@/core/project';
import type { AnalysisLayer, AnalysisObject, Geometry, MeasurementInfo, Project } from '@/core/types';
import { commit, getProject, useProjectStore } from '@/store/project';

import { makeObject, nextName } from '@/features/objects/ops';

/**
 * Measurement annotations (row 35): optional analysis objects of kind 'measurement' kept on a
 * "Measurements" layer (created on first use, hidden from the legend). Their dimension text is
 * computed when drawn, so it always follows the display units and the current geometry.
 */

export const MEASURE_LAYER_NAME = 'Measurements';

const MODE_NAMES: Record<MeasurementInfo['mode'], string> = {
  distance: 'Distance',
  chain: 'Chain',
  length: 'Length',
  area: 'Area',
  radius: 'Radius',
  angle: 'Angle',
  check: 'Check',
  point: 'Point',
};

export function measurementLayer(project: Project): AnalysisLayer | undefined {
  return project.layers.find((l) => l.name === MEASURE_LAYER_NAME);
}

export function newMeasurementLayer(project: Project): AnalysisLayer {
  const layer = createLayer(MEASURE_LAYER_NAME, project.layers.length);
  layer.style = {
    ...layer.style,
    stroke: '#0ea5e9',
    strokeWidth: 0.25,
    fill: '#0ea5e9',
    fillOpacity: 0.1,
    hatch: 'solid',
    labelColor: '#111827',
    labelSize: 2.5,
  };
  layer.legend = { show: false };
  return layer;
}

export interface PreparedMeasurement {
  layer: AnalysisLayer | null;
  object: AnalysisObject;
}

/** Builds the object (and the layer when it does not exist yet); null when the layer is locked. */
export function prepareMeasurement(
  project: Project,
  geometry: Geometry,
  mode: MeasurementInfo['mode'],
  value?: number,
): PreparedMeasurement | null {
  const existing = measurementLayer(project);
  if (existing?.locked) {
    toast.error(`Layer “${existing.name}” is locked; the measurement was not kept.`);
    return null;
  }
  const layer = existing ? null : newMeasurementLayer(project);
  const layerId = existing?.id ?? layer!.id;
  const object = makeObject(project, {
    kind: 'measurement',
    geometry,
    layerId,
    name: nextName(project, MODE_NAMES[mode]),
    measurement: value === undefined ? { mode } : { mode, value },
    label: { visible: false },
  });
  return { layer, object };
}

/** Adds a prepared measurement to a project draft (inside a commit). */
export function pushMeasurement(draft: Draft<Project>, m: PreparedMeasurement) {
  if (m.layer && !draft.layers.some((l) => l.id === m.layer!.id)) draft.layers.push(m.layer);
  draft.objects.push(m.object);
}

/** Keeps a measurement as an annotation (one undoable command). Returns the new object id. */
export function addMeasurement(
  geometry: Geometry,
  mode: MeasurementInfo['mode'],
  value: number | undefined,
  label: string,
): string | null {
  const project = getProject();
  if (!project || useProjectStore.getState().readOnly) return null;
  const m = prepareMeasurement(project, geometry, mode, value);
  if (!m) return null;
  const ok = commit(label, (d) => pushMeasurement(d, m));
  return ok ? m.object.id : null;
}
