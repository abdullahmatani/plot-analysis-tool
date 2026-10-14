import type { HistoryState } from '@/core/history';
import { newId, nowIso } from '@/core/ids';
import { createProject } from '@/core/project';
import type { Project } from '@/core/types';

import { collectGarbage } from './blobs';
import { getDb, type ProjectMeta } from './db';
import { serializeSnapshot } from './serialize';
import { writeSnapshot } from './snapshots';

/** Local project store (row 9): metadata list + per-project journal/snapshots. */

export function metaFor(project: Project, lastSeq: number, existing?: ProjectMeta): ProjectMeta {
  const now = nowIso();
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: existing?.updatedAt ?? now,
    lastOpenedAt: existing?.lastOpenedAt ?? now,
    lastSeq,
    drawingCount: project.drawings.length,
    objectCount: project.objects.length,
    blobKeys: [...new Set(project.drawings.map((d) => d.source.sha256))],
  };
}

/** Stores a project as a new local project with an initial snapshot at seq 0. */
export async function storeNewProject(
  project: Project,
  history: Pick<HistoryState, 'undo' | 'redo'> = { undo: [], redo: [] },
): Promise<ProjectMeta> {
  const db = getDb();
  const serialized = await serializeSnapshot({ project, ...history });
  const meta = metaFor(project, 0);
  await db.projects.put(meta);
  await writeSnapshot(project.id, 0, 'checkpoint', serialized);
  return meta;
}

export async function createNewProject(name?: string): Promise<Project> {
  const project = createProject(name);
  await storeNewProject(project);
  return project;
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const all = await getDb().projects.toArray();
  return all.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
}

export async function touchProject(id: string): Promise<void> {
  await getDb().projects.update(id, { lastOpenedAt: nowIso() });
}

export async function renameProjectMeta(id: string, name: string): Promise<void> {
  await getDb().projects.update(id, { name });
}

export async function deleteProject(id: string): Promise<void> {
  const db = getDb();
  await db.transaction('rw', [db.projects, db.journal, db.snapshots, db.drafts, db.fileLinks], async () => {
    await db.projects.delete(id);
    await db.journal.where('projectId').equals(id).delete();
    await db.snapshots.where('projectId').equals(id).delete();
    await db.drafts.where('projectId').equals(id).delete();
    await db.fileLinks.delete(id);
  });
  await collectGarbage();
}

/** Stores a copy of a project state under a new id (restore as copy, open as copy). */
export async function storeProjectCopy(project: Project, name?: string): Promise<Project> {
  const copy: Project = {
    ...project,
    id: newId('prj'),
    name: name ?? `${project.name} (copy)`,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await storeNewProject(copy);
  return copy;
}
