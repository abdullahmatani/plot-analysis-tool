import { downloadBytes, fsaSupported, pickSaveHandle, writeToHandle } from '@/persistence/file-link';

import { concatParts } from './png-encoder';
import { formatInfo, type ExportFormat } from './settings';

/**
 * Saving export files (row 81): the File System Access API save picker when available (asked for
 * before the export starts, while the click still counts as a user gesture), otherwise a download.
 */

export type SaveTarget = { kind: 'handle'; handle: FileSystemFileHandle } | { kind: 'download' };

/** Asks where to save; null when the user cancelled the picker. */
export async function chooseTarget(fileName: string, format: ExportFormat): Promise<SaveTarget | null> {
  if (!fsaSupported()) return { kind: 'download' };
  const f = formatInfo(format);
  try {
    const handle = await pickSaveHandle(fileName, [
      { description: f.label, accept: { [f.mime]: [`.${f.ext}`] } },
    ]);
    return handle ? { kind: 'handle', handle } : null;
  } catch {
    // Picker unavailable in this context (e.g. no user activation): fall back to a download.
    return { kind: 'download' };
  }
}

export async function saveParts(target: SaveTarget, parts: Uint8Array[], fileName: string, mime: string) {
  const bytes = parts.length === 1 ? parts[0] : concatParts(parts);
  if (target.kind === 'handle') await writeToHandle(target.handle, bytes);
  else downloadBytes(bytes, fileName, mime);
}
