import { defaultSheet } from '@/core/project';
import type { ExportProfile, Project, SheetLayout } from '@/core/types';

/**
 * Export settings (rows 76–81). The shape is an {@link ExportProfile} without its identity, so a
 * named profile is just saved settings and re-running it reproduces the same output.
 */
export type ExportSettings = Omit<ExportProfile, 'id' | 'name'>;
export type ExportFormat = ExportProfile['format'];

export const FORMATS: { id: ExportFormat; label: string; ext: string; mime: string }[] = [
  { id: 'pdf', label: 'PDF (vector, true scale)', ext: 'pdf', mime: 'application/pdf' },
  { id: 'png', label: 'PNG image', ext: 'png', mime: 'image/png' },
  { id: 'svg', label: 'SVG (vector)', ext: 'svg', mime: 'image/svg+xml' },
  { id: 'dxf', label: 'DXF (analysis for CAD)', ext: 'dxf', mime: 'application/dxf' },
  {
    id: 'xlsx',
    label: 'XLSX workbook (tables)',
    ext: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  { id: 'csv', label: 'CSV table', ext: 'csv', mime: 'text/csv' },
];

export function formatInfo(f: ExportFormat) {
  return FORMATS.find((x) => x.id === f) ?? FORMATS[0];
}

/** Formats drawn from the sheet/scene (preview shows the sheet). */
export const GRAPHIC_FORMATS: ExportFormat[] = ['pdf', 'png', 'svg'];

export function isGraphic(f: ExportFormat): boolean {
  return GRAPHIC_FORMATS.includes(f);
}

export function defaultExportSettings(project?: Project | null): ExportSettings {
  return {
    format: 'pdf',
    sheet: structuredClone(project?.sheet ?? defaultSheet()),
    dpi: 300,
    region: 'sheet',
    includeUnderlay: true,
    includeLegend: true,
    dxfCoordinates: project?.drawings.length ? 'drawing' : 'world',
    dxfDrawingId: project?.drawings[0]?.id,
    dxfText: 'auto',
    csvTable: 'objects',
    svgTextAsPaths: false,
  };
}

/** Settings of a profile (without id/name). */
export function profileSettings(p: ExportProfile): ExportSettings {
  const { id: _id, name: _name, ...rest } = p;
  void _id;
  void _name;
  return structuredClone(rest);
}

/** Settings with the live project sheet layout (the dialog edits `project.sheet` directly). */
export function withSheet(s: ExportSettings, sheet: SheetLayout): ExportSettings {
  return { ...s, sheet };
}

/** File name (without extension) for an export. */
export function exportBaseName(project: Project, settings: ExportSettings): string {
  const tb = settings.sheet.titleBlock;
  const parts = [project.name, tb.drawingNo, tb.revision ? `Rev ${tb.revision}` : ''].filter(
    (s) => s && s.trim(),
  );
  const base = parts.join(' - ') || 'export';
  // Keep names safe on every OS (no path separators or reserved characters).
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120);
}
