import { toast } from 'sonner';
import { create } from 'zustand';

import { currentSession } from '@/app/session';
import type { ExportProfile, Project } from '@/core/types';
import { getProject } from '@/store/project';

import { ExportCancelled, exportJob, type JobHandle } from './client';
import type { DoneMessage } from './protocol';
import { chooseTarget, saveParts, type SaveTarget } from './save';
import {
  defaultExportSettings,
  exportBaseName,
  formatInfo,
  profileSettings,
  withSheet,
  type ExportSettings,
} from './settings';

/**
 * Running exports (rows 77–81): file name, save target, pre-export checkpoint (row 92), the worker
 * job with progress and cancel, saving, and the "last used" options per project (a per-browser
 * convenience; the sheet layout itself lives in the project).
 */

export interface ExportRunState {
  running: boolean;
  fraction: number;
  message: string;
  cancel: (() => void) | null;
  last: { fileName: string; bytes: number; ms: number; format: string } | null;
  set(patch: Partial<Omit<ExportRunState, 'set'>>): void;
}

export const useExportRun = create<ExportRunState>()((set) => ({
  running: false,
  fraction: 0,
  message: '',
  cancel: null,
  last: null,
  set: (patch) => set(patch),
}));

/** Options the dialog keeps outside the project (format, DPI, region, DXF/CSV choices). */
export type ExportOptions = Omit<ExportSettings, 'sheet'>;

const KEY = (projectId: string) => `pat:export:last:${projectId}`;

export function loadLastOptions(project: Project): ExportOptions {
  const { sheet: _sheet, ...defaults } = defaultExportSettings(project);
  void _sheet;
  try {
    const raw = localStorage.getItem(KEY(project.id));
    if (raw) {
      const v = { ...defaults, ...(JSON.parse(raw) as Partial<ExportOptions>) };
      if (v.dxfDrawingId && !project.drawings.some((d) => d.id === v.dxfDrawingId))
        v.dxfDrawingId = project.drawings[0]?.id;
      return v;
    }
  } catch {
    /* storage unavailable */
  }
  return defaults;
}

export function saveLastOptions(project: Project, o: ExportOptions) {
  try {
    localStorage.setItem(KEY(project.id), JSON.stringify(o));
  } catch {
    /* storage unavailable */
  }
}

export function settingsOf(project: Project, o: ExportOptions): ExportSettings {
  return withSheet({ ...o, sheet: project.sheet }, project.sheet);
}

export function fileNameFor(project: Project, settings: ExportSettings): string {
  return `${exportBaseName(project, settings)}.${formatInfo(settings.format).ext}`;
}

export interface ExportOutcome {
  fileName: string;
  done: DoneMessage;
}

/**
 * Exports with `settings`. Asks for the save location first (user gesture), then checkpoints the
 * project and runs the worker. Resolves null when cancelled.
 */
export async function runExport(
  settings: ExportSettings,
  opts: { target?: SaveTarget; quiet?: boolean } = {},
): Promise<ExportOutcome | null> {
  const project = getProject();
  if (!project) return null;
  const run = useExportRun.getState();
  if (run.running) {
    toast.info('An export is already running.');
    return null;
  }
  const fileName = fileNameFor(project, settings);
  const target = opts.target ?? (await chooseTarget(fileName, settings.format));
  if (!target) return null;
  let job: JobHandle | null = null;
  let cancelled = false;
  // Cancel works from the moment the progress appears, including while the project is checkpointed.
  run.set({
    running: true,
    fraction: 0,
    message: 'Preparing…',
    cancel: () => {
      cancelled = true;
      job?.cancel();
    },
  });
  try {
    await currentSession()?.beforeExport();
    if (cancelled) throw new ExportCancelled();
    job = exportJob(project, settings, (fraction, message) =>
      useExportRun.getState().set({ fraction, message: message ?? useExportRun.getState().message }),
    );
    const done = await job.promise;
    const parts = done.parts ?? [];
    await saveParts(target, parts, fileName, done.mime ?? formatInfo(settings.format).mime);
    const bytes = parts.reduce((s, p) => s + p.length, 0);
    useExportRun.getState().set({ last: { fileName, bytes, ms: done.ms, format: settings.format } });
    if (!opts.quiet) {
      toast.success(`Exported “${fileName}”`, {
        description: `${(bytes / 1024).toFixed(0)} KB in ${(done.ms / 1000).toFixed(1)} s`,
      });
      if (done.info.warnings.length)
        toast.warning('Export notes', { description: done.info.warnings.slice(0, 4).join(' ') });
    }
    return { fileName, done };
  } catch (e) {
    if (e instanceof ExportCancelled || (e as Error)?.name === 'AbortError') {
      toast.info('Export cancelled.');
      return null;
    }
    toast.error('Export failed', { description: (e as Error)?.message ?? String(e) });
    return null;
  } finally {
    useExportRun.getState().set({ running: false, cancel: null, fraction: 0, message: '' });
  }
}

/** Re-runs a saved profile exactly (its own sheet layout, not the project's current one). */
export function runProfile(p: ExportProfile, opts: { target?: SaveTarget } = {}) {
  return runExport(profileSettings(p), opts);
}
