import { canonicalJson, sha256Hex } from '@/core/canonical';
import type { HistoryState } from '@/core/history';

export interface SerializedSnapshot {
  data: string;
  sha256: string;
  projectHash: string;
  size: number;
}

/** Serialises project state + undo/redo stacks and computes integrity hashes (runs in a worker). */
export async function serializeSnapshot(state: HistoryState): Promise<SerializedSnapshot> {
  const data = JSON.stringify({ project: state.project, undo: state.undo, redo: state.redo });
  const [sha256, projectHash] = await Promise.all([sha256Hex(data), hashProject(state.project)]);
  return { data, sha256, projectHash, size: data.length };
}

export async function hashProject(project: unknown): Promise<string> {
  return sha256Hex(canonicalJson(project));
}

export function parseSnapshotData(data: string): HistoryState {
  const parsed = JSON.parse(data) as Partial<HistoryState>;
  if (!parsed || typeof parsed !== 'object' || !parsed.project) throw new Error('Snapshot has no project');
  return { project: parsed.project, undo: parsed.undo ?? [], redo: parsed.redo ?? [] };
}
