import { toast } from 'sonner';

import { currentSession } from '@/app/session';
import { apply } from '@/core/affine';
import type { Geometry, Pt, Vertex } from '@/core/types';
import { formatNumber } from '@/core/units';
import { traceGeometry } from '@/render/draw-geometry';
import { requestCanvasRender } from '@/render/canvas-controller';
import { getProject } from '@/store/project';
import { useViewStore } from '@/store/view';
import { refreshHint, setTool } from '@/tools/registry';
import type { FrameInfo, Tool, ToolContext } from '@/tools/types';
import type { ChainState } from '@/tracing/chain';
import { entityTypeName } from '@/underlay/entity-geometry';
import { activeLayerWritable, addObjects } from '@/features/objects/ops';

import {
  BoundaryCancelled,
  collectVisibleGeometry,
  detectBoundary,
  type BoundaryJob,
} from './boundary-client';
import { boundaryGeometry } from './boundary-core';
import { traceSettings } from './settings';
import {
  chainModel,
  chainWorldGeometry,
  entityWorldGeometry,
  nearestPrimOf,
  pickTraceable,
  type ChainModel,
  type VectorSource,
} from './underlay';

/** Pick-trace (row 50), chain trace (row 51) and boundary pick (row 52) tools. */

const chordTol = () => getProject()?.chordTolerance ?? 0.005;

function setHover(source: VectorSource | null, index = -1) {
  const cur = useViewStore.getState().hoverEntity;
  const next = source ? { drawingId: source.drawing.id, index } : null;
  if (cur?.drawingId !== next?.drawingId || cur?.index !== next?.index)
    useViewStore.getState().set({ hoverEntity: next });
}

function hoverAt(world: Pt, scale: number) {
  const p = getProject();
  const hit = p ? pickTraceable(p, world, scale) : null;
  setHover(hit?.source ?? null, hit?.index ?? -1);
}

function guardLayer(): boolean {
  if (activeLayerWritable()) return true;
  setTimeout(() => setTool('select'), 0);
  return false;
}

/** Follows a chain from a primitive, taking the straightest way at every junction. */
function autoChain(model: ChainModel, prim: number, local: Pt): ChainState {
  let s = model.tracer.start(prim, local);
  for (let k = 0; k < 10_000 && s.status === 'junction'; k++) s = model.tracer.accept();
  return s;
}

// ------------------------------------------------------------------------------- pick-trace

export const pickTraceTool: Tool = {
  id: 'trace.pick',
  title: 'Pick-trace drawing entity',
  cursor: 'crosshair',
  hint: () =>
    'Pick-trace: click a drawing entity (line, polyline, circle, arc, ellipse, hatch) to copy its exact geometry · Shift+click a block part for the block outline · Esc to finish',
  activate() {
    guardLayer();
  },
  deactivate() {
    setHover(null);
  },
  pointerMove(e, ctx) {
    hoverAt(e.world, ctx.frame().scale);
  },
  pointerDown(e, ctx) {
    if (e.button !== 0) return;
    const p = getProject();
    if (!p) return;
    const hit = pickTraceable(p, e.world, ctx.frame().scale);
    if (!hit) {
      toast.info('No drawing entity here — hover until it is highlighted, then click.');
      return;
    }
    const { source, index } = hit;
    const st = source.store;
    let geometry: Geometry | null = null;
    let what = entityTypeName(st, index).toLowerCase();
    if (e.shift && st.insertIndex[index] >= 0) {
      // Block outline: follow the connected parts of the same block reference.
      const ins = st.insertIndex[index];
      const model = chainModel(source, traceSettings().gapTol, chordTol(), {
        key: `insert:${ins}`,
        filter: (i) => st.insertIndex[i] === ins,
      });
      const np = nearestPrimOf(model, index, e.world);
      if (np) {
        autoChain(model, np.prim, np.local);
        const r = model.tracer.result();
        geometry = chainWorldGeometry(source, r.pts, r.closed, chordTol());
        what = `block ${st.inserts[ins]?.name ?? ''} outline`.replace('  ', ' ');
      }
    } else {
      geometry = entityWorldGeometry(source, index, chordTol());
    }
    if (!geometry || geometry.type === 'point') {
      toast.error('This entity has no geometry that can be traced.');
      return;
    }
    addObjects([{ kind: 'trace', geometry }], `Pick-trace ${what}`);
  },
  keyDown(e) {
    if (e.key === 'Escape') {
      setTool('select');
      return true;
    }
    return false;
  },
};

// ------------------------------------------------------------------------------- chain trace

type Pending =
  | { kind: 'live'; model: ChainModel; state: ChainState }
  | { kind: 'restored'; pts: Vertex[]; closed: boolean };

let pending: Pending | null = null;
const chainDraft = { key: 'tool:trace.chain', tool: 'trace.chain', label: 'Chain trace' };

function pendingWorld(): { pts: Vertex[]; closed: boolean } | null {
  if (!pending) return null;
  if (pending.kind === 'restored') return { pts: pending.pts, closed: pending.closed };
  const g = chainWorldGeometry(pending.model.source, pending.state.pts, pending.state.closed, chordTol());
  return g?.type === 'polyline' ? { pts: g.pts, closed: g.closed } : null;
}

function saveChainDraft() {
  const s = currentSession();
  if (!s) return;
  const w = pendingWorld();
  if (w && w.pts.length) s.drafts.set(chainDraft, { points: w.pts, closed: w.closed });
  else s.drafts.clear(chainDraft.key);
}

function finishChain() {
  const w = pendingWorld();
  pending = null;
  saveChainDraft();
  refreshHint();
  if (!w || w.pts.length < 2) return;
  addObjects(
    [{ kind: 'trace', geometry: { type: 'polyline', pts: w.pts, closed: w.closed } }],
    'Chain trace',
  );
}

function afterStep() {
  if (pending?.kind === 'live' && pending.state.status !== 'junction') finishChain();
  else {
    saveChainDraft();
    refreshHint();
  }
}

export const chainTraceTool: Tool & { restoreDraft(state: unknown): void } = {
  id: 'trace.chain',
  title: 'Chain trace (auto-follow)',
  cursor: 'crosshair',
  hint: () => {
    if (pending?.kind === 'restored') return 'Recovered chain trace: Enter to keep it · Esc to discard';
    if (pending?.kind === 'live' && pending.state.junction) {
      const j = pending.state.junction;
      return `Junction (${j.current + 1}/${j.alternatives.length}): Tab next direction · Enter follow it · S stop here · Esc cancel`;
    }
    const tol = formatNumber(traceSettings().gapTol, 3);
    return `Chain trace: click a line of the drawing to follow connected segments (gaps ≤ ${tol} m are closed)`;
  },
  activate() {
    guardLayer();
  },
  deactivate() {
    pending = null;
    saveChainDraft();
    setHover(null);
  },
  pointerMove(e, ctx) {
    hoverAt(e.world, ctx.frame().scale);
  },
  pointerDown(e, ctx) {
    if (e.button !== 0) return;
    const p = getProject();
    if (!p) return;
    const hit = pickTraceable(p, e.world, ctx.frame().scale);
    if (!hit) {
      toast.info('Click on a line of the drawing to start the chain.');
      return;
    }
    const model = chainModel(hit.source, traceSettings().gapTol, chordTol());
    const np = nearestPrimOf(model, hit.index, e.world);
    if (!np) return;
    pending = { kind: 'live', model, state: model.tracer.start(np.prim, np.local) };
    afterStep();
  },
  keyDown(e) {
    if (!pending) {
      if (e.key === 'Escape') {
        setTool('select');
        return true;
      }
      return false;
    }
    if (e.key === 'Escape') {
      pending = null;
      saveChainDraft();
      refreshHint();
      return true;
    }
    if (pending.kind === 'restored') {
      if (e.key === 'Enter') {
        finishChain();
        return true;
      }
      return false;
    }
    const tracer = pending.model.tracer;
    if (e.key === 'Tab') {
      pending.state = tracer.cycle();
      saveChainDraft();
      refreshHint();
      return true;
    }
    if (e.key === 'Enter') {
      pending.state = tracer.accept();
      afterStep();
      return true;
    }
    if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      pending.state = tracer.skip();
      afterStep();
      return true;
    }
    return false;
  },
  render(g, f) {
    if (!pending) return;
    if (pending.kind === 'restored') {
      strokeChain(g, f, (p) => f.toScreen(p), f.scale, pending.pts, pending.closed, '#f59e0b', 2.5, []);
      return;
    }
    const s = pending.model.source;
    const xf = (p: Pt) => f.toScreen(apply(s.placement, p));
    const sc = f.scale * s.unit;
    const st = pending.state;
    const j = st.junction;
    if (j) {
      j.alternatives.forEach((alt, k) => {
        if (k !== j.current)
          strokeChain(g, f, xf, sc, alt.preview, false, 'rgba(148,163,184,0.8)', 2, [3, 4]);
      });
      const cur = j.alternatives[j.current];
      if (cur) strokeChain(g, f, xf, sc, cur.preview, false, '#22d3ee', 3, [8, 5]);
    }
    strokeChain(g, f, xf, sc, st.pts, st.closed, '#f59e0b', 3, []);
    if (j) {
      const c = xf(j.at);
      g.beginPath();
      g.arc(c.x, c.y, 7, 0, Math.PI * 2);
      g.strokeStyle = '#22d3ee';
      g.lineWidth = 2;
      g.stroke();
    }
  },
  restoreDraft(state: unknown) {
    const s = state as { points?: Vertex[]; closed?: boolean } | null;
    if (!s?.points?.length) return;
    pending = {
      kind: 'restored',
      pts: s.points.map((v) => (v.bulge ? { x: v.x, y: v.y, bulge: v.bulge } : { x: v.x, y: v.y })),
      closed: !!s.closed,
    };
    refreshHint();
    requestCanvasRender();
  },
};

function strokeChain(
  g: CanvasRenderingContext2D,
  _f: FrameInfo,
  xf: (p: Pt) => Pt,
  scale: number,
  pts: Vertex[],
  closed: boolean,
  color: string,
  width: number,
  dash: number[],
) {
  if (pts.length < 2) return;
  g.beginPath();
  traceGeometry(g, { type: 'polyline', pts, closed }, xf, scale);
  g.strokeStyle = color;
  g.lineWidth = width;
  g.setLineDash(dash);
  g.lineJoin = 'round';
  g.stroke();
  g.setLineDash([]);
}

// ------------------------------------------------------------------------------- boundary pick

let job: { job: BoundaryJob; pick: Pt; toastId: string | number | null } | null = null;
let ctxRef: ToolContext | null = null;

async function runBoundary(pick: Pt) {
  const p = getProject();
  if (!p) return;
  const { drawings, entities } = collectVisibleGeometry(p);
  if (!drawings.length) {
    toast.error('No visible vector drawing geometry to detect a boundary from.');
    return;
  }
  const s = traceSettings();
  const j = detectBoundary(drawings, pick, {
    gapTol: s.gapTol,
    detectIslands: s.detectIslands,
    chordTol: p.chordTolerance > 0 ? p.chordTolerance : 0.005,
  });
  const cur = { job: j, pick, toastId: null as string | number | null };
  job = cur;
  ctxRef?.requestRender();
  // Progress with Cancel when detection takes noticeable time.
  const timer = setTimeout(() => {
    if (job !== cur) return;
    cur.toastId = toast.loading('Detecting boundary…', {
      description: `${entities.toLocaleString()} drawing entities`,
      action: { label: 'Cancel', onClick: () => j.cancel() },
      duration: Infinity,
    });
  }, 600);
  try {
    const { result } = await j.promise;
    if (!result) {
      toast.error('No closed boundary around this point', {
        description:
          'The point is not enclosed by visible drawing geometry. Show the layers that close the region or increase the gap tolerance (Trace → Gap tolerance…).',
      });
      return;
    }
    addObjects([{ kind: 'trace', geometry: boundaryGeometry(result) }], 'Boundary pick');
  } catch (err) {
    if (err instanceof BoundaryCancelled) toast('Boundary detection cancelled');
    else toast.error('Boundary detection failed', { description: (err as Error).message });
  } finally {
    clearTimeout(timer);
    if (cur.toastId !== null) toast.dismiss(cur.toastId);
    if (job === cur) job = null;
    refreshHint();
    requestCanvasRender();
  }
}

/** True while a boundary detection runs (for tests and the UI). */
export function boundaryBusy(): boolean {
  return job !== null;
}

export const boundaryPickTool: Tool = {
  id: 'trace.boundary',
  title: 'Boundary pick',
  cursor: 'cell',
  hint: () =>
    job
      ? 'Detecting boundary… (Esc to cancel)'
      : `Boundary pick: click inside a region enclosed by drawing lines${traceSettings().detectIslands ? ' (islands become holes)' : ''}`,
  activate(ctx) {
    ctxRef = ctx;
    guardLayer();
  },
  pointerDown(e) {
    if (e.button !== 0 || job) return;
    void runBoundary({ x: e.world.x, y: e.world.y });
    refreshHint();
  },
  keyDown(e) {
    if (e.key !== 'Escape') return false;
    if (job) job.job.cancel();
    else setTool('select');
    return true;
  },
  render(g, f) {
    if (!job) return;
    const s = f.toScreen(job.pick);
    const t = (performance.now() / 600) % 1;
    g.beginPath();
    g.arc(s.x, s.y, 4 + 10 * t, 0, Math.PI * 2);
    g.strokeStyle = `rgba(245,158,11,${1 - t})`;
    g.lineWidth = 2;
    g.stroke();
    requestAnimationFrame(() => requestCanvasRender());
  },
};
