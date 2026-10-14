import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ClipboardPaste,
  Eye,
  EyeOff,
  FileUp,
  LayoutTemplate,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  ZoomIn,
} from 'lucide-react';
import { toast } from 'sonner';

import { confirmAction, promptText } from '@/app/prompt';
import type { ContourDataset } from '@/core/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useProject, useProjectStore } from '@/store/project';
import { useUiStore } from '@/store/ui';

import { datasetContours } from './compute';
import { DatasetDetail } from './DatasetDetail';
import { openImport } from './actions';
import { MAPPING_DIALOG } from './EditMappingDialog';
import { deleteDataset, moveDataset, updateDataset } from './ops';
import { useContoursUi } from './store';
import { makeTemplate, saveTemplate } from './templates';
import { zoomToDataset } from './view-ops';

/** Data tab: contour datasets (rows 62–74) — list with visibility, draw order and validation badge. */

export function DatasetBadge({ ds }: { ds: ContourDataset }) {
  const project = useProject((p) => p);
  if (!project) return null;
  const dc = datasetContours(project, ds);
  const { valid, total, errors } = dc.validation.counts;
  return (
    <Badge
      variant={errors > 0 || valid < total ? 'warning' : 'success'}
      className="font-normal tabular-nums"
      data-testid="dataset-badge"
      title={`${valid} of ${total} rows valid${errors ? `, ${errors} error(s)` : ''}${
        dc.unmatchedAnchors.length ? `, ${dc.unmatchedAnchors.length} unmatched anchor(s)` : ''
      }`}
    >
      {valid}/{total}
      {errors > 0 && <span className="ml-0.5">· {errors}⚠</span>}
    </Badge>
  );
}

export function DatasetsPanel() {
  const datasets = useProject((p) => p.datasets) ?? [];
  const readOnly = useProjectStore((s) => s.readOnly);
  const activeId = useContoursUi((s) => s.activeDatasetId);
  const ordered = [...datasets].sort((a, b) => b.order - a.order);
  const active = datasets.find((d) => d.id === activeId) ?? ordered[0];

  return (
    <section className="space-y-2" data-testid="datasets-panel">
      <div className="flex items-center justify-between px-1">
        <h3 className="text-muted-foreground text-xs font-semibold uppercase">Contour datasets</h3>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="xs" disabled={readOnly} data-testid="dataset-import-menu">
              <Plus /> Import <ChevronDown className="opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => openImport()}>
              <FileUp /> Import CSV, TSV or XLSX…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openImport({ paste: true })}>
              <ClipboardPaste /> Paste from spreadsheet…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {ordered.length === 0 ? (
        <p className="text-muted-foreground px-1 text-xs">
          Import a results table (CSV, TSV, XLSX or a pasted range) to draw contours around equipment.
        </p>
      ) : (
        <ul className="space-y-0.5" aria-label="Contour datasets">
          {ordered.map((ds) => {
            const isActive = ds.id === active?.id;
            const sorted = [...datasets].sort((a, b) => a.order - b.order);
            const idx = sorted.indexOf(ds);
            return (
              <li
                key={ds.id}
                className={cn(
                  'hover:bg-accent/60 flex items-center gap-1 rounded-md border px-1 py-0.5',
                  isActive && 'border-primary/50 bg-accent/40',
                )}
                data-testid={`dataset-${ds.name}`}
              >
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={ds.visible ? `Hide dataset ${ds.name}` : `Show dataset ${ds.name}`}
                  disabled={readOnly}
                  onClick={() =>
                    updateDataset(ds.id, `${ds.visible ? 'Hide' : 'Show'} dataset “${ds.name}”`, (d) => {
                      d.visible = !d.visible;
                    })
                  }
                >
                  {ds.visible ? <Eye /> : <EyeOff className="opacity-50" />}
                </Button>
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-sm"
                  aria-current={isActive || undefined}
                  onClick={() => useContoursUi.getState().set({ activeDatasetId: ds.id })}
                  onDoubleClick={() => void renameDataset(ds)}
                  title={
                    ds.source
                      ? `${ds.source.fileName}${ds.source.sheet ? ` – ${ds.source.sheet}` : ''}`
                      : ds.name
                  }
                >
                  {ds.name}
                </button>
                <DatasetBadge ds={ds} />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-xs" aria-label={`Dataset options for ${ds.name}`}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => zoomToDataset(ds.id)}>
                      <ZoomIn /> Zoom to dataset
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={readOnly}
                      onSelect={() => useUiStore.getState().openDialog(MAPPING_DIALOG, { datasetId: ds.id })}
                    >
                      <Settings2 /> Edit column mapping…
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={readOnly} onSelect={() => openImport({ reimportOf: ds.id })}>
                      <RefreshCw /> Re-import data…
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void saveDatasetTemplate(ds)}>
                      <LayoutTemplate /> Save as mapping template…
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={readOnly} onSelect={() => void renameDataset(ds)}>
                      Rename…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={readOnly || idx === sorted.length - 1}
                      onSelect={() => moveDataset(ds.id, 1)}
                    >
                      <ArrowUp /> Move up (draw above)
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={readOnly || idx === 0}
                      onSelect={() => moveDataset(ds.id, -1)}
                    >
                      <ArrowDown /> Move down
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={readOnly}
                      onSelect={async () => {
                        const ok = await confirmAction({
                          title: `Delete dataset “${ds.name}”?`,
                          description: `Its ${ds.table.rows.length} rows and contours are removed. This can be undone.`,
                          confirmLabel: 'Delete dataset',
                          destructive: true,
                        });
                        if (ok) deleteDataset(ds.id);
                      }}
                    >
                      <Trash2 /> Delete dataset
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            );
          })}
        </ul>
      )}
      {active && <DatasetDetail key={active.id} ds={active} />}
    </section>
  );
}

async function renameDataset(ds: ContourDataset) {
  const name = await promptText({ title: 'Rename dataset', label: 'Name', defaultValue: ds.name });
  if (name && name !== ds.name)
    updateDataset(ds.id, `Rename dataset to “${name}”`, (d) => {
      d.name = name;
    });
}

async function saveDatasetTemplate(ds: ContourDataset) {
  const name = await promptText({
    title: 'Save mapping template',
    label: 'Template name',
    defaultValue: ds.name,
  });
  if (!name) return;
  await saveTemplate(makeTemplate(name, ds.table.columns, ds));
  toast.success(`Template “${name}” saved`, {
    description: 'It is suggested whenever a table with matching headers is imported.',
  });
}
