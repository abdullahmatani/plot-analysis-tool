import { create } from 'zustand';

import type { Geometry } from '@/core/types';

import type { MeasureMode } from './compute';

/** Measurement result panel state: the live (in-progress) and last finished measurement. */

export interface MeasureEntry {
  mode: MeasureMode;
  /** World geometry. */
  geometry: Geometry;
}

interface MeasureStore {
  live: MeasureEntry | null;
  result: (MeasureEntry & { keptId?: string | null }) | null;
  /** Keep finished measurements as annotations (remembered per browser). */
  keep: boolean;
  setLive(e: MeasureEntry | null): void;
  setResult(e: MeasureStore['result']): void;
  setKeep(v: boolean): void;
}

const KEY = 'pat:measure-keep';

function loadKeep(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export const useMeasureStore = create<MeasureStore>()((set, get) => ({
  live: null,
  result: null,
  keep: loadKeep(),
  setLive: (live) => {
    const cur = get().live;
    if (cur === live) return;
    if (
      cur &&
      live &&
      cur.mode === live.mode &&
      JSON.stringify(cur.geometry) === JSON.stringify(live.geometry)
    )
      return;
    set({ live });
  },
  setResult: (result) => set({ result, live: null }),
  setKeep: (keep) => {
    set({ keep });
    try {
      localStorage.setItem(KEY, keep ? '1' : '0');
    } catch {
      /* ignore */
    }
  },
}));
