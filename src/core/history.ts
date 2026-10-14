import { applyPatches, enablePatches, produceWithPatches, type Draft, type Patch } from 'immer';

import { newId, nowIso } from './ids';
import type { Project } from './types';

enablePatches();

/**
 * Command pattern for every edit (row 11). Each committed command is stored as Immer patches plus
 * inverse patches, so it can be undone, redone, written to the autosave journal (row 90) and
 * replayed on top of a snapshot during recovery (rows 91, 95, 97).
 */

export const MAX_UNDO = 200;

export interface HistoryEntry {
  id: string;
  label: string;
  at: string;
  patches: Patch[];
  inverse: Patch[];
  /** Commands with the same coalesce key committed within COALESCE_MS merge into one undo step. */
  coalesceKey?: string;
}

export interface HistoryState {
  project: Project;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
}

/** Journal operations. Each is self-contained: `patches` are exactly what was applied to the project. */
export type JournalOp =
  | { op: 'do'; entry: HistoryEntry; coalesce?: boolean }
  | { op: 'undo'; entryId: string; patches: Patch[] }
  | { op: 'redo'; entryId: string; patches: Patch[] };

export const COALESCE_MS = 1500;

export type Recipe = (draft: Draft<Project>) => void | Project;

export interface CommitOptions {
  coalesceKey?: string;
}

export interface CommitResult {
  state: HistoryState;
  op: JournalOp;
}

function trim(stack: HistoryEntry[]): HistoryEntry[] {
  return stack.length > MAX_UNDO ? stack.slice(stack.length - MAX_UNDO) : stack;
}

/**
 * Derived-data hook (row 59, parametric offsets). After the user's recipe has produced its result,
 * every registered derivation runs on a draft of that result (`original(draft)` is the post-recipe
 * project, `before` the project before the commit; unchanged objects keep their identity, so
 * comparing references tells what the recipe changed). Its changes are appended to the same
 * patches, so the derived update is part of the same undo step and journal entry and replays
 * identically (undo/redo/recovery only apply patches and never re-run derivations). Derivations do
 * not run when the recipe changed nothing.
 */
export type Derivation = (draft: Draft<Project>, before: Project) => void;

const derivations: Derivation[] = [];

export function registerDerivation(fn: Derivation): () => void {
  derivations.push(fn);
  return () => {
    const i = derivations.indexOf(fn);
    if (i >= 0) derivations.splice(i, 1);
  };
}

function produceCommit(before: Project, recipe: Recipe): [Project, Patch[], Patch[]] {
  const [project, patches, inverse] = produceWithPatches(before, recipe as (d: Draft<Project>) => void);
  if (!derivations.length || patches.length === 0) return [project, patches, inverse];
  const fns = [...derivations];
  const [derived, dPatches, dInverse] = produceWithPatches(project, (d: Draft<Project>) => {
    for (const fn of fns) fn(d, before);
  });
  if (dPatches.length === 0) return [project, patches, inverse];
  return [derived, [...patches, ...dPatches], [...dInverse, ...inverse]];
}

export function commit(
  state: HistoryState,
  label: string,
  recipe: Recipe,
  opts: CommitOptions = {},
): CommitResult | null {
  const [project, patches, inverse] = produceCommit(state.project, recipe);
  if (patches.length === 0) return null;
  const now = nowIso();
  const top = state.undo[state.undo.length - 1];
  const canCoalesce =
    opts.coalesceKey !== undefined &&
    top?.coalesceKey === opts.coalesceKey &&
    state.redo.length === 0 &&
    Date.now() - Date.parse(top.at) < COALESCE_MS;
  const entry: HistoryEntry = {
    id: canCoalesce ? top.id : newId('cmd'),
    label,
    at: now,
    patches,
    inverse,
    coalesceKey: opts.coalesceKey,
  };
  let undo: HistoryEntry[];
  if (canCoalesce) {
    const merged: HistoryEntry = {
      ...top,
      at: now,
      patches: [...top.patches, ...patches],
      inverse: [...inverse, ...top.inverse],
    };
    undo = [...state.undo.slice(0, -1), merged];
  } else {
    undo = trim([...state.undo, entry]);
  }
  return { state: { project, undo, redo: [] }, op: { op: 'do', entry, coalesce: canCoalesce } };
}

export function undo(state: HistoryState): CommitResult | null {
  const entry = state.undo[state.undo.length - 1];
  if (!entry) return null;
  const project = applyPatches(state.project, entry.inverse);
  return {
    state: { project, undo: state.undo.slice(0, -1), redo: [...state.redo, entry] },
    op: { op: 'undo', entryId: entry.id, patches: entry.inverse },
  };
}

export function redo(state: HistoryState): CommitResult | null {
  const entry = state.redo[state.redo.length - 1];
  if (!entry) return null;
  const project = applyPatches(state.project, entry.patches);
  return {
    state: { project, undo: trim([...state.undo, entry]), redo: state.redo.slice(0, -1) },
    op: { op: 'redo', entryId: entry.id, patches: entry.patches },
  };
}

/**
 * Applies a journal operation during replay. Project state changes only through the recorded
 * patches; the undo/redo stacks are rebuilt best-effort from the entry ids. Throws if the patches
 * cannot be applied (the caller skips the entry and reports it).
 */
export function applyOp(state: HistoryState, op: JournalOp): HistoryState {
  switch (op.op) {
    case 'do': {
      const project = applyPatches(state.project, op.entry.patches);
      if (op.coalesce) {
        const top = state.undo[state.undo.length - 1];
        if (top && top.id === op.entry.id) {
          const merged: HistoryEntry = {
            ...top,
            at: op.entry.at,
            patches: [...top.patches, ...op.entry.patches],
            inverse: [...op.entry.inverse, ...top.inverse],
          };
          return { project, undo: [...state.undo.slice(0, -1), merged], redo: [] };
        }
      }
      return { project, undo: trim([...state.undo, op.entry]), redo: [] };
    }
    case 'undo': {
      const project = applyPatches(state.project, op.patches);
      const idx = findLast(state.undo, op.entryId);
      if (idx < 0) return { project, undo: state.undo, redo: state.redo };
      const entry = state.undo[idx];
      return {
        project,
        undo: [...state.undo.slice(0, idx), ...state.undo.slice(idx + 1)],
        redo: [...state.redo, entry],
      };
    }
    case 'redo': {
      const project = applyPatches(state.project, op.patches);
      const idx = findLast(state.redo, op.entryId);
      if (idx < 0) return { project, undo: state.undo, redo: state.redo };
      const entry = state.redo[idx];
      return {
        project,
        undo: trim([...state.undo, entry]),
        redo: [...state.redo.slice(0, idx), ...state.redo.slice(idx + 1)],
      };
    }
  }
}

function findLast(stack: HistoryEntry[], id: string): number {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].id === id) return i;
  return -1;
}

/** Short human summary of a list of ops, e.g. for recovery dialogs. */
export function summariseOps(ops: JournalOp[]): string {
  const counts = new Map<string, number>();
  for (const op of ops) {
    const key = op.op === 'do' ? op.entry.label : op.op === 'undo' ? 'Undo' : 'Redo';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .slice(0, 6)
    .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k))
    .join(', ');
}
