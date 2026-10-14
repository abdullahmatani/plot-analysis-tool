import { create } from 'zustand';
import { toast } from 'sonner';

import { newId } from '@/core/ids';
import type { Drawing, DrawingKind, Project } from '@/core/types';
import { insunitsToUnits } from '@/core/units';
import { getBlobBytes, hashBytes, putBlob } from '@/persistence/blobs';
import { getSetting } from '@/persistence/settings';
import { commit, getProject, useProjectStore } from '@/store/project';
import { useUiStore } from '@/store/ui';
import type { ImportReport } from '@/underlay/entity-store';
import { attachIndices, getModel, useModelsStore } from '@/underlay/models';

import { detectFileType } from './detect';
import { ParseCancelled, parseInWorker, type ParseJob, type ParseOutput } from './parse-client';
import { openPdfDocument, pdfAssetBase } from './pdf/pdf-doc';

/**
 * Drawing import (rows 13–16, 21–23): signature detection, size warning, background parsing with
 * progress and cancel, storage of the source bytes (once per SHA-256), an undoable "Import drawing"
 * command and an import report. Drawings of an opened project are re-parsed from stored bytes.
 */

export interface ImportJobInfo {
  id: string;
  name: string;
  progress: number;
  message: string;
  cancel: () => void;
}

interface ImportStore {
  jobs: ImportJobInfo[];
  update(job: ImportJobInfo | { id: string; remove: true }): void;
}

export const useImportStore = create<ImportStore>()((set) => ({
  jobs: [],
  update: (job) =>
    set((s) =>
      'remove' in job
        ? { jobs: s.jobs.filter((j) => j.id !== job.id) }
        : {
            jobs: s.jobs.some((j) => j.id === job.id)
              ? s.jobs.map((j) => (j.id === job.id ? job : j))
              : [...s.jobs, job],
          },
    ),
}));

export const DEFAULT_WARN_MB = 50;

function runJob(
  name: string,
  kind: DrawingKind,
  bytes: Uint8Array,
  opts: { page?: number; layout?: string },
): ParseJob & { id: string } {
  const id = newId('job');
  const store = useImportStore.getState();
  let job: ParseJob | null = null;
  const info: ImportJobInfo = { id, name, progress: 0, message: 'Starting…', cancel: () => job?.cancel() };
  store.update(info);
  job = parseInWorker(kind, bytes, { ...opts, assetBase: pdfAssetBase() }, (f, message) => {
    useImportStore.getState().update({ ...info, progress: f, message: message ?? info.message });
  });
  const promise = job.promise.finally(() => useImportStore.getState().update({ id, remove: true }));
  return { id, promise, cancel: job.cancel };
}

export function showReport(name: string, report: ImportReport, version?: string) {
  useUiStore.getState().openDialog('import-report', { name, report, version });
}

function reportNeedsAttention(r: ImportReport) {
  return r.errors.length > 0 || r.warnings.length > 0 || Object.keys(r.skipped).length > 0;
}

/** Imports dropped/picked files: drawings, project files and tables are routed by signature. */
export async function importFiles(files: File[]): Promise<void> {
  for (const file of files) await importFile(file);
}

async function importFile(file: File) {
  const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  const detected = detectFileType(head, file.name);
  if (detected.kind === 'patproj') {
    const { openProjectBytes } = await import('@/app/file-ops');
    await openProjectBytes(new Uint8Array(await file.arrayBuffer()));
    return;
  }
  if (detected.kind === 'xlsx' || detected.kind === 'csv') {
    if (!getProject()) {
      toast.error('Open or create a project before importing a table.');
      return;
    }
    useUiStore.getState().openDialog('import-table', { file });
    return;
  }
  if (detected.kind === 'unknown') {
    toast.error(`“${file.name}” cannot be imported`, {
      description: `Detected: ${detected.label}. Supported drawings are DXF, DWG and PDF; tables are CSV, TSV and XLSX.`,
    });
    return;
  }
  if (!getProject()) {
    toast.error('Open or create a project first.');
    return;
  }
  if (useProjectStore.getState().readOnly) {
    toast.error('This project is read-only in this tab.');
    return;
  }
  const warnMb = await getSetting<number>('import.warnMB', DEFAULT_WARN_MB);
  if (file.size > warnMb * 1024 * 1024) {
    const { confirmAction } = await import('@/app/prompt');
    const ok = await confirmAction({
      title: 'Large file',
      description: `“${file.name}” is ${(file.size / 1024 / 1024).toFixed(0)} MB. Importing may take a while and use a lot of memory. Continue?`,
      confirmLabel: 'Import',
    });
    if (!ok) return;
  }
  if (detected.misnamed) toast.info(`“${file.name}” is actually a ${detected.label}; importing it as such.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = detected.kind as DrawingKind;
  let pages = [1];
  let pageCount = 1;
  if (kind === 'pdf') {
    try {
      const doc = await openPdfDocument(bytes);
      pageCount = doc.numPages;
      await doc.loadingTask.destroy();
    } catch (e) {
      toast.error(`“${file.name}” could not be opened as a PDF`, { description: (e as Error).message });
      return;
    }
    if (pageCount > 1) {
      const { pickPdfPages } = await import('./pdf/page-picker');
      const chosen = await pickPdfPages(file.name, bytes, pageCount);
      if (!chosen?.length) return;
      pages = chosen;
    }
  }
  const sha = await hashBytes(bytes);
  for (const page of pages) {
    const label = kind === 'pdf' && pageCount > 1 ? `${file.name} (page ${page})` : file.name;
    const job = runJob(label, kind, bytes, { page });
    let out: ParseOutput;
    try {
      out = await job.promise;
    } catch (e) {
      if (e instanceof ParseCancelled) {
        toast.info(`Import of “${label}” cancelled.`);
        return;
      }
      failedImport(label, kind, e as Error, detected.version);
      continue;
    }
    if (out.result.store.count === 0 && kind !== 'pdf') {
      showReport(
        label,
        {
          ...out.result.report,
          errors: [...out.result.report.errors, 'No drawable entities were found in this file.'],
        },
        detected.version,
      );
      if (kind === 'dwg') return;
    }
    await putBlob(bytes, file.name, file.type || 'application/octet-stream', sha);
    const drawing = makeDrawing(file.name, kind, sha, bytes.byteLength, out, page, pageCount);
    const before = getProject();
    const ok = commit(`Import drawing “${label}”`, (d) => {
      drawing.order = d.drawings.length;
      d.drawings.push(drawing);
    });
    if (!ok) return;
    await installModel(drawing, out, bytes);
    window.dispatchEvent(
      new CustomEvent('pat:zoom-extents', {
        detail: { drawingId: drawing.id, onlyIfFirst: (before?.drawings.length ?? 0) === 0 },
      }),
    );
    const counts = Object.values(out.result.report.counts).reduce((s, n) => s + n, 0);
    if (reportNeedsAttention(out.result.report)) {
      toast.warning(`Imported “${label}” with notes`, {
        description: `${counts.toLocaleString()} items. Some content was skipped or needs attention.`,
        action: {
          label: 'View report',
          onClick: () => showReport(label, out.result.report, detected.version),
        },
      });
    } else {
      toast.success(`Imported “${label}”`, { description: `${counts.toLocaleString()} items` });
    }
  }
}

function failedImport(label: string, kind: DrawingKind, e: Error, version?: string) {
  const fallback =
    kind === 'dwg'
      ? 'If this DWG cannot be read, export it from your CAD application as DXF (ASCII) or plot it to PDF and import that instead.'
      : kind === 'pdf'
        ? 'The PDF may be damaged or password-protected. Try re-saving it from a PDF viewer.'
        : 'The DXF may be damaged or in an unsupported variant. Try saving it again from your CAD application (ASCII DXF, any version).';
  showReport(label, { counts: {}, skipped: {}, warnings: [fallback], errors: [e.message] }, version);
}

function makeDrawing(
  fileName: string,
  kind: DrawingKind,
  sha: string,
  size: number,
  out: ParseOutput,
  page: number,
  pageCount: number,
): Drawing {
  const base = fileName.replace(/\.[^.]+$/, '');
  return {
    id: newId('drw'),
    name: kind === 'pdf' && pageCount > 1 ? `${base} p${page}` : base,
    source: { kind, fileName, sha256: sha, blobKey: sha, size },
    page: kind === 'pdf' ? page : undefined,
    nativeUnits: kind === 'pdf' ? 'pt' : insunitsToUnits(out.result.insunits),
    opacity: 1,
    ghost: false,
    visible: true,
    hiddenSourceLayers: out.result.store.layers.filter((l) => l.off || l.frozen).map((l) => l.name),
    order: 0,
  };
}

async function installModel(drawing: Drawing, out: ParseOutput, bytes: Uint8Array) {
  const models = useModelsStore.getState();
  const base = {
    drawingId: drawing.id,
    status: 'ready' as const,
    progress: 1,
    result: out.result,
    render: out.render,
    version: (getModel(drawing.id)?.version ?? 0) + 1,
  };
  let pdf:
    | {
        doc: Awaited<ReturnType<typeof openPdfDocument>>;
        page: Awaited<ReturnType<Awaited<ReturnType<typeof openPdfDocument>>['getPage']>>;
      }
    | undefined;
  if (drawing.source.kind === 'pdf') {
    const doc = await openPdfDocument(bytes);
    pdf = { doc, page: await doc.getPage(drawing.page ?? 1) };
  }
  models.set(drawing.id, { ...base, ...attachIndices(base as never), pdf, error: undefined });
}

const loading = new Set<string>();

/** Ensures every drawing of the project has a parsed model; drops models of removed drawings. */
export async function syncModels(project: Project | null) {
  const models = useModelsStore.getState();
  if (!project) {
    models.clear();
    return;
  }
  const ids = new Set(project.drawings.map((d) => d.id));
  for (const id of Object.keys(models.models)) if (!ids.has(id)) models.remove(id);
  for (const d of project.drawings) {
    if (models.models[d.id] || loading.has(d.id)) continue;
    loading.add(d.id);
    models.set(d.id, { status: 'loading', progress: 0, message: 'Loading…' });
    void (async () => {
      try {
        const bytes = await getBlobBytes(d.source.sha256);
        if (!bytes) throw new Error(`The source file “${d.source.fileName}” is missing from local storage.`);
        const job = runJob(d.name, d.source.kind, bytes, { page: d.page, layout: d.layout });
        const out = await job.promise;
        await installModel(d, out, bytes);
      } catch (e) {
        if (!(e instanceof ParseCancelled))
          models.set(d.id, { status: 'error', error: (e as Error).message });
      } finally {
        loading.delete(d.id);
      }
    })();
  }
}

/** Re-parses a drawing (e.g. after choosing another CAD layout). */
export async function reloadModel(d: Drawing) {
  useModelsStore.getState().remove(d.id);
  await syncModels(getProject());
}
