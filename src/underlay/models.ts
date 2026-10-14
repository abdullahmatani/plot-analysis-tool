import Flatbush from 'flatbush';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { create } from 'zustand';

import { multiply, scale as scaleM } from '@/core/affine';
import type { Affine2D, Drawing } from '@/core/types';
import { insunitsToMetres, METRES_PER, METRES_PER_PT } from '@/core/units';

import type { DrawingParseResult } from './entity-store';
import type { RenderData } from './render-data';

/**
 * Parsed underlay drawings held in memory (derived data, rebuilt from the stored source file when a
 * project opens). Not part of the undoable project document.
 */

export interface DrawingModel {
  drawingId: string;
  status: 'loading' | 'ready' | 'error';
  progress: number;
  message?: string;
  error?: string;
  result?: DrawingParseResult;
  render?: RenderData;
  index?: Flatbush;
  textIndex?: Flatbush;
  pdf?: { doc: PDFDocumentProxy; page: PDFPageProxy };
  /** Bumped whenever GPU data must be (re)uploaded. */
  version: number;
}

interface ModelsStore {
  models: Record<string, DrawingModel>;
  set(id: string, patch: Partial<DrawingModel>): void;
  remove(id: string): void;
  clear(): void;
}

export const useModelsStore = create<ModelsStore>()((set) => ({
  models: {},
  set: (id, patch) =>
    set((s) => {
      const prev = s.models[id] ?? { drawingId: id, status: 'loading', progress: 0, version: 0 };
      return { models: { ...s.models, [id]: { ...prev, ...patch } } };
    }),
  remove: (id) =>
    set((s) => {
      const next = { ...s.models };
      void next[id]?.pdf?.doc.loadingTask.destroy();
      delete next[id];
      return { models: next };
    }),
  clear: () =>
    set((s) => {
      for (const m of Object.values(s.models)) void m.pdf?.doc.loadingTask.destroy();
      return { models: {} };
    }),
}));

export function getModel(id: string): DrawingModel | undefined {
  return useModelsStore.getState().models[id];
}

export function attachIndices(m: DrawingModel): Pick<DrawingModel, 'index' | 'textIndex'> {
  return {
    index: m.render?.index ? Flatbush.from(m.render.index) : undefined,
    textIndex: m.render?.textIndex ? Flatbush.from(m.render.textIndex) : undefined,
  };
}

/** Metres per drawing unit before calibration: CAD units from the header (or override), PDF points at 1:1. */
export function defaultUnitScale(d: Drawing, insunits?: number): number {
  if (d.source.kind === 'pdf') return METRES_PER_PT;
  if (d.unitsOverride) return METRES_PER[d.unitsOverride];
  if (d.nativeUnits && d.nativeUnits !== 'pt' && d.nativeUnits !== 'unitless')
    return METRES_PER[d.nativeUnits];
  const f = insunits !== undefined ? insunitsToMetres(insunits) : null;
  return f ?? 1;
}

/** Drawing units → world metres: alignment ∘ (calibration or default units). */
export function placementOf(d: Drawing, insunits?: number): Affine2D {
  const base: Affine2D = d.calibration?.transform ?? scaleM(defaultUnitScale(d, insunits));
  return d.alignment ? multiply(d.alignment, base) : base;
}

export type CalibrationState = 'uncalibrated' | 'calibrated' | 'verified';

export function calibrationState(d: Drawing): CalibrationState {
  if (!d.calibration) return 'uncalibrated';
  return d.verified ? 'verified' : 'calibrated';
}
