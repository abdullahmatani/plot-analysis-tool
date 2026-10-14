import { ClipboardPaste, FileSpreadsheet, RefreshCw, Settings2, Table2 } from 'lucide-react';
import { toast } from 'sonner';

import { registerCommands } from '@/app/commands';
import { extraDialogs } from '@/components/app/extra-dialogs';
import { dataPanels } from '@/components/inspector/panels';
import { unionArea } from '@/geometry/boolean';
import type { DraftRecord } from '@/persistence/db';
import { registerExtentProvider } from '@/render/canvas-controller';
import { getProject, useProjectStore } from '@/store/project';
import { useUiStore } from '@/store/ui';

import { contourExtents, datasetContours, datasetEnvelopes, datasetLegend } from './compute';
import { openImport } from './actions';
import { DatasetsPanel } from './DatasetsPanel';
import { EditMappingDialog, MAPPING_DIALOG } from './EditMappingDialog';
import { IMPORT_DIALOG, ImportTableDialog, type ImportDraftState } from './ImportTableDialog';
import { installContourPicking } from './interaction';
import { registerContourOverlays } from './render';
import { useContoursUi } from './store';

/** Bulk contour import (0.8.0, rows 62–74): Data panel, import/mapping dialogs, overlays, commands. */

if (!dataPanels.includes(DatasetsPanel)) dataPanels.push(DatasetsPanel);
if (!extraDialogs.some((d) => d.id === IMPORT_DIALOG))
  extraDialogs.push(
    { id: IMPORT_DIALOG, Component: ImportTableDialog },
    { id: MAPPING_DIALOG, Component: EditMappingDialog },
  );

const canEdit = () => !!getProject() && !useProjectStore.getState().readOnly;

function activeDataset() {
  const p = getProject();
  if (!p?.datasets.length) return undefined;
  const id = useContoursUi.getState().activeDatasetId;
  return p.datasets.find((d) => d.id === id) ?? [...p.datasets].sort((a, b) => b.order - a.order)[0];
}

/** Offers to resume an import dialog that was open when the app closed (row 93). */
function onDrafts(e: Event) {
  const drafts = (e as CustomEvent<DraftRecord[]>).detail ?? [];
  for (const d of drafts) {
    if (d.key !== 'dialog:import-table') continue;
    const state = d.state as ImportDraftState | null;
    if (!state?.src) continue;
    toast('Unfinished table import recovered', {
      description: `“${state.src.name}” was being imported when the app closed.`,
      duration: 30000,
      action: { label: 'Resume', onClick: () => openImport({ draft: state }) },
    });
  }
}

/** Test and integration hook: derived contour data for E2E assertions. */
function installHook() {
  const find = (id: string) => getProject()?.datasets.find((d) => d.id === id || d.name === id);
  (window as unknown as { __patContours?: unknown }).__patContours = {
    rings: (id: string) => {
      const p = getProject();
      const ds = find(id);
      if (!p || !ds) return [];
      return datasetContours(p, ds).rings.map((r) => ({
        row: r.row,
        sizeColumn: r.sizeColumn,
        centre: r.item.centre,
        r: r.item.r,
        shape: r.item.shape,
        label: r.label,
        color: r.style.stroke,
        legendKey: r.legendKey,
      }));
    },
    validation: (id: string) => {
      const p = getProject();
      const ds = find(id);
      if (!p || !ds) return null;
      const dc = datasetContours(p, ds);
      return { counts: dc.validation.counts, issues: dc.validation.issues, unmatched: dc.unmatchedAnchors };
    },
    envelopes: (id: string) => {
      const p = getProject();
      const ds = find(id);
      if (!p || !ds) return [];
      return datasetEnvelopes(p, ds).map((e) => ({ sizeColumn: e.sizeColumn, area: e.area }));
    },
    /** Boolean union area of the drawn rings of one size column, computed independently. */
    unionArea: (id: string, sizeColumn: string) => {
      const p = getProject();
      const ds = find(id);
      if (!p || !ds) return 0;
      const gs = datasetContours(p, ds)
        .rings.filter((r) => r.sizeColumn === sizeColumn)
        .map((r) => r.geometry);
      return unionArea(gs, p.chordTolerance > 0 ? p.chordTolerance : 0.005);
    },
    legend: (id: string) => {
      const p = getProject();
      const ds = find(id);
      return p && ds ? datasetLegend(p, ds) : null;
    },
    ui: () => {
      const s = useContoursUi.getState();
      return { activeDatasetId: s.activeDatasetId, hover: s.hover, selection: s.selection };
    },
  };
}

export function register() {
  const unOverlays = registerContourOverlays();
  const unPick = installContourPicking();
  const unExtents = registerExtentProvider(() => {
    const p = getProject();
    return p ? contourExtents(p) : [];
  });
  window.addEventListener('pat:drafts', onDrafts);
  installHook();
  const unCmds = registerCommands([
    {
      id: 'file.importTable',
      title: 'Import results table (CSV, TSV, XLSX)…',
      menu: 'File',
      section: 'import',
      icon: FileSpreadsheet,
      keywords: ['contours', 'csv', 'excel', 'xlsx', 'tsv', 'dataset'],
      needsProject: true,
      enabled: canEdit,
      run: () => openImport(),
    },
    {
      id: 'data.importTable',
      title: 'Import table…',
      menu: 'Data',
      section: 'import',
      icon: FileSpreadsheet,
      keywords: ['contours', 'csv', 'excel', 'xlsx', 'tsv'],
      needsProject: true,
      enabled: canEdit,
      run: () => openImport(),
    },
    {
      id: 'data.pasteTable',
      title: 'Paste table from spreadsheet…',
      menu: 'Data',
      section: 'import',
      icon: ClipboardPaste,
      keywords: ['clipboard', 'excel', 'contours'],
      needsProject: true,
      enabled: canEdit,
      run: () => openImport({ paste: true }),
    },
    {
      id: 'data.reimport',
      title: 'Re-import active dataset…',
      menu: 'Data',
      section: 'dataset',
      icon: RefreshCw,
      needsProject: true,
      enabled: () => canEdit() && !!activeDataset(),
      run: () => {
        const ds = activeDataset();
        if (ds) openImport({ reimportOf: ds.id });
      },
    },
    {
      id: 'data.editMapping',
      title: 'Edit column mapping…',
      menu: 'Data',
      section: 'dataset',
      icon: Settings2,
      needsProject: true,
      enabled: () => canEdit() && !!activeDataset(),
      run: () => {
        const ds = activeDataset();
        if (ds) useUiStore.getState().openDialog(MAPPING_DIALOG, { datasetId: ds.id });
      },
    },
    {
      id: 'data.showPanel',
      title: 'Show data panel (datasets and objects table)',
      menu: 'Data',
      section: 'view',
      icon: Table2,
      needsProject: true,
      run: () => useUiStore.getState().setInspectorTab('data'),
    },
  ]);
  return () => {
    unOverlays();
    unPick();
    unExtents();
    unCmds();
    window.removeEventListener('pat:drafts', onDrafts);
  };
}
