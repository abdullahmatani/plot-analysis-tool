import { nowIso } from '@/core/ids';

import { getDb, type FileLinkRecord } from './db';

/**
 * File System Access API helpers with download/upload fallbacks (row 10) and autosave to a linked
 * project file (row 98). Writes go through `createWritable()`, which writes to a swap file and only
 * replaces the target on `close()`, so a write interrupted by a crash never corrupts the file.
 */

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: FilePickerAcceptType[];
  excludeAcceptAllOption?: boolean;
}
interface OpenFilePickerOptions {
  multiple?: boolean;
  types?: FilePickerAcceptType[];
  excludeAcceptAllOption?: boolean;
}
type FsaWindow = Window & {
  showSaveFilePicker?: (o?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  showOpenFilePicker?: (o?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>;
};
type PermissionedHandle = FileSystemFileHandle & {
  queryPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
};

export function fsaSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as FsaWindow).showSaveFilePicker === 'function';
}

export const PROJECT_PICKER_TYPES: FilePickerAcceptType[] = [
  { description: 'Plot Analysis project', accept: { 'application/x-plot-analysis-project': ['.patproj'] } },
];

export async function pickSaveHandle(
  suggestedName: string,
  types = PROJECT_PICKER_TYPES,
): Promise<FileSystemFileHandle | null> {
  try {
    return (await (window as FsaWindow).showSaveFilePicker!({ suggestedName, types })) ?? null;
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return null;
    throw e;
  }
}

export async function pickOpenHandle(types = PROJECT_PICKER_TYPES): Promise<FileSystemFileHandle | null> {
  try {
    const [h] = await (window as FsaWindow).showOpenFilePicker!({ multiple: false, types });
    return h ?? null;
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return null;
    throw e;
  }
}

export async function writeToHandle(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  const w = await handle.createWritable();
  try {
    await w.write(bytes as unknown as FileSystemWriteChunkType);
    await w.close();
  } catch (e) {
    try {
      await w.abort();
    } catch {
      /* ignore */
    }
    throw e;
  }
}

export async function permissionState(
  handle: FileSystemFileHandle,
  request: boolean,
): Promise<PermissionState> {
  const h = handle as PermissionedHandle;
  if (!h.queryPermission) return 'granted';
  const state = await h.queryPermission({ mode: 'readwrite' });
  if (state === 'granted' || !request || !h.requestPermission) return state;
  return h.requestPermission({ mode: 'readwrite' });
}

/** Triggers a browser download of local bytes (fallback when the File System Access API is unavailable). */
export function downloadBytes(bytes: Uint8Array | string, fileName: string, mime: string) {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Opens a file chooser using a hidden input (upload fallback). */
export function pickFileViaInput(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.onchange = () => {
      resolve(input.files ? [...input.files] : []);
      input.remove();
    };
    input.oncancel = () => {
      resolve([]);
      input.remove();
    };
    document.body.appendChild(input);
    input.click();
  });
}

export async function getFileLink(projectId: string): Promise<FileLinkRecord | undefined> {
  try {
    return await getDb().fileLinks.get(projectId);
  } catch {
    return undefined;
  }
}

export async function setFileLink(rec: FileLinkRecord): Promise<void> {
  await getDb().fileLinks.put(rec);
}

export async function removeFileLink(projectId: string): Promise<void> {
  await getDb().fileLinks.delete(projectId);
}

export interface FileLinkStatus {
  linked: boolean;
  name: string | null;
  autosave: boolean;
  lastWrittenAt: string | null;
  lastWrittenSeq: number;
  needsPermission: boolean;
  error: string | null;
  writing: boolean;
}

/**
 * Autosave to the linked project file: every `intervalSec` while there are changes not yet written,
 * and on tab hide/close (row 98).
 */
export class FileLinkManager {
  private rec: FileLinkRecord | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private writing: Promise<void> | null = null;
  private listeners = new Set<(s: FileLinkStatus) => void>();
  status: FileLinkStatus = {
    linked: false,
    name: null,
    autosave: false,
    lastWrittenAt: null,
    lastWrittenSeq: -1,
    needsPermission: false,
    error: null,
    writing: false,
  };

  constructor(
    private projectId: string,
    private build: () => Promise<Uint8Array>,
    private currentSeq: () => number,
    private intervalSec: number,
  ) {}

  async load() {
    this.rec = (await getFileLink(this.projectId)) ?? null;
    this.emit();
    this.restartTimer();
  }

  subscribe(fn: (s: FileLinkStatus) => void) {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<FileLinkStatus> = {}) {
    this.status = {
      ...this.status,
      ...patch,
      linked: !!this.rec,
      name: this.rec?.name ?? null,
      autosave: !!this.rec?.autosave,
      lastWrittenAt: this.rec?.lastWrittenAt ?? null,
      lastWrittenSeq: this.rec?.lastWrittenSeq ?? -1,
    };
    for (const l of this.listeners) l(this.status);
  }

  setInterval(sec: number) {
    this.intervalSec = sec;
    this.restartTimer();
  }

  private restartTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.rec?.autosave) {
      this.timer = setInterval(() => void this.writeIfChanged('interval'), this.intervalSec * 1000);
    }
  }

  async link(handle: FileSystemFileHandle, writtenSeq: number, autosave: boolean) {
    this.rec = {
      projectId: this.projectId,
      handle,
      name: handle.name,
      autosave,
      lastWrittenSeq: writtenSeq,
      lastWrittenAt: nowIso(),
    };
    await setFileLink(this.rec);
    this.emit({ error: null, needsPermission: false });
    this.restartTimer();
  }

  async setAutosave(on: boolean) {
    if (!this.rec) return;
    this.rec = { ...this.rec, autosave: on };
    await setFileLink(this.rec);
    this.emit();
    this.restartTimer();
  }

  async unlink() {
    this.rec = null;
    await removeFileLink(this.projectId);
    this.emit();
    this.restartTimer();
  }

  get dirty() {
    return !!this.rec && this.currentSeq() > this.rec.lastWrittenSeq;
  }

  /** Writes if there are unwritten changes. `interactive` allows a permission prompt. */
  async writeIfChanged(reason: string, interactive = false): Promise<boolean> {
    void reason;
    if (!this.rec || !this.rec.autosave || !this.dirty) return false;
    return this.write(interactive);
  }

  async write(interactive = false): Promise<boolean> {
    if (!this.rec) return false;
    if (this.writing) await this.writing.catch(() => {});
    const rec = this.rec;
    const perm = await permissionState(rec.handle, interactive).catch(() => 'denied' as PermissionState);
    if (perm !== 'granted') {
      this.emit({ needsPermission: true });
      return false;
    }
    const seq = this.currentSeq();
    this.emit({ writing: true });
    const task = (async () => {
      const bytes = await this.build();
      await writeToHandle(rec.handle, bytes);
      this.rec = { ...rec, lastWrittenSeq: seq, lastWrittenAt: nowIso() };
      await setFileLink(this.rec);
    })();
    this.writing = task;
    try {
      await task;
      this.emit({ writing: false, error: null, needsPermission: false });
      return true;
    } catch (e) {
      this.emit({ writing: false, error: `Could not write "${rec.name}": ${(e as Error).message}` });
      return false;
    } finally {
      this.writing = null;
    }
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.listeners.clear();
  }
}
