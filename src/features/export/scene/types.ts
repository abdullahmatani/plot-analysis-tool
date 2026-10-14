import type { Affine2D, Bounds, DashStyle, Geometry, Project } from '@/core/types';
import type { FontSet } from '@/export/fonts';
import type { ContourItem } from '@/tables/contours';
import type { EntityStore } from '@/underlay/entity-store';

import type { ExportSettings } from '../settings';

/**
 * Inputs of the project → scene builder. Everything is structured-cloneable so the builder can run
 * in the export worker (stores and PDF bytes are sent once per job).
 */

export interface PdfPageInput {
  /** Source file bytes; required for PDF output (the page is embedded as vectors). */
  bytes?: Uint8Array;
  /** 0-based page index. */
  pageIndex: number;
  /** PDF user space (pt, y-up, unrotated) → drawing units (pt, origin at the displayed page's bottom-left). */
  userToDrawing: Affine2D;
  /** Displayed page size in points (drawing units). */
  widthPt: number;
  heightPt: number;
  /** Scanned (raster-only) page. */
  raster?: boolean;
  /** Optional-content group id → name (to export the user's hidden PDF layers switched off). */
  ocgNames?: Record<string, string>;
}

export interface DrawingSceneInput {
  id: string;
  /** Parsed CAD entities (DXF/DWG); PDF pages carry vectors for snapping only and are embedded instead. */
  store?: EntityStore;
  /** $INSUNITS of the CAD file. */
  insunits?: number;
  /** Drawing extents in drawing units. */
  extents?: Bounds;
  pdf?: PdfPageInput;
}

export interface ContourEnvelope {
  sizeColumn: string;
  label: string;
  geometry: Geometry;
  color: string;
  dash: DashStyle;
  strokeWidth: number;
}

export interface ContourSceneInput {
  datasetId: string;
  items: ContourItem[];
  envelopes: ContourEnvelope[];
}

/** The screen view (for region 'view' and "use current view"). */
export interface ViewInput {
  cx: number;
  cy: number;
  /** CSS px per metre. */
  scale: number;
  rotation: number;
  /** Canvas size in CSS px. */
  width: number;
  height: number;
}

export interface ProjectSceneInput {
  project: Project;
  settings: ExportSettings;
  drawings: Record<string, DrawingSceneInput>;
  contours: ContourSceneInput[];
  view?: ViewInput;
  fonts?: FontSet;
}
