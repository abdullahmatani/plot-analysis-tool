import { create } from 'zustand';

import { currentSession } from '@/app/session';
import type { Pt, Units } from '@/core/types';
import { parseLength } from '@/core/units';
import { getProject } from '@/store/project';

import type { PointFitKind } from './compute';

/**
 * Calibration, alignment and distance-check sessions (rows 28–34). The panels are non-modal: the user
 * picks points on the canvas while the panel collects values. The whole session is kept as a draft
 * (row 93) so an interrupted calibration can be resumed after a crash.
 */

export type CalTab = 'two-point' | 'references' | 'ratio' | 'coordinates';

export interface DistanceRow {
  /** Drawing units. */
  a: Pt | null;
  b: Pt | null;
  /** Real length as typed (display units by default). */
  value: string;
}

export interface PointRow {
  /** Drawing units. */
  p: Pt | null;
  /** Known world X/E and Y/N as typed. */
  x: string;
  y: string;
}

export interface CalibrateSession {
  kind: 'calibrate';
  drawingId: string;
  tab: CalTab;
  twoPoint: DistanceRow;
  refMode: 'distance' | 'point';
  distances: DistanceRow[];
  points: PointRow[];
  pointFit: PointFitKind;
  separateXY: boolean;
  coords: PointRow[];
  coordFit: PointFitKind;
  ratio: string;
  /** Sheet size the stated ratio refers to (PDF), null = the PDF page itself. */
  sheet: string | null;
  /** CAD units choice ('' = file units). */
  unit: Units | '';
  /** Row currently being picked. */
  picking: { list: 'twoPoint' | 'distances' | 'points' | 'coords'; index: number } | null;
}

export interface AlignSession {
  kind: 'align';
  /** The sub-drawing being placed. */
  drawingId: string;
  baseId: string | null;
  mode: 'two-point' | 'shared';
  /** Sub-drawing points (its drawing units) and the matching base points (base drawing units). */
  src: (Pt | null)[];
  dst: (Pt | null)[];
  keepScale: boolean;
  /** Next pick in the sequence src1, dst1, src2, dst2 (null = not picking). */
  step: number | null;
}

export interface CheckSession {
  kind: 'check';
  /** World points. */
  a: Pt | null;
  b: Pt | null;
  drawingId: string | null;
  value: string;
  tolerance: string;
  picking: boolean;
  result: { measured: number; expected: number; diff: number; tolerance: number; pass: boolean } | null;
}

export type Session = CalibrateSession | AlignSession | CheckSession;

interface Store {
  session: Session | null;
  set(s: Session | null): void;
  update<K extends Session['kind']>(kind: K, fn: (s: Extract<Session, { kind: K }>) => void): void;
}

const DRAFT = { key: 'calibration:session', tool: 'calibration', label: 'Calibration' };

function saveDraft(s: Session | null) {
  const sess = currentSession();
  if (!sess) return;
  if (s) sess.drafts.set(DRAFT, { session: s, projectId: getProject()?.id });
  else sess.drafts.clear(DRAFT.key);
}

export const useCalStore = create<Store>()((set, get) => ({
  session: null,
  set: (session) => {
    set({ session });
    saveDraft(session);
  },
  update: (kind, fn) => {
    const cur = get().session;
    if (!cur || cur.kind !== kind) return;
    const next = structuredClone(cur) as Extract<Session, { kind: typeof kind }>;
    fn(next);
    set({ session: next });
    saveDraft(next);
  },
}));

export const DRAFT_KEY = DRAFT.key;

export function newCalibrateSession(drawingId: string, tab: CalTab = 'two-point'): CalibrateSession {
  return {
    kind: 'calibrate',
    drawingId,
    tab,
    twoPoint: { a: null, b: null, value: '' },
    refMode: 'distance',
    distances: [],
    points: [],
    pointFit: 'similarity',
    separateXY: false,
    coords: [],
    coordFit: 'similarity',
    ratio: '',
    sheet: null,
    unit: '',
    picking: null,
  };
}

/** Opens the calibration panel for a drawing (from the Drawings menu, the guard or the badge). */
export function openCalibration(drawingId: string, tab?: CalTab) {
  const p = getProject();
  const d = p?.drawings.find((x) => x.id === drawingId);
  if (!d) return;
  const cur = useCalStore.getState().session;
  if (cur?.kind === 'calibrate' && cur.drawingId === drawingId) {
    if (tab) useCalStore.getState().update('calibrate', (s) => void (s.tab = tab));
    return;
  }
  const initialTab: CalTab =
    tab ??
    (d.calibration?.method === 'coordinates'
      ? 'coordinates'
      : d.calibration?.method === 'multi-point'
        ? 'references'
        : d.calibration?.method === 'ratio' || d.calibration?.method === 'cad-units'
          ? 'ratio'
          : 'two-point');
  const s = newCalibrateSession(drawingId, initialTab);
  if (d.calibration?.method === 'ratio' && d.calibration.ratio) s.ratio = String(d.calibration.ratio);
  if (d.unitsOverride) s.unit = d.unitsOverride;
  useCalStore.getState().set(s);
}

export function openAlignment(drawingId: string) {
  const p = getProject();
  if (!p?.drawings.some((x) => x.id === drawingId)) return;
  const others = [...p.drawings].filter((d) => d.id !== drawingId).sort((a, b) => a.order - b.order);
  useCalStore.getState().set({
    kind: 'align',
    drawingId,
    baseId: others[0]?.id ?? null,
    mode: 'two-point',
    src: [null, null],
    dst: [null, null],
    keepScale: false,
    step: null,
  });
}

export function openCheck() {
  const p = getProject();
  const visible = (p?.drawings ?? []).filter((d) => d.visible);
  useCalStore.getState().set({
    kind: 'check',
    a: null,
    b: null,
    drawingId: visible.length === 1 ? visible[0].id : null,
    value: '',
    tolerance: '',
    picking: false,
    result: null,
  });
}

export function closeSession() {
  useCalStore.getState().set(null);
}

/** Forgets the session without touching drafts (project switched or closed). */
export function dropSession() {
  useCalStore.setState({ session: null });
}

/** Parses a typed length or coordinate in display units (spaces and thin spaces allowed). */
export function parseDisplayLength(v: string): number | null {
  const units = getProject()?.display.units ?? 'm';
  const t = v.replace(/[\s\u202F\u2009]+(?=[\d.,])/g, '').trim();
  if (!t) return null;
  return parseLength(t, units);
}
