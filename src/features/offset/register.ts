import { Expand, Radar, Ruler, Unlink, Link2 } from 'lucide-react';

import { registerCommands } from '@/app/commands';
import { promptText } from '@/app/prompt';
import { registerDerivation } from '@/core/history';
import type { Geometry } from '@/core/types';
import { formatNumber, fromMetres, parseLength } from '@/core/units';
import { extraDialogs } from '@/components/app/extra-dialogs';
import { propertySections } from '@/components/inspector/property-sections';
import { traceGeometry } from '@/render/draw-geometry';
import { registerOverlay } from '@/render/canvas-controller';
import { getProject, useProjectStore } from '@/store/project';
import { useViewStore } from '@/store/view';
import { dragPreview } from '@/features/objects/select-tool';
import { resolveStyle } from '@/features/objects/style';

import { detachOffsets, offsetSources, reportDerivation, setChordTolerance } from './actions';
import { computeOffset, deriveOffsets, hasLiveOffsets, type DeriveReport } from './derive';
import { OffsetDialog } from './OffsetDialog';
import { OFFSET_DIALOG, openOffsetDialog } from './options';
import { OffsetSection } from './OffsetSection';

/** Offset menu (rows 55–61) and the live-offset derivation (row 59). */

const canEdit = () => !!getProject() && !useProjectStore.getState().readOnly;
const hasSelection = () => canEdit() && useViewStore.getState().selection.length > 0;
const selectedLive = () => offsetSources().filter((o) => o.derived);

/** Reports collected while a commit runs; shown once the commit has finished. */
let reports: DeriveReport[] = [];

function derivation(d: Parameters<typeof deriveOffsets>[0], before: Parameters<typeof deriveOffsets>[1]) {
  const r = deriveOffsets(d, before);
  if (!r.collapsed.length && !r.detached.length) return;
  if (!reports.length)
    queueMicrotask(() => {
      const all = reports;
      reports = [];
      for (const x of all) reportDerivation(x);
    });
  reports.push(r);
}

/** Live preview of dependent offsets while a source is dragged (grip or move). */
function drawLivePreview(
  g: CanvasRenderingContext2D,
  f: Parameters<Parameters<typeof registerOverlay>[1]>[1],
) {
  const edits = dragPreview();
  const p = getProject();
  if (!edits.length || !p || !hasLiveOffsets(p)) return;
  const geoms = new Map<string, Geometry>(edits.map((e) => [e.id, e.geometry]));
  const hidden = new Set(p.layers.filter((l) => !l.visible).map((l) => l.id));
  const shown: { geometry: Geometry; color: string }[] = [];
  // Offsets of offsets follow too (a few levels).
  for (let depth = 0; depth < 4; depth++) {
    let added = false;
    for (const o of p.objects) {
      if (!o.derived || geoms.has(o.id)) continue;
      const src = geoms.get(o.derived.sourceId);
      if (!src) continue;
      const res = computeOffset(src, o.derived, p.chordTolerance);
      if (!res.geometry) continue;
      geoms.set(o.id, res.geometry);
      if (!hidden.has(o.layerId)) shown.push({ geometry: res.geometry, color: resolveStyle(p, o).stroke });
      added = true;
    }
    if (!added) break;
  }
  for (const s of shown) {
    g.beginPath();
    traceGeometry(g, s.geometry, f.toScreen, f.scale);
    g.strokeStyle = s.color;
    g.lineWidth = 2;
    g.setLineDash([6, 4]);
    g.stroke();
  }
  g.setLineDash([]);
}

async function promptChordTolerance() {
  const p = getProject();
  if (!p) return;
  const v = await promptText({
    title: 'Chord tolerance',
    description:
      'Largest deviation allowed when curves are approximated by straight segments for polygon offsets, merges and boundary detection (circles and arcs are offset exactly). Live offsets are recomputed.',
    label: 'Chord tolerance (mm)',
    defaultValue: formatNumber(fromMetres(p.chordTolerance, 'mm'), 2),
  });
  if (v === null) return;
  const m = parseLength(v, 'mm');
  if (m === null) return;
  setChordTolerance(m);
}

export function register() {
  const unDerive = registerDerivation(derivation);
  if (!propertySections.includes(OffsetSection)) propertySections.push(OffsetSection);
  if (!extraDialogs.some((d) => d.id === OFFSET_DIALOG))
    extraDialogs.push({ id: OFFSET_DIALOG, Component: OffsetDialog });
  const unPreview = registerOverlay(61, drawLivePreview);
  const unCmds = registerCommands([
    {
      id: 'offset.offset',
      title: 'Offset…',
      menu: 'Offset',
      section: 'offset',
      shortcut: 'O',
      icon: Expand,
      rail: true,
      needsProject: true,
      keywords: ['expand', 'contract', 'buffer', 'inflate', 'deflate', 'merge', 'envelope'],
      enabled: hasSelection,
      run: () => openOffsetDialog('single'),
    },
    {
      id: 'offset.rings',
      title: 'Multi-ring offset…',
      menu: 'Offset',
      section: 'offset',
      icon: Radar,
      rail: true,
      needsProject: true,
      keywords: ['rings', 'buffer zones', 'distances'],
      enabled: () => canEdit() && useViewStore.getState().selection.length === 1,
      run: () => openOffsetDialog('rings'),
    },
    {
      id: 'offset.selectSource',
      title: 'Select offset source',
      menu: 'Offset',
      section: 'live',
      icon: Link2,
      needsProject: true,
      enabled: () => selectedLive().length > 0,
      run: () => {
        const ids = [...new Set(selectedLive().map((o) => o.derived!.sourceId))];
        useViewStore.getState().set({ selection: ids });
      },
    },
    {
      id: 'offset.detach',
      title: 'Detach offset (make static)',
      menu: 'Offset',
      section: 'live',
      icon: Unlink,
      needsProject: true,
      enabled: () => canEdit() && selectedLive().length > 0,
      run: () => void detachOffsets(selectedLive().map((o) => o.id)),
    },
    {
      id: 'offset.chordTolerance',
      title: 'Chord tolerance…',
      menu: 'Offset',
      section: 'settings',
      icon: Ruler,
      needsProject: true,
      enabled: canEdit,
      run: promptChordTolerance,
    },
  ]);
  return () => {
    unDerive();
    const i = propertySections.indexOf(OffsetSection);
    if (i >= 0) propertySections.splice(i, 1);
    const j = extraDialogs.findIndex((d) => d.id === OFFSET_DIALOG);
    if (j >= 0) extraDialogs.splice(j, 1);
    unPreview();
    unCmds();
  };
}
