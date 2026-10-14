import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, Save, Trash2, X } from 'lucide-react';

import { currentSession } from '@/app/session';
import type { Bounds, Project } from '@/core/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useProjectStore } from '@/store/project';
import { useUiStore } from '@/store/ui';
import { useModelsStore } from '@/underlay/models';

import { previewWorker, type JobHandle } from './client';
import { ExportSettingsForm } from './ExportSettingsForm';
import { collectContours } from './inputs';
import { applyProfileSheet, deleteProfile, saveProfileAs, updateProfile } from './profile-ops';
import type { PreviewInfo } from './protocol';
import {
  fileNameFor,
  loadLastOptions,
  runExport,
  saveLastOptions,
  settingsOf,
  useExportRun,
  type ExportOptions,
} from './run';
import { contentBounds } from './scene/project-scene';
import { scaleLabel } from './scene/sheet';
import type { DrawingSceneInput } from './scene/types';
import { formatInfo, isGraphic, profileSettings, type ExportFormat } from './settings';
import { objectsTable } from './tabular';

/**
 * Export dialog (rows 76–81): settings on the left, a WYSIWYG preview on the right (the export scene
 * rendered by the same canvas backend as the PNG export, in the export worker), named profiles, and
 * export with progress and cancel.
 */

export interface ExportDialogPayload {
  format?: ExportFormat;
  profileId?: string;
}

const DRAFT = { key: 'export-dialog', tool: 'export', label: 'Export dialog' };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function TablePreview({ project, options }: { project: Project; options: ExportOptions }) {
  const t = useMemo(() => objectsTable(project), [project]);
  const ds = project.datasets.find((d) => d.id === options.csvTable);
  return (
    <div className="space-y-2 p-3 text-xs" data-testid="export-table-preview">
      <p className="text-muted-foreground">
        {options.format === 'xlsx'
          ? `Workbook: Export info (calibration), Objects (${t.rows.length} rows + totals)${project.datasets.length ? `, ${project.datasets.length} contour sheet(s)` : ''}.`
          : ds
            ? `Contours – ${ds.name}`
            : `Objects: ${t.rows.length} rows + totals, header lines with calibration details.`}
      </p>
      <div className="overflow-auto rounded border">
        <Table>
          <TableHeader>
            <TableRow>
              {t.columns.slice(0, 10).map((c) => (
                <TableHead key={c} className="h-7 text-xs whitespace-nowrap">
                  {c}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {t.rows.slice(0, 15).map((r, i) => (
              <TableRow key={i}>
                {r.slice(0, 10).map((v, j) => (
                  <TableCell key={j} className="py-1 text-xs whitespace-nowrap">
                    {v === null ? '' : String(v)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            <TableRow>
              <TableCell className="py-1 text-xs font-semibold">Total</TableCell>
              {t.columns.slice(1, 10).map((c, j) => (
                <TableCell key={c} className="py-1 text-xs font-semibold">
                  {j === 6 ? t.totals.area : j === 7 ? t.totals.perimeter : j === 8 ? t.totals.length : ''}
                </TableCell>
              ))}
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function ExportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const project = useProjectStore((s) => s.history?.project ?? null);
  const readOnly = useProjectStore((s) => s.readOnly);
  const payload = useUiStore((s) =>
    s.dialog === 'export' ? (s.dialogPayload as ExportDialogPayload | null) : null,
  );
  const models = useModelsStore((s) => s.models);
  const run = useExportRun();
  const [options, setOptionsState] = useState<ExportOptions | null>(null);
  const [profileId, setProfileId] = useState<string>('');
  const [info, setInfo] = useState<PreviewInfo | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxSize, setBoxSize] = useState({ w: 800, h: 600 });
  const jobRef = useRef<JobHandle | null>(null);

  // Initialise options when the dialog opens.
  useEffect(() => {
    if (!open || !project) return;
    const o = loadLastOptions(project);
    if (payload?.format) o.format = payload.format;
    setOptionsState(o);
    setProfileId('');
    if (payload?.profileId) {
      const p = project.exportProfiles.find((x) => x.id === payload.profileId);
      if (p) {
        applyProfileSheet(p);
        const { sheet: _s, ...rest } = profileSettings(p);
        void _s;
        setOptionsState(rest);
        setProfileId(p.id);
      }
    }
    // Only when opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) currentSession()?.drafts.clear(DRAFT.key);
  }, [open]);

  const setOptions = useCallback(
    (patch: Partial<ExportOptions>) => {
      setOptionsState((prev) => {
        if (!prev || !project) return prev;
        const next = { ...prev, ...patch };
        saveLastOptions(project, next);
        currentSession()?.drafts.set(DRAFT, next);
        return next;
      });
    },
    [project],
  );

  // Preview box size (the box mounts once the options are ready).
  const ready = options !== null;
  useEffect(() => {
    if (!open) return;
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setBoxSize({ w: Math.max(100, r.width), h: Math.max(100, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, ready]);

  const settings = useMemo(
    () => (project && options ? settingsOf(project, options) : null),
    [project, options],
  );
  const previewKey = useDebounced(
    useMemo(() => ({ project, settings, models, boxSize }), [project, settings, models, boxSize]),
    250,
  );

  // Preview (export scene rendered in the worker, drawn 1:1 into the canvas).
  useEffect(() => {
    const { project: p, settings: s, boxSize: box } = previewKey;
    if (!open || !p || !s) return;
    const previewSettings = isGraphic(s.format) ? s : { ...s, region: 'sheet' as const };
    let alive = true;
    jobRef.current?.cancel();
    setPreviewBusy(true);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const previewPx = Math.round(Math.min(2400, Math.max(box.w, box.h) * dpr));
    void previewWorker()
      .run('preview', p, previewSettings, { previewPx })
      .then((h) => {
        jobRef.current = h;
        return h.promise;
      })
      .then((done) => {
        if (!alive) {
          done.preview?.close();
          return;
        }
        const c = canvasRef.current;
        if (c && done.preview) {
          c.width = done.preview.width;
          c.height = done.preview.height;
          c.getContext('2d')!.drawImage(done.preview, 0, 0);
          c.dataset.pxPerMm = String(done.info.pxPerMm);
          c.dataset.dpi = String(done.info.pxPerMm * 25.4);
          done.preview.close();
        }
        setInfo(done.info);
        setPreviewError(null);
        setPreviewBusy(false);
      })
      .catch((e: Error) => {
        if (!alive || e?.name === 'AbortError') return;
        setPreviewError(e?.message ?? String(e));
        setPreviewBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [open, previewKey]);

  const getContentBounds = useCallback((): Bounds | null => {
    if (!project) return null;
    const drawings: Record<string, DrawingSceneInput> = {};
    for (const d of project.drawings) {
      const m = models[d.id];
      if (!m?.result) continue;
      drawings[d.id] = m.result.page
        ? {
            id: d.id,
            pdf: {
              pageIndex: 0,
              userToDrawing: [1, 0, 0, 1, 0, 0],
              widthPt: m.result.page.width,
              heightPt: m.result.page.height,
            },
          }
        : { id: d.id, extents: m.result.extents, insunits: m.result.insunits };
    }
    return contentBounds({
      project,
      drawings,
      contours: collectContours(project),
      settings: settingsOf(project, options!),
    });
  }, [project, models, options]);

  if (!project || !options || !settings) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export</DialogTitle>
            <DialogDescription>Open a project to export.</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  const fmt = formatInfo(options.format);
  const profiles = project.exportProfiles;
  const doExport = async () => {
    await runExport(settings);
  };
  const layout = info?.layout;

  return (
    <Dialog open={open} onOpenChange={(o) => !run.running && onOpenChange(o)}>
      <DialogContent
        className="flex h-[92vh] max-h-[92vh] w-[96vw] max-w-[96vw] flex-col gap-3 p-4 sm:max-w-[min(1400px,96vw)]"
        data-testid="export-dialog"
        onKeyDown={(e) => e.stopPropagation()}
      >
        <DialogHeader className="flex-row flex-wrap items-center gap-2 space-y-0 pr-8">
          <DialogTitle className="mr-2">Export</DialogTitle>
          <DialogDescription className="sr-only">Sheet layout, format and preview</DialogDescription>
          <Select
            value={profileId || 'none'}
            onValueChange={(v) => {
              if (v === 'none') return setProfileId('');
              const p = profiles.find((x) => x.id === v);
              if (!p) return;
              applyProfileSheet(p);
              const { sheet: _s, ...rest } = profileSettings(p);
              void _s;
              setOptions(rest);
              setProfileId(p.id);
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-56"
              aria-label="Export profile"
              data-testid="export-profile-select"
            >
              <SelectValue placeholder="Profile" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No profile</SelectItem>
              {profiles.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            disabled={readOnly}
            data-testid="export-save-profile"
            onClick={async () => {
              const id = await saveProfileAs(settings);
              if (id) setProfileId(id);
            }}
          >
            <Save /> Save as profile…
          </Button>
          {profileId && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={readOnly}
                onClick={() => updateProfile(profileId, settings)}
                data-testid="export-update-profile"
              >
                Update profile
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly}
                aria-label="Delete profile"
                onClick={async () => {
                  if (await deleteProfile(profileId)) setProfileId('');
                }}
              >
                <Trash2 />
              </Button>
            </>
          )}
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[22rem_1fr]">
          <ScrollArea className="min-h-0 rounded-md border">
            <div className="p-3">
              <ExportSettingsForm
                project={project}
                options={options}
                setOptions={setOptions}
                readOnly={readOnly}
                contentBounds={getContentBounds}
              />
            </div>
          </ScrollArea>
          <div className="flex min-h-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="export-info">
              {layout && (
                <>
                  <Badge variant="outline">
                    {layout.paper.w.toFixed(0)} × {layout.paper.h.toFixed(0)} mm
                  </Badge>
                  <Badge variant="outline" data-testid="export-scale">
                    {scaleLabel(layout.scale)}
                  </Badge>
                  {options.format === 'png' && info && (
                    <Badge variant="outline" data-testid="export-png-size">
                      {info.pngSize.width} × {info.pngSize.height} px
                    </Badge>
                  )}
                  <span className="text-muted-foreground">{layout.scaleStatement}</span>
                </>
              )}
              {previewBusy && <Loader2 className="size-3.5 animate-spin" aria-label="Updating preview" />}
            </div>
            <div
              ref={boxRef}
              className="relative min-h-0 flex-1 overflow-hidden rounded-md border bg-[repeating-conic-gradient(#e5e7eb_0%_25%,#f9fafb_0%_50%)] bg-[length:16px_16px]"
            >
              {options.format === 'csv' || options.format === 'xlsx' ? (
                <div className="bg-background absolute inset-0 overflow-auto">
                  <TablePreview project={project} options={options} />
                </div>
              ) : (
                <canvas
                  ref={canvasRef}
                  data-testid="export-preview"
                  data-busy={previewBusy ? 'true' : 'false'}
                  className="absolute inset-0 m-auto max-h-full max-w-full shadow-md"
                  style={{ objectFit: 'contain' }}
                  aria-label="Export preview"
                />
              )}
              {previewError && (
                <p className="bg-destructive/10 text-destructive absolute bottom-2 left-2 rounded px-2 py-1 text-xs">
                  Preview failed: {previewError}
                </p>
              )}
            </div>
            {info && (info.warnings.length > 0 || options.format === 'dxf') && (
              <div className="text-muted-foreground space-y-0.5 text-xs" data-testid="export-warnings">
                {options.format === 'dxf' && (
                  <p>
                    DXF contains the analysis only (objects, labels, contours
                    {options.includeLegend ? ', legend' : ''} and the calibration statement) on named layers;
                    the preview shows how it looks on the sheet.
                  </p>
                )}
                {info.warnings.map((w, i) => (
                  <p key={i}>⚠ {w}</p>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 border-t pt-3">
          {run.running ? (
            <div className="flex flex-1 items-center gap-2" data-testid="export-progress">
              <Progress value={Math.round(run.fraction * 100)} className="max-w-sm" />
              <span className="text-muted-foreground text-xs">{run.message}</span>
              <Button size="sm" variant="outline" onClick={() => run.cancel?.()} data-testid="export-cancel">
                <X /> Cancel
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground flex-1 truncate text-xs" data-testid="export-filename">
              {fileNameFor(project, settings)}
              {run.last &&
                ` · last: ${run.last.fileName} (${(run.last.bytes / 1024).toFixed(0)} KB, ${(run.last.ms / 1000).toFixed(1)} s)`}
            </p>
          )}
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={run.running}
            data-testid="export-close"
          >
            Close
          </Button>
          <Button onClick={() => void doExport()} disabled={run.running} data-testid="export-run">
            <Download /> Export {fmt.ext.toUpperCase()}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
