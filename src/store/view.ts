import { create } from 'zustand';

import type { Pt } from '@/core/types';

/** Transient view/tool state (not part of the project document). */

export type SnapMode =
  'endpoint' | 'midpoint' | 'centre' | 'quadrant' | 'intersection' | 'nearest' | 'perpendicular' | 'tangent';

export const ALL_SNAP_MODES: SnapMode[] = [
  'endpoint',
  'midpoint',
  'centre',
  'quadrant',
  'intersection',
  'nearest',
  'perpendicular',
  'tangent',
];

export interface ViewTransform {
  /** World point at the centre of the canvas. */
  cx: number;
  cy: number;
  /** Screen CSS pixels per world metre. */
  scale: number;
  /** View rotation (radians, CCW). */
  rotation: number;
}

interface ViewStore {
  view: ViewTransform;
  canvasSize: { w: number; h: number };
  cursor: Pt | null;
  snapEnabled: boolean;
  snapModes: SnapMode[];
  ortho: boolean;
  polar: boolean;
  polarIncrementDeg: number;
  gridSnap: boolean;
  gridSize: number;
  activeTool: string;
  selection: string[];
  /** Underlay entity under the cursor / picked (drawingId + entity index). */
  hoverEntity: { drawingId: string; index: number } | null;
  pickedEntity: { drawingId: string; index: number } | null;
  hoverObject: string | null;
  setView(v: Partial<ViewTransform>): void;
  setCanvasSize(w: number, h: number): void;
  setCursor(p: Pt | null): void;
  set(patch: Partial<Omit<ViewStore, 'set' | 'setView' | 'setCanvasSize' | 'setCursor'>>): void;
}

export const useViewStore = create<ViewStore>()((set) => ({
  view: { cx: 0, cy: 0, scale: 1, rotation: 0 },
  canvasSize: { w: 800, h: 600 },
  cursor: null,
  snapEnabled: true,
  snapModes: ['endpoint', 'midpoint', 'centre', 'quadrant', 'intersection', 'perpendicular'],
  ortho: false,
  polar: false,
  polarIncrementDeg: 15,
  gridSnap: false,
  gridSize: 1,
  activeTool: 'select',
  selection: [],
  hoverEntity: null,
  pickedEntity: null,
  hoverObject: null,
  setView: (v) => set((s) => ({ view: { ...s.view, ...v } })),
  setCanvasSize: (w, h) => set({ canvasSize: { w, h } }),
  setCursor: (cursor) => set({ cursor }),
  set: (patch) => set(patch),
}));
