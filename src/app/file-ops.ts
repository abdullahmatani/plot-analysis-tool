import { toast } from 'sonner';

import { createProject } from '@/core/project';
import type { Project } from '@/core/types';
import { getDb } from '@/persistence/db';
import {
  downloadBytes,
  fsaSupported,
  pickFileViaInput,
  pickOpenHandle,
  pickSaveHandle,
  writeToHandle,
} from '@/persistence/file-link';
import {
  PROJECT_FILE_EXT,
  PROJECT_FILE_MIME,
  ProjectFileError,
  projectFileName,
  readProjectFile,
} from '@/persistence/project-file';
import { listProjects, storeNewProject, storeProjectCopy } from '@/persistence/projects';
import { requestPersistence, storageInfo } from '@/persistence/storage';
import { useAppStore } from '@/store/app';
import { useProjectStore } from '@/store/project';

import { closeSession, currentSession, openSession } from './session';

/** High-level project file operations used by menus and the start screen (rows 9, 10, 98). */

export async function refreshRecents() {
  try {
    useAppStore.getState().set({ recents: await listProjects(), storage: await storageInfo() });
  } catch {
    /* storage unavailable */
  }
}

async function ensurePersistence() {
  const granted = await requestPersistence();
  useAppStore.getState().set({ persistGranted: granted });
}

export async function newProject(name = 'Untitled project'): Promise<void> {
  const project = createProject(name);
  if (useAppStore.getState().storageUnavailable) {
    toast.error(
      'Browser storage is unavailable, so autosave is off. Save the project to a file to keep your work.',
    );
  }
  await storeNewProject(project);
  const first = (await getDb().projects.count()) === 1;
  if (first) await ensurePersistence();
  await openSession(project.id);
  await refreshRecents();
}

export async function openLocalProject(id: string, opts: { checkpointOnly?: boolean } = {}) {
  try {
    await openSession(id, opts);
    await refreshRecents();
  } catch (e) {
    toast.error(`Could not open project: ${(e as Error).message}`);
    await closeSession(false);
  }
}

export async function closeProject() {
  await closeSession(true);
  await refreshRecents();
}

/** Opens a .patproj file (File System Access API, or upload fallback). */
export async function openProjectFile(): Promise<void> {
  let bytes: Uint8Array | null = null;
  let handle: FileSystemFileHandle | null = null;
  if (fsaSupported()) {
    handle = await pickOpenHandle();
    if (!handle) return;
    bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } else {
    const [file] = await pickFileViaInput(PROJECT_FILE_EXT);
    if (!file) return;
    bytes = new Uint8Array(await file.arrayBuffer());
  }
  await openProjectBytes(bytes, handle);
}

export async function openProjectBytes(bytes: Uint8Array, handle: FileSystemFileHandle | null = null) {
  try {
    const opened = await readProjectFile(bytes);
    let project: Project = opened.project;
    const existing = await getDb().projects.get(project.id);
    if (existing) {
      // Keep the local copy untouched; the file opens as a separate project.
      project = await storeProjectCopy(project, project.name);
    } else {
      await storeNewProject(project);
    }
    const session = await openSession(project.id);
    if (handle) await session.file.link(handle, session.engine?.currentSeq ?? 0, false);
    if (opened.missingDrawings.length)
      toast.warning(`Missing drawings in file: ${opened.missingDrawings.join(', ')}`);
    if (opened.migratedFrom < opened.project.schemaVersion)
      toast.info(`Project upgraded from schema ${opened.migratedFrom}.`);
    await refreshRecents();
    toast.success(`Opened "${project.name}"`);
  } catch (e) {
    const msg =
      e instanceof ProjectFileError ? e.message : `Could not open the project file: ${(e as Error).message}`;
    toast.error(msg);
  }
}

/** Save (to the linked file when there is one), otherwise Save As. */
export async function saveProject(): Promise<boolean> {
  const s = currentSession();
  if (!s) return false;
  if (s.file.status.linked) {
    const ok = await s.file.write(true);
    if (ok) {
      s.noteFileSaved();
      toast.success(`Saved to "${s.file.status.name}"`);
    } else if (s.file.status.error) {
      toast.error(s.file.status.error);
    }
    return ok;
  }
  return saveProjectAs();
}

export async function saveProjectAs(): Promise<boolean> {
  const s = currentSession();
  const project = useProjectStore.getState().history?.project;
  if (!s || !project) return false;
  await s.beforeExport();
  const bytes = await s.buildFile();
  if (fsaSupported()) {
    const handle = await pickSaveHandle(projectFileName(project));
    if (!handle) return false;
    await writeToHandle(handle, bytes);
    await s.file.link(handle, s.engine?.currentSeq ?? 0, s.file.status.autosave || true);
    s.noteFileSaved();
    toast.success(`Saved to "${handle.name}". Autosave to this file is on.`);
    return true;
  }
  downloadBytes(bytes, projectFileName(project), PROJECT_FILE_MIME);
  s.noteFileSaved();
  toast.success('Project file downloaded.');
  return true;
}

/** Downloads a backup copy without linking (also used by the quota alert, row 99). */
export async function downloadBackup(): Promise<void> {
  const s = currentSession();
  const project = useProjectStore.getState().history?.project;
  if (!s || !project) return;
  const bytes = await s.buildFile();
  downloadBytes(bytes, projectFileName(project), PROJECT_FILE_MIME);
  s.noteFileSaved();
}
