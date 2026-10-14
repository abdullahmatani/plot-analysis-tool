import type { AnalysisObject, CellValue, ContourDataset, Project } from '@/core/types';
import { AREA_FACTORS, AREA_LABEL, fromMetres, UNIT_LABEL } from '@/core/units';
import { area as geometryArea, centroid } from '@/geometry/measure';
import { labelText, measures } from '@/features/objects/labels';
import { layerOf } from '@/features/objects/style';
import { formatDelimited } from '@/tables/csv';
import type { ContourItem } from '@/tables/contours';
import { writeXlsx, type XlsxWriteSheet } from '@/tables/xlsx';

import { calibrationStatement, drawingCalibrationInfo, statementDrawings } from './scene/calibration';
import { contourGeometry } from './scene/contours';
import type { ContourSceneInput } from './scene/types';
import type { ExportSettings } from './settings';

/**
 * Tabular export (rows 45, 80): analysis objects (name, layer, type, area, perimeter, length,
 * centroid, radius/diameter, label and every custom attribute as a column) and contour datasets
 * with computed fields, in the project's display units. Measures use the same `measures()` as the
 * Properties panel, so totals match the on-screen values. The calibration details go in a header
 * sheet (XLSX) or header lines (CSV): distances never leave the app without them (row 32).
 */

export interface TableData {
  name: string;
  columns: string[];
  rows: CellValue[][];
}

export interface ObjectsTable extends TableData {
  /** Totals (display units) of area, perimeter and length over all objects. */
  totals: { area: number; perimeter: number; length: number };
}

/** Rounds away float noise while keeping well below display precision. */
function num(v: number | undefined, precision: number): CellValue {
  if (v === undefined || !Number.isFinite(v)) return null;
  const d = Math.min(12, Math.max(0, precision) + 4);
  return Number(v.toFixed(d));
}

const BASE_COLUMNS = (p: Project) => {
  const u = UNIT_LABEL[p.display.units];
  const a = AREA_LABEL[p.display.areaUnits];
  return [
    'Name',
    'Layer',
    'Visible',
    'Kind',
    'Geometry',
    'Category',
    'Notes',
    `Area (${a})`,
    `Perimeter (${u})`,
    `Length (${u})`,
    `Centroid X (${u})`,
    `Centroid Y (${u})`,
    `Radius (${u})`,
    `Diameter (${u})`,
    'Label',
  ];
};

/** Analysis objects with measures and attributes (all layers, project order). */
export function objectsTable(
  project: Project,
  objects: readonly AnalysisObject[] = project.objects,
): ObjectsTable {
  const { units, precision, areaUnits } = project.display;
  const base = BASE_COLUMNS(project);
  const attrKeys: string[] = [];
  for (const o of objects)
    for (const k of Object.keys(o.attributes)) if (!attrKeys.includes(k)) attrKeys.push(k);
  const attrCols = attrKeys.map((k) => (base.includes(k) ? `${k} (attribute)` : k));
  const len = (m: number | undefined) => (m === undefined ? undefined : fromMetres(m, units));
  const totals = { area: 0, perimeter: 0, length: 0 };
  const rows: CellValue[][] = objects.map((o) => {
    const m = measures(o.geometry);
    const layer = layerOf(project, o);
    const c = centroid(o.geometry);
    const areaV = m.area === undefined ? undefined : m.area / AREA_FACTORS[areaUnits];
    const perimV = len(m.perimeter);
    const lenV = len(m.length);
    if (areaV !== undefined) totals.area += areaV;
    if (perimV !== undefined) totals.perimeter += perimV;
    if (lenV !== undefined) totals.length += lenV;
    const label = o.label?.visible ? labelText(project, o) : '';
    return [
      o.name,
      layer?.name ?? '',
      layer?.visible === false ? 'No' : 'Yes',
      o.kind,
      o.geometry.type,
      o.category ?? '',
      o.notes ?? '',
      num(areaV, precision),
      num(perimV, precision),
      num(lenV, precision),
      num(len(c.x), precision),
      num(len(c.y), precision),
      num(len(m.radius), precision),
      num(m.radius === undefined ? undefined : len(m.radius * 2), precision),
      label,
      ...attrKeys.map((k) => {
        const v = o.attributes[k];
        return v === undefined ? null : v;
      }),
    ];
  });
  return {
    name: 'Objects',
    columns: [...base, ...attrCols],
    rows,
    totals: {
      area: Number(num(totals.area, precision) ?? 0),
      perimeter: Number(num(totals.perimeter, precision) ?? 0),
      length: Number(num(totals.length, precision) ?? 0),
    },
  };
}

/** Totals row aligned with the objects table columns. */
export function totalsRow(t: ObjectsTable): CellValue[] {
  const row: CellValue[] = new Array(t.columns.length).fill(null);
  row[0] = 'Total';
  row[7] = t.totals.area;
  row[8] = t.totals.perimeter;
  row[9] = t.totals.length;
  return row;
}

/** Contour dataset rows with computed fields, followed by the source row values. */
export function datasetTable(project: Project, ds: ContourDataset, items: readonly ContourItem[]): TableData {
  const { units, precision, areaUnits } = project.display;
  const u = UNIT_LABEL[units];
  const computed = [
    'Row',
    'Size column',
    `X (${u})`,
    `Y (${u})`,
    'Shape',
    `Radius (${u})`,
    `Diameter (${u})`,
    `Area (${AREA_LABEL[areaUnits]})`,
    'Label',
    'Group',
    'Colour',
  ];
  const srcCols = ds.table.columns.map((c) => (computed.includes(c) ? `${c} (source)` : c));
  const rows: CellValue[][] = items.map((it) => {
    const g = contourGeometry(it, project.chordTolerance || 0.005);
    const a = geometryArea(g) / AREA_FACTORS[areaUnits];
    return [
      it.row + 1,
      it.sizeColumn,
      num(fromMetres(it.centre.x, units), precision),
      num(fromMetres(it.centre.y, units), precision),
      it.shape,
      num(fromMetres(it.r, units), precision),
      num(fromMetres(2 * it.r, units), precision),
      num(a, precision),
      it.label,
      it.group ?? '',
      it.color,
      ...ds.table.columns.map((_, i) => ds.table.rows[it.row]?.[i] ?? null),
    ];
  });
  return { name: `Contours – ${ds.name}`, columns: [...computed, ...srcCols], rows };
}

/** Export information and calibration details as label/value lines. */
export function headerInfo(project: Project, settings: ExportSettings): [string, string][] {
  const tb = settings.sheet.titleBlock;
  const { units, areaUnits } = project.display;
  const out: [string, string][] = [
    ['Exported by', 'Plot Analysis Tool'],
    ['Project', project.name],
  ];
  if (tb.title) out.push(['Title', tb.title]);
  if (tb.drawingNo) out.push(['Drawing no.', tb.drawingNo]);
  if (tb.revision) out.push(['Revision', tb.revision]);
  if (tb.date) out.push(['Date', tb.date]);
  out.push(['Length unit', UNIT_LABEL[units]], ['Area unit', AREA_LABEL[areaUnits]]);
  out.push(['Coordinates', project.display.plantCoords ? 'World / plant E, N' : 'World X, Y']);
  for (const line of calibrationStatement(project, settings.includeUnderlay))
    out.push(['Calibration', line.replace(/^Calibration: /, '')]);
  return out;
}

/** Calibration detail table (one row per drawing). */
export function calibrationTable(project: Project, settings: ExportSettings): TableData {
  const rows: CellValue[][] = statementDrawings(project, settings.includeUnderlay).map((d) => {
    const info = drawingCalibrationInfo(project, d);
    return [
      d.name,
      d.source.fileName,
      info.state,
      info.method || '',
      info.rms === undefined ? null : info.rms,
      info.verified ? info.verified.expected : null,
      info.verified ? info.verified.measured : null,
      d.calibration?.at ?? '',
    ];
  });
  return {
    name: 'Calibration',
    columns: [
      'Drawing',
      'File',
      'State',
      'Method',
      'RMS (m)',
      'Check expected (m)',
      'Check measured (m)',
      'Calibrated at',
    ],
    rows,
  };
}

/** Deterministic document date for metadata (title block date, else project creation). */
export function exportDate(project: Project, settings: ExportSettings): Date {
  const d = settings.sheet.titleBlock.date;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T00:00:00Z`) : NaN;
  return new Date(Number.isFinite(t) ? t : Date.parse(project.createdAt) || 0);
}

export function contourItemsFor(contours: readonly ContourSceneInput[], dsId: string): ContourItem[] {
  return contours.find((c) => c.datasetId === dsId)?.items ?? [];
}

/** CSV with '#' header lines (export info and calibration), then the chosen table. */
export function exportCsv(
  project: Project,
  settings: ExportSettings,
  contours: readonly ContourSceneInput[],
): string {
  const header = headerInfo(project, settings).map(([k, v]) => `# ${k}: ${v}`);
  let table: TableData;
  const ds = project.datasets.find((d) => d.id === settings.csvTable);
  if (ds) table = datasetTable(project, ds, contourItemsFor(contours, ds.id));
  else {
    const t = objectsTable(project);
    table = { ...t, rows: [...t.rows, totalsRow(t)] };
  }
  const body = formatDelimited(table.columns, table.rows, { bom: false });
  return '\ufeff' + header.join('\r\n') + '\r\n\r\n' + body;
}

/** XLSX workbook: export info + calibration header sheet, objects with totals, one sheet per dataset. */
export function exportXlsx(
  project: Project,
  settings: ExportSettings,
  contours: readonly ContourSceneInput[],
): Uint8Array {
  const info = headerInfo(project, settings);
  const cal = calibrationTable(project, settings);
  const headerRows: CellValue[][] = [
    ...info.map(([k, v]) => [k, v] as CellValue[]),
    [],
    cal.columns,
    ...cal.rows,
  ];
  const sheets: XlsxWriteSheet[] = [{ name: 'Export info', columns: ['Item', 'Value'], rows: headerRows }];
  const objs = objectsTable(project);
  sheets.push({ name: objs.name, columns: objs.columns, rows: [...objs.rows, totalsRow(objs)] });
  for (const ds of [...project.datasets].sort((a, b) => a.order - b.order)) {
    const t = datasetTable(project, ds, contourItemsFor(contours, ds.id));
    sheets.push({ name: t.name, columns: t.columns, rows: t.rows });
  }
  return writeXlsx(sheets, {
    title: settings.sheet.titleBlock.title || project.name,
    date: exportDate(project, settings),
  });
}
