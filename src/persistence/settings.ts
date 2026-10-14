import { getDb } from './db';

/** Autosave settings (row 101). Local journalling itself cannot be switched off. */
export interface AutosaveSettings {
  /** Minutes of active editing between automatic restore points. */
  restorePointIntervalMin: number;
  /** Number of most recent automatic restore points kept. */
  keepAutoPoints: number;
  /** Additionally keep one automatic point per day for this many days. */
  keepDailyDays: number;
  /** Seconds between writes to a linked project file. */
  fileAutosaveIntervalSec: number;
  /** Minutes of work not saved to a file before reminding to download a backup (no File System Access API). */
  backupReminderMin: number;
  /** Journal entries between checkpoints. */
  checkpointEvery: number;
  /** Seconds of idle before a checkpoint. */
  idleCheckpointSec: number;
}

export const DEFAULT_AUTOSAVE_SETTINGS: AutosaveSettings = {
  restorePointIntervalMin: 10,
  keepAutoPoints: 30,
  keepDailyDays: 30,
  fileAutosaveIntervalSec: 60,
  backupReminderMin: 30,
  checkpointEvery: 50,
  idleCheckpointSec: 60,
};

export async function loadAutosaveSettings(): Promise<AutosaveSettings> {
  try {
    const rec = await getDb().settings.get('autosave');
    return { ...DEFAULT_AUTOSAVE_SETTINGS, ...((rec?.value as Partial<AutosaveSettings>) ?? {}) };
  } catch {
    return { ...DEFAULT_AUTOSAVE_SETTINGS };
  }
}

export async function saveAutosaveSettings(s: AutosaveSettings): Promise<void> {
  await getDb().settings.put({ key: 'autosave', value: s });
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const rec = await getDb().settings.get(key);
    return rec ? (rec.value as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await getDb().settings.put({ key, value });
}
