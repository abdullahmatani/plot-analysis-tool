import { newId, nowIso } from './ids';
import type { AnalysisLayer, LegendConfig, Project, SheetLayout, Style } from './types';

/** Current project schema version. Bump with a migration in `migrations.ts`. */
export const SCHEMA_VERSION = 1;

export const DEFAULT_STYLE: Style = {
  stroke: '#e11d48',
  strokeWidth: 0.35,
  strokeOpacity: 1,
  dash: 'solid',
  fill: '#e11d48',
  fillOpacity: 0.15,
  hatch: 'solid',
  labelColor: '#111827',
  labelSize: 2.5,
  labelSizeUnit: 'paper',
  labelHalo: true,
  labelFont: 'sans',
  labelBold: false,
};

/** Categorical palette used for new layers and category values (colour-blind aware ordering). */
export const PALETTE = [
  '#e11d48',
  '#2563eb',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#65a30d',
  '#ea580c',
  '#4f46e5',
  '#0d9488',
  '#ca8a04',
];

export function createLayer(
  name: string,
  index: number,
  overrides: Partial<AnalysisLayer> = {},
): AnalysisLayer {
  const color = PALETTE[index % PALETTE.length];
  return {
    id: newId('lyr'),
    name,
    visible: true,
    locked: false,
    style: { ...DEFAULT_STYLE, stroke: color, fill: color },
    legend: { show: true },
    tagPrefix: '',
    nextTag: 1,
    ...overrides,
  };
}

export function defaultSheet(): SheetLayout {
  return {
    paper: 'A1',
    orientation: 'landscape',
    marginsMm: 10,
    scale: null,
    viewRotation: 0,
    titleBlock: {
      title: '',
      project: '',
      drawingNo: '',
      revision: 'A',
      date: new Date().toISOString().slice(0, 10),
      preparedBy: '',
      checkedBy: '',
      notes: '',
    },
    showScaleBar: true,
    showNorthArrow: true,
    showLegend: true,
    showTitleBlock: true,
  };
}

export function defaultLegend(): LegendConfig {
  return { title: 'Legend', overrides: [], position: 'top-right', widthMm: 70, showCalibration: true };
}

export function createProject(name = 'Untitled project'): Project {
  const now = nowIso();
  const layer = createLayer('Analysis', 0);
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId('prj'),
    name,
    createdAt: now,
    updatedAt: now,
    display: { units: 'm', precision: 2, areaUnits: 'm2', angleUnits: 'deg', plantCoords: true },
    drawings: [],
    layers: [layer],
    activeLayerId: layer.id,
    objects: [],
    anchors: [],
    datasets: [],
    legend: defaultLegend(),
    exportProfiles: [],
    sheet: defaultSheet(),
    views: [],
    stylePresets: [],
    north: { trueNorthAngle: 0, arrow: 'plant' },
    chordTolerance: 0.005,
  };
}
