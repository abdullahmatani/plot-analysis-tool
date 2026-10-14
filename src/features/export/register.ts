import { FileDown, FileImage, FileSpreadsheet, FileText, Frame, Printer, Repeat, Shapes } from 'lucide-react';

import { registerCommands, type Command } from '@/app/commands';
import { apply, invert } from '@/core/affine';
import type { Affine2D, Project, Pt } from '@/core/types';
import { extraDialogs } from '@/components/app/extra-dialogs';
import { registerOverlay, requestCanvasRender } from '@/render/canvas-controller';
import { getProject, useProjectStore } from '@/store/project';
import { useUiStore } from '@/store/ui';
import { useModelsStore } from '@/underlay/models';
import type { DraftRecord } from '@/persistence/db';

import { disposePreviewWorker } from './client';
import { ExportDialog, type ExportDialogPayload } from './ExportDialog';
import { collectContours } from './inputs';
import {
  loadLastOptions,
  runExport,
  runProfile,
  saveLastOptions,
  settingsOf,
  type ExportOptions,
} from './run';
import { computeLayout } from './scene/project-scene';
import type { Rect } from './scene/sheet';
import type { DrawingSceneInput } from './scene/types';
import type { ExportFormat } from './settings';

/**
 * Export feature (rows 36, 48, 75–81): Export menu commands, the export dialog, profile commands
 * and an optional sheet-frame overlay showing what the sheet will print.
 */

if (!extraDialogs.some((d) => d.id === 'export'))
  extraDialogs.push({ id: 'export', Component: ExportDialog });

const open = (payload: ExportDialogPayload = {}) => useUiStore.getState().openDialog('export', payload);
const hasProject = () => !!getProject();

// ---- sheet frame overlay ----

let showFrame = false;
let cache: { key: unknown[]; M: Affine2D; viewport: Rect; titleBlock?: Rect; legend?: Rect } | null = null;

function frameLayout(p: Project) {
  const models = useModelsStore.getState().models;
  const key = [p.sheet, p.drawings, p.objects, p.datasets, p.layers, p.legend, models];
  if (cache && cache.key.every((k, i) => k === key[i])) return cache;
  const drawings: Record<string, DrawingSceneInput> = {};
  for (const d of p.drawings) {
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
  const settings = settingsOf(p, { ...loadLastOptions(p), region: 'sheet' });
  const contours = p.sheet.scale === null ? collectContours(p) : [];
  const layout = computeLayout({ project: p, settings, drawings, contours });
  cache = { key, M: layout.paperFromWorld, viewport: layout.viewport };
  return cache;
}

function drawFrameOverlay(g: CanvasRenderingContext2D, f: { toScreen: (p: Pt) => Pt }) {
  const p = getProject();
  if (!showFrame || !p) return;
  const l = frameLayout(p);
  let inv: Affine2D;
  try {
    inv = invert(l.M);
  } catch {
    return;
  }
  const r = l.viewport;
  const corners = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ].map((c) => f.toScreen(apply(inv, c)));
  g.save();
  g.beginPath();
  corners.forEach((c, i) => (i ? g.lineTo(c.x, c.y) : g.moveTo(c.x, c.y)));
  g.closePath();
  g.setLineDash([8, 5]);
  g.lineWidth = 1.5;
  g.strokeStyle = '#f59e0b';
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = '#f59e0b';
  g.font = '12px sans-serif';
  g.fillText(
    `Sheet ${p.sheet.paper} ${p.sheet.scale ? `1:${p.sheet.scale}` : '(fit)'}`,
    corners[0].x + 4,
    corners[0].y + 14,
  );
  g.restore();
}

// ---- profile commands ----

let unProfiles: (() => void) | null = null;
let lastProfiles: unknown = null;

function registerProfileCommands() {
  const p = getProject();
  const profiles = p?.exportProfiles ?? [];
  if (profiles === lastProfiles) return;
  lastProfiles = profiles;
  unProfiles?.();
  unProfiles = registerCommands(
    profiles.map((pr): Command => ({
      id: `export.profile.${pr.id}`,
      title: `Export profile: ${pr.name}`,
      menu: 'Export',
      section: 'profiles',
      icon: Repeat,
      needsProject: true,
      keywords: ['profile', pr.format],
      run: () => void runProfile(pr),
    })),
  );
}

const FORMAT_COMMANDS: { format: ExportFormat; title: string; icon: typeof FileDown }[] = [
  { format: 'pdf', title: 'Export PDF (vector, true scale)…', icon: FileText },
  { format: 'png', title: 'Export PNG image…', icon: FileImage },
  { format: 'svg', title: 'Export SVG…', icon: Shapes },
  { format: 'dxf', title: 'Export DXF for CAD…', icon: FileDown },
  { format: 'xlsx', title: 'Export tables (XLSX / CSV)…', icon: FileSpreadsheet },
];

export function register() {
  const unCmds = registerCommands([
    {
      id: 'export.dialog',
      title: 'Export / print sheet…',
      menu: 'Export',
      section: 'export',
      shortcut: 'Mod+P',
      icon: Printer,
      needsProject: true,
      keywords: ['print', 'sheet', 'layout', 'title block', 'pdf', 'png', 'svg', 'dxf', 'csv', 'xlsx'],
      enabled: hasProject,
      run: () => open(),
    },
    ...FORMAT_COMMANDS.map((c): Command => ({
      id: `export.${c.format}`,
      title: c.title,
      menu: 'Export',
      section: 'formats',
      icon: c.icon,
      needsProject: true,
      enabled: hasProject,
      run: () => open({ format: c.format }),
    })),
    {
      id: 'export.again',
      title: 'Export again with last settings',
      menu: 'Export',
      section: 'export',
      shortcut: 'Mod+Shift+E',
      icon: Repeat,
      needsProject: true,
      enabled: hasProject,
      run: () => {
        const p = getProject();
        if (!p) return;
        void runExport(settingsOf(p, loadLastOptions(p)));
      },
    },
    {
      id: 'export.sheetFrame',
      title: 'Show sheet frame on canvas',
      menu: 'Export',
      section: 'view',
      icon: Frame,
      needsProject: true,
      checked: () => showFrame,
      run: () => {
        showFrame = !showFrame;
        requestCanvasRender();
      },
    },
  ]);
  const unOverlay = registerOverlay(55, drawFrameOverlay);
  registerProfileCommands();
  const unSub = useProjectStore.subscribe((s, prev) => {
    if (s.history?.project.exportProfiles !== prev.history?.project.exportProfiles) registerProfileCommands();
    if (s.history?.project.id !== prev.history?.project.id) {
      disposePreviewWorker();
      cache = null;
    }
  });
  // A crash while the dialog was open: keep its options as the last-used ones (C7).
  const onDrafts = (e: Event) => {
    const drafts = (e as CustomEvent<DraftRecord[]>).detail ?? [];
    const d = drafts.find((x) => x.key === 'export-dialog');
    const p = getProject();
    if (d && p) saveLastOptions(p, { ...loadLastOptions(p), ...(d.state as Partial<ExportOptions>) });
  };
  window.addEventListener('pat:drafts', onDrafts);
  // Test hooks (E2E): whether every drawing's parsed model is ready for export.
  (window as unknown as { __patExport?: unknown }).__patExport = {
    modelsReady: () => {
      const p = getProject();
      const models = useModelsStore.getState().models;
      return !!p && p.drawings.every((d) => models[d.id]?.status === 'ready');
    },
  };
  return () => {
    unCmds();
    unOverlay();
    unSub();
    unProfiles?.();
    unProfiles = null;
    lastProfiles = null;
    window.removeEventListener('pat:drafts', onDrafts);
  };
}
