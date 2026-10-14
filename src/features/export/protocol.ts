import type { Affine2D, Project } from '@/core/types';
import type { LegendModel } from '@/features/legend/legend-model';

import type { SceneLayout } from './scene/project-scene';
import type { ContourSceneInput, DrawingSceneInput, ViewInput } from './scene/types';
import type { ExportSettings } from './settings';

/** Messages between the main thread and the export worker. */

export type JobKind = 'export' | 'preview';

export interface JobMessage {
  type: 'job';
  id: number;
  kind: JobKind;
  settings: ExportSettings;
  project: Project;
  /** Drawing inputs, or a cache key of an input sent earlier to this worker. */
  drawings: Record<string, DrawingSceneInput | { cached: string }>;
  /** Cache keys of the drawings sent in full (the worker stores them). */
  versions: Record<string, string>;
  contours: ContourSceneInput[];
  view?: ViewInput;
  /** Base URL of the bundled fonts (`…/fonts/`). */
  fontBase: string;
  /** Preview: longest side in device pixels. */
  previewPx?: number;
}

export interface TileReplyMessage {
  type: 'tile';
  reqId: number;
  bitmap: ImageBitmap | null;
}

export type ToWorker = JobMessage | TileReplyMessage | { type: 'cancel'; id: number };

export interface TileRequestMessage {
  type: 'tile-request';
  id: number;
  reqId: number;
  drawingId: string;
  /** PDF user space → tile pixels. */
  transform: Affine2D;
  width: number;
  height: number;
  /** Hidden optional-content group names. */
  hiddenLayers: string[];
}

export interface PreviewInfo {
  layout: SceneLayout;
  legend: LegendModel;
  calibration: string[];
  warnings: string[];
  /** Pixel size the PNG export would have at the settings' DPI. */
  pngSize: { width: number; height: number };
  pxPerMm: number;
}

export interface DoneMessage {
  type: 'done';
  id: number;
  /** File output as parts (concatenate / Blob). */
  parts?: Uint8Array[];
  mime?: string;
  preview?: ImageBitmap;
  info: PreviewInfo;
  ms: number;
}

export type FromWorker =
  | { type: 'progress'; id: number; fraction: number; message?: string }
  | TileRequestMessage
  | DoneMessage
  | { type: 'error'; id: number; message: string; name?: string };
