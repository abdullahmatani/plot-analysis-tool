import {
  ArrowLeftRight,
  CircleMinus,
  CirclePlus,
  Combine,
  Contrast,
  Eraser,
  PaintBucket,
  PenTool,
  Pipette,
  Route,
  Scissors,
  Spline,
  SquareDashed,
  Unlink2,
  Waypoints,
  ZoomIn,
} from 'lucide-react';
import { toast } from 'sonner';

import { registerCommands } from '@/app/commands';
import { promptText } from '@/app/prompt';
import type { Geometry } from '@/core/types';
import { formatLength, parseLength } from '@/core/units';
import { commit, getProject, useProjectStore } from '@/store/project';
import { useViewStore } from '@/store/view';
import { registerTool, setTool } from '@/tools/registry';
import { editableSelection, updateGeometries } from '@/features/objects/ops';
import { gripExtensions, type GripExtension } from '@/features/objects/grips';

import {
  closeGeometry,
  dedupeGeometry,
  insertAndMove,
  joinGeometries,
  openGeometry,
  reverseGeometry,
  segmentMidpoints,
  simplifyGeometry,
} from './edit-ops';
import { convertSegmentTool, insertVertexTool, removeVertexTool, splitTool } from './edit-tools';
import { boundaryPickTool, chainTraceTool, pickTraceTool } from './entity-tools';
import { registerRasterAids } from './loupe';
import { manualTraceTool } from './manual-tool';
import { traceSettings, useTraceSettings } from './settings';

/** Trace menu (rows 49–54): tracing tools, trace editing and cleanup, raster aids. */

const canEdit = () => !!getProject() && !useProjectStore.getState().readOnly;
const hasSel = () => canEdit() && editableSelection().length > 0;
const chordTol = () => getProject()?.chordTolerance ?? 0.005;
const units = () => getProject()?.display.units ?? 'm';

/** Toggles a setting and refreshes menus (their check marks are computed when they render). */
function toggle(key: 'detectIslands' | 'loupe' | 'edgeContrast') {
  useTraceSettings.getState().set({ [key]: !traceSettings()[key] });
  registerCommands([]);
}

/** Applies a geometry edit to every editable selected object in one command. */
function editSelection(label: string, fn: (g: Geometry) => Geometry | null, none: string): number {
  const p = getProject();
  const ids = editableSelection();
  if (!p || !ids.length) return 0;
  const results = new Map<string, Geometry>();
  for (const o of p.objects) {
    if (!ids.includes(o.id)) continue;
    const g = fn(o.geometry);
    if (g) results.set(o.id, g);
  }
  if (!results.size) {
    toast.info(none);
    return 0;
  }
  updateGeometries([...results.keys()], label, (g, o) => results.get(o.id) ?? g);
  return results.size;
}

async function simplifySelection() {
  const s = traceSettings();
  const u = units();
  const v = await promptText({
    title: 'Simplify',
    description:
      'Removes vertices that lie within the tolerance of the simplified outline. Kept vertices are never moved; arcs are kept.',
    label: `Tolerance (${u})`,
    defaultValue: formatLength(s.simplifyTol, u, 3).replace(/\s.*$/, ''),
  });
  if (v === null) return;
  const tol = parseLength(v, u);
  if (tol === null || !(tol > 0)) {
    toast.error('Enter a positive tolerance, e.g. 0.05 or 50 mm.');
    return;
  }
  useTraceSettings.getState().set({ simplifyTol: tol });
  let removed = 0;
  const n = editSelection(
    'Simplify',
    (g) => {
      const r = simplifyGeometry(g, tol);
      if (r) removed += r.removed;
      return r?.geometry ?? null;
    },
    'Nothing to simplify within that tolerance (only polylines and areas can be simplified).',
  );
  if (n) toast.success(`Removed ${removed} vertices`);
}

function dedupeSelection() {
  let removed = 0;
  const n = editSelection(
    'Remove duplicate vertices',
    (g) => {
      const r = dedupeGeometry(g, 1e-6);
      if (r) removed += r.removed;
      return r?.geometry ?? null;
    },
    'No duplicate vertices found.',
  );
  if (n) toast.success(`Removed ${removed} duplicate vertices`);
}

function joinSelection() {
  const p = getProject();
  if (!p) return;
  const ids = editableSelection();
  const objs = p.objects.filter((o) => ids.includes(o.id));
  const tol = traceSettings().gapTol;
  const open = objs.filter((o) => o.geometry.type === 'polyline' && !o.geometry.closed);
  if (open.length < 2) {
    toast.info('Select two or more open polylines whose ends meet to join them.');
    return;
  }
  const r = joinGeometries(
    open.map((o) => o.geometry),
    tol,
  );
  if (!r) {
    toast.error(
      `The selected polylines do not meet within the gap tolerance (${formatLength(tol, units(), 3)}).`,
    );
    return;
  }
  const keep = open[0].id;
  const drop = new Set(r.used.slice(1).map((i) => open[i].id));
  const ok = commit(`Join ${r.used.length} polylines`, (d) => {
    const o = d.objects.find((x) => x.id === keep);
    if (o) o.geometry = r.geometry;
    d.objects = d.objects.filter((x) => !drop.has(x.id));
  });
  if (!ok) return;
  useViewStore.getState().set({ selection: [keep] });
  if (r.used.length < open.length)
    toast.info(`${open.length - r.used.length} polyline(s) did not connect and were left unchanged.`);
}

async function setGapTolerance() {
  const u = units();
  const v = await promptText({
    title: 'Gap tolerance',
    description: 'Chain trace and boundary pick close gaps between line ends up to this size.',
    label: `Gap tolerance (${u})`,
    defaultValue: formatLength(traceSettings().gapTol, u, 3).replace(/\s.*$/, ''),
  });
  if (v === null) return;
  const tol = parseLength(v, u);
  if (tol === null || tol < 0) {
    toast.error('Enter a tolerance of zero or more, e.g. 0.1 or 100 mm.');
    return;
  }
  useTraceSettings.getState().set({ gapTol: tol });
  toast.success(`Gap tolerance ${formatLength(tol, u, 3)}`);
}

const insertGrips: GripExtension = {
  grips: (g) =>
    segmentMidpoints(g).map((m) => ({ kind: 'insert' as const, ring: m.ring, index: m.index, pt: m.pt })),
  apply: (g, grip, to) =>
    grip.kind === 'insert'
      ? insertAndMove(g, { ring: grip.ring ?? 0, index: grip.index ?? 0, pt: grip.pt }, to)
      : null,
};

const TOOLS = [
  { tool: manualTraceTool, icon: PenTool, shortcut: 'T', rail: true, section: 'trace' },
  { tool: pickTraceTool, icon: Pipette, shortcut: 'Shift+T', rail: true, section: 'trace' },
  { tool: chainTraceTool, icon: Route, shortcut: 'Shift+C', rail: true, section: 'trace' },
  { tool: boundaryPickTool, icon: PaintBucket, shortcut: 'B', rail: true, section: 'trace' },
  { tool: insertVertexTool, icon: CirclePlus, section: 'vertices' },
  { tool: removeVertexTool, icon: CircleMinus, section: 'vertices' },
  { tool: splitTool, icon: Scissors, section: 'vertices' },
  { tool: convertSegmentTool, icon: Spline, section: 'vertices' },
] as const;

export function register() {
  for (const t of TOOLS) registerTool(t.tool);
  gripExtensions.push(insertGrips);
  const unAids = registerRasterAids();
  const unCmds = registerCommands([
    ...TOOLS.map((t) => ({
      id: t.tool.id,
      title: t.tool.title,
      menu: 'Trace' as const,
      section: t.section,
      shortcut: 'shortcut' in t ? t.shortcut : undefined,
      icon: t.icon,
      rail: 'rail' in t ? t.rail : false,
      needsProject: true,
      enabled: canEdit,
      active: () => useViewStore.getState().activeTool === t.tool.id,
      run: () => setTool(t.tool.id),
    })),
    {
      id: 'trace.join',
      title: 'Join selected polylines',
      menu: 'Trace',
      section: 'cleanup',
      icon: Combine,
      needsProject: true,
      enabled: hasSel,
      run: joinSelection,
    },
    {
      id: 'trace.reverse',
      title: 'Reverse direction',
      menu: 'Trace',
      section: 'cleanup',
      icon: ArrowLeftRight,
      needsProject: true,
      enabled: hasSel,
      run: () => void editSelection('Reverse', (g) => reverseGeometry(g, chordTol()), 'Nothing to reverse.'),
    },
    {
      id: 'trace.close',
      title: 'Close polyline',
      menu: 'Trace',
      section: 'cleanup',
      icon: SquareDashed,
      needsProject: true,
      enabled: hasSel,
      run: () =>
        void editSelection(
          'Close polyline',
          (g) => closeGeometry(g, chordTol()),
          'Select an open polyline or arc.',
        ),
    },
    {
      id: 'trace.open',
      title: 'Open polyline (remove closing segment)',
      menu: 'Trace',
      section: 'cleanup',
      icon: Unlink2,
      needsProject: true,
      enabled: hasSel,
      run: () =>
        void editSelection(
          'Open polyline',
          (g) => openGeometry(g, chordTol()),
          'Select a closed polyline or shape.',
        ),
    },
    {
      id: 'trace.dedupe',
      title: 'Remove duplicate vertices',
      menu: 'Trace',
      section: 'cleanup',
      icon: Eraser,
      needsProject: true,
      enabled: hasSel,
      run: dedupeSelection,
    },
    {
      id: 'trace.simplify',
      title: 'Simplify…',
      menu: 'Trace',
      section: 'cleanup',
      icon: Waypoints,
      needsProject: true,
      enabled: hasSel,
      run: simplifySelection,
    },
    {
      id: 'trace.gapTolerance',
      title: 'Gap tolerance…',
      menu: 'Trace',
      section: 'settings',
      needsProject: true,
      run: setGapTolerance,
    },
    {
      id: 'trace.islands',
      title: 'Boundary pick: detect islands (holes)',
      menu: 'Trace',
      section: 'settings',
      checked: () => useTraceSettings.getState().detectIslands,
      run: () => toggle('detectIslands'),
    },
    {
      id: 'trace.loupe',
      title: 'Magnifier loupe',
      menu: 'Trace',
      section: 'aids',
      shortcut: 'Alt+M',
      icon: ZoomIn,
      checked: () => useTraceSettings.getState().loupe,
      run: () => toggle('loupe'),
    },
    {
      id: 'trace.edgeContrast',
      title: 'Edge contrast for scanned pages',
      menu: 'Trace',
      section: 'aids',
      icon: Contrast,
      checked: () => useTraceSettings.getState().edgeContrast,
      run: () => toggle('edgeContrast'),
    },
  ]);
  return () => {
    const i = gripExtensions.indexOf(insertGrips);
    if (i >= 0) gripExtensions.splice(i, 1);
    unAids();
    unCmds();
  };
}
