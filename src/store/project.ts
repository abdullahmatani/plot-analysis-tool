import { create } from 'zustand';

import {
  applyOp,
  commit as commitCmd,
  redo as redoCmd,
  undo as undoCmd,
  type CommitOptions,
  type HistoryState,
  type JournalOp,
  type Recipe,
} from '@/core/history';
import type { Project } from '@/core/types';

/**
 * The open project and its undo/redo history. Every edit goes through `commit` (row 11); the
 * resulting journal op is handed to the autosave sink (row 90) registered by the project session.
 */

type Sink = (op: JournalOp) => void;
let sink: Sink | null = null;
const commitListeners = new Set<(op: JournalOp) => void>();

export function setJournalSink(fn: Sink | null) {
  sink = fn;
}

export function onCommit(fn: (op: JournalOp) => void): () => void {
  commitListeners.add(fn);
  return () => commitListeners.delete(fn);
}

export interface PreviewInfo {
  snapshotId: string;
  label: string;
  at: string;
}

interface ProjectStore {
  history: HistoryState | null;
  /** Live state stashed while previewing a restore point. */
  stashed: HistoryState | null;
  readOnly: boolean;
  readOnlyReason: 'other-tab' | 'preview' | 'storage' | null;
  preview: PreviewInfo | null;
  load(state: HistoryState): void;
  unload(): void;
  setReadOnly(readOnly: boolean, reason?: ProjectStore['readOnlyReason']): void;
  commit(label: string, recipe: Recipe, opts?: CommitOptions): boolean;
  undo(): boolean;
  redo(): boolean;
  /** Applies ops written by another tab (read-only followers). */
  applyRemote(ops: JournalOp[]): void;
  startPreview(state: HistoryState, info: PreviewInfo): void;
  endPreview(): void;
}

function emit(op: JournalOp) {
  sink?.(op);
  for (const l of commitListeners) l(op);
}

export const useProjectStore = create<ProjectStore>()((set, get) => ({
  history: null,
  stashed: null,
  readOnly: false,
  readOnlyReason: null,
  preview: null,
  load: (state) => set({ history: state, stashed: null, preview: null }),
  unload: () => set({ history: null, stashed: null, preview: null, readOnly: false, readOnlyReason: null }),
  setReadOnly: (readOnly, reason = null) => set({ readOnly, readOnlyReason: readOnly ? reason : null }),
  commit: (label, recipe, opts) => {
    const { history, readOnly } = get();
    if (!history || readOnly) return false;
    const r = commitCmd(history, label, recipe, opts);
    if (!r) return false;
    set({ history: r.state });
    emit(r.op);
    return true;
  },
  undo: () => {
    const { history, readOnly } = get();
    if (!history || readOnly) return false;
    const r = undoCmd(history);
    if (!r) return false;
    set({ history: r.state });
    emit(r.op);
    return true;
  },
  redo: () => {
    const { history, readOnly } = get();
    if (!history || readOnly) return false;
    const r = redoCmd(history);
    if (!r) return false;
    set({ history: r.state });
    emit(r.op);
    return true;
  },
  applyRemote: (ops) => {
    const { history, stashed } = get();
    if (!history) return;
    if (stashed) {
      let s = stashed;
      for (const op of ops) s = applyOp(s, op);
      set({ stashed: s });
      return;
    }
    let s = history;
    for (const op of ops) s = applyOp(s, op);
    set({ history: s });
  },
  startPreview: (state, info) => {
    const { history, stashed } = get();
    set({ stashed: stashed ?? history, history: state, preview: info });
  },
  endPreview: () => {
    const { stashed } = get();
    if (!stashed) return;
    set({ history: stashed, stashed: null, preview: null });
  },
}));

export function getProject(): Project | null {
  return useProjectStore.getState().history?.project ?? null;
}

export function useProject<T>(selector: (p: Project) => T): T | undefined {
  return useProjectStore((s) => (s.history ? selector(s.history.project) : undefined));
}

export function commit(label: string, recipe: Recipe, opts?: CommitOptions): boolean {
  return useProjectStore.getState().commit(label, recipe, opts);
}
